import { randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { MemoryKind, MemoryScope, ReadScope } from "./server.js";

export const CANDIDATE_STATUSES = ["pending", "approved", "rejected"] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];
export type CandidateDecision = "approve" | "reject";
export const SETTINGS_OWNER_ACTOR = "memory-settings-owner" as const;

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

export interface CandidateChallenge {
  id: string;
  summary: string;
  evidence: string[];
  sourceThreadId: string | null;
  createdAt: number;
}

export interface CandidateDecisionReceipt {
  candidateId: string;
  decision: CandidateDecision;
  candidateVersion: number;
  actor: typeof SETTINGS_OWNER_ACTOR;
  reason: string;
  promotedMemoryId: string | null;
  decidedAt: number;
}

export interface MemoryCandidate {
  id: string;
  status: CandidateStatus;
  scope: MemoryScope;
  projectId: string | null;
  name: string;
  summary: string;
  details: string;
  kind: MemoryKind;
  tags: string[];
  importance: number;
  pinned: boolean;
  evidence: string[];
  challenges: CandidateChallenge[];
  proposedByThreadId: string | null;
  proposalReason: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  decisionReceipt: CandidateDecisionReceipt | null;
}

export interface MemoryCandidateCreate {
  scope: MemoryScope;
  projectId: string | null;
  name: string;
  summary: string;
  details: string;
  kind: MemoryKind;
  tags: string[];
  importance: number;
  pinned: boolean;
  evidence: string[];
  proposedByThreadId: string | null;
  proposalReason: string;
}

interface CandidateStoreDependencies<TMemory extends { id: string }> {
  validateName(value: string): string;
  validateText(label: string, value: string, maxChars: number): string;
  validateTags(values: string[]): string[];
  normalizeMemoryKind(value: unknown): MemoryKind;
  scopeKey(scope: MemoryScope, projectId: string | null): string;
  scopeSql(
    scope: ReadScope,
    projectId: string | undefined,
    columnPrefix: string,
  ): { sql: string; params: string[] };
  buildMemory(candidate: MemoryCandidate, decisionReason: string): TMemory;
  insertMemory(memory: TMemory): void;
  isUniqueConstraintError(error: unknown): boolean;
}

export class CandidateStoreError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function parseCandidateStatus(value: unknown): CandidateStatus {
  return CANDIDATE_STATUSES.some((status) => status === value)
    ? (value as CandidateStatus)
    : "pending";
}

function parseChallengeRow(row: unknown): CandidateChallenge {
  if (!isRecord(row)) {
    throw new Error(
      "memory candidate challenge database returned an invalid row",
    );
  }
  return {
    id: String(row.id),
    summary: String(row.summary),
    evidence: parseStringArray(row.evidence_json),
    sourceThreadId:
      typeof row.source_thread_id === "string" ? row.source_thread_id : null,
    createdAt: Number(row.created_at),
  };
}

function parseDecisionReceiptRow(
  row: unknown,
): CandidateDecisionReceipt | null {
  if (!isRecord(row) || typeof row.decision !== "string") return null;
  return {
    candidateId: String(row.candidate_id),
    decision: row.decision === "approve" ? "approve" : "reject",
    candidateVersion: Number(row.candidate_version),
    actor: SETTINGS_OWNER_ACTOR,
    reason: String(row.reason),
    promotedMemoryId:
      typeof row.promoted_memory_id === "string"
        ? row.promoted_memory_id
        : null,
    decidedAt: Number(row.created_at),
  };
}

function parseCandidateRow(
  row: unknown,
  challenges: CandidateChallenge[],
  decisionReceipt: CandidateDecisionReceipt | null,
  kind: MemoryKind,
): MemoryCandidate {
  if (!isRecord(row)) {
    throw new Error("memory candidate database returned an invalid row");
  }
  return {
    id: String(row.id),
    status: parseCandidateStatus(row.status),
    scope: row.scope === "project" ? "project" : "global",
    projectId: typeof row.project_id === "string" ? row.project_id : null,
    name: String(row.name),
    summary: String(row.summary),
    details: String(row.details),
    kind,
    tags: parseStringArray(row.tags_json),
    importance: Number(row.importance),
    pinned: Number(row.pinned) === 1,
    evidence: parseStringArray(row.evidence_json),
    challenges,
    proposedByThreadId:
      typeof row.proposed_by_thread_id === "string"
        ? row.proposed_by_thread_id
        : null,
    proposalReason: String(row.proposal_reason),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    decisionReceipt,
  };
}

function createId(prefix: "mcan" | "mchal"): string {
  return `${prefix}_${randomBytes(8).toString("base64url").toLowerCase()}`;
}

