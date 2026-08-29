import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { artifactMigrations } from "./artifact-storage.js";
import type { ResolvedWorkflowExecutionSelection } from "./cache.js";
import type { JsonValue, WorkflowAgentOptions } from "./types.js";
import {
  MAX_WORKFLOW_CHECKPOINT_BYTES_PER_RUN,
  MAX_WORKFLOW_CHECKPOINTS_PER_RUN,
  type WorkflowCheckpoint,
  readStoredAcceptance,
  readStoredCheckpoint,
} from "./workflow-checkpoint.js";
import {
  type AcceptanceApproval,
  MAX_WORKFLOW_COVERAGE_CHECKPOINTS,
  deriveOpenGates,
  type WorkflowApprovalSurface,
  acceptanceApprovalSchema,
  deriveAcceptanceCoverage,
} from "./workflow-coverage.js";
import { MAX_WORKFLOW_RUNS_PER_CAMPAIGN } from "./workflow-campaign.js";

export type Db = Database.Database;
type WorkflowRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";
type WorkflowCallStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

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
  status: WorkflowRunStatus;
  resumedFromRunId: string | null;
  resultJson: string | null;
  error: string | null;
  phase: string | null;
  replaySafetyVersion: number;
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

/**
 * Every refusal is a bare tag except the gate one, which carries the criterion
 * IDs that blocked it. The reader is an agent deciding what to do next, and
 * "some criterion you require is open" costs it another round trip to find out
 * which — the opposite of the cheap steering this ledger exists to provide.
 */
export type UpsertWorkflowCheckpointOutcome =
  | "accepted"
  | "inactive"
  | "limit_exceeded"
  | "ownership_conflict"
  | "kind_conflict"
  | "acceptance_conflict"
  | { kind: "gate_conflict"; openCriterionIds: string[] }
  | {
      kind: "gate_weakened";
      gateId: string;
      droppedCriterionIds: string[];
    };

type StoreStructuredResultOutcome =
  | "accepted"
  | "idempotent"
  | "conflict"
  | "inactive";

interface RawRunRow extends Omit<WorkflowRunRow, "notificationSent"> {
  notificationSent: 0 | 1;
}

interface RawCallRow extends Omit<WorkflowCallRow, "contextUsageEstimated"> {
  contextUsageEstimated: 0 | 1 | null;
}

function runRow(value: unknown): WorkflowRunRow {
  const row = value as RawRunRow;
  return { ...row, notificationSent: row.notificationSent === 1 };
}

function optionalRun(value: unknown): WorkflowRunRow | null {
  return value === undefined ? null : runRow(value);
}

function callRow(value: unknown): WorkflowCallRow {
  const row = value as RawCallRow;
  return {
    ...row,
    contextUsageEstimated:
      row.contextUsageEstimated === null
        ? null
        : row.contextUsageEstimated === 1,
  };
}

function optionalCall(value: unknown): WorkflowCallRow | null {
  return value === undefined ? null : callRow(value);
}

function checkpointRow(value: unknown): WorkflowCheckpointRow {
  return value as WorkflowCheckpointRow;
}

const RUN_SELECT = `
  SELECT id, project_id AS projectId, origin_thread_id AS originThreadId,
    COALESCE(presentation_thread_id, origin_thread_id) AS presentationThreadId,
    parent_run_id AS parentRunId, COALESCE(root_run_id, id) AS rootRunId,
    COALESCE(campaign_id, id) AS campaignId,
    environment_id AS environmentId, origin_provider AS originProvider,
    origin_model AS originModel, origin_reasoning_level AS originReasoningLevel,
    origin_permission_mode AS originPermissionMode,
    name, source, source_hash AS sourceHash, args_json AS argsJson,
    settings_json AS settingsJson, status,
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

const CALL_SELECT = `
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

const acceptanceApprovalMigration = `CREATE TABLE IF NOT EXISTS workflow_acceptance_approvals (
     id TEXT PRIMARY KEY,
     campaign_id TEXT NOT NULL,
     acceptance_checkpoint_id TEXT NOT NULL,
     contract_canonical TEXT NOT NULL,
     approved_by_thread_id TEXT NOT NULL,
     surface TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE(campaign_id, acceptance_checkpoint_id, contract_canonical)
   );`;

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
  // Approvals live outside the checkpoint ledger on purpose: the ledger is
  // what a workflow writes about itself, and an approval is the one fact about
  // a campaign that its own tool path must not be able to produce. The
  // canonical body is stored rather than a hash so this module stays free of
  // `node:crypto`, which the browser bundle would have to carry.
  acceptanceApprovalMigration,
  ...artifactMigrations,
  // The direct-build playground used IDs 14..16 for artifact schema before
  // acceptance approvals landed at ID 14 on the personal fork. Repeating this
  // idempotent table creation at the append-only tip upgrades both ledgers
  // without replaying ALTER TABLE statements or rewriting recorded IDs.
  acceptanceApprovalMigration,
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
> & { campaignId?: string };

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
       args_json, settings_json, status, resumed_from_run_id,
       replay_safety_version, created_at
     ) VALUES (
       @id, @projectId, @originThreadId, @presentationThreadId,
       @parentRunId, @rootRunId, @campaignId, @environmentId, @originProvider,
       @originModel, @originReasoningLevel, @originPermissionMode,
       @name, @source, @sourceHash,
       @argsJson, @settingsJson, 'queued', @resumedFromRunId, 1, @now
     )`,
    ).run({ id, now, ...input, rootRunId, campaignId });
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
      `${RUN_SELECT} WHERE origin_thread_id = ? AND status IN ('queued', 'running')
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
         AND status IN ('queued', 'running')
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

