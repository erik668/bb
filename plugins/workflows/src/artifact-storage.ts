import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export interface WorkflowStorageProfile {
  journalMode: "wal";
  synchronous: 2;
  foreignKeys: 1;
  busyTimeoutMs: number;
}

const REQUIRED_BUSY_TIMEOUT_MS = 5_000;
const ARTIFACT_TABLE_PREFIXES = [
  "workflow_artifact_",
  "workflow_campaign_",
] as const;

export const LOCAL_ARTIFACT_OWNER_ACTOR_KEY = "local-owner";

export interface ArtifactOwnerScope {
  actorKey: typeof LOCAL_ARTIFACT_OWNER_ACTOR_KEY;
  campaignId: string;
  projectId: string;
  environmentId: string;
  presentationThreadId: string;
}

interface ForeignKeyViolation {
  table: string;
}

function isArtifactTable(table: string): boolean {
  return ARTIFACT_TABLE_PREFIXES.some((prefix) => table.startsWith(prefix));
}

function tableExists(db: Database.Database, table: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined
  );
}

function contentBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value);
  throw new Error("Workflow artifact blob content has an invalid storage type");
}

function assertBlobDigest(
  sha256: string,
  content: Buffer,
  byteLength: number,
): void {
  const actualSha256 = createHash("sha256").update(content).digest("hex");
  if (content.byteLength !== byteLength || actualSha256 !== sha256) {
    throw new Error(`Workflow artifact blob integrity mismatch for ${sha256}`);
  }
}

/**
 * Checks only workflow-artifact-owned state after migrations have completed.
 * Unrelated legacy violations are reported but cannot disable artifact RPC.
 */
export function verifyArtifactStorageIntegrity(db: Database.Database): void {
  const violations = db.pragma("foreign_key_check") as ForeignKeyViolation[];
  const artifactViolations = violations.filter((violation) =>
    isArtifactTable(violation.table),
  );
  const unrelatedViolationCount = violations.length - artifactViolations.length;
  if (unrelatedViolationCount > 0) {
    console.warn(
      `Workflow storage found ${unrelatedViolationCount} unrelated legacy foreign-key violation(s); artifact admission remains scoped to artifact tables`,
    );
  }
  if (artifactViolations.length > 0) {
    throw new Error(
      `Workflow artifact storage foreign_key_check found ${artifactViolations.length} violation(s)`,
    );
  }

  if (!tableExists(db, "workflow_artifact_blobs")) return;
  const blobs = db
    .prepare(
      `SELECT sha256, content, byte_length AS byteLength
       FROM workflow_artifact_blobs`,
    )
    .all() as Array<{ sha256: string; content: unknown; byteLength: number }>;
  for (const blob of blobs) {
    assertBlobDigest(blob.sha256, contentBuffer(blob.content), blob.byteLength);
  }

  if (tableExists(db, "workflow_campaign_contract_snapshot_artifacts")) {
    const mismatchedSnapshotArtifacts = db
      .prepare(
        `SELECT count(*)
         FROM workflow_campaign_contract_snapshot_artifacts AS snapshot_artifact
         JOIN workflow_artifact_revisions AS revision
           ON revision.campaign_id = snapshot_artifact.campaign_id
          AND revision.project_id = snapshot_artifact.project_id
          AND revision.environment_id = snapshot_artifact.environment_id
          AND revision.artifact_id = snapshot_artifact.artifact_id
          AND revision.revision = snapshot_artifact.artifact_revision
         WHERE revision.blob_sha256 <> snapshot_artifact.blob_sha256`,
      )
      .pluck()
      .get() as number;
    if (mismatchedSnapshotArtifacts > 0) {
      throw new Error(
        `Workflow artifact snapshot integrity found ${mismatchedSnapshotArtifacts} digest mismatch(es)`,
      );
    }
  }
}