export class CandidateStore<TMemory extends { id: string }> {
  constructor(
    private readonly db: PluginDatabase,
    private readonly dependencies: CandidateStoreDependencies<TMemory>,
  ) {}

  propose(input: MemoryCandidateCreate): MemoryCandidate {
    const now = Date.now();
    const candidate: MemoryCandidate = {
      id: createId("mcan"),
      status: "pending",
      scope: input.scope,
      projectId: input.projectId,
      name: this.dependencies.validateName(input.name),
      summary: this.dependencies.validateText("summary", input.summary, 400),
      details: this.dependencies.validateText("details", input.details, 16_000),
      kind: input.kind,
      tags: this.dependencies.validateTags(input.tags),
      importance: input.importance,
      pinned: input.pinned,
      evidence: this.validateEvidence(input.evidence),
      challenges: [],
      proposedByThreadId: input.proposedByThreadId,
      proposalReason: this.dependencies.validateText(
        "reason",
        input.proposalReason,
        500,
      ),
      version: 1,
      createdAt: now,
      updatedAt: now,
      decisionReceipt: null,
    };
    try {
      this.db
        .prepare(
          `INSERT INTO memory_candidates (
             id, status, scope, scope_key, project_id, name, summary, details,
             kind, tags_json, importance, pinned, evidence_json,
             proposed_by_thread_id, proposal_reason, version, created_at,
             updated_at
           ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          candidate.id,
          candidate.scope,
          this.dependencies.scopeKey(candidate.scope, candidate.projectId),
          candidate.projectId,
          candidate.name,
          candidate.summary,
          candidate.details,
          candidate.kind,
          JSON.stringify(candidate.tags),
          candidate.importance,
          candidate.pinned ? 1 : 0,
          JSON.stringify(candidate.evidence),
          candidate.proposedByThreadId,
          candidate.proposalReason,
          candidate.createdAt,
          candidate.updatedAt,
        );
    } catch (error) {
      if (this.dependencies.isUniqueConstraintError(error)) {
        throw new CandidateStoreError(
          `a pending ${candidate.scope} candidate named "${candidate.name}" already exists`,
        );
      }
      throw error;
    }
    return candidate;
  }

  challenge(
    id: string,
    summary: string,
    evidence: string[],
    sourceThreadId: string | null,
    projectId: string | undefined,
  ): MemoryCandidate {
    const current = this.get(id, projectId);
    if (!current) {
      throw new CandidateStoreError(`memory candidate "${id}" was not found`);
    }
    if (current.status !== "pending") {
      throw new CandidateStoreError(
        `memory candidate "${id}" is already ${current.status}`,
      );
    }
    const challenge: CandidateChallenge = {
      id: createId("mchal"),
      summary: this.dependencies.validateText(
        "challenge summary",
        summary,
        2_000,
      ),
      evidence: this.validateEvidence(evidence, "challenge evidence"),
      sourceThreadId,
      createdAt: Date.now(),
    };
    this.db.transaction(() => {
      const updated = this.db
        .prepare(
          `UPDATE memory_candidates
           SET version = version + 1, updated_at = ?
           WHERE id = ? AND status = 'pending' AND version = ?`,
        )
        .run(challenge.createdAt, id, current.version);
      if (updated.changes !== 1) {
        throw new CandidateStoreError(
          `memory candidate ${id} changed concurrently; retry`,
        );
      }
      this.db
        .prepare(
          `INSERT INTO memory_candidate_challenges (
             id, candidate_id, summary, evidence_json, source_thread_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          challenge.id,
          id,
          challenge.summary,
          JSON.stringify(challenge.evidence),
          challenge.sourceThreadId,
          challenge.createdAt,
        );
    })();
    return this.requireAdmin(id);
  }

  listAdmin(status: CandidateStatus = "pending"): MemoryCandidate[] {
    const rows: unknown[] = this.db
      .prepare(
        `SELECT * FROM memory_candidates
         WHERE status = ?
         ORDER BY updated_at DESC, name ASC`,
      )
      .all(status);
    return rows.map((row) => this.hydrate(row));
  }

  list(
    scope: ReadScope,
    projectId: string | undefined,
    status: CandidateStatus,
    limit: number,
  ): MemoryCandidate[] {
    const scoped = this.dependencies.scopeSql(scope, projectId, "c.");
    const rows: unknown[] = this.db
      .prepare(
        `SELECT c.* FROM memory_candidates c
         WHERE c.status = ? AND ${scoped.sql}
         ORDER BY c.updated_at DESC, c.name ASC
         LIMIT ?`,
      )
      .all(status, ...scoped.params, limit);
    return rows.map((row) => this.hydrate(row));
  }