/**
 * Coverage spans a campaign's whole history, so it deliberately does NOT reuse
 * the campaign inspection path: that one hydrates only
 * MAX_WORKFLOW_CAMPAIGN_DETAILED_RUNS ledgers, which would drop the acceptance
 * contract itself as soon as a campaign outgrew four runs. Only the four kinds
 * coverage reads are selected, and the row cap is reported to the caller rather
 * than silently truncating a partial ledger into a confident answer.
 *
 * The kind filter is guarded by `json_valid` because this read spans every run
 * in the campaign, including ones bounded hydration never touches. A single
 * corrupt row there must not take the campaign view down with it, and bare
 * `json_extract` raises on malformed JSON rather than returning NULL.
 */
export function listCampaignCoverageCheckpoints(
  db: Db,
  args: {
    campaignId: string;
    projectId: string;
    environmentId: string;
    presentationThreadId: string;
    limit: number;
  },
): { checkpointJson: string }[] {
  return db
    .prepare(
      `SELECT checkpoint.checkpoint_json AS checkpointJson
         FROM workflow_checkpoints AS checkpoint
         JOIN workflow_runs AS run ON run.id = checkpoint.run_id
         WHERE COALESCE(run.campaign_id, run.id) = ?
           AND run.project_id = ?
           AND run.environment_id = ?
           AND COALESCE(run.presentation_thread_id, run.origin_thread_id) = ?
           AND CASE WHEN json_valid(checkpoint.checkpoint_json)
                    THEN json_extract(checkpoint.checkpoint_json, '$.kind')
               END IN ('acceptance', 'plan', 'work-item', 'verification')
         ORDER BY run.created_at ASC, run.rowid ASC, checkpoint.ordinal ASC
         LIMIT ?`,
    )
    .all(
      args.campaignId,
      args.projectId,
      args.environmentId,
      args.presentationThreadId,
      args.limit,
    ) as { checkpointJson: string }[];
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

export function claimQueuedRun(
  db: Db,
  maxActiveRuns: number,
): WorkflowRunRow | null {
  return db.transaction(() => {
    const active = db
      .prepare(
        `SELECT COUNT(*) AS count FROM workflow_runs WHERE status = 'running'`,
      )
      .get() as { count: number };
    if (active.count >= maxActiveRuns) return null;
    const row = optionalRun(
      db
        .prepare(
          `${RUN_SELECT} WHERE status = 'queued' ORDER BY created_at LIMIT 1`,
        )
        .get(),
    );
    if (row === null) return null;
    const changed = db
      .prepare(
        `UPDATE workflow_runs SET status = 'running', started_at = COALESCE(started_at, ?)
         WHERE id = ? AND status = 'queued'`,
      )
      .run(Date.now(), row.id).changes;
    return changed === 1 ? getRunRequired(db, row.id) : null;
  })();
}

function interruptWorkflowCheckpoints(
  db: Db,
  args: { runId?: string; sourceCallId?: string; now: number },
): void {
  const selector =
    args.runId === undefined
      ? "source_call_id = @sourceCallId"
      : "run_id = @runId";
  db.prepare(
    `UPDATE workflow_checkpoints
     SET checkpoint_json = json_set(
       checkpoint_json, '$.status', 'interrupted'
     ), updated_at = @now
     WHERE ${selector}
       AND json_extract(checkpoint_json, '$.status') IN ('pending', 'running')`,
  ).run(args);
}

export function settleRun(
  db: Db,
  args: {
    id: string;
    status: Extract<WorkflowRunStatus, "succeeded" | "failed" | "cancelled">;
    result: JsonValue | null;
    error: string | null;
  },
): WorkflowCallRow[] {
  return db.transaction(() => {
    const outstanding = db
      .prepare(
        `${CALL_SELECT} WHERE run_id = ? AND status IN ('queued', 'running')`,
      )
      .all(args.id)
      .map(callRow);
    const now = Date.now();
    const changed = db
      .prepare(
        `UPDATE workflow_runs SET status = @status, result_json = @resultJson,
         error = @error, finished_at = @now
         WHERE id = @id AND status IN ('queued', 'running')`,
      )
      .run({
        id: args.id,
        status: args.status,
        resultJson:
          args.status === "succeeded" ? JSON.stringify(args.result) : null,
        error: args.error,
        now,
      }).changes;
    if (changed === 0) return [];
    db.prepare(
      `UPDATE workflow_calls SET status = 'cancelled',
       error = 'Parent workflow finished before this call', finished_at = ?
       WHERE run_id = ? AND status IN ('queued', 'running')`,
    ).run(now, args.id);
    interruptWorkflowCheckpoints(db, { runId: args.id, now });
    return outstanding;
  })();
}

export function updateRunPhase(db: Db, id: string, phase: string): void {
  db.prepare(
    `UPDATE workflow_runs SET phase = ? WHERE id = ? AND status = 'running'`,
  ).run(phase, id);
}

/**
 * Decides whether a write would change the campaign's acceptance contract.
 *
 * Acceptance is the one checkpoint kind the campaign is measured against, so an
 * orchestrator that can rewrite it can always agree with itself. Two vectors
 * have to be closed and only one of them is loud:
 *
 * - Republishing under the same ID UPDATEs the row in place and destroys the
 *   original, leaving the derivation nothing to compare and nothing to report.
 *   That is refused unconditionally — an amendment cannot overwrite the thing it
 *   supersedes.
 * - Publishing a different contract under a new ID keeps the original readable,
 *   so it is accepted only when it names what it supersedes.
 *
 * Campaign-scoped rather than run-scoped, because acceptance belongs to the
 * campaign: a child run publishing its own contract is the same rewrite one
 * level out. Only acceptance writes pay for this query, and both legs of the
 * join are indexed (`workflow_runs(campaign_id, ...)`,
 * `workflow_checkpoints(run_id, ordinal)`).
 *
 * This makes a rewritten contract evident, not impossible. Nothing here can
 * stop a writer that edits the database directly, which is why the derivation
 * re-checks the amendment chain on read instead of trusting the newest row.
 */
function conflictsWithCampaignAcceptance(
  db: Db,
  args: {
    runId: string;
    checkpointId: string;
    incoming: { canonical: string; supersedes: string | null };
  },
): boolean {
  const rows = db
    .prepare(
      `SELECT checkpoint.checkpoint_id AS checkpointId,
         checkpoint.checkpoint_json AS checkpointJson
       FROM workflow_checkpoints AS checkpoint
       JOIN workflow_runs AS run ON run.id = checkpoint.run_id
       WHERE COALESCE(run.campaign_id, run.id) = (
           SELECT COALESCE(campaign_id, id) FROM workflow_runs WHERE id = ?
         )
         AND CASE WHEN json_valid(checkpoint.checkpoint_json)
                  THEN json_extract(checkpoint.checkpoint_json, '$.kind')
             END = 'acceptance'`,
    )
    .all(args.runId) as {
    checkpointId: string;
    checkpointJson: string;
  }[];

  // A row whose body cannot be read cannot be compared, so it is excluded from
  // the equality check while still counting as a valid supersede target.
  const existing = rows.map((row) => ({
    checkpointId: row.checkpointId,
    acceptance: readStoredAcceptance(row.checkpointJson),
  }));
  if (existing.length === 0) {
    // An amendment naming a predecessor this campaign never published is a
    // fabricated chain, not an amendment.
    return args.incoming.supersedes !== null;
  }

  // Campaign-wide, not run-scoped. `workflow_checkpoints` is unique per
  // (run_id, checkpoint_id), so a sibling run can hold its own row under the
  // same acceptance ID. Letting those bodies differ would mean one ID names two
  // contracts, and an approval issued against the body a reader saw would
  // silently authorize the other one.
  const sameIdWithDifferentBody = existing.some(
    (row) =>
      row.checkpointId === args.checkpointId &&
      row.acceptance !== null &&
      row.acceptance.canonical !== args.incoming.canonical,
  );
  if (sameIdWithDifferentBody) return true;

  const comparable = existing.filter((row) => row.acceptance !== null);
  const unchanged = comparable.every(
    (row) => row.acceptance?.canonical === args.incoming.canonical,
  );
  if (unchanged) return false;

  return !existing.some((row) => row.checkpointId === args.incoming.supersedes);
}

function campaignIdForRun(db: Db, runId: string): string | null {
  const row = db
    .prepare(
      `SELECT COALESCE(campaign_id, id) AS campaignId
       FROM workflow_runs WHERE id = ?`,
    )
    .get(runId) as { campaignId: string } | undefined;
  return row?.campaignId ?? null;
}

/**
 * Reads a campaign's amendment approvals for the coverage derivation.
 *
 * Rows are parsed rather than cast: a row this schema rejects — an unknown
 * surface, say — is dropped, which leaves the amendment it referred to pending.
 * That is the safe direction. An approval invented by writing to the database
 * directly either parses and is attributable, or does not count.
 */
export function listAcceptanceApprovals(
  db: Db,
  args: { campaignId: string },
): AcceptanceApproval[] {
  const rows = db
    .prepare(
      `SELECT acceptance_checkpoint_id AS acceptanceId,
         contract_canonical AS contractCanonical,
         approved_by_thread_id AS approvedByThreadId,
         surface, created_at AS approvedAt
       FROM workflow_acceptance_approvals
       WHERE campaign_id = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(args.campaignId) as unknown[];
  return rows.flatMap((row) => {
    const parsed = acceptanceApprovalSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

export type RecordAcceptanceApprovalOutcome =
  | {
      kind: "approved";
      newlyApproved: boolean;
      supersedes: string;
      contractCanonical: string;
    }
  | { kind: "unknown_acceptance" }
  | { kind: "not_an_amendment" }
  | { kind: "ambiguous_body" };

/**
 * Records a human approval for one amending acceptance checkpoint.
 *
 * The approval binds to the canonical criteria body, not just the checkpoint
 * ID, so it authorizes exactly the contract that was on screen when it was
 * issued. Approving the original contract is refused: there is nothing to
 * authorize, and accepting it would put a meaningless row in the table that a
 * later reader could mistake for consent to a change.
 *
 * The write path refuses to let one acceptance ID carry two different bodies in
 * a campaign, so there is normally exactly one body to bind to. If a row
 * predating that guard makes the ID ambiguous, this refuses rather than picking
 * one: choosing the newest would authorize a body the approver never saw, which
 * is the whole failure this record exists to prevent.
 */
export function recordAcceptanceApproval(
  db: Db,
  input: {
    runId: string;
    acceptanceCheckpointId: string;
    approvedByThreadId: string;
    surface: WorkflowApprovalSurface;
  },
): RecordAcceptanceApprovalOutcome {
  return db.transaction((): RecordAcceptanceApprovalOutcome => {
    const campaignId = campaignIdForRun(db, input.runId);
    if (campaignId === null) return { kind: "unknown_acceptance" };
    const rows = db
      .prepare(
        `SELECT checkpoint.checkpoint_json AS checkpointJson
         FROM workflow_checkpoints AS checkpoint
         JOIN workflow_runs AS run ON run.id = checkpoint.run_id
         WHERE COALESCE(run.campaign_id, run.id) = ?
           AND checkpoint.checkpoint_id = ?
           AND CASE WHEN json_valid(checkpoint.checkpoint_json)
                    THEN json_extract(checkpoint.checkpoint_json, '$.kind')
               END = 'acceptance'`,
      )
      .all(campaignId, input.acceptanceCheckpointId) as {
      checkpointJson: string;
    }[];
    const candidates = rows.flatMap((row) => {
      const parsed = readStoredAcceptance(row.checkpointJson);
      return parsed === null ? [] : [parsed];
    });
    const acceptance = candidates[0];
    if (acceptance === undefined) return { kind: "unknown_acceptance" };
    if (
      candidates.some(
        (candidate) => candidate.canonical !== acceptance.canonical,
      )
    ) {
      return { kind: "ambiguous_body" };
    }
    if (acceptance.supersedes === null) return { kind: "not_an_amendment" };
    const result = db
      .prepare(
        `INSERT INTO workflow_acceptance_approvals (
           id, campaign_id, acceptance_checkpoint_id, contract_canonical,
           approved_by_thread_id, surface, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(campaign_id, acceptance_checkpoint_id, contract_canonical)
           DO NOTHING`,
      )
      .run(
        `wfa_${randomUUID()}`,
        campaignId,
        input.acceptanceCheckpointId,
        acceptance.canonical,
        input.approvedByThreadId,
        input.surface,
        Date.now(),
      );
    return {
      kind: "approved",
      newlyApproved: result.changes > 0,
      supersedes: acceptance.supersedes,
      contractCanonical: acceptance.canonical,
    };
  })();
}

/**
 * Returns the acceptance criteria a gate still requires but has not closed, so
 * a gate cannot be recorded as succeeded while the outcomes it guards are open.
 *
 * The edge and the claim live in different checkpoints by design: the plan
 * declares `requiresClosed` on a `nodeType: "gate"` item, and success is
 * reported later on a work-item checkpoint. Joining them is therefore a
 * campaign-wide read — a child run's gate may require a criterion the parent's
 * plan declared — ordered exactly like the coverage read, since the derivation
 * depends on chronological order.
 *
 * Closure is resolved by running that derivation rather than a second query, so
 * "closed" has one definition. A criterion no contract declares can never
 * close, so it counts as open: a typo in `requiresClosed` blocks the gate
 * loudly rather than quietly disabling it.
 */
/**
 * Reads the campaign checkpoints the coverage derivation needs, ordered exactly
 * like the panel's read so both resolve the same contract head.
 */
function campaignCoverageInputs(
  db: Db,
  runId: string,
): readonly WorkflowCheckpoint[] {
  const rows = db
    .prepare(
      `SELECT checkpoint.checkpoint_id AS checkpointId,
              checkpoint.checkpoint_json AS checkpointJson
       FROM workflow_checkpoints AS checkpoint
       JOIN workflow_runs AS run ON run.id = checkpoint.run_id
       WHERE COALESCE(run.campaign_id, run.id) = (
           SELECT COALESCE(campaign_id, id) FROM workflow_runs WHERE id = ?
         )
         AND CASE WHEN json_valid(checkpoint.checkpoint_json)
                  THEN json_extract(checkpoint.checkpoint_json, '$.kind')
             END IN ('acceptance', 'plan', 'work-item', 'verification')
       ORDER BY run.created_at ASC, run.rowid ASC, checkpoint.ordinal ASC
       LIMIT ?`,
    )
    .all(runId, MAX_WORKFLOW_COVERAGE_CHECKPOINTS) as {
    checkpointId: string;
    checkpointJson: string;
  }[];
  // The row's `checkpoint_id` is authoritative here, not the `id` inside the
  // body. Uniqueness, the gate this guard is keyed on, and the ID an amendment
  // supersedes are all that column; taking identity from the body would let a
  // checkpoint filed under one ID be read as another.
  return rows.flatMap((row) => {
    const parsed = readStoredCheckpoint(row.checkpointJson);
    return parsed === null ? [] : [{ ...parsed, id: row.checkpointId }];
  });
}

/** The campaign's open gates, as the reader's coverage reports them. */
function openGatesForCampaign(
  db: Db,
  runId: string,
): readonly { gateId: string; openCriterionIds: readonly string[] }[] {
  const campaignId = campaignIdForRun(db, runId);
  return deriveOpenGates(
    campaignCoverageInputs(db, runId),
    campaignId === null ? [] : listAcceptanceApprovals(db, { campaignId }),
  );
}

function gateRequirementsLeftOpen(
  db: Db,
  args: { runId: string; checkpointId: string },
): string[] {
  // One definition of what a gate requires and of what "closed" means: the
  // refusal below and the `openGates` a reader sees are the same computation.
  // Resolving the requirement separately here is exactly how the two drifted —
  // a sticky per-item walk refused gates that coverage reported as clear, so an
  // agent was blocked with no readable explanation anywhere.
  //
  // Approvals are read for the same reason coverage reads them: an unapproved
  // amendment must not be able to redefine the criteria a gate requires, which
  // would let a workflow open its own gate by rewriting what done means.
  return (
    openGatesForCampaign(db, args.runId)
      .find((gate) => gate.gateId === args.checkpointId)
      ?.openCriterionIds.slice() ?? []
  );
}

/**
 * Returns the gate requirements an incoming plan would drop while the criteria
 * they name are still open AND still declared by the approved contract.
 *
 * Without this the gate is the weakest link in the chain it belongs to: the
 * contract needs a human approval to narrow, but a plan that gates on the
 * contract could be republished with the gate demoted to a work node, by the
 * same agent, through the same tool. That is the agent-writable anchor this
 * ledger exists to remove, one level out.
 *
 * A criterion the approved contract no longer declares may be dropped freely.
 * The approval is what authorized that, and requiring the plan to keep waiting
 * on a criterion nobody declares any more would deadlock the legitimate
 * two-step change instead of recording it.
 */
function gateWeakeningsInPlan(
  db: Db,
  args: {
    runId: string;
    incoming: readonly {
      id: string;
      nodeType?: "work" | "gate";
      requiresClosed?: string[];
    }[];
  },
): { gateId: string; droppedCriterionIds: string[] }[] {
  const checkpoints = campaignCoverageInputs(db, args.runId);
  const campaignId = campaignIdForRun(db, args.runId);
  const approvals =
    campaignId === null ? [] : listAcceptanceApprovals(db, { campaignId });
  const coverage = deriveAcceptanceCoverage(checkpoints, approvals);
  // No contract, nothing to protect: there is no approval that could authorize
  // dropping a requirement, so requiring one here would be unsatisfiable. The
  // gate itself still fails closed while it exists.
  if (coverage === null) return [];
  const declaredIds = new Set(
    coverage.criteria.map((criterion) => criterion.id),
  );
  return deriveOpenGates(checkpoints, approvals).flatMap((gate) => {
    const item = args.incoming.find((entry) => entry.id === gate.gateId);
    const requiredNow =
      item?.nodeType === "gate" ? (item.requiresClosed ?? []) : [];
    const dropped = gate.openCriterionIds.filter(
      (criterionId) =>
        declaredIds.has(criterionId) && !requiredNow.includes(criterionId),
    );
    return dropped.length === 0
      ? []
      : [{ gateId: gate.gateId, droppedCriterionIds: dropped }];
  });
}

export function upsertWorkflowCheckpoint(
  db: Db,
  input: {
    runId: string;
    checkpointId: string;
    checkpointJson: string;
    phase: string | null;
    sourceCallId: string | null;
  },
): UpsertWorkflowCheckpointOutcome {
  return db.transaction(() => {
    const run = db
      .prepare(`SELECT status FROM workflow_runs WHERE id = ?`)
      .get(input.runId) as { status: WorkflowRunStatus } | undefined;
    if (run?.status !== "running") return "inactive";

    const existing = db
      .prepare(
        `SELECT length(CAST(checkpoint_json AS BLOB)) AS bytes,
           source_call_id AS sourceCallId,
           json_extract(checkpoint_json, '$.kind') AS kind,
           CASE WHEN json_extract(checkpoint_json, '$.status') IN ('pending', 'running')
             THEN 4 ELSE 0 END AS interruptionReserveBytes
         FROM workflow_checkpoints
         WHERE run_id = ? AND checkpoint_id = ?`,
      )
      .get(input.runId, input.checkpointId) as
      | {
          bytes: number;
          sourceCallId: string | null;
          kind: string;
          interruptionReserveBytes: number;
        }
      | undefined;
    const incoming = JSON.parse(input.checkpointJson) as {
      kind: string;
      status: string;
    };
    if (
      existing !== undefined &&
      input.sourceCallId !== null &&
      existing.sourceCallId !== input.sourceCallId
    ) {
      return "ownership_conflict";
    }
    if (
      existing !== undefined &&
      typeof existing.kind === "string" &&
      typeof incoming.kind === "string" &&
      existing.kind !== incoming.kind
    ) {
      return "kind_conflict";
    }
    const incomingAcceptance =
      incoming.kind === "acceptance"
        ? readStoredAcceptance(input.checkpointJson)
        : null;
    if (
      incomingAcceptance !== null &&
      conflictsWithCampaignAcceptance(db, {
        runId: input.runId,
        checkpointId: input.checkpointId,
        incoming: incomingAcceptance,
      })
    ) {
      return "acceptance_conflict";
    }
    // A plan may not retire a gate the campaign is still stuck behind. Without
    // this, the human approval that guards the contract guards nothing: the
    // same agent could demote the gate to a work node through the same tool.
    if (incoming.kind === "plan") {
      const parsed = readStoredCheckpoint(input.checkpointJson);
      const weakened =
        parsed?.kind === "plan"
          ? gateWeakeningsInPlan(db, {
              runId: input.runId,
              incoming: parsed.items,
            })[0]
          : undefined;
      if (weakened !== undefined) {
        return {
          kind: "gate_weakened" as const,
          gateId: weakened.gateId,
          droppedCriterionIds: weakened.droppedCriterionIds,
        };
      }
    }
    // Only a claim of success is gated. A gate reported as failed, blocked, or
    // still running is exactly the honest reporting this is meant to encourage.
    if (incoming.kind === "work-item" && incoming.status === "succeeded") {
      const openCriterionIds = gateRequirementsLeftOpen(db, {
        runId: input.runId,
        checkpointId: input.checkpointId,
      });
      if (openCriterionIds.length > 0) {
        return { kind: "gate_conflict" as const, openCriterionIds };
      }
    }
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS count,
           COALESCE(SUM(length(CAST(checkpoint_json AS BLOB))), 0) AS bytes,
           COALESCE(SUM(CASE
             WHEN json_extract(checkpoint_json, '$.status') IN ('pending', 'running')
             THEN 4 ELSE 0 END), 0) AS interruptionReserveBytes,
           COALESCE(MAX(ordinal), -1) AS maximumOrdinal
         FROM workflow_checkpoints WHERE run_id = ?`,
      )
      .get(input.runId) as {
      count: number;
      bytes: number;
      interruptionReserveBytes: number;
      maximumOrdinal: number;
    };
    const checkpointBytes = Buffer.byteLength(input.checkpointJson, "utf8");
    const incomingInterruptionReserveBytes = ["pending", "running"].includes(
      incoming.status,
    )
      ? 4
      : 0;
    const nextReservedTotalBytes =
      totals.bytes +
      totals.interruptionReserveBytes -
      (existing?.bytes ?? 0) -
      (existing?.interruptionReserveBytes ?? 0) +
      checkpointBytes +
      incomingInterruptionReserveBytes;
    if (
      nextReservedTotalBytes > MAX_WORKFLOW_CHECKPOINT_BYTES_PER_RUN ||
      (existing === undefined &&
        totals.count >= MAX_WORKFLOW_CHECKPOINTS_PER_RUN)
    ) {
      return "limit_exceeded";
    }

    const now = Date.now();
    if (existing !== undefined) {
      db.prepare(
        `UPDATE workflow_checkpoints
         SET checkpoint_json = @checkpointJson, phase = @phase,
           source_call_id = COALESCE(@sourceCallId, source_call_id),
           updated_at = @now
         WHERE run_id = @runId AND checkpoint_id = @checkpointId`,
      ).run({ ...input, now });
      return "accepted";
    }
    db.prepare(
      `INSERT INTO workflow_checkpoints (
         id, run_id, checkpoint_id, checkpoint_json, phase, source_call_id,
         ordinal, created_at, updated_at
       ) VALUES (
         @id, @runId, @checkpointId, @checkpointJson, @phase, @sourceCallId,
         @ordinal, @now, @now
       )`,
    ).run({
      id: `wcp_${randomUUID()}`,
      ...input,
      ordinal: totals.maximumOrdinal + 1,
      now,
    });
    return "accepted";
  })();
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

export function recoverInterruptedRuns(db: Db): string[] {
  return db.transaction(() => {
    const runRows = db
      .prepare(`SELECT id FROM workflow_runs WHERE status = 'running'`)
      .all() as Array<{ id: string }>;
    const childRows = db
      .prepare(
        `SELECT calls.child_thread_id AS childThreadId
         FROM workflow_calls calls
         JOIN workflow_runs runs ON runs.id = calls.run_id
         WHERE runs.status = 'running' AND calls.status = 'running'
           AND calls.child_thread_id IS NOT NULL`,
      )
      .all() as Array<{ childThreadId: string }>;
    const now = Date.now();
    for (const run of runRows) {
      interruptWorkflowCheckpoints(db, { runId: run.id, now });
    }
    db.prepare(
      `UPDATE workflow_calls SET status = 'succeeded', error = NULL, finished_at = ?
       WHERE status = 'running' AND result_json IS NOT NULL AND run_id IN (
         SELECT id FROM workflow_runs WHERE status = 'running'
       )`,
    ).run(now);
    db.prepare(
      `UPDATE workflow_calls SET status = 'cancelled', error = 'Plugin restarted', finished_at = ?
       WHERE status IN ('queued', 'running') AND run_id IN (
         SELECT id FROM workflow_runs WHERE status = 'running'
       )`,
    ).run(now);
    db.prepare(
      `UPDATE workflow_runs SET status = 'queued', error = NULL, finished_at = NULL
       WHERE status = 'running'`,
    ).run();
    return childRows.map((row) => row.childThreadId);
  })();
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

export function startCall(
  db: Db,
  args: {
    runId: string;
    callIndex: number;
    cacheKey: string;
    prompt: string;
    options: WorkflowAgentOptions;
    selection: ResolvedWorkflowExecutionSelection;
    replay: {
      callId: string;
      result: Exclude<JsonValue, null>;
      observedContextUsedTokens: number | null;
      observedModelContextWindow: number | null;
      contextUsageEstimated: boolean | null;
    } | null;
  },
): WorkflowCallRow {
  return db.transaction(() => {
    const parent = getRun(db, args.runId);
    if (parent?.status !== "running") {
      throw new Error(`Workflow run ${args.runId} is not running`);
    }
    const existing = getCall(db, args.runId, args.callIndex);
    const now = Date.now();
    const id = existing?.id ?? `wfc_${randomUUID()}`;
    const {
      contextRequirement: _contextRequirement,
      contextProfile: _contextProfile,
      ...storedOptions
    } = args.options;
    db.prepare(
      `INSERT INTO workflow_calls (
       id, run_id, call_index, cache_key, prompt, options_json,
       resolved_provider, resolved_model, resolved_reasoning_level,
       resolved_permission_mode, status, prompt_bytes, context_minimum_tokens,
       context_profile_json,
       observed_context_used_tokens, observed_model_context_window,
       context_usage_estimated, result_json, replayed_from_call_id,
       replay_source, created_at, started_at, finished_at
     ) VALUES (
       @id, @runId, @callIndex, @cacheKey, @prompt, @optionsJson,
       @resolvedProvider, @resolvedModel, @resolvedReasoningLevel,
       @resolvedPermissionMode, @status, @promptBytes, @contextMinimumTokens,
       @contextProfileJson,
       @observedContextUsedTokens, @observedModelContextWindow,
       @contextUsageEstimated, @resultJson, @replayedFromCallId,
       @replaySource, @now, @now, @finishedAt
     ) ON CONFLICT(run_id, call_index) DO UPDATE SET
       cache_key = excluded.cache_key, prompt = excluded.prompt,
       options_json = excluded.options_json,
       resolved_provider = excluded.resolved_provider,
       resolved_model = excluded.resolved_model,
       resolved_reasoning_level = excluded.resolved_reasoning_level,
       resolved_permission_mode = excluded.resolved_permission_mode,
       status = excluded.status,
       child_thread_id = NULL, repair_attempts = 0,
       prompt_bytes = excluded.prompt_bytes,
       context_minimum_tokens = excluded.context_minimum_tokens,
       context_profile_json = excluded.context_profile_json,
       observed_context_used_tokens = excluded.observed_context_used_tokens,
       observed_model_context_window = excluded.observed_model_context_window,
       context_usage_estimated = excluded.context_usage_estimated,
       result_json = excluded.result_json, error = NULL,
       replayed_from_call_id = excluded.replayed_from_call_id,
       replay_source = excluded.replay_source,
       started_at = excluded.started_at, finished_at = excluded.finished_at`,
    ).run({
      id,
      runId: args.runId,
      callIndex: args.callIndex,
      cacheKey: args.cacheKey,
      prompt: args.prompt,
      optionsJson: JSON.stringify(storedOptions),
      resolvedProvider: args.selection.providerId,
      resolvedModel: args.selection.model,
      resolvedReasoningLevel: args.selection.reasoningLevel,
      resolvedPermissionMode: args.selection.permissionMode,
      status: args.replay === null ? "queued" : "succeeded",
      promptBytes: Buffer.byteLength(args.prompt, "utf8"),
      contextMinimumTokens:
        args.options.contextRequirement?.minimumTokens ?? null,
      contextProfileJson:
        args.options.contextProfile === null ||
        args.options.contextProfile === undefined
          ? null
          : JSON.stringify(args.options.contextProfile),
      observedContextUsedTokens: args.replay?.observedContextUsedTokens ?? null,
      observedModelContextWindow:
        args.replay?.observedModelContextWindow ?? null,
      contextUsageEstimated:
        args.replay?.contextUsageEstimated === undefined ||
        args.replay.contextUsageEstimated === null
          ? null
          : args.replay.contextUsageEstimated
            ? 1
            : 0,
      resultJson:
        args.replay === null ? null : JSON.stringify(args.replay.result),
      replayedFromCallId: args.replay?.callId ?? null,
      replaySource: args.replay === null ? null : "resumed-run",
      now,
      finishedAt: args.replay === null ? null : now,
    });
    return getCall(db, args.runId, args.callIndex)!;
  })();
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

export function attachCallThread(
  db: Db,
  callId: string,
  threadId: string,
): boolean {
  return (
    db
      .prepare(
        `UPDATE workflow_calls SET status = 'running', child_thread_id = ?,
         error = NULL, started_at = ?, last_activity_at = ?
       WHERE id = ? AND status = 'queued'
         AND EXISTS (
           SELECT 1 FROM workflow_runs
           WHERE workflow_runs.id = workflow_calls.run_id
             AND workflow_runs.status = 'running'
         )`,
      )
      .run(threadId, Date.now(), Date.now(), callId).changes === 1
  );
}

export function queueCallProviderRetry(
  db: Db,
  callId: string,
  error: string,
): WorkflowCallRow | null {
  const changed = db
    .prepare(
      `UPDATE workflow_calls SET status = 'queued', child_thread_id = NULL,
       provider_retry_attempts = provider_retry_attempts + 1,
       error = ?, started_at = NULL, last_activity_at = ?, finished_at = NULL
       WHERE id = ? AND status IN ('queued', 'failed') AND result_json IS NULL`,
    )
    .run(error, Date.now(), callId).changes;
  return changed === 0
    ? null
    : optionalCall(db.prepare(`${CALL_SELECT} WHERE id = ?`).get(callId));
}

export function storeStructuredResult(
  db: Db,
  callId: string,
  result: JsonValue,
): StoreStructuredResultOutcome {
  const resultJson = JSON.stringify(result);
  return db.transaction(() => {
    const changed = db
      .prepare(
        `UPDATE workflow_calls SET result_json = ?, last_activity_at = ?
         WHERE id = ? AND status = 'running' AND result_json IS NULL`,
      )
      .run(resultJson, Date.now(), callId).changes;
    if (changed === 1) return "accepted";

    const row = optionalCall(
      db.prepare(`${CALL_SELECT} WHERE id = ?`).get(callId),
    );
    if (row?.resultJson === null || row === null) return "inactive";
    try {
      return equalJsonValues(JSON.parse(row.resultJson), result)
        ? "idempotent"
        : "conflict";
    } catch {
      return "conflict";
    }
  })();
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

export function settleCall(
  db: Db,
  args: {
    id: string;
    status: Extract<WorkflowCallStatus, "succeeded" | "failed" | "cancelled">;
    result: JsonValue | null;
    error: string | null;
  },
): string | null {
  return db.transaction(() => {
    const call = db
      .prepare(`SELECT run_id AS runId FROM workflow_calls WHERE id = ?`)
      .get(args.id) as { runId: string } | undefined;
    if (call === undefined) return null;
    const now = Date.now();
    const changed = db
      .prepare(
        `UPDATE workflow_calls SET status = @status,
         result_json = COALESCE(result_json, @resultJson), error = @error,
         finished_at = @now
         WHERE id = @id AND status IN ('queued', 'running')`,
      )
      .run({
        id: args.id,
        status: args.status,
        resultJson:
          args.status === "succeeded" ? JSON.stringify(args.result) : null,
        error: args.error,
        now,
      }).changes;
    if (changed === 0) return null;
    interruptWorkflowCheckpoints(db, { sourceCallId: args.id, now });
    return call.runId;
  })();
}

function equalJsonValues(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equalJsonValues(value, right[index]!))
    );
  }
  if (typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && equalJsonValues(left[key]!, right[key]!),
    )
  );
}

