import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  artifactRepositoryFoundationMigration,
  artifactRepositoryFoundationRepairMigration,
  artifactStorageMigrations,
} from "./artifact-storage.js";
import { RECOVERY_MIGRATION_22_SQL } from "./artifact-recovery.js";
import type { JsonValue } from "./types.js";
import { MAX_WORKFLOW_RUNS_PER_CAMPAIGN } from "./workflow-campaign.js";
import { MAX_WORKFLOW_CHECKPOINTS_PER_RUN } from "./workflow-checkpoint.js";

// Every status transition on workflow_runs / workflow_calls lives in the
// settlement module; this module owns rows, reads, and the migration ledger,
// and re-exports the settlement verbs for existing importers. The two modules
// import each other, so neither may touch the other's bindings at top level.
export {
  attachCallThread,
  cancelRun,
  claimQueuedRun,
  queueCallProviderRetry,
  recoverInterruptedRuns,
  settleCall,
  settleRun,
  startCall,
  storeStructuredResult,
  upsertWorkflowCheckpoint,
  type StoreStructuredResultOutcome,
  type UpsertWorkflowCheckpointOutcome,
} from "./workflow-terminal-settlement.js";

export type Db = Database.Database;

/** Statuses a run or call may still transition out of. */
export const WORKFLOW_ACTIVE_STATUSES = ["queued", "running"] as const;
/** Statuses only the settlement module may write; nothing transitions out. */
export const WORKFLOW_TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const;
type WorkflowActiveStatus = (typeof WORKFLOW_ACTIVE_STATUSES)[number];
type WorkflowTerminalStatus = (typeof WORKFLOW_TERMINAL_STATUSES)[number];
type WorkflowRunStatus = WorkflowActiveStatus | WorkflowTerminalStatus;
type WorkflowCallStatus = WorkflowActiveStatus | WorkflowTerminalStatus;

export function sqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

/** `IN (...)` operands derived from the closed status sets above. */
export const ACTIVE_STATUS_SQL = sqlStringList(WORKFLOW_ACTIVE_STATUSES);
export const TERMINAL_STATUS_SQL = sqlStringList(WORKFLOW_TERMINAL_STATUSES);