  get(id: string, projectId: string | undefined): MemoryCandidate | null {
    const scoped = this.dependencies.scopeSql("all", projectId, "c.");
    const row: unknown = this.db
      .prepare(
        `SELECT c.* FROM memory_candidates c
         WHERE c.id = ? AND ${scoped.sql}
         LIMIT 1`,
      )
      .get(id, ...scoped.params);
    return row === undefined ? null : this.hydrate(row);
  }

  decide(
    id: string,
    expectedVersion: number,
    decision: CandidateDecision,
    reason: string,
  ):
    | {
        candidate: MemoryCandidate;
        receipt: CandidateDecisionReceipt;
        memory: TMemory;
      }
    | {
        candidate: MemoryCandidate;
        receipt: CandidateDecisionReceipt;
        memory: null;
      } {
    const current = this.requireAdmin(id);
    if (current.status !== "pending") {
      throw new CandidateStoreError(
        `memory candidate "${id}" is already ${current.status}`,
      );
    }
    if (current.version !== expectedVersion) {
      throw new CandidateStoreError(
        `version conflict for ${id}: expected ${expectedVersion}, current ${current.version}`,
      );
    }
    const decidedAt = Date.now();
    const decisionReason = this.dependencies.validateText(
      "decision reason",
      reason,
      400,
    );
    const memory =
      decision === "approve"
        ? this.dependencies.buildMemory(current, decisionReason)
        : null;
    const receipt: CandidateDecisionReceipt = {
      candidateId: id,
      decision,
      candidateVersion: expectedVersion,
      actor: SETTINGS_OWNER_ACTOR,
      reason: decisionReason,
      promotedMemoryId: memory?.id ?? null,
      decidedAt,
    };
    try {
      this.db.transaction(() => {
        if (memory) this.dependencies.insertMemory(memory);
        const updated = this.db
          .prepare(
            `UPDATE memory_candidates
             SET status = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND status = 'pending' AND version = ?`,
          )
          .run(
            decision === "approve" ? "approved" : "rejected",
            decidedAt,
            id,
            expectedVersion,
          );
        if (updated.changes !== 1) {
          throw new CandidateStoreError(
            `memory candidate ${id} changed concurrently; retry`,
          );
        }
        this.db
          .prepare(
            `INSERT INTO memory_candidate_decisions (
               candidate_id, decision, candidate_version, actor, reason,
               promoted_memory_id, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            decision,
            expectedVersion,
            SETTINGS_OWNER_ACTOR,
            decisionReason,
            memory?.id ?? null,
            decidedAt,
          );
      })();
    } catch (error) {
      if (
        decision === "approve" &&
        this.dependencies.isUniqueConstraintError(error)
      ) {
        throw new CandidateStoreError(
          `an active ${current.scope} memory named "${current.name}" already exists; review or edit it in Memory settings`,
        );
      }
      throw error;
    }
    const candidate = this.requireAdmin(id);
    return memory
      ? { candidate, receipt, memory }
      : { candidate, receipt, memory: null };
  }

  private validateEvidence(values: string[], label = "evidence"): string[] {
    const evidence = [...new Set(values.map((value) => value.trim()))];
    if (evidence.length === 0) {
      throw new CandidateStoreError(`${label} requires at least one item`);
    }
    if (evidence.length > 20) {
      throw new CandidateStoreError(`${label} allows at most 20 items`);
    }
    return evidence.map((value) =>
      this.dependencies.validateText(label, value, 2_000),
    );
  }

  private hydrate(row: unknown): MemoryCandidate {
    if (!isRecord(row)) {
      throw new Error("memory candidate database returned an invalid row");
    }
    const id = String(row.id);
    const challenges: unknown[] = this.db
      .prepare(
        `SELECT * FROM memory_candidate_challenges
         WHERE candidate_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(id);
    const decisionRow: unknown = this.db
      .prepare(
        `SELECT * FROM memory_candidate_decisions
         WHERE candidate_id = ?
         LIMIT 1`,
      )
      .get(id);
    return parseCandidateRow(
      row,
      challenges.map(parseChallengeRow),
      parseDecisionReceiptRow(decisionRow),
      this.dependencies.normalizeMemoryKind(row.kind),
    );
  }

  private requireAdmin(id: string): MemoryCandidate {
    const row: unknown = this.db
      .prepare("SELECT * FROM memory_candidates WHERE id = ?")
      .get(id);
    if (row === undefined) {
      throw new CandidateStoreError(`memory candidate "${id}" was not found`);
    }
    return this.hydrate(row);
  }
}