export function cancelRun(db: Db, id: string): boolean {
  return db.transaction(() => {
    const now = Date.now();
    const changed = db
      .prepare(
        `UPDATE workflow_runs SET status = 'cancelled', error = 'Cancelled', finished_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(now, id).changes;
    db.prepare(
      `UPDATE workflow_calls SET status = 'cancelled', error = 'Cancelled', finished_at = ?
       WHERE run_id = ? AND status IN ('queued', 'running')`,
    ).run(now, id);
    if (changed === 1) interruptWorkflowCheckpoints(db, { runId: id, now });
    return changed === 1;
  })();
}

export function activeChildThreadsForRun(db: Db, runId: string): string[] {
  return (
    db
      .prepare(
        `SELECT child_thread_id AS childThreadId FROM workflow_calls
         WHERE run_id = ? AND status IN ('queued', 'running')
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
       AND status IN ('succeeded', 'failed', 'cancelled')
       AND (notification_next_attempt_at IS NULL OR notification_next_attempt_at <= ?)
       ORDER BY finished_at, id LIMIT ?`,
    )
    .all(now, limit)
    .map(runRow);
}

const EXPIRED_TERMINAL_RUN_IDS_SQL = `WITH RECURSIVE retained(id, resumed_from_run_id) AS (
         SELECT id, resumed_from_run_id FROM workflow_runs
         WHERE status IN ('queued', 'running')
           OR finished_at + json_extract(settings_json, '$.retentionDays') * 86400000 > ?
         UNION
         SELECT parent.id, parent.resumed_from_run_id
         FROM workflow_runs parent
         JOIN retained child ON child.resumed_from_run_id = parent.id
       ), expired_candidates(id, resumed_from_run_id) AS (
         SELECT id, resumed_from_run_id FROM workflow_runs
         WHERE status IN ('succeeded', 'failed', 'cancelled')
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
       SELECT id FROM expired`;

export interface ExpiredTerminalRuns {
  runIds: string[];
  childThreadIds: string[];
}

export function listExpiredTerminalRuns(
  db: Db,
  now: number,
  limit: number,
): ExpiredTerminalRuns {
  const runIds = (
    db.prepare(EXPIRED_TERMINAL_RUN_IDS_SQL).all(now, now, limit) as Array<{
      id: string;
    }>
  ).map((row) => row.id);
  if (runIds.length === 0) return { runIds: [], childThreadIds: [] };
  const placeholders = runIds.map(() => "?").join(", ");
  const childThreadIds = (
    db
      .prepare(
        `SELECT DISTINCT child_thread_id AS childThreadId FROM workflow_calls
         WHERE run_id IN (${placeholders}) AND child_thread_id IS NOT NULL`,
      )
      .all(...runIds) as Array<{ childThreadId: string }>
  ).map((row) => row.childThreadId);
  return { runIds, childThreadIds };
}

export function deleteTerminalRuns(db: Db, runIds: readonly string[]): number {
  if (runIds.length === 0) return 0;
  const placeholders = runIds.map(() => "?").join(", ");
  return db
    .prepare(`DELETE FROM workflow_runs WHERE id IN (${placeholders})`)
    .run(...runIds).changes;
}