export interface WorkflowRunRow {
  id: string;
  projectId: string;
  originThreadId: string;
  presentationThreadId: string;
  parentRunId: string | null;
  rootRunId: string;
  campaignId: string;
  environmentId: string;
  originProvider: string;
  originModel: string;
  originReasoningLevel: string;
  originPermissionMode: string;
  name: string;
  source: string;
  sourceHash: string;
  argsJson: string;
  settingsJson: string;
  /** Immutable definition-level rollout gate captured when the run is created. */
  workflowArtifactLiveChanges?: boolean;
  status: WorkflowRunStatus;
  resumedFromRunId: string | null;
  resultJson: string | null;
  error: string | null;
  phase: string | null;
  replaySafetyVersion: number;
  /** Legacy durable field retained for stored-row compatibility; always null. */
  replayBarrierIndex: number | null;
  notificationSent: boolean;
  notificationOutcome: "pending" | "delivered" | "abandoned";
  notificationAttemptCount: number;
  notificationNextAttemptAt: number | null;
  notificationError: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface WorkflowCampaignRunSummaryRow {
  id: string;
  campaignId: string;
  name: string;
  status: WorkflowRunRow["status"];
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface WorkflowCallRow {
  id: string;
  runId: string;
  callIndex: number;
  cacheKey: string;
  prompt: string;
  optionsJson: string;
  resolvedProvider: string;
  resolvedModel: string;
  resolvedReasoningLevel: string;
  resolvedPermissionMode: string;
  status: WorkflowCallStatus;
  childThreadId: string | null;
  promptBytes: number;
  contextMinimumTokens: number | null;
  contextProfileJson: string | null;
  observedContextUsedTokens: number | null;
  observedModelContextWindow: number | null;
  contextUsageEstimated: boolean | null;
  repairAttempts: number;
  providerRetryAttempts: number;
  resultJson: string | null;
  error: string | null;
  replayedFromCallId: string | null;
  replaySource: "same-run" | "resumed-run" | null;
  createdAt: number;
  startedAt: number | null;
  lastActivityAt: number | null;
  finishedAt: number | null;
}

export interface WorkflowCallCounts {
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export interface WorkflowCheckpointRow {
  id: string;
  runId: string;
  checkpointId: string;
  checkpointJson: string;
  phase: string | null;
  sourceCallId: string | null;
  childThreadId: string | null;
  ordinal: number;
  createdAt: number;
  updatedAt: number;
}

interface RawRunRow extends Omit<
  WorkflowRunRow,
  "notificationSent" | "workflowArtifactLiveChanges"
> {
  notificationSent: 0 | 1;
  workflowArtifactLiveChanges: 0 | 1;
}

interface RawCallRow extends Omit<WorkflowCallRow, "contextUsageEstimated"> {
  contextUsageEstimated: 0 | 1 | null;
}

export function runRow(value: unknown): WorkflowRunRow {
  const row = value as RawRunRow;
  return {
    ...row,
    notificationSent: row.notificationSent === 1,
    workflowArtifactLiveChanges: row.workflowArtifactLiveChanges === 1,
  };
}

export function optionalRun(value: unknown): WorkflowRunRow | null {
  return value === undefined ? null : runRow(value);
}

export function callRow(value: unknown): WorkflowCallRow {
  const row = value as RawCallRow;
  return {
    ...row,
    contextUsageEstimated:
      row.contextUsageEstimated === null
        ? null
        : row.contextUsageEstimated === 1,
  };
}

export function optionalCall(value: unknown): WorkflowCallRow | null {
  return value === undefined ? null : callRow(value);
}

function checkpointRow(value: unknown): WorkflowCheckpointRow {
  return value as WorkflowCheckpointRow;
}

export const RUN_SELECT = `
  SELECT id, project_id AS projectId, origin_thread_id AS originThreadId,
    COALESCE(presentation_thread_id, origin_thread_id) AS presentationThreadId,
    parent_run_id AS parentRunId, COALESCE(root_run_id, id) AS rootRunId,
    COALESCE(campaign_id, id) AS campaignId,
    environment_id AS environmentId, origin_provider AS originProvider,
    origin_model AS originModel, origin_reasoning_level AS originReasoningLevel,
    origin_permission_mode AS originPermissionMode,
    name, source, source_hash AS sourceHash, args_json AS argsJson,
    settings_json AS settingsJson,
    workflow_artifact_live_changes AS workflowArtifactLiveChanges, status,
    resumed_from_run_id AS resumedFromRunId, result_json AS resultJson, error,
    phase, replay_safety_version AS replaySafetyVersion,
    replay_barrier_index AS replayBarrierIndex,
    notification_sent AS notificationSent,
    notification_outcome AS notificationOutcome,
    notification_attempt_count AS notificationAttemptCount,
    notification_next_attempt_at AS notificationNextAttemptAt,
    notification_error AS notificationError, created_at AS createdAt,
    started_at AS startedAt, finished_at AS finishedAt
  FROM workflow_runs`;

export const CALL_SELECT = `
  SELECT id, run_id AS runId, call_index AS callIndex, cache_key AS cacheKey,
    prompt, options_json AS optionsJson,
    resolved_provider AS resolvedProvider, resolved_model AS resolvedModel,
    resolved_reasoning_level AS resolvedReasoningLevel,
    resolved_permission_mode AS resolvedPermissionMode, status,
    child_thread_id AS childThreadId, prompt_bytes AS promptBytes,
    context_minimum_tokens AS contextMinimumTokens,
    context_profile_json AS contextProfileJson,
    observed_context_used_tokens AS observedContextUsedTokens,
    observed_model_context_window AS observedModelContextWindow,
    context_usage_estimated AS contextUsageEstimated,
    repair_attempts AS repairAttempts,
    provider_retry_attempts AS providerRetryAttempts,
    result_json AS resultJson, error,
    replayed_from_call_id AS replayedFromCallId, replay_source AS replaySource,
    created_at AS createdAt, last_activity_at AS lastActivityAt,
    started_at AS startedAt, finished_at AS finishedAt
  FROM workflow_calls`;

/** Interlock states a call can hold against an admitted contract change. */
export const CONTRACT_INTERLOCK_STATES = [
  "pending",
  "adopted",
  "blocked",
  "stop-required",
] as const;

/**
 * Artifact revision lifecycle. `artifact-storage.ts` (artifact persistence
 * unit) enumerates the same set in the CHECK constraint on
 * `workflow_artifact_revisions.status`; it cannot import this binding without
 * a module cycle, so the settlement proof asserts parity against the live
 * schema. Settlement SQL derives its revision-status literals from this set.
 */
export const ARTIFACT_REVISION_STATUSES = [
  "draft",
  "accepted-pending-impact",
  "admitted",
  "superseded",
] as const;
export type ArtifactRevisionStatus =
  (typeof ARTIFACT_REVISION_STATUSES)[number];

/** Production writers that can retain old-snapshot evidence as stale. */
export const STALE_EVIDENCE_WRITERS = [
  "structured-result",
  "settle-call",
  "checkpoint",
  "recovery",
  "admission",
] as const;

/**
 * Contract snapshot binding, campaign transition ledger, per-call interlocks,
 * and stale evidence. Appended after the artifact storage statement; dormant
 * until an artifact revision is admitted for a campaign.
 */
const contractInterlockMigration = `
  ALTER TABLE workflow_calls ADD COLUMN contract_snapshot TEXT;
  CREATE TABLE IF NOT EXISTS workflow_campaign_contract_changes (
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    change_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence >= 1),
    presentation_thread_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    artifact_revision INTEGER NOT NULL CHECK(artifact_revision >= 1),
    old_snapshot TEXT,
    new_snapshot TEXT NOT NULL,
    admitted_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, project_id, environment_id, change_id),
    UNIQUE (campaign_id, project_id, environment_id, sequence)
  );
  CREATE TABLE IF NOT EXISTS workflow_call_contract_interlocks (
    change_id TEXT NOT NULL,
    call_id TEXT NOT NULL REFERENCES workflow_calls(id) ON DELETE CASCADE,
    required_sequence INTEGER NOT NULL CHECK(required_sequence >= 1),
    old_snapshot TEXT,
    new_snapshot TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN (${sqlStringList(CONTRACT_INTERLOCK_STATES)})),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (change_id, call_id)
  );
  CREATE INDEX IF NOT EXISTS workflow_call_contract_interlocks_call_idx
    ON workflow_call_contract_interlocks(call_id, state, required_sequence);
  CREATE TABLE IF NOT EXISTS workflow_call_stale_evidence (
    id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL REFERENCES workflow_calls(id) ON DELETE CASCADE,
    writer TEXT NOT NULL CHECK(writer IN (${sqlStringList(STALE_EVIDENCE_WRITERS)})),
    evidence_snapshot TEXT,
    blocking_change_id TEXT NOT NULL,
    blocking_sequence INTEGER NOT NULL,
    payload_json TEXT,
    error TEXT,
    recorded_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS workflow_call_stale_evidence_call_idx
    ON workflow_call_stale_evidence(call_id, recorded_at);`;

/** Additive rollout identity: old definitions and all existing runs stay off. */
const workflowArtifactLiveChangesMigration = `
  ALTER TABLE workflow_runs ADD COLUMN workflow_artifact_live_changes
    INTEGER NOT NULL DEFAULT 0 CHECK(workflow_artifact_live_changes IN (0, 1));`;

/** A durable pre-spawn linearization receipt; it never contains a thread ID. */
const workflowDispatchClaimMigration = `
  CREATE TABLE IF NOT EXISTS workflow_call_dispatch_claims (
    call_id TEXT PRIMARY KEY REFERENCES workflow_calls(id) ON DELETE CASCADE,
    contract_snapshot TEXT,
    claimed_at INTEGER NOT NULL
  );`;

/**
 * Idempotent backfill plus a durable mixed-version guard. Older binaries that
 * omit the canonical campaign/presentation fields fail closed after v5 rather
 * than creating an ambiguous origin scope.
 */
const workflowArtifactScopeGuardMigration = `
  UPDATE workflow_runs
    SET campaign_id = id
    WHERE campaign_id IS NULL;
  UPDATE workflow_runs
    SET presentation_thread_id = origin_thread_id
    WHERE presentation_thread_id IS NULL;
  CREATE TRIGGER workflow_runs_artifact_scope_insert_guard
    BEFORE INSERT ON workflow_runs
    WHEN (NEW.campaign_id IS NULL OR NEW.presentation_thread_id IS NULL)
      AND NEW.workflow_artifact_live_changes = 1
    BEGIN
      SELECT RAISE(ABORT, 'workflow artifact origin scope is required');
    END;
  CREATE TRIGGER workflow_runs_artifact_scope_update_guard
    BEFORE UPDATE OF campaign_id, presentation_thread_id ON workflow_runs
    WHEN (NEW.campaign_id IS NULL OR NEW.presentation_thread_id IS NULL)
      AND NEW.workflow_artifact_live_changes = 1
    BEGIN
      SELECT RAISE(ABORT, 'workflow artifact origin scope is required');
    END;`;

/** Keep the unreviewed live kernel unreachable until its owning unit admits it. */
const workflowArtifactFoundationDarkMigration = `
  UPDATE workflow_runs SET workflow_artifact_live_changes = 0
    WHERE workflow_artifact_live_changes = 1;
  CREATE TRIGGER workflow_runs_artifact_live_changes_insert_guard
    BEFORE INSERT ON workflow_runs
    WHEN NEW.workflow_artifact_live_changes = 1
    BEGIN
      SELECT RAISE(ABORT, 'workflow artifact live changes are not admitted');
    END;
  CREATE TRIGGER workflow_runs_artifact_live_changes_update_guard
    BEFORE UPDATE OF workflow_artifact_live_changes ON workflow_runs
    WHEN NEW.workflow_artifact_live_changes = 1
    BEGIN
      SELECT RAISE(ABORT, 'workflow artifact live changes are not admitted');
    END;`;

export const migrations = [
  `CREATE TABLE IF NOT EXISTS workflow_runs (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     origin_thread_id TEXT NOT NULL,
     environment_id TEXT NOT NULL,
     origin_provider TEXT NOT NULL,
     origin_model TEXT NOT NULL,
     origin_reasoning_level TEXT NOT NULL,
     origin_permission_mode TEXT NOT NULL,
     name TEXT NOT NULL,
     source TEXT NOT NULL,
     source_hash TEXT NOT NULL,
     args_json TEXT NOT NULL,
     status TEXT NOT NULL,
     resumed_from_run_id TEXT REFERENCES workflow_runs(id),
     result_json TEXT,
     error TEXT,
     phase TEXT,
     notification_sent INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     started_at INTEGER,
     finished_at INTEGER
   );
   CREATE INDEX IF NOT EXISTS workflow_runs_project_created_idx
     ON workflow_runs(project_id, created_at DESC);
   CREATE INDEX IF NOT EXISTS workflow_runs_status_created_idx
     ON workflow_runs(status, created_at);
   CREATE TABLE IF NOT EXISTS workflow_calls (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
     call_index INTEGER NOT NULL,
     cache_key TEXT NOT NULL,
     prompt TEXT NOT NULL,
     options_json TEXT NOT NULL,
     resolved_provider TEXT NOT NULL,
     resolved_model TEXT NOT NULL,
     resolved_reasoning_level TEXT NOT NULL,
     resolved_permission_mode TEXT NOT NULL,
     status TEXT NOT NULL,
     child_thread_id TEXT UNIQUE,
     repair_attempts INTEGER NOT NULL DEFAULT 0,
     result_json TEXT,
     error TEXT,
     replayed_from_call_id TEXT REFERENCES workflow_calls(id),
     replay_source TEXT,
     created_at INTEGER NOT NULL,
     started_at INTEGER,
     finished_at INTEGER,
     UNIQUE(run_id, call_index)
   );
   CREATE INDEX IF NOT EXISTS workflow_calls_run_idx
     ON workflow_calls(run_id, call_index);
   CREATE INDEX IF NOT EXISTS workflow_calls_child_idx
     ON workflow_calls(child_thread_id);`,
  `ALTER TABLE workflow_runs ADD COLUMN settings_json TEXT NOT NULL
     DEFAULT '{"maxActiveRuns":4,"maxConcurrentAgents":8,"maxAgentCalls":100,"totalRunTimeoutMs":86400000,"retentionDays":30,"maxNotificationBytes":16384}';
   ALTER TABLE workflow_calls ADD COLUMN last_activity_at INTEGER;
   CREATE INDEX IF NOT EXISTS workflow_calls_running_activity_idx
     ON workflow_calls(status, last_activity_at);
   CREATE INDEX IF NOT EXISTS workflow_runs_terminal_retention_idx
     ON workflow_runs(status, notification_sent, finished_at);`,
  `ALTER TABLE workflow_runs ADD COLUMN notification_attempt_count INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE workflow_runs ADD COLUMN notification_next_attempt_at INTEGER;
   ALTER TABLE workflow_runs ADD COLUMN notification_error TEXT;
   CREATE INDEX IF NOT EXISTS workflow_runs_notification_retry_idx
     ON workflow_runs(notification_sent, notification_next_attempt_at, finished_at);`,
  `ALTER TABLE workflow_runs ADD COLUMN notification_outcome TEXT NOT NULL DEFAULT 'pending';
   UPDATE workflow_runs SET notification_outcome = 'delivered'
     WHERE notification_sent = 1 AND notification_error IS NULL;
   UPDATE workflow_runs SET notification_outcome = 'abandoned'
     WHERE notification_sent = 1 AND notification_error IS NOT NULL;`,
  `ALTER TABLE workflow_runs ADD COLUMN replay_safety_version INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE workflow_runs ADD COLUMN replay_barrier_index INTEGER;`,
  `CREATE INDEX IF NOT EXISTS workflow_runs_origin_created_idx
     ON workflow_runs(origin_thread_id, created_at DESC);`,
  `UPDATE workflow_runs SET replay_barrier_index = NULL
     WHERE replay_safety_version = 1;`,
  `ALTER TABLE workflow_calls ADD COLUMN provider_retry_attempts INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE workflow_calls ADD COLUMN prompt_bytes INTEGER NOT NULL DEFAULT 0;
   UPDATE workflow_calls SET prompt_bytes = length(CAST(prompt AS BLOB));
   ALTER TABLE workflow_calls ADD COLUMN observed_context_used_tokens INTEGER;
   ALTER TABLE workflow_calls ADD COLUMN observed_model_context_window INTEGER;
   ALTER TABLE workflow_calls ADD COLUMN context_usage_estimated INTEGER;`,
  `ALTER TABLE workflow_calls ADD COLUMN context_minimum_tokens INTEGER;`,
  `ALTER TABLE workflow_calls ADD COLUMN context_profile_json TEXT;`,
  `CREATE TABLE IF NOT EXISTS workflow_checkpoints (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
     checkpoint_id TEXT NOT NULL,
     checkpoint_json TEXT NOT NULL,
     phase TEXT,
     source_call_id TEXT REFERENCES workflow_calls(id) ON DELETE SET NULL,
     ordinal INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE(run_id, checkpoint_id)
   );
   CREATE INDEX IF NOT EXISTS workflow_checkpoints_run_created_idx
     ON workflow_checkpoints(run_id, ordinal);`,
  `ALTER TABLE workflow_runs ADD COLUMN presentation_thread_id TEXT;
   ALTER TABLE workflow_runs ADD COLUMN parent_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL;
   ALTER TABLE workflow_runs ADD COLUMN root_run_id TEXT;
   UPDATE workflow_runs
     SET presentation_thread_id = origin_thread_id
     WHERE presentation_thread_id IS NULL;
   UPDATE workflow_runs SET root_run_id = id WHERE root_run_id IS NULL;
   CREATE INDEX IF NOT EXISTS workflow_runs_presentation_created_idx
     ON workflow_runs(presentation_thread_id, created_at DESC);
   CREATE INDEX IF NOT EXISTS workflow_runs_root_created_idx
     ON workflow_runs(root_run_id, created_at ASC);`,
  `ALTER TABLE workflow_runs ADD COLUMN campaign_id TEXT;
   UPDATE workflow_runs SET campaign_id = id WHERE campaign_id IS NULL;
   CREATE INDEX IF NOT EXISTS workflow_runs_campaign_created_idx
     ON workflow_runs(campaign_id, created_at ASC);`,
  ...artifactStorageMigrations,
  contractInterlockMigration,
  workflowArtifactLiveChangesMigration,
  workflowDispatchClaimMigration,
  artifactRepositoryFoundationMigration,
  workflowArtifactScopeGuardMigration,
  artifactRepositoryFoundationRepairMigration,
  workflowArtifactFoundationDarkMigration,
  RECOVERY_MIGRATION_22_SQL,
];

type CreateWorkflowRunInput = Omit<
  WorkflowRunRow,
  | "id"
  | "campaignId"
  | "status"
  | "resultJson"
  | "error"
  | "phase"
  | "replaySafetyVersion"
  | "replayBarrierIndex"
  | "notificationSent"
  | "notificationOutcome"
  | "notificationAttemptCount"
  | "notificationNextAttemptAt"
  | "notificationError"
  | "createdAt"
  | "startedAt"
  | "finishedAt"
  | "workflowArtifactLiveChanges"
> & { campaignId?: string; workflowArtifactLiveChanges?: boolean };

export function createRun(
  db: Db,
  input: CreateWorkflowRunInput,
): WorkflowRunRow {
  const id = `wfr_${randomUUID()}`;
  const now = Date.now();
  const rootRunId = input.rootRunId || id;
  const campaignId = input.campaignId || id;
  db.transaction(() => {
    if (input.campaignId) {
      const { count } = db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM workflow_runs
            WHERE COALESCE(campaign_id, id) = ?
              AND project_id = ?
              AND environment_id = ?
              AND COALESCE(presentation_thread_id, origin_thread_id) = ?`,
        )
        .get(
          campaignId,
          input.projectId,
          input.environmentId,
          input.presentationThreadId,
        ) as { count: number };
      if (count >= MAX_WORKFLOW_RUNS_PER_CAMPAIGN) {
        throw new Error(
          `Workflow campaign cannot exceed ${MAX_WORKFLOW_RUNS_PER_CAMPAIGN} runs`,
        );
      }
    }
    db.prepare(
      `INSERT INTO workflow_runs (
       id, project_id, origin_thread_id, presentation_thread_id,
       parent_run_id, root_run_id, campaign_id, environment_id, origin_provider,
       origin_model, origin_reasoning_level, origin_permission_mode,
       name, source, source_hash,
       args_json, settings_json, workflow_artifact_live_changes, status, resumed_from_run_id,
       replay_safety_version, created_at
     ) VALUES (
       @id, @projectId, @originThreadId, @presentationThreadId,
       @parentRunId, @rootRunId, @campaignId, @environmentId, @originProvider,
       @originModel, @originReasoningLevel, @originPermissionMode,
       @name, @source, @sourceHash,
       @argsJson, @settingsJson, @workflowArtifactLiveChanges, 'queued', @resumedFromRunId, 1, @now
     )`,
    ).run({
      id,
      now,
      ...input,
      workflowArtifactLiveChanges: input.workflowArtifactLiveChanges ? 1 : 0,
      rootRunId,
      campaignId,
    });
  })();
  return getRunRequired(db, id);
}

export function getRun(db: Db, id: string): WorkflowRunRow | null {
  return optionalRun(db.prepare(`${RUN_SELECT} WHERE id = ?`).get(id));
}

export function getRunRequired(db: Db, id: string): WorkflowRunRow {
  const row = getRun(db, id);
  if (row === null) throw new Error(`Unknown workflow run ${id}`);
  return row;
}

export function getLatestRunForOriginThread(
  db: Db,
  originThreadId: string,
): WorkflowRunRow | null {
  return optionalRun(
    db
      .prepare(
        `${RUN_SELECT} WHERE origin_thread_id = ? ORDER BY created_at DESC, workflow_runs.rowid DESC LIMIT 1`,
      )
      .get(originThreadId),
  );
}

export function getLatestRunForThread(
  db: Db,
  threadId: string,
): WorkflowRunRow | null {
  return optionalRun(
    db
      .prepare(
        `${RUN_SELECT}
         WHERE origin_thread_id = ? OR presentation_thread_id = ?
         ORDER BY created_at DESC, workflow_runs.rowid DESC LIMIT 1`,
      )
      .get(threadId, threadId),
  );
}

export function listActiveRunsForOriginThread(
  db: Db,
  originThreadId: string,
): WorkflowRunRow[] {
  return db
    .prepare(
      `${RUN_SELECT} WHERE origin_thread_id = ? AND status IN (${ACTIVE_STATUS_SQL})
       ORDER BY created_at DESC, workflow_runs.rowid DESC`,
    )
    .all(originThreadId)
    .map(runRow);
}

export function listActiveRunsForThread(
  db: Db,
  threadId: string,
): WorkflowRunRow[] {
  return db
    .prepare(
      `${RUN_SELECT}
       WHERE (origin_thread_id = ? OR presentation_thread_id = ?)
         AND status IN (${ACTIVE_STATUS_SQL})
       ORDER BY created_at DESC, workflow_runs.rowid DESC`,
    )
    .all(threadId, threadId)
    .map(runRow);
}

export function listRuns(
  db: Db,
  args: { projectId: string; limit: number },
): WorkflowRunRow[] {
  return db
    .prepare(
      `${RUN_SELECT} WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(args.projectId, args.limit)
    .map(runRow);
}

export function getFirstRunForCampaignScope(
  db: Db,
  args: { campaignId: string; projectId: string; environmentId: string },
): WorkflowRunRow | null {
  return optionalRun(
    db
      .prepare(
        `${RUN_SELECT}
           WHERE COALESCE(campaign_id, id) = ?
             AND project_id = ? AND environment_id = ?
           ORDER BY created_at ASC, workflow_runs.rowid ASC LIMIT 1`,
      )
      .get(args.campaignId, args.projectId, args.environmentId),
  );
}

export function countRunsForCampaign(db: Db, campaignId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM workflow_runs
       WHERE COALESCE(campaign_id, id) = ?`,
    )
    .get(campaignId) as { count: number };
  return row.count;
}

export function listRunsForCampaign(
  db: Db,
  args: {
    campaignId: string;
    projectId: string;
    environmentId: string;
    presentationThreadId: string;
  },
): WorkflowCampaignRunSummaryRow[] {
  return db
    .prepare(
      `SELECT
          id,
          COALESCE(campaign_id, id) AS campaignId,
          name,
          status,
          created_at AS createdAt,
          started_at AS startedAt,
          finished_at AS finishedAt
         FROM workflow_runs
         WHERE COALESCE(campaign_id, id) = ?
           AND project_id = ?
           AND environment_id = ?
           AND COALESCE(presentation_thread_id, origin_thread_id) = ?
         ORDER BY created_at ASC, workflow_runs.rowid ASC`,
    )
    .all(
      args.campaignId,
      args.projectId,
      args.environmentId,
      args.presentationThreadId,
    ) as WorkflowCampaignRunSummaryRow[];
}

export function updateRunPhase(db: Db, id: string, phase: string): void {
  db.prepare(
    `UPDATE workflow_runs SET phase = ? WHERE id = ? AND status = 'running'`,
  ).run(phase, id);
}

export function listWorkflowCheckpointsForRun(
  db: Db,
  runId: string,
): WorkflowCheckpointRow[] {
  return db
    .prepare(
      `SELECT checkpoint.id, checkpoint.run_id AS runId,
         checkpoint.checkpoint_id AS checkpointId,
         checkpoint.checkpoint_json AS checkpointJson, checkpoint.phase,
         checkpoint.source_call_id AS sourceCallId,
         call.child_thread_id AS childThreadId,
         checkpoint.ordinal,
         checkpoint.created_at AS createdAt,
         checkpoint.updated_at AS updatedAt
       FROM workflow_checkpoints AS checkpoint
       LEFT JOIN workflow_calls AS call ON call.id = checkpoint.source_call_id
       WHERE checkpoint.run_id = ?
       ORDER BY checkpoint.ordinal
       LIMIT ?`,
    )
    .all(runId, MAX_WORKFLOW_CHECKPOINTS_PER_RUN + 1)
    .map(checkpointRow);
}

export function markNotificationSent(db: Db, id: string): void {
  db.prepare(
    `UPDATE workflow_runs SET notification_sent = 1,
     notification_outcome = 'delivered', notification_next_attempt_at = NULL,
     notification_error = NULL
     WHERE id = ?`,
  ).run(id);
}

export function settleNotificationUndeliverable(
  db: Db,
  id: string,
  error: string,
): void {
  db.prepare(
    `UPDATE workflow_runs SET notification_sent = 1,
     notification_outcome = 'abandoned', notification_next_attempt_at = NULL,
     notification_error = ?
     WHERE id = ?`,
  ).run(error, id);
}

export function recordNotificationFailure(
  db: Db,
  args: { id: string; error: string; nextAttemptAt: number },
): void {
  db.prepare(
    `UPDATE workflow_runs SET
       notification_next_attempt_at = @nextAttemptAt,
       notification_error = @error
     WHERE id = @id AND notification_sent = 0`,
  ).run(args);
}

export function beginNotificationAttempt(db: Db, id: string): boolean {
  return (
    db
      .prepare(
        `UPDATE workflow_runs SET
           notification_attempt_count = notification_attempt_count + 1,
           notification_next_attempt_at = NULL
         WHERE id = ? AND notification_sent = 0`,
      )
      .run(id).changes === 1
  );
}

export function getCall(
  db: Db,
  runId: string,
  callIndex: number,
): WorkflowCallRow | null {
  return optionalCall(
    db
      .prepare(`${CALL_SELECT} WHERE run_id = ? AND call_index = ?`)
      .get(runId, callIndex),
  );
}

export function getCallByChildThread(
  db: Db,
  threadId: string,
): WorkflowCallRow | null {
  return optionalCall(
    db.prepare(`${CALL_SELECT} WHERE child_thread_id = ?`).get(threadId),
  );
}

export function listCallsForRun(db: Db, runId: string): WorkflowCallRow[] {
  return db
    .prepare(`${CALL_SELECT} WHERE run_id = ? ORDER BY call_index`)
    .all(runId)
    .map(callRow);
}

export function listCallsForRunPage(
  db: Db,
  args: { runId: string; afterCallIndex: number; limit: number },
): WorkflowCallRow[] {
  return db
    .prepare(
      `${CALL_SELECT} WHERE run_id = ? AND call_index > ?
       ORDER BY call_index LIMIT ?`,
    )
    .all(args.runId, args.afterCallIndex, args.limit)
    .map(callRow);
}

export function countCallsForRun(db: Db, runId: string): WorkflowCallCounts {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
       COALESCE(SUM(status = 'queued'), 0) AS queued,
       COALESCE(SUM(status = 'running'), 0) AS running,
       COALESCE(SUM(status = 'succeeded'), 0) AS succeeded,
       COALESCE(SUM(status = 'failed'), 0) AS failed,
       COALESCE(SUM(status = 'cancelled'), 0) AS cancelled
       FROM workflow_calls WHERE run_id = ?`,
    )
    .get(runId) as WorkflowCallCounts;
  return row;
}

export function listRunningCalls(db: Db, limit: number): WorkflowCallRow[] {
  return db
    .prepare(
      `${CALL_SELECT} WHERE status = 'running' AND child_thread_id IS NOT NULL
       ORDER BY COALESCE(last_activity_at, started_at), id LIMIT ?`,
    )
    .all(limit)
    .map(callRow);
}

export function listTimedOutRuns(
  db: Db,
  now: number,
  limit: number,
): WorkflowRunRow[] {
  return db
    .prepare(
      `${RUN_SELECT} WHERE status = 'running' AND started_at IS NOT NULL
       AND started_at + json_extract(settings_json, '$.totalRunTimeoutMs') <= ?
       ORDER BY started_at, id LIMIT ?`,
    )
    .all(now, limit)
    .map(runRow);
}

export function recordCallContextUsage(
  db: Db,
  callId: string,
  usage: {
    usedTokens: number | null;
    modelContextWindow: number | null;
    estimated: boolean;
  },
): void {
  if (usage.usedTokens === null && usage.modelContextWindow === null) return;
  db.transaction(() => {
    const current = db
      .prepare(
        `SELECT observed_context_used_tokens AS usedTokens,
                context_usage_estimated AS estimated
         FROM workflow_calls WHERE id = ?`,
      )
      .get(callId) as
      | { usedTokens: number | null; estimated: 0 | 1 | null }
      | undefined;
    if (current === undefined) return;
    const currentTokens = current.usedTokens ?? -1;
    const nextTokens = usage.usedTokens ?? -1;
    if (nextTokens < currentTokens) return;
    if (
      nextTokens === currentTokens &&
      current.estimated === 0 &&
      usage.estimated
    ) {
      return;
    }
    db.prepare(
      `UPDATE workflow_calls SET
         observed_context_used_tokens = @usedTokens,
         observed_model_context_window = @modelContextWindow,
         context_usage_estimated = @estimated,
         last_activity_at = @now
       WHERE id = @callId`,
    ).run({
      callId,
      usedTokens: usage.usedTokens,
      modelContextWindow: usage.modelContextWindow,
      estimated: usage.estimated ? 1 : 0,
      now: Date.now(),
    });
  })();
}

export function markCallReplayedSameRun(db: Db, callId: string): void {
  db.prepare(
    `UPDATE workflow_calls SET replay_source = 'same-run'
     WHERE id = ? AND status = 'succeeded' AND result_json IS NOT NULL`,
  ).run(callId);
}

export function incrementRepairAttempts(db: Db, callId: string): number | null {
  const changed = db
    .prepare(
      `UPDATE workflow_calls SET repair_attempts = repair_attempts + 1,
       last_activity_at = ?
       WHERE id = ? AND status = 'running' AND result_json IS NULL`,
    )
    .run(Date.now(), callId).changes;
  if (changed === 0) return null;
  const row = optionalCall(
    db.prepare(`${CALL_SELECT} WHERE id = ?`).get(callId),
  );
  if (row === null) throw new Error(`Unknown workflow call ${callId}`);
  return row.repairAttempts;
}

export function activeChildThreadsForRun(db: Db, runId: string): string[] {
  return (
    db
      .prepare(
        `SELECT child_thread_id AS childThreadId FROM workflow_calls
         WHERE run_id = ? AND status IN (${ACTIVE_STATUS_SQL})
           AND child_thread_id IS NOT NULL`,
      )
      .all(runId) as Array<{ childThreadId: string }>
  ).map((row) => row.childThreadId);
}

export function listPendingNotificationRuns(
  db: Db,
  now = Date.now(),
  limit = 100,
): WorkflowRunRow[] {
  return db
    .prepare(
      `${RUN_SELECT} WHERE notification_sent = 0
       AND status IN (${TERMINAL_STATUS_SQL})
       AND (notification_next_attempt_at IS NULL OR notification_next_attempt_at <= ?)
       ORDER BY finished_at, id LIMIT ?`,
    )
    .all(now, limit)
    .map(runRow);
}

export function deleteExpiredTerminalRuns(
  db: Db,
  now: number,
  limit: number,
): number {
  return db
    .prepare(
      `WITH RECURSIVE retained(id, resumed_from_run_id) AS (
         SELECT id, resumed_from_run_id FROM workflow_runs
         WHERE status IN (${ACTIVE_STATUS_SQL})
           OR finished_at + json_extract(settings_json, '$.retentionDays') * 86400000 > ?
         UNION
         SELECT parent.id, parent.resumed_from_run_id
         FROM workflow_runs parent
         JOIN retained child ON child.resumed_from_run_id = parent.id
       ), expired_candidates(id, resumed_from_run_id) AS (
         SELECT id, resumed_from_run_id FROM workflow_runs
         WHERE status IN (${TERMINAL_STATUS_SQL})
           AND notification_sent = 1
           AND finished_at + json_extract(settings_json, '$.retentionDays') * 86400000 <= ?
           AND id NOT IN (SELECT id FROM retained)
       ), leaf_depth(id, resumed_from_run_id, depth) AS (
         SELECT candidate.id, candidate.resumed_from_run_id, 0
         FROM expired_candidates candidate
         WHERE NOT EXISTS (
           SELECT 1 FROM expired_candidates child
           WHERE child.resumed_from_run_id = candidate.id
         )
         UNION ALL
         SELECT parent.id, parent.resumed_from_run_id, child.depth + 1
         FROM expired_candidates parent
         JOIN leaf_depth child ON child.resumed_from_run_id = parent.id
       ), expired(id) AS (
         SELECT id FROM leaf_depth
         GROUP BY id
         ORDER BY MAX(depth), id
         LIMIT ?
       )
       DELETE FROM workflow_runs WHERE id IN (SELECT id FROM expired)`,
    )
    .run(now, now, limit).changes;
}
