import { randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  NATIVE_MEMORY_LAYOUTS,
  type NativeMemoryLayout,
  type NativeMemorySource,
} from "./native-memory-contract.js";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

export type NativeMemoryObservationState = "available" | "removed";

export interface NativeMemoryObservation {
  id: string;
  projectId: string;
  layout: NativeMemoryLayout;
  hostId: string;
  repositoryKey: string;
  sourceKey: string;
  contentHash: string;
  byteLength: number;
  modifiedAt: number;
  state: NativeMemoryObservationState;
  sourceVersion: number;
  environmentId: string;
  firstObservedAt: number;
  lastObservedAt: number;
  changedAt: number;
  removedAt: number | null;
}

export interface NativeMemoryReconcileResult {
  added: number;
  changed: number;
  unchanged: number;
  removed: number;
  totalAvailable: number;
}

interface ObservationRow {
  id: string;
  project_id: string;
  layout: string;
  host_id: string;
  repository_key: string;
  source_key: string;
  content_hash: string;
  byte_length: number;
  modified_at: number;
  state: NativeMemoryObservationState;
  source_version: number;
  environment_id: string;
  first_observed_at: number;
  last_observed_at: number;
  changed_at: number;
  removed_at: number | null;
}

function observationId(): string {
  return `nmo_${randomBytes(12).toString("hex")}`;
}

function fromRow(row: ObservationRow): NativeMemoryObservation {
  const layout = NATIVE_MEMORY_LAYOUTS.find((known) => known === row.layout);
  if (!layout) {
    throw new Error(`unsupported native memory layout "${row.layout}"`);
  }
  return {
    id: row.id,
    projectId: row.project_id,
    layout,
    hostId: row.host_id,
    repositoryKey: row.repository_key,
    sourceKey: row.source_key,
    contentHash: row.content_hash,
    byteLength: row.byte_length,
    modifiedAt: row.modified_at,
    state: row.state,
    sourceVersion: row.source_version,
    environmentId: row.environment_id,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    changedAt: row.changed_at,
    removedAt: row.removed_at,
  };
}

export class NativeMemoryObservationStore {
  constructor(private readonly db: PluginDatabase) {}

  reconcile(input: {
    projectId: string;
    layout: NativeMemoryLayout;
    hostId: string;
    repositoryKey: string;
    environmentId: string;
    sources: readonly NativeMemorySource[];
  }): NativeMemoryReconcileResult {
    return this.db.transaction(() => {
      const now = Date.now();
      const existing = this.db
        .prepare(
          `SELECT * FROM native_memory_observations
           WHERE project_id = ? AND layout = ? AND host_id = ? AND repository_key = ?`,
        )
        .all(
          input.projectId,
          input.layout,
          input.hostId,
          input.repositoryKey,
        ) as ObservationRow[];
      const bySource = new Map(existing.map((row) => [row.source_key, row]));
      const seen = new Set<string>();
      let added = 0;
      let changed = 0;
      let unchanged = 0;

      for (const source of input.sources) {
        if (seen.has(source.sourceKey)) {
          throw new Error(
            `duplicate native memory source "${source.sourceKey}"`,
          );
        }
        seen.add(source.sourceKey);
        const current = bySource.get(source.sourceKey);
        if (!current) {
          this.db
            .prepare(
              `INSERT INTO native_memory_observations (
                 id, project_id, layout, host_id, repository_key, source_key,
                 content_hash, byte_length, modified_at, state, source_version,
                 environment_id, first_observed_at, last_observed_at, changed_at,
                 removed_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', 1, ?, ?, ?, ?, NULL)`,
            )
            .run(
              observationId(),
              input.projectId,
              input.layout,
              input.hostId,
              input.repositoryKey,
              source.sourceKey,
              source.contentHash,
              source.byteLength,
              source.modifiedAt,
              input.environmentId,
              now,
              now,
              now,
            );
          added += 1;
          continue;
        }

        const contentChanged = current.content_hash !== source.contentHash;
        this.db
          .prepare(
            `UPDATE native_memory_observations SET
               content_hash = ?, byte_length = ?, modified_at = ?, state = 'available',
               source_version = ?, environment_id = ?, last_observed_at = ?,
               changed_at = ?, removed_at = NULL
             WHERE id = ?`,
          )
          .run(
            source.contentHash,
            source.byteLength,
            source.modifiedAt,
            contentChanged
              ? current.source_version + 1
              : current.source_version,
            input.environmentId,
            now,
            contentChanged ? now : current.changed_at,
            current.id,
          );
        if (contentChanged) changed += 1;
        else unchanged += 1;
      }

      let removed = 0;
      for (const current of existing) {
        if (seen.has(current.source_key) || current.state === "removed")
          continue;
        this.db
          .prepare(
            `UPDATE native_memory_observations
             SET state = 'removed', last_observed_at = ?, removed_at = ?
             WHERE id = ?`,
          )
          .run(now, now, current.id);
        removed += 1;
      }

      const totalAvailable = Number(
        (
          this.db
            .prepare(
              `SELECT COUNT(*) AS count FROM native_memory_observations
               WHERE project_id = ? AND layout = ? AND host_id = ?
                 AND repository_key = ? AND state = 'available'`,
            )
            .get(
              input.projectId,
              input.layout,
              input.hostId,
              input.repositoryKey,
            ) as { count: number }
        ).count,
      );
      return { added, changed, unchanged, removed, totalAvailable };
    })();
  }

  list(
    projectId: string,
    state: NativeMemoryObservationState,
    limit: number,
  ): NativeMemoryObservation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM native_memory_observations
         WHERE project_id = ? AND state = ?
         ORDER BY changed_at DESC, source_key ASC
         LIMIT ?`,
      )
      .all(projectId, state, limit) as ObservationRow[];
    return rows.map(fromRow);
  }

  get(id: string, projectId: string): NativeMemoryObservation | null {
    const row = this.db
      .prepare(
        `SELECT * FROM native_memory_observations
         WHERE id = ? AND project_id = ?`,
      )
      .get(id, projectId) as ObservationRow | undefined;
    return row ? fromRow(row) : null;
  }

  counts(projectId: string): { available: number; removed: number } {
    const rows = this.db
      .prepare(
        `SELECT state, COUNT(*) AS count FROM native_memory_observations
         WHERE project_id = ? GROUP BY state`,
      )
      .all(projectId) as Array<{
      state: NativeMemoryObservationState;
      count: number;
    }>;
    return {
      available: rows.find((row) => row.state === "available")?.count ?? 0,
      removed: rows.find((row) => row.state === "removed")?.count ?? 0,
    };
  }
}