export function storeVerifiedArtifactBlob(
  db: Database.Database,
  input: {
    contentType: "text/markdown" | "text/html" | "application/json";
    content: Buffer | Uint8Array | string;
    createdAt: number;
  },
): string {
  const content = contentBuffer(input.content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  db.prepare(
    `INSERT OR IGNORE INTO workflow_artifact_blobs
       (sha256, content_type, content, byte_length, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    sha256,
    input.contentType,
    content,
    content.byteLength,
    input.createdAt,
  );

  const stored = db
    .prepare(
      `SELECT content_type AS contentType, content, byte_length AS byteLength
       FROM workflow_artifact_blobs WHERE sha256 = ?`,
    )
    .get(sha256) as
    | { contentType: string; content: unknown; byteLength: number }
    | undefined;
  if (stored === undefined || stored.contentType !== input.contentType) {
    throw new Error(`Workflow artifact blob collision for ${sha256}`);
  }
  assertBlobDigest(sha256, contentBuffer(stored.content), stored.byteLength);
  return sha256;
}

/** Derives all mutation authority from the stored run and presentation grant. */
export function resolveLocalArtifactOwnerScope(
  db: Database.Database,
  input: { runId: string; presentationThreadId: string },
): ArtifactOwnerScope {
  const run = db
    .prepare(
      `SELECT campaign_id AS campaignId, project_id AS projectId,
         environment_id AS environmentId
       FROM workflow_runs
       WHERE id = ? AND campaign_id IS NOT NULL
         AND presentation_thread_id IS NOT NULL`,
    )
    .get(input.runId) as
    | { campaignId: string; projectId: string; environmentId: string }
    | undefined;
  if (run === undefined) {
    throw new Error("Workflow artifact origin scope is unavailable");
  }
  const grant = db
    .prepare(
      `SELECT 1 FROM workflow_artifact_presentation_grants
       WHERE campaign_id = ? AND project_id = ? AND environment_id = ?
         AND presentation_thread_id = ? AND revoked_at IS NULL`,
    )
    .get(
      run.campaignId,
      run.projectId,
      run.environmentId,
      input.presentationThreadId,
    );
  if (grant === undefined) {
    throw new Error("Workflow artifact presentation grant is unavailable");
  }
  return {
    actorKey: LOCAL_ARTIFACT_OWNER_ACTOR_KEY,
    ...run,
    presentationThreadId: input.presentationThreadId,
  };
}

function pragmaNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(
      `Workflow storage ${name} pragma returned an invalid value`,
    );
  }
  return value;
}

/**
 * Establishes the durability profile required by workflow artifact state.
 * This must run immediately after opening the plugin database and before any
 * migration or RPC registration.
 */
export function initializeWorkflowStorage(
  db: Database.Database,
): WorkflowStorageProfile {
  const journalMode = db.pragma("journal_mode = WAL", { simple: true });
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${REQUIRED_BUSY_TIMEOUT_MS}`);

  const profile = {
    journalMode,
    synchronous: pragmaNumber(
      db.pragma("synchronous", { simple: true }),
      "synchronous",
    ),
    foreignKeys: pragmaNumber(
      db.pragma("foreign_keys", { simple: true }),
      "foreign_keys",
    ),
    busyTimeoutMs: pragmaNumber(
      db.pragma("busy_timeout", { simple: true }),
      "busy_timeout",
    ),
  };

  if (profile.journalMode !== "wal") {
    throw new Error(
      `Workflow storage requires WAL journal mode; received ${String(profile.journalMode)}`,
    );
  }
  if (profile.synchronous !== 2) {
    throw new Error(
      `Workflow storage requires synchronous=FULL; received ${profile.synchronous}`,
    );
  }
  if (profile.foreignKeys !== 1) {
    throw new Error("Workflow storage requires foreign_keys=ON");
  }
  if (profile.busyTimeoutMs < REQUIRED_BUSY_TIMEOUT_MS) {
    throw new Error(
      `Workflow storage requires busy_timeout>=${REQUIRED_BUSY_TIMEOUT_MS}; received ${profile.busyTimeoutMs}`,
    );
  }

  return profile as WorkflowStorageProfile;
}

export const artifactStorageMigrations = [
  `CREATE TABLE workflow_artifact_blobs (
     sha256 TEXT PRIMARY KEY CHECK(length(sha256) = 64),
     content_type TEXT NOT NULL CHECK(content_type IN ('text/markdown', 'text/html', 'application/json')),
     content BLOB NOT NULL,
     byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
     created_at INTEGER NOT NULL,
     CHECK(length(content) = byte_length)
   );
   CREATE TABLE workflow_artifacts (
     campaign_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     environment_id TEXT NOT NULL,
     presentation_thread_id TEXT NOT NULL,
     id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK(kind IN ('requirements', 'architecture', 'decision-log')),
     title TEXT NOT NULL,
     content_type TEXT NOT NULL CHECK(content_type IN ('text/markdown', 'text/html', 'application/json')),
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (campaign_id, project_id, environment_id, presentation_thread_id, id),
     UNIQUE (campaign_id, project_id, environment_id, presentation_thread_id, kind)
   );
   CREATE TABLE workflow_artifact_revisions (
     campaign_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     environment_id TEXT NOT NULL,
     presentation_thread_id TEXT NOT NULL,
     artifact_id TEXT NOT NULL,
     revision INTEGER NOT NULL CHECK(revision >= 1),
     blob_sha256 TEXT NOT NULL REFERENCES workflow_artifact_blobs(sha256) ON DELETE RESTRICT,
     status TEXT NOT NULL CHECK(status IN ('draft', 'accepted-pending-impact', 'admitted', 'superseded')),
     source_host_id TEXT,
     source_root_path TEXT,
     source_relative_path TEXT,
     source_sha256 TEXT,
     produced_by_thread_id TEXT,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (campaign_id, project_id, environment_id, presentation_thread_id, artifact_id, revision),
     FOREIGN KEY (campaign_id, project_id, environment_id, presentation_thread_id, artifact_id)
       REFERENCES workflow_artifacts(campaign_id, project_id, environment_id, presentation_thread_id, id)
       ON DELETE RESTRICT,
     CHECK (
       (source_host_id IS NULL AND source_root_path IS NULL AND source_relative_path IS NULL AND source_sha256 IS NULL)
       OR
       (source_host_id IS NOT NULL AND source_root_path IS NOT NULL AND source_relative_path IS NOT NULL AND source_sha256 IS NOT NULL)
     )
   );
   CREATE UNIQUE INDEX workflow_artifact_one_admitted_revision_idx
     ON workflow_artifact_revisions(campaign_id, project_id, environment_id, presentation_thread_id, artifact_id)
     WHERE status = 'admitted';
   CREATE INDEX workflow_artifact_revisions_history_idx
     ON workflow_artifact_revisions(campaign_id, project_id, environment_id, presentation_thread_id, artifact_id, revision DESC);
   CREATE TABLE workflow_artifact_annotations (
     campaign_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     environment_id TEXT NOT NULL,
     presentation_thread_id TEXT NOT NULL,
     id TEXT NOT NULL,
     artifact_id TEXT NOT NULL,
     artifact_revision INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK(kind IN ('highlight', 'comment', 'suggestion')),
     anchor_json TEXT NOT NULL CHECK(json_valid(anchor_json)),
     body TEXT,
     author TEXT NOT NULL CHECK(author = 'local-owner'),
     status TEXT NOT NULL CHECK(status IN ('open', 'resolved', 'orphaned')),
     resolution TEXT CHECK(resolution IS NULL OR resolution IN ('accepted', 'declined', 'superseded')),
     steward_thread_message_id TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (campaign_id, project_id, environment_id, presentation_thread_id, id),
     FOREIGN KEY (campaign_id, project_id, environment_id, presentation_thread_id, artifact_id, artifact_revision)
       REFERENCES workflow_artifact_revisions(campaign_id, project_id, environment_id, presentation_thread_id, artifact_id, revision)
       ON DELETE RESTRICT
   );
   CREATE INDEX workflow_artifact_annotations_open_idx
     ON workflow_artifact_annotations(campaign_id, project_id, environment_id, presentation_thread_id, artifact_id, artifact_revision, status, created_at);
   CREATE TABLE workflow_artifact_working_drafts (
     campaign_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     environment_id TEXT NOT NULL,
     presentation_thread_id TEXT NOT NULL,
     artifact_id TEXT NOT NULL,
     base_revision INTEGER NOT NULL,
     content TEXT NOT NULL,
     content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
     state TEXT NOT NULL CHECK(state IN ('saving', 'saved', 'failed')),
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (campaign_id, project_id, environment_id, presentation_thread_id, artifact_id),
     FOREIGN KEY (campaign_id, project_id, environment_id, presentation_thread_id, artifact_id, base_revision)
       REFERENCES workflow_artifact_revisions(campaign_id, project_id, environment_id, presentation_thread_id, artifact_id, revision)
       ON DELETE RESTRICT
   );
   CREATE TABLE workflow_artifact_decisions (
     campaign_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     environment_id TEXT NOT NULL,
     presentation_thread_id TEXT NOT NULL,
     id TEXT NOT NULL,
     artifact_id TEXT NOT NULL,
     base_revision INTEGER NOT NULL,
     candidate_revision INTEGER,
     decision TEXT NOT NULL CHECK(decision IN ('accepted', 'declined', 'superseded')),
     actor TEXT NOT NULL CHECK(actor = 'local-owner'),
     rationale TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (campaign_id, project_id, environment_id, presentation_thread_id, id),
     FOREIGN KEY (campaign_id, project_id, environment_id, presentation_thread_id, artifact_id, base_revision)
       REFERENCES workflow_artifact_revisions(campaign_id, project_id, environment_id, presentation_thread_id, artifact_id, revision)
       ON DELETE RESTRICT,
     FOREIGN KEY (campaign_id, project_id, environment_id, presentation_thread_id, artifact_id, candidate_revision)
       REFERENCES workflow_artifact_revisions(campaign_id, project_id, environment_id, presentation_thread_id, artifact_id, revision)
       ON DELETE RESTRICT
   );
   CREATE TABLE workflow_artifact_stewards (
     campaign_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     environment_id TEXT NOT NULL,
     presentation_thread_id TEXT NOT NULL,
     role TEXT NOT NULL CHECK(role = 'artifact-steward'),
     thread_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (campaign_id, project_id, environment_id, presentation_thread_id, role),
     UNIQUE (thread_id)
   );
   CREATE TABLE workflow_artifact_mutations (
     campaign_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     environment_id TEXT NOT NULL,
     presentation_thread_id TEXT NOT NULL,
     actor TEXT NOT NULL CHECK(actor = 'local-owner'),
     operation_kind TEXT NOT NULL,
     idempotency_key TEXT NOT NULL,
     request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
     outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json)),
     committed_at INTEGER NOT NULL,
     PRIMARY KEY (campaign_id, project_id, environment_id, presentation_thread_id, actor, operation_kind, idempotency_key)
   );
   CREATE TABLE workflow_artifact_apply_intents (
     campaign_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     environment_id TEXT NOT NULL,
     presentation_thread_id TEXT NOT NULL,
     id TEXT NOT NULL,
     artifact_id TEXT NOT NULL,
     base_revision INTEGER NOT NULL,
     finalized_revision INTEGER,
     source_host_id TEXT NOT NULL,
     source_root_path TEXT NOT NULL,
     source_relative_path TEXT NOT NULL,
     source_before_sha256 TEXT NOT NULL CHECK(length(source_before_sha256) = 64),
     target_sha256 TEXT NOT NULL CHECK(length(target_sha256) = 64),
     target_blob_sha256 TEXT NOT NULL REFERENCES workflow_artifact_blobs(sha256) ON DELETE RESTRICT,
     state TEXT NOT NULL CHECK(state IN ('prepared', 'file-applied', 'finalized', 'conflict', 'awaiting-source-host', 'rejected')),
     detail TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (campaign_id, project_id, environment_id, presentation_thread_id, id),
     FOREIGN KEY (campaign_id, project_id, environment_id, presentation_thread_id, artifact_id, base_revision)
       REFERENCES workflow_artifact_revisions(campaign_id, project_id, environment_id, presentation_thread_id, artifact_id, revision)
       ON DELETE RESTRICT,
     FOREIGN KEY (campaign_id, project_id, environment_id, presentation_thread_id, artifact_id, finalized_revision)
       REFERENCES workflow_artifact_revisions(campaign_id, project_id, environment_id, presentation_thread_id, artifact_id, revision)
       ON DELETE RESTRICT
   );
   CREATE UNIQUE INDEX workflow_artifact_one_active_apply_idx
     ON workflow_artifact_apply_intents(campaign_id, project_id, environment_id, presentation_thread_id, artifact_id)
     WHERE state IN ('prepared', 'file-applied', 'awaiting-source-host');`,
] as const;

/**
 * Append-only correction for the revision-1 dark schema. This migration is
 * deliberately exported separately: data.ts appends it after every migration
 * that already followed revision 1, preserving their durable numeric IDs.
 */
export const artifactRepositoryFoundationMigration = `
  CREATE TABLE workflow_artifact_blobs_v2 (
    sha256 TEXT PRIMARY KEY CHECK(length(sha256) = 64),
    content_type TEXT NOT NULL CHECK(content_type IN ('text/markdown', 'text/html', 'application/json')),
    content BLOB NOT NULL,
    byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
    created_at INTEGER NOT NULL,
    CHECK(length(content) = byte_length)
  );
  INSERT INTO workflow_artifact_blobs_v2
    SELECT sha256, content_type, content, byte_length, created_at
    FROM workflow_artifact_blobs;

  CREATE TABLE workflow_artifact_presentation_grants (
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    presentation_thread_id TEXT NOT NULL,
    presentation_run_id TEXT,
    granted_at INTEGER NOT NULL,
    revoked_at INTEGER,
    PRIMARY KEY (campaign_id, project_id, environment_id, presentation_thread_id),
    CHECK(revoked_at IS NULL OR revoked_at >= granted_at)
  );
  INSERT INTO workflow_artifact_presentation_grants
    (campaign_id, project_id, environment_id, presentation_thread_id,
     presentation_run_id, granted_at, revoked_at)
    SELECT campaign_id, project_id, environment_id, presentation_thread_id,
      NULL, MIN(created_at), NULL
    FROM workflow_artifacts
    GROUP BY campaign_id, project_id, environment_id, presentation_thread_id;

  CREATE TABLE workflow_artifacts_v2 (
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    presentation_thread_id TEXT,
    id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('requirements', 'architecture', 'decision-log')),
    title TEXT NOT NULL,
    content_type TEXT NOT NULL CHECK(content_type IN ('text/markdown', 'text/html', 'application/json')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, project_id, environment_id, id),
    UNIQUE (campaign_id, project_id, environment_id, kind)
  );
  INSERT INTO workflow_artifacts_v2
    SELECT campaign_id, project_id, environment_id, NULL, id, kind, title,
      content_type, MIN(created_at), MAX(updated_at)
    FROM workflow_artifacts
    GROUP BY campaign_id, project_id, environment_id, id, kind, title, content_type;

  CREATE TABLE workflow_artifact_revisions_v2 (
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    presentation_thread_id TEXT,
    artifact_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    blob_sha256 TEXT NOT NULL REFERENCES workflow_artifact_blobs_v2(sha256) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK(status IN ('draft', 'accepted-pending-impact', 'admitted', 'superseded')),
    source_host_id TEXT,
    source_root_path TEXT,
    source_relative_path TEXT,
    source_sha256 TEXT,
    produced_by_thread_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, project_id, environment_id, artifact_id, revision),
    FOREIGN KEY (campaign_id, project_id, environment_id, artifact_id)
      REFERENCES workflow_artifacts_v2(campaign_id, project_id, environment_id, id)
      ON DELETE RESTRICT,
    CHECK (
      (source_host_id IS NULL AND source_root_path IS NULL AND source_relative_path IS NULL AND source_sha256 IS NULL)
      OR
      (source_host_id IS NOT NULL AND source_root_path IS NOT NULL AND source_relative_path IS NOT NULL AND source_sha256 IS NOT NULL)
    )
  );
  INSERT INTO workflow_artifact_revisions_v2
    SELECT campaign_id, project_id, environment_id, NULL, artifact_id, revision,
      blob_sha256, status, source_host_id, source_root_path,
      source_relative_path, source_sha256, produced_by_thread_id, MIN(created_at)
    FROM workflow_artifact_revisions
    GROUP BY campaign_id, project_id, environment_id, artifact_id, revision,
      blob_sha256, status, source_host_id, source_root_path,
      source_relative_path, source_sha256, produced_by_thread_id;

  CREATE TABLE workflow_artifact_annotations_v2 (
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    presentation_thread_id TEXT NOT NULL,
    id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    artifact_revision INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('highlight', 'comment', 'suggestion')),
    anchor_json TEXT NOT NULL CHECK(json_valid(anchor_json)),
    body TEXT,
    author TEXT NOT NULL CHECK(length(author) > 0),
    status TEXT NOT NULL CHECK(status IN ('open', 'resolved', 'orphaned')),
    resolution TEXT CHECK(resolution IS NULL OR resolution IN ('accepted', 'declined', 'superseded')),
    steward_thread_message_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, project_id, environment_id, id),
    FOREIGN KEY (campaign_id, project_id, environment_id, presentation_thread_id)
      REFERENCES workflow_artifact_presentation_grants(campaign_id, project_id, environment_id, presentation_thread_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (campaign_id, project_id, environment_id, artifact_id, artifact_revision)
      REFERENCES workflow_artifact_revisions_v2(campaign_id, project_id, environment_id, artifact_id, revision)
      ON DELETE RESTRICT
  );
  INSERT INTO workflow_artifact_annotations_v2
    SELECT campaign_id, project_id, environment_id, presentation_thread_id, id,
      artifact_id, artifact_revision, kind, anchor_json, body, author, status,
      resolution, steward_thread_message_id, created_at, updated_at
    FROM workflow_artifact_annotations;

  CREATE TABLE workflow_artifact_working_drafts_v2 (
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    presentation_thread_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    base_revision INTEGER NOT NULL,
    content TEXT NOT NULL,
    content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
    state TEXT NOT NULL CHECK(state IN ('saving', 'saved', 'failed')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, project_id, environment_id, presentation_thread_id, artifact_id),
    FOREIGN KEY (campaign_id, project_id, environment_id, presentation_thread_id)
      REFERENCES workflow_artifact_presentation_grants(campaign_id, project_id, environment_id, presentation_thread_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (campaign_id, project_id, environment_id, artifact_id, base_revision)
      REFERENCES workflow_artifact_revisions_v2(campaign_id, project_id, environment_id, artifact_id, revision)
      ON DELETE RESTRICT
  );
  INSERT INTO workflow_artifact_working_drafts_v2
    SELECT campaign_id, project_id, environment_id, presentation_thread_id,
      artifact_id, base_revision, content, content_sha256, state, updated_at
    FROM workflow_artifact_working_drafts;

  CREATE TABLE workflow_artifact_decisions_v2 (
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    presentation_thread_id TEXT NOT NULL,
    id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    base_revision INTEGER NOT NULL,
    candidate_revision INTEGER,
    decision TEXT NOT NULL CHECK(decision IN ('accepted', 'declined', 'superseded')),
    actor TEXT NOT NULL CHECK(length(actor) > 0),
    rationale TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, project_id, environment_id, id),
    FOREIGN KEY (campaign_id, project_id, environment_id, presentation_thread_id)
      REFERENCES workflow_artifact_presentation_grants(campaign_id, project_id, environment_id, presentation_thread_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (campaign_id, project_id, environment_id, artifact_id, base_revision)
      REFERENCES workflow_artifact_revisions_v2(campaign_id, project_id, environment_id, artifact_id, revision)
      ON DELETE RESTRICT,
    FOREIGN KEY (campaign_id, project_id, environment_id, artifact_id, candidate_revision)
      REFERENCES workflow_artifact_revisions_v2(campaign_id, project_id, environment_id, artifact_id, revision)
      ON DELETE RESTRICT
  );
  INSERT INTO workflow_artifact_decisions_v2
    SELECT campaign_id, project_id, environment_id, presentation_thread_id, id,
      artifact_id, base_revision, candidate_revision, decision, actor, rationale,
      created_at
    FROM workflow_artifact_decisions;

  CREATE TABLE workflow_artifact_stewards_v2 (
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    presentation_thread_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role = 'artifact-steward'),
    thread_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, project_id, environment_id, role),
    UNIQUE (thread_id),
    FOREIGN KEY (campaign_id, project_id, environment_id, presentation_thread_id)
      REFERENCES workflow_artifact_presentation_grants(campaign_id, project_id, environment_id, presentation_thread_id)
      ON DELETE RESTRICT
  );
  INSERT INTO workflow_artifact_stewards_v2
    SELECT campaign_id, project_id, environment_id, presentation_thread_id,
      role, thread_id, created_at
    FROM workflow_artifact_stewards;

  CREATE TABLE workflow_artifact_mutations_v2 (
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    presentation_thread_id TEXT NOT NULL,
    actor TEXT NOT NULL CHECK(length(actor) > 0),
    operation_kind TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
    outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json)),
    committed_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, project_id, environment_id, presentation_thread_id, actor, idempotency_key),
    FOREIGN KEY (campaign_id, project_id, environment_id, presentation_thread_id)
      REFERENCES workflow_artifact_presentation_grants(campaign_id, project_id, environment_id, presentation_thread_id)
      ON DELETE RESTRICT
  );
  INSERT INTO workflow_artifact_mutations_v2
    SELECT campaign_id, project_id, environment_id, presentation_thread_id,
      actor, operation_kind, idempotency_key, request_digest, outcome_json,
      committed_at
    FROM workflow_artifact_mutations;

  CREATE TABLE workflow_artifact_apply_intents_v2 (
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    presentation_thread_id TEXT NOT NULL,
    id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    base_revision INTEGER NOT NULL,
    finalized_revision INTEGER,
    source_host_id TEXT NOT NULL,
    source_root_path TEXT NOT NULL,
    source_relative_path TEXT NOT NULL,
    source_before_sha256 TEXT NOT NULL CHECK(length(source_before_sha256) = 64),
    target_sha256 TEXT NOT NULL CHECK(length(target_sha256) = 64),
    target_blob_sha256 TEXT NOT NULL REFERENCES workflow_artifact_blobs_v2(sha256) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK(state IN ('prepared', 'file-applied', 'finalized', 'conflict', 'awaiting-source-host', 'rejected')),
    detail TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, project_id, environment_id, id),
    FOREIGN KEY (campaign_id, project_id, environment_id, presentation_thread_id)
      REFERENCES workflow_artifact_presentation_grants(campaign_id, project_id, environment_id, presentation_thread_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (campaign_id, project_id, environment_id, artifact_id, base_revision)
      REFERENCES workflow_artifact_revisions_v2(campaign_id, project_id, environment_id, artifact_id, revision)
      ON DELETE RESTRICT,
    FOREIGN KEY (campaign_id, project_id, environment_id, artifact_id, finalized_revision)
      REFERENCES workflow_artifact_revisions_v2(campaign_id, project_id, environment_id, artifact_id, revision)
      ON DELETE RESTRICT
  );
  INSERT INTO workflow_artifact_apply_intents_v2
    SELECT campaign_id, project_id, environment_id, presentation_thread_id, id,
      artifact_id, base_revision, finalized_revision, source_host_id,
      source_root_path, source_relative_path, source_before_sha256, target_sha256,
      target_blob_sha256, state, detail, created_at, updated_at
    FROM workflow_artifact_apply_intents;

  DROP TABLE workflow_artifact_apply_intents;
  DROP TABLE workflow_artifact_mutations;
  DROP TABLE workflow_artifact_stewards;
  DROP TABLE workflow_artifact_decisions;
  DROP TABLE workflow_artifact_working_drafts;
  DROP TABLE workflow_artifact_annotations;
  DROP TABLE workflow_artifact_revisions;
  DROP TABLE workflow_artifacts;
  DROP TABLE workflow_artifact_blobs;
  ALTER TABLE workflow_artifact_blobs_v2 RENAME TO workflow_artifact_blobs;
  ALTER TABLE workflow_artifacts_v2 RENAME TO workflow_artifacts;
  ALTER TABLE workflow_artifact_revisions_v2 RENAME TO workflow_artifact_revisions;
  ALTER TABLE workflow_artifact_annotations_v2 RENAME TO workflow_artifact_annotations;
  ALTER TABLE workflow_artifact_working_drafts_v2 RENAME TO workflow_artifact_working_drafts;
  ALTER TABLE workflow_artifact_decisions_v2 RENAME TO workflow_artifact_decisions;
  ALTER TABLE workflow_artifact_stewards_v2 RENAME TO workflow_artifact_stewards;
  ALTER TABLE workflow_artifact_mutations_v2 RENAME TO workflow_artifact_mutations;
  ALTER TABLE workflow_artifact_apply_intents_v2 RENAME TO workflow_artifact_apply_intents;

  CREATE UNIQUE INDEX workflow_artifact_one_admitted_revision_idx
    ON workflow_artifact_revisions(campaign_id, project_id, environment_id, artifact_id)
    WHERE status = 'admitted';
  CREATE INDEX workflow_artifact_revisions_history_idx
    ON workflow_artifact_revisions(campaign_id, project_id, environment_id, artifact_id, revision DESC);
  CREATE INDEX workflow_artifact_annotations_open_idx
    ON workflow_artifact_annotations(campaign_id, project_id, environment_id, artifact_id, artifact_revision, status, created_at);
  CREATE UNIQUE INDEX workflow_artifact_one_active_apply_idx
    ON workflow_artifact_apply_intents(campaign_id, project_id, environment_id, artifact_id)
    WHERE state IN ('prepared', 'file-applied', 'awaiting-source-host');

  CREATE TABLE workflow_campaign_work_items (
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1),
    state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'completed', 'superseded')),
    reporting_run_id TEXT,
    reporting_checkpoint_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, project_id, environment_id, work_item_id)
  );
  CREATE TABLE workflow_campaign_work_edges (
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    predecessor_work_item_id TEXT NOT NULL,
    successor_work_item_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1),
    PRIMARY KEY (campaign_id, project_id, environment_id, predecessor_work_item_id, successor_work_item_id),
    FOREIGN KEY (campaign_id, project_id, environment_id, predecessor_work_item_id)
      REFERENCES workflow_campaign_work_items(campaign_id, project_id, environment_id, work_item_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (campaign_id, project_id, environment_id, successor_work_item_id)
      REFERENCES workflow_campaign_work_items(campaign_id, project_id, environment_id, work_item_id)
      ON DELETE RESTRICT,
    CHECK(predecessor_work_item_id <> successor_work_item_id)
  );
  CREATE TABLE workflow_campaign_contract_snapshots (
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest) = 64),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, project_id, environment_id, snapshot_digest)
  );
  CREATE TABLE workflow_campaign_contract_snapshot_artifacts (
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    snapshot_digest TEXT NOT NULL,
    slot TEXT NOT NULL CHECK(slot IN ('requirements', 'architecture', 'decisions')),
    artifact_id TEXT NOT NULL,
    artifact_revision INTEGER NOT NULL CHECK(artifact_revision >= 1),
    blob_sha256 TEXT NOT NULL CHECK(length(blob_sha256) = 64),
    PRIMARY KEY (campaign_id, project_id, environment_id, snapshot_digest, slot),
    FOREIGN KEY (campaign_id, project_id, environment_id, snapshot_digest)
      REFERENCES workflow_campaign_contract_snapshots(campaign_id, project_id, environment_id, snapshot_digest)
      ON DELETE RESTRICT,
    FOREIGN KEY (campaign_id, project_id, environment_id, artifact_id, artifact_revision)
      REFERENCES workflow_artifact_revisions(campaign_id, project_id, environment_id, artifact_id, revision)
      ON DELETE RESTRICT
  );
  CREATE TABLE workflow_campaign_contract_state (
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    transition_high_watermark INTEGER NOT NULL DEFAULT 0 CHECK(transition_high_watermark >= 0),
    current_snapshot_digest TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, project_id, environment_id),
    FOREIGN KEY (campaign_id, project_id, environment_id, current_snapshot_digest)
      REFERENCES workflow_campaign_contract_snapshots(campaign_id, project_id, environment_id, snapshot_digest)
      ON DELETE RESTRICT
  );
  CREATE TABLE workflow_campaign_transition_receipts (
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    change_id TEXT NOT NULL,
    transition_sequence INTEGER NOT NULL CHECK(transition_sequence >= 1),
    snapshot_digest TEXT NOT NULL,
    actor_key TEXT NOT NULL CHECK(length(actor_key) > 0),
    request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, project_id, environment_id, change_id),
    UNIQUE (campaign_id, project_id, environment_id, transition_sequence),
    FOREIGN KEY (campaign_id, project_id, environment_id, snapshot_digest)
      REFERENCES workflow_campaign_contract_snapshots(campaign_id, project_id, environment_id, snapshot_digest)
      ON DELETE RESTRICT
  );
  CREATE TABLE workflow_artifact_change_outbox (
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    change_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    transition_sequence INTEGER NOT NULL CHECK(transition_sequence >= 1),
    snapshot_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending', 'leased', 'delivered', 'blocked', 'settled')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    next_attempt_at INTEGER,
    lease_expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, project_id, environment_id, change_id, call_id, work_item_id),
    FOREIGN KEY (campaign_id, project_id, environment_id, work_item_id)
      REFERENCES workflow_campaign_work_items(campaign_id, project_id, environment_id, work_item_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (campaign_id, project_id, environment_id, snapshot_digest)
      REFERENCES workflow_campaign_contract_snapshots(campaign_id, project_id, environment_id, snapshot_digest)
      ON DELETE RESTRICT
  );
  CREATE INDEX workflow_artifact_change_outbox_claim_idx
    ON workflow_artifact_change_outbox(state, next_attempt_at, transition_sequence);
  CREATE TABLE workflow_artifact_change_receipts (
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    change_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    adopted_sequence INTEGER NOT NULL CHECK(adopted_sequence >= 1),
    snapshot_digest TEXT NOT NULL,
    actor_key TEXT NOT NULL CHECK(length(actor_key) > 0),
    outcome TEXT NOT NULL CHECK(outcome IN ('adopted', 'blocked', 'stop-required')),
    summary TEXT NOT NULL,
    blocker TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, project_id, environment_id, change_id, call_id, adopted_sequence),
    FOREIGN KEY (campaign_id, project_id, environment_id, snapshot_digest)
      REFERENCES workflow_campaign_contract_snapshots(campaign_id, project_id, environment_id, snapshot_digest)
      ON DELETE RESTRICT
  );`;

/**
 * Append-only repair for normalized aliases and delivery identity. This stays
 * separate from the already-applied foundation migration.
 */
export const artifactRepositoryFoundationRepairMigration = `
  CREATE TABLE workflow_campaign_work_item_aliases (
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    reporting_run_id TEXT NOT NULL,
    reporting_checkpoint_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, project_id, environment_id, reporting_run_id, reporting_checkpoint_id),
    UNIQUE (campaign_id, project_id, environment_id, work_item_id, reporting_run_id, reporting_checkpoint_id),
    FOREIGN KEY (campaign_id, project_id, environment_id, work_item_id)
      REFERENCES workflow_campaign_work_items(campaign_id, project_id, environment_id, work_item_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (reporting_run_id, reporting_checkpoint_id)
      REFERENCES workflow_checkpoints(run_id, checkpoint_id)
      ON DELETE RESTRICT
  );

  CREATE UNIQUE INDEX workflow_campaign_transition_receipts_identity_idx
    ON workflow_campaign_transition_receipts(
      campaign_id, project_id, environment_id, change_id,
      transition_sequence, snapshot_digest
    );

  ALTER TABLE workflow_artifact_change_outbox RENAME TO workflow_artifact_change_outbox_v1;
  CREATE TABLE workflow_artifact_change_outbox (
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    change_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    work_item_id TEXT NOT NULL,
    transition_sequence INTEGER NOT NULL CHECK(transition_sequence >= 1),
    snapshot_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending', 'leased', 'delivered', 'blocked', 'settled')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    next_attempt_at INTEGER,
    lease_expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, project_id, environment_id, change_id, call_id, work_item_id),
    FOREIGN KEY (campaign_id, project_id, environment_id, work_item_id)
      REFERENCES workflow_campaign_work_items(campaign_id, project_id, environment_id, work_item_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (campaign_id, project_id, environment_id, change_id, transition_sequence, snapshot_digest)
      REFERENCES workflow_campaign_transition_receipts(
        campaign_id, project_id, environment_id, change_id,
        transition_sequence, snapshot_digest
      ) ON DELETE RESTRICT,
    FOREIGN KEY (call_id) REFERENCES workflow_calls(id) ON DELETE RESTRICT
  );
  INSERT INTO workflow_artifact_change_outbox SELECT * FROM workflow_artifact_change_outbox_v1;
  DROP TABLE workflow_artifact_change_outbox_v1;
  CREATE INDEX workflow_artifact_change_outbox_claim_idx
    ON workflow_artifact_change_outbox(state, next_attempt_at, transition_sequence);

  ALTER TABLE workflow_artifact_change_receipts RENAME TO workflow_artifact_change_receipts_v1;
  CREATE TABLE workflow_artifact_change_receipts (
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    change_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    adopted_sequence INTEGER NOT NULL CHECK(adopted_sequence >= 1),
    snapshot_digest TEXT NOT NULL,
    actor_key TEXT NOT NULL CHECK(length(actor_key) > 0),
    outcome TEXT NOT NULL CHECK(outcome IN ('adopted', 'blocked', 'stop-required')),
    summary TEXT NOT NULL,
    blocker TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, project_id, environment_id, change_id, call_id, adopted_sequence),
    FOREIGN KEY (campaign_id, project_id, environment_id, change_id, adopted_sequence, snapshot_digest)
      REFERENCES workflow_campaign_transition_receipts(
        campaign_id, project_id, environment_id, change_id,
        transition_sequence, snapshot_digest
      ) ON DELETE RESTRICT,
    FOREIGN KEY (call_id) REFERENCES workflow_calls(id) ON DELETE RESTRICT
  );
  INSERT INTO workflow_artifact_change_receipts SELECT * FROM workflow_artifact_change_receipts_v1;
  DROP TABLE workflow_artifact_change_receipts_v1;
`;
