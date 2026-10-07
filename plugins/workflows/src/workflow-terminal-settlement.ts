/**
 * Consolidated terminal-writer surface for workflow runs and calls.
 *
 * Every status transition on `workflow_runs` / `workflow_calls` — queued-run
 * claim, child attach, failed-to-queued provider retry, structured result,
 * call settlement, run settlement, whole-run cancellation, restart recovery,
 * replay upsert, and terminal checkpoints — commits through
 * `settleWorkflowTransition` inside one SQLite transaction. That is the only
 * place the contract snapshot / interlock predicate is evaluated, so dispatch,
 * evidence, replay, settlement, staleness, and promotion share one decision.
 *
 * `data.ts` owns row projections, reads, the migration ledger, and writers
 * that never touch status; it re-exports the named verbs below for existing
 * importers. This module deliberately touches `data.ts` bindings only inside
 * function bodies so the two modules can import each other safely.
 *
 * Feature-off compatibility: a call whose definition did not opt into live
 * artifact changes binds `contract_snapshot = NULL`, ignores even admitted
 * artifact rows and interlocks, and behaves exactly as before this module. The
 * later change controller, outbox, adoption/acknowledgement flow, and
 * inspector are not installed here. Admission is owned exclusively by the
 * later U6 controller; this kernel only consumes durable rows it has committed.
 */
import { createHash, randomUUID } from "node:crypto";
import type { ResolvedWorkflowExecutionSelection } from "./cache.js";
import {
  ACTIVE_STATUS_SQL,
  CALL_SELECT,
  CONTRACT_INTERLOCK_STATES,
  RUN_SELECT,
  STALE_EVIDENCE_WRITERS,
  callRow,
  getCall,
  getRun,
  getRunRequired,
  optionalCall,
  optionalRun,
  type ArtifactRevisionStatus,
  type Db,
  type WorkflowCallRow,
  type WorkflowRunRow,
} from "./data.js";
import type { JsonValue, WorkflowAgentOptions } from "./types.js";
import { workflowArtifactLiveChangesEnabled } from "./service-policy.js";
import {
  MAX_WORKFLOW_CHECKPOINT_BYTES_PER_RUN,
  MAX_WORKFLOW_CHECKPOINTS_PER_RUN,
} from "./workflow-checkpoint.js";

export type TerminalRunStatus = Extract<
  WorkflowRunRow["status"],
  "succeeded" | "failed" | "cancelled"
>;
export type TerminalCallStatus = Extract<
  WorkflowCallRow["status"],
  "succeeded" | "failed" | "cancelled"
>;
export type ContractInterlockState = (typeof CONTRACT_INTERLOCK_STATES)[number];
export type StaleEvidenceWriter = (typeof STALE_EVIDENCE_WRITERS)[number];

/** Checkpoint statuses that are still in flight; anything else is terminal. */
const OPEN_CHECKPOINT_STATUSES = ["pending", "running"] as const;
const OPEN_CHECKPOINT_STATUS_SQL = OPEN_CHECKPOINT_STATUSES.map(
  (status) => `'${status}'`,
).join(", ");
/**
 * Only adoption releases an interlock; pending, blocked, and stop-required
 * all block promotion. Every interlock predicate in this module derives from
 * this one fragment so settlement, recovery, and evidence retention agree.
 */
const BLOCKING_INTERLOCK_PREDICATE = "state != 'adopted'";
/** SQL literal for one member of the artifact revision closed set. */
function revisionStatusSql(status: ArtifactRevisionStatus): string {
  return `'${status}'`;
}
const ADMITTED_REVISION_SQL = revisionStatusSql("admitted");

// ---------------------------------------------------------------------------
// Transition intents and outcomes
// ---------------------------------------------------------------------------

export interface StartCallReplay {
  callId: string;
  result: Exclude<JsonValue, null>;
  observedContextUsedTokens: number | null;
  observedModelContextWindow: number | null;
  contextUsageEstimated: boolean | null;
  /** Snapshot the replayed result was produced under (null = feature-off). */
  contractSnapshot: string | null;
}

export interface StartCallInput {
  runId: string;
  callIndex: number;
  cacheKey: string;
  prompt: string;
  options: WorkflowAgentOptions;
  selection: ResolvedWorkflowExecutionSelection;
  replay: StartCallReplay | null;
}

export interface RecordCheckpointInput {
  runId: string;
  checkpointId: string;
  checkpointJson: string;
  phase: string | null;
  sourceCallId: string | null;
}

/** The already-authorized controller supplies the reviewed target and closure. */
export interface AdmitContractChangeInput {
  scope: ContractScope;
  changeId: string;
  presentationThreadId: string;
  artifactId: string;
  artifactRevision: number;
  affectedCallIds: string[];
}

export type ClaimDispatchOutcome =
  | { kind: "claimed"; snapshot: string | null }
  | { kind: "blocked"; block: ContractInterlockBlock }
  | { kind: "inactive" };

export type WorkflowStatusTransition =
  | { kind: "claim-queued-run"; maxActiveRuns: number }
  | {
      kind: "settle-run";
      id: string;
      status: TerminalRunStatus;
      result: JsonValue | null;
      error: string | null;
    }
  | { kind: "cancel-run"; id: string }
  | { kind: "recover-interrupted-runs" }
  | ({ kind: "admit-contract-change" } & AdmitContractChangeInput)
  | { kind: "claim-call-dispatch"; callId: string }
  | ({ kind: "start-call" } & StartCallInput)
  | { kind: "attach-call-thread"; callId: string; threadId: string }
  | { kind: "queue-call-provider-retry"; callId: string; error: string }
  | { kind: "store-structured-result"; callId: string; result: JsonValue }
  | {
      kind: "settle-call";
      id: string;
      status: TerminalCallStatus;
      result: JsonValue | null;
      error: string | null;
    }
  | ({ kind: "record-checkpoint" } & RecordCheckpointInput);

export type WorkflowTransitionKind = WorkflowStatusTransition["kind"];

export interface ContractInterlockBlock {
  changeId: string;
  requiredSequence: number;
  oldSnapshot: string | null;
  newSnapshot: string;
  state: ContractInterlockState;
}

export type SettleCallOutcome =
  | { kind: "settled"; runId: string }
  | { kind: "stale"; runId: string; block: ContractInterlockBlock }
  | { kind: "inactive" };

export interface SettleRunOutcome {
  settled: boolean;
  /** Calls that were still queued/running when the run settled. */
  outstanding: WorkflowCallRow[];
}

export interface RecoverInterruptedRunsOutcome {
  /** Child threads that were running when the plugin stopped. */
  childThreadIds: string[];
  /** Old-snapshot results that were retained as stale instead of promoted. */
  staleResultsRetained: number;
}

export type StoreStructuredResultOutcome =
  | "accepted"
  | "idempotent"
  | "conflict"
  | "inactive"
  | "stale";

export type UpsertWorkflowCheckpointOutcome =
  | "accepted"
  | "inactive"
  | "limit_exceeded"
  | "ownership_conflict"
  | "kind_conflict"
  | "stale";

export type WorkflowTransitionOutcome<K extends WorkflowTransitionKind> =
  K extends "claim-queued-run"
    ? WorkflowRunRow | null
    : K extends "settle-run"
      ? SettleRunOutcome
      : K extends "cancel-run"
        ? boolean
        : K extends "recover-interrupted-runs"
        ? RecoverInterruptedRunsOutcome
          : K extends "admit-contract-change"
            ? { sequence: number; oldSnapshot: string | null; newSnapshot: string }
            : K extends "claim-call-dispatch"
              ? ClaimDispatchOutcome
          : K extends "start-call"
            ? WorkflowCallRow
            : K extends "attach-call-thread"
              ? boolean
              : K extends "queue-call-provider-retry"
                ? WorkflowCallRow | null
                : K extends "store-structured-result"
                  ? StoreStructuredResultOutcome
                  : K extends "settle-call"
                    ? SettleCallOutcome
                    : K extends "record-checkpoint"
                      ? UpsertWorkflowCheckpointOutcome
                      : never;

type TransitionHandlers = {
  [K in WorkflowTransitionKind]: (
    db: Db,
    transition: Extract<WorkflowStatusTransition, { kind: K }>,
  ) => WorkflowTransitionOutcome<K>;
};

/**
 * The single transactional settlement entry point. Every handler runs inside
 * one `db.transaction`, so nested handler transactions become savepoints and a
 * throwing handler leaves no partial status write behind.
 */
export function settleWorkflowTransition<T extends WorkflowStatusTransition>(
  db: Db,
  transition: T,
): WorkflowTransitionOutcome<T["kind"]> {
  // The handler record is exhaustive over the kind union (a missing key is a
  // compile error); TypeScript cannot correlate the union member with its
  // handler at the dispatch site, so the narrowing happens here once.
  const handler = TRANSITION_HANDLERS[transition.kind] as (
    db: Db,
    transition: WorkflowStatusTransition,
  ) => WorkflowTransitionOutcome<T["kind"]>;
  return db.transaction(() => handler(db, transition))();
}

const TRANSITION_HANDLERS: TransitionHandlers = {
  "claim-queued-run": (db, t) => claimQueuedRunTransition(db, t.maxActiveRuns),
  "settle-run": (db, t) => settleRunTransition(db, t),
  "cancel-run": (db, t) => cancelRunTransition(db, t.id),
  "recover-interrupted-runs": (db) => recoverInterruptedRunsTransition(db),
  "admit-contract-change": (db, t) => admitContractChangeTransition(db, t),
  "claim-call-dispatch": (db, t) => claimCallDispatchTransition(db, t.callId),
  "start-call": (db, t) => startCallTransition(db, t),
  "attach-call-thread": (db, t) =>
    attachCallThreadTransition(db, t.callId, t.threadId),
  "queue-call-provider-retry": (db, t) =>
    queueCallProviderRetryTransition(db, t.callId, t.error),
  "store-structured-result": (db, t) =>
    storeStructuredResultTransition(db, t.callId, t.result),
  "settle-call": (db, t) => settleCallTransition(db, t),
  "record-checkpoint": (db, t) => recordCheckpointTransition(db, t),
};

// ---------------------------------------------------------------------------
// Contract snapshot and interlock predicate
// ---------------------------------------------------------------------------

export interface ContractScope {
  campaignId: string;
  projectId: string;
  environmentId: string;
}

export function contractScopeOfRun(run: WorkflowRunRow): ContractScope {
  return {
    campaignId: run.campaignId,
    projectId: run.projectId,
    environmentId: run.environmentId,
  };
}

/**
 * Deterministic digest of the admitted artifact revision set for an origin
 * campaign scope, or null when nothing has been admitted (feature-off).
 */
export function currentContractSnapshot(
  db: Db,
  scope: ContractScope,
): string | null {
  const rows = db
    .prepare(
      `SELECT artifact_id AS artifactId, revision, blob_sha256 AS blobSha256
       FROM workflow_artifact_revisions
       WHERE campaign_id = @campaignId AND project_id = @projectId
         AND environment_id = @environmentId AND status = ${ADMITTED_REVISION_SQL}
       ORDER BY artifact_id`,
    )
    .all(scope) as Array<{
    artifactId: string;
    revision: number;
    blobSha256: string;
  }>;
  if (rows.length === 0) return null;
  const digest = createHash("sha256");
  for (const row of rows) {
    digest.update(
      JSON.stringify([row.artifactId, row.revision, row.blobSha256]),
    );
    digest.update("\n");
  }
  return `cs1:${digest.digest("hex")}`;
}

/**
 * Replay may reuse a stored result only when it was produced under the
 * campaign's current contract snapshot. Both null (feature-off) compares equal,
 * so legacy replay identity is unchanged.
 */
export function replaySnapshotIsCurrent(
  db: Db,
  run: WorkflowRunRow,
  sourceSnapshot: string | null,
): boolean {
  if (!workflowArtifactLiveChangesEnabled(run.workflowArtifactLiveChanges)) {
    return sourceSnapshot === null;
  }
  return currentContractSnapshot(db, contractScopeOfRun(run)) === sourceSnapshot;
}

/**
 * Contract snapshot a call was dispatched under; null for feature-off calls
 * and for calls created before the snapshot column existed.
 */
export function callContractSnapshot(db: Db, callId: string): string | null {
  const row = db
    .prepare(`SELECT contract_snapshot AS snapshot FROM workflow_calls WHERE id = ?`)
    .get(callId) as { snapshot: string | null } | undefined;
  return row?.snapshot ?? null;
}

function blockingInterlock(
  db: Db,
  callId: string,
): ContractInterlockBlock | null {
  const row = db
    .prepare(
      `SELECT change_id AS changeId, required_sequence AS requiredSequence,
         old_snapshot AS oldSnapshot, new_snapshot AS newSnapshot, state
       FROM workflow_call_contract_interlocks
       JOIN workflow_calls ON workflow_calls.id = workflow_call_contract_interlocks.call_id
       JOIN workflow_runs ON workflow_runs.id = workflow_calls.run_id
       WHERE call_id = ? AND ${BLOCKING_INTERLOCK_PREDICATE}
         AND workflow_runs.workflow_artifact_live_changes = 1
       ORDER BY required_sequence LIMIT 1`,
    )
    .get(callId) as ContractInterlockBlock | undefined;
  return row ?? null;
}

/**
 * Retains old-snapshot evidence against the blocking change. Idempotent on
 * (call, writer, blocking change, evidence snapshot, payload, error): a worker
 * that resubmits the same stale result while it waits for adoption does not
 * grow the table. Returns whether a new row was written.
 */
function retainStaleEvidence(
  db: Db,
  input: {
    callId: string;
    writer: StaleEvidenceWriter;
    evidenceSnapshot: string | null;
    block: ContractInterlockBlock;
    payloadJson: string | null;
    error: string | null;
    now: number;
  },
): boolean {
  const duplicate = db
    .prepare(
      `SELECT 1 FROM workflow_call_stale_evidence
       WHERE call_id = @callId AND writer = @writer
         AND blocking_change_id = @blockingChangeId
         AND evidence_snapshot IS @evidenceSnapshot
         AND payload_json IS @payloadJson AND error IS @error
       LIMIT 1`,
    )
    .get({
      callId: input.callId,
      writer: input.writer,
      blockingChangeId: input.block.changeId,
      evidenceSnapshot: input.evidenceSnapshot,
      payloadJson: input.payloadJson,
      error: input.error,
    });
  if (duplicate !== undefined) return false;
  db.prepare(
    `INSERT INTO workflow_call_stale_evidence (
       id, call_id, writer, evidence_snapshot, blocking_change_id,
       blocking_sequence, payload_json, error, recorded_at
     ) VALUES (
       @id, @callId, @writer, @evidenceSnapshot, @blockingChangeId,
       @blockingSequence, @payloadJson, @error, @now
     )`,
  ).run({
    id: `wse_${randomUUID()}`,
    callId: input.callId,
    writer: input.writer,
    evidenceSnapshot: input.evidenceSnapshot,
    blockingChangeId: input.block.changeId,
    blockingSequence: input.block.requiredSequence,
    payloadJson: input.payloadJson,
    error: input.error,
    now: input.now,
  });
  return true;
}

/**
 * The minimal production-owned admission transaction. It deliberately accepts
 * only the already-reviewed revision and affected-call closure; assessment,
 * delivery, acknowledgement, and prompt rebuilding remain later owners.
 */
function admitContractChangeTransition(
  db: Db,
  input: AdmitContractChangeInput,
): { sequence: number; oldSnapshot: string | null; newSnapshot: string } {
  const now = Date.now();
  const revision = db.prepare(
    `SELECT status FROM workflow_artifact_revisions
     WHERE campaign_id = @campaignId AND project_id = @projectId
       AND environment_id = @environmentId AND presentation_thread_id = @presentationThreadId
       AND artifact_id = @artifactId AND revision = @artifactRevision`,
  ).get({ ...input, ...input.scope }) as { status: ArtifactRevisionStatus } | undefined;
  if (revision?.status !== "accepted-pending-impact") {
    throw new Error("Contract admission requires an accepted-pending-impact revision");
  }
  const oldSnapshot = currentContractSnapshot(db, input.scope);
  db.prepare(
    `UPDATE workflow_artifact_revisions SET status = 'superseded'
     WHERE campaign_id = @campaignId AND project_id = @projectId
       AND environment_id = @environmentId AND artifact_id = @artifactId
       AND status = 'admitted'`,
  ).run({ ...input.scope, artifactId: input.artifactId });
  const admitted = db.prepare(
    `UPDATE workflow_artifact_revisions SET status = 'admitted'
     WHERE campaign_id = @campaignId AND project_id = @projectId
       AND environment_id = @environmentId AND presentation_thread_id = @presentationThreadId
       AND artifact_id = @artifactId AND revision = @artifactRevision
       AND status = 'accepted-pending-impact'`,
  ).run({ ...input, ...input.scope });
  if (admitted.changes !== 1) throw new Error("Contract admission lost its revision CAS");
  const newSnapshot = currentContractSnapshot(db, input.scope);
  if (newSnapshot === null) throw new Error("Contract admission produced no snapshot");
  const sequence = (db.prepare(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
     FROM workflow_campaign_contract_changes
     WHERE campaign_id = @campaignId AND project_id = @projectId AND environment_id = @environmentId`,
  ).get(input.scope) as { sequence: number }).sequence;
  db.prepare(
    `INSERT INTO workflow_campaign_contract_changes (
       campaign_id, project_id, environment_id, change_id, sequence, presentation_thread_id,
       artifact_id, artifact_revision, old_snapshot, new_snapshot, admitted_at
     ) VALUES (@campaignId, @projectId, @environmentId, @changeId, @sequence,
       @presentationThreadId, @artifactId, @artifactRevision, @oldSnapshot, @newSnapshot, @now)`,
  ).run({ ...input, ...input.scope, sequence, oldSnapshot, newSnapshot, now });
  for (const callId of new Set(input.affectedCallIds)) {
    const call = optionalCall(db.prepare(`${CALL_SELECT} WHERE id = ?`).get(callId));
    if (call === null || call.runId === "") throw new Error(`Unknown affected call ${callId}`);
    const run = getRunRequired(db, call.runId);
    if (run.campaignId !== input.scope.campaignId || run.projectId !== input.scope.projectId || run.environmentId !== input.scope.environmentId) {
      throw new Error(`Affected call ${callId} is outside the admission scope`);
    }
    const prior = db.prepare(
      `SELECT new_snapshot AS newSnapshot FROM workflow_call_contract_interlocks
       WHERE call_id = ? AND state != 'adopted' ORDER BY required_sequence DESC LIMIT 1`,
    ).get(callId) as { newSnapshot: string } | undefined;
    db.prepare(
      `INSERT INTO workflow_call_contract_interlocks (
         change_id, call_id, required_sequence, old_snapshot, new_snapshot, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(input.changeId, callId, sequence, prior?.newSnapshot ?? oldSnapshot, newSnapshot, now, now);
    if (call.status === "succeeded" || call.status === "failed" || call.status === "cancelled") {
      retainStaleEvidence(db, { callId, writer: "admission", evidenceSnapshot: callContractSnapshot(db, callId),
        block: { changeId: input.changeId, requiredSequence: sequence, oldSnapshot: prior?.newSnapshot ?? oldSnapshot, newSnapshot, state: "pending" },
        payloadJson: call.resultJson, error: call.error, now });
    }
  }
  return { sequence, oldSnapshot, newSnapshot };
}

/** Atomically binds the queued call's exact current snapshot before any spawn. */
function claimCallDispatchTransition(db: Db, callId: string): ClaimDispatchOutcome {
  const call = optionalCall(db.prepare(`${CALL_SELECT} WHERE id = ?`).get(callId));
  if (call === null || call.status !== "queued") return { kind: "inactive" };
  const run = getRunRequired(db, call.runId);
  if (run.status !== "running") return { kind: "inactive" };
  if (!workflowArtifactLiveChangesEnabled(run.workflowArtifactLiveChanges)) {
    return { kind: "claimed", snapshot: null };
  }
  const block = blockingInterlock(db, callId);
  if (block !== null) return { kind: "blocked", block };
  const snapshot = currentContractSnapshot(db, contractScopeOfRun(run));
  // A disjoint admission may advance the campaign snapshot without creating an
  // interlock for this queued call. Rebind it here; an affecting admission has
  // already returned the blocking branch above and therefore cannot spawn.
  if (snapshot !== callContractSnapshot(db, callId)) {
    db.prepare(`UPDATE workflow_calls SET contract_snapshot = ? WHERE id = ? AND status = 'queued'`)
      .run(snapshot, callId);
  }
  db.prepare(
    `INSERT INTO workflow_call_dispatch_claims (call_id, contract_snapshot, claimed_at)
     VALUES (?, ?, ?) ON CONFLICT(call_id) DO UPDATE SET
       contract_snapshot = excluded.contract_snapshot, claimed_at = excluded.claimed_at`,
  ).run(callId, snapshot, Date.now());
  return { kind: "claimed", snapshot };
}

// ---------------------------------------------------------------------------
// Run transitions
// ---------------------------------------------------------------------------

function claimQueuedRunTransition(
  db: Db,
  maxActiveRuns: number,
): WorkflowRunRow | null {
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
       AND json_extract(checkpoint_json, '$.status') IN (${OPEN_CHECKPOINT_STATUS_SQL})`,
  ).run(args);
}

/**
 * Run settlement is never gated by call interlocks: finishing or cancelling a
 * whole run is the conservative fallback the design relies on.
 */
function settleRunTransition(
  db: Db,
  args: {
    id: string;
    status: TerminalRunStatus;
    result: JsonValue | null;
    error: string | null;
  },
): SettleRunOutcome {
  const outstanding = db
    .prepare(
      `${CALL_SELECT} WHERE run_id = ? AND status IN (${ACTIVE_STATUS_SQL})`,
    )
    .all(args.id)
    .map(callRow);
  const now = Date.now();
  // A normal successful workflow completion promotes the work of every active
  // call. Do not let it bypass an admitted contract barrier. Explicit whole-run
  // failure/cancellation remains the authoritative conservative stop path.
  if (args.status === "succeeded") {
    const blocked = db
      .prepare(
        `SELECT 1
         FROM workflow_calls calls
         JOIN workflow_runs runs ON runs.id = calls.run_id
         JOIN workflow_call_contract_interlocks interlocks ON interlocks.call_id = calls.id
         WHERE calls.run_id = ? AND runs.workflow_artifact_live_changes = 1
           AND interlocks.${BLOCKING_INTERLOCK_PREDICATE}
         LIMIT 1`,
      )
      .get(args.id);
    if (blocked !== undefined) {
      db.prepare(
        `UPDATE workflow_runs SET result_json = ?, error = NULL
         WHERE id = ? AND status = 'running'`,
      ).run(JSON.stringify(args.result), args.id);
      return { settled: false, outstanding: [] };
    }
  }
  const changed = db
    .prepare(
      `UPDATE workflow_runs SET status = @status, result_json = @resultJson,
       error = @error, finished_at = @now
       WHERE id = @id AND status IN (${ACTIVE_STATUS_SQL})`,
    )
    .run({
      id: args.id,
      status: args.status,
      resultJson:
        args.status === "succeeded" ? JSON.stringify(args.result) : null,
      error: args.error,
      now,
    }).changes;
  if (changed === 0) return { settled: false, outstanding: [] };
  db.prepare(
    `UPDATE workflow_calls SET status = 'cancelled',
     error = 'Parent workflow finished before this call', finished_at = ?
     WHERE run_id = ? AND status IN (${ACTIVE_STATUS_SQL})`,
  ).run(now, args.id);
  interruptWorkflowCheckpoints(db, { runId: args.id, now });
  return { settled: true, outstanding };
}

function cancelRunTransition(db: Db, id: string): boolean {
  const now = Date.now();
  const changed = db
    .prepare(
      `UPDATE workflow_runs SET status = 'cancelled', error = 'Cancelled', finished_at = ?
       WHERE id = ? AND status IN (${ACTIVE_STATUS_SQL})`,
    )
    .run(now, id).changes;
  db.prepare(
    `UPDATE workflow_calls SET status = 'cancelled', error = 'Cancelled', finished_at = ?
     WHERE run_id = ? AND status IN (${ACTIVE_STATUS_SQL})`,
  ).run(now, id);
  if (changed === 1) interruptWorkflowCheckpoints(db, { runId: id, now });
  return changed === 1;
}

/**
 * Restart recovery. A running call that already holds a result is promoted
 * to succeeded only when no interlock blocks it; a blocked result is retained
 * as stale evidence and the call falls into the ordinary restart cancellation.
 */
function recoverInterruptedRunsTransition(
  db: Db,
): RecoverInterruptedRunsOutcome {
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
  // A blocked successful controller is durable: after adoption, restart can
  // complete it without re-running the workflow body; while still blocked it
  // remains an explicit retained result rather than a timeout-only loss.
  for (const run of runRows) {
    const retained = getRunRequired(db, run.id);
    if (retained.resultJson !== null) {
      const blocked = db.prepare(
        `SELECT 1 FROM workflow_calls calls
         JOIN workflow_call_contract_interlocks interlocks ON interlocks.call_id = calls.id
         WHERE calls.run_id = ? AND interlocks.${BLOCKING_INTERLOCK_PREDICATE} LIMIT 1`,
      ).get(run.id);
      if (blocked === undefined) {
        db.prepare(`UPDATE workflow_runs SET status = 'succeeded', finished_at = ? WHERE id = ? AND status = 'running'`).run(now, run.id);
      }
    }
  }
  for (const run of runRows) {
    interruptWorkflowCheckpoints(db, { runId: run.id, now });
  }
  const staleCandidates = db
    .prepare(
      `SELECT id, result_json AS resultJson, contract_snapshot AS contractSnapshot
       FROM workflow_calls
       WHERE status = 'running' AND result_json IS NOT NULL AND run_id IN (
         SELECT id FROM workflow_runs WHERE status = 'running'
       )`,
    )
    .all() as Array<{
    id: string;
    resultJson: string;
    contractSnapshot: string | null;
  }>;
  let staleResultsRetained = 0;
  for (const candidate of staleCandidates) {
    const block = blockingInterlock(db, candidate.id);
    if (block === null) continue;
    retainStaleEvidence(db, {
      callId: candidate.id,
      writer: "recovery",
      evidenceSnapshot: candidate.contractSnapshot,
      block,
      payloadJson: candidate.resultJson,
      error: null,
      now,
    });
    staleResultsRetained += 1;
  }
  db.prepare(
    `UPDATE workflow_calls SET status = 'succeeded', error = NULL, finished_at = ?
     WHERE status = 'running' AND result_json IS NOT NULL AND run_id IN (
       SELECT id FROM workflow_runs WHERE status = 'running'
     ) AND NOT EXISTS (
       SELECT 1 FROM workflow_call_contract_interlocks interlocks
       JOIN workflow_runs runs ON runs.id = workflow_calls.run_id
       WHERE interlocks.call_id = workflow_calls.id
         AND runs.workflow_artifact_live_changes = 1
         AND interlocks.${BLOCKING_INTERLOCK_PREDICATE}
     )`,
  ).run(now);
  db.prepare(
    `UPDATE workflow_calls SET status = 'cancelled', error = 'Plugin restarted', finished_at = ?
     WHERE status IN (${ACTIVE_STATUS_SQL}) AND run_id IN (
       SELECT id FROM workflow_runs WHERE status = 'running'
     )`,
  ).run(now);
  db.prepare(
    `UPDATE workflow_runs SET status = 'queued', error = NULL, finished_at = NULL
     WHERE status = 'running'`,
  ).run();
  return {
    childThreadIds: childRows.map((row) => row.childThreadId),
    staleResultsRetained,
  };
}

// ---------------------------------------------------------------------------
// Call transitions
// ---------------------------------------------------------------------------

/**
 * Dispatch binding. The call binds the campaign's current contract snapshot.
 * A replayed result is written as settled only when it was produced under
 * that same snapshot; otherwise the row is queued for fresh dispatch.
 *
 * Binding is adoption for every change already admitted for this call: a
 * call row is reused across re-dispatch (restart recovery cancels the running
 * call and requeues the run), and admission commits in the same database as
 * dispatch, so every interlock that exists here has `required_sequence` at or
 * below the edge that produced the bound snapshot. Leaving those rows pending
 * would make the re-dispatched call permanently unsettleable.
 */
function startCallTransition(db: Db, args: StartCallInput): WorkflowCallRow {
  const parent = getRun(db, args.runId);
  if (parent?.status !== "running") {
    throw new Error(`Workflow run ${args.runId} is not running`);
  }
  const contractSnapshot = workflowArtifactLiveChangesEnabled(
    parent.workflowArtifactLiveChanges,
  )
    ? currentContractSnapshot(db, contractScopeOfRun(parent))
    : null;
  const replay =
    args.replay !== null && args.replay.contractSnapshot === contractSnapshot
      ? args.replay
      : null;
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
       replay_source, contract_snapshot, created_at, started_at, finished_at
     ) VALUES (
       @id, @runId, @callIndex, @cacheKey, @prompt, @optionsJson,
       @resolvedProvider, @resolvedModel, @resolvedReasoningLevel,
       @resolvedPermissionMode, @status, @promptBytes, @contextMinimumTokens,
       @contextProfileJson,
       @observedContextUsedTokens, @observedModelContextWindow,
       @contextUsageEstimated, @resultJson, @replayedFromCallId,
       @replaySource, @contractSnapshot, @now, @now, @finishedAt
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
       contract_snapshot = excluded.contract_snapshot,
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
    status: replay === null ? "queued" : "succeeded",
    promptBytes: Buffer.byteLength(args.prompt, "utf8"),
    contextMinimumTokens: args.options.contextRequirement?.minimumTokens ?? null,
    contextProfileJson:
      args.options.contextProfile === null ||
      args.options.contextProfile === undefined
        ? null
        : JSON.stringify(args.options.contextProfile),
    observedContextUsedTokens: replay?.observedContextUsedTokens ?? null,
    observedModelContextWindow: replay?.observedModelContextWindow ?? null,
    contextUsageEstimated:
      replay?.contextUsageEstimated === undefined ||
      replay.contextUsageEstimated === null
        ? null
        : replay.contextUsageEstimated
          ? 1
          : 0,
    resultJson: replay === null ? null : JSON.stringify(replay.result),
    replayedFromCallId: replay?.callId ?? null,
    replaySource: replay === null ? null : "resumed-run",
    contractSnapshot,
    now,
    finishedAt: replay === null ? null : now,
  });
  const stored = getCall(db, args.runId, args.callIndex);
  if (stored === null) {
    throw new Error(`Workflow call ${args.runId}#${args.callIndex} vanished`);
  }
  return stored;
}

/**
 * Seam limitation: attach is not gated by the interlock predicate. A queued
 * call named in an admitted change still starts on the prompt it was
 * dispatched with, and its result is retained as stale rather than settled.
 * Denying attach here would surface as a whole-run abort in the dispatcher;
 * the delivery unit rebuilds pending prompts before start (design: "Pending
 * work is not started until its prompt/context packet is rebuilt").
 */
function attachCallThreadTransition(
  db: Db,
  callId: string,
  threadId: string,
): boolean {
  const now = Date.now();
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
      .run(threadId, now, now, callId).changes === 1
  );
}

function queueCallProviderRetryTransition(
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

/**
 * A structured result from a worker still bound to a superseded snapshot is
 * retained as stale evidence; it never becomes the call's result.
 */
function storeStructuredResultTransition(
  db: Db,
  callId: string,
  result: JsonValue,
): StoreStructuredResultOutcome {
  const resultJson = JSON.stringify(result);
  const now = Date.now();
  const call = optionalCall(
    db.prepare(`${CALL_SELECT} WHERE id = ?`).get(callId),
  );
  if (call !== null && call.status === "running" && call.resultJson === null) {
    const block = blockingInterlock(db, callId);
    if (block !== null) {
      retainStaleEvidence(db, {
        callId,
        writer: "structured-result",
        evidenceSnapshot: callContractSnapshot(db, callId),
        block,
        payloadJson: resultJson,
        error: null,
        now,
      });
      return "stale";
    }
  }
  const changed = db
    .prepare(
      `UPDATE workflow_calls SET result_json = ?, last_activity_at = ?
       WHERE id = ? AND status = 'running' AND result_json IS NULL`,
    )
    .run(resultJson, now, callId).changes;
  if (changed === 1) return "accepted";
  if (call?.resultJson === null || call === null) return "inactive";
  try {
    return equalJsonValues(JSON.parse(call.resultJson), result)
      ? "idempotent"
      : "conflict";
  } catch {
    return "conflict";
  }
}

/**
 * Call settlement. A successful result under a non-adopted interlock is
 * retained as stale evidence and the call stays running. Worker-derived
 * failure and cancellation are evidence too: only the authoritative whole-run
 * stop transitions may terminate an interlocked call.
 */
function settleCallTransition(
  db: Db,
  args: {
    id: string;
    status: TerminalCallStatus;
    result: JsonValue | null;
    error: string | null;
  },
): SettleCallOutcome {
  const call = optionalCall(
    db.prepare(`${CALL_SELECT} WHERE id = ?`).get(args.id),
  );
  if (call === null) return { kind: "inactive" };
  if (call.status !== "queued" && call.status !== "running") {
    return { kind: "inactive" };
  }
  const now = Date.now();
  const resultJson =
    args.status === "succeeded" ? JSON.stringify(args.result) : null;
  const block = blockingInterlock(db, args.id);
  if (block !== null) {
    retainStaleEvidence(db, {
      callId: args.id,
      writer: "settle-call",
      evidenceSnapshot: callContractSnapshot(db, args.id),
      block,
      payloadJson: call.resultJson ?? resultJson,
      error: args.error,
      now,
    });
    return { kind: "stale", runId: call.runId, block };
  }
  const changed = db
    .prepare(
      `UPDATE workflow_calls SET status = @status,
       result_json = COALESCE(result_json, @resultJson), error = @error,
       finished_at = @now
       WHERE id = @id AND status IN (${ACTIVE_STATUS_SQL})`,
    )
    .run({
      id: args.id,
      status: args.status,
      resultJson,
      error: args.error,
      now,
    }).changes;
  if (changed === 0) return { kind: "inactive" };
  interruptWorkflowCheckpoints(db, { sourceCallId: args.id, now });
  return { kind: "settled", runId: call.runId };
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

// ---------------------------------------------------------------------------
// Checkpoint transition (terminal checkpoints are settlement evidence)
// ---------------------------------------------------------------------------

function recordCheckpointTransition(
  db: Db,
  input: RecordCheckpointInput,
): UpsertWorkflowCheckpointOutcome {
  const run = db
    .prepare(`SELECT status FROM workflow_runs WHERE id = ?`)
    .get(input.runId) as { status: WorkflowRunRow["status"] } | undefined;
  if (run?.status !== "running") return "inactive";

  const existing = db
    .prepare(
      `SELECT length(CAST(checkpoint_json AS BLOB)) AS bytes,
         source_call_id AS sourceCallId,
         json_extract(checkpoint_json, '$.kind') AS kind,
         CASE WHEN json_extract(checkpoint_json, '$.status') IN (${OPEN_CHECKPOINT_STATUS_SQL})
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
  const incomingIsOpen = (OPEN_CHECKPOINT_STATUSES as readonly string[]).includes(
    incoming.status,
  );
  if (!incomingIsOpen) {
    const block = input.sourceCallId === null
      ? (db.prepare(
          `SELECT interlocks.change_id AS changeId,
             interlocks.required_sequence AS requiredSequence,
             interlocks.old_snapshot AS oldSnapshot,
             interlocks.new_snapshot AS newSnapshot, interlocks.state
           FROM workflow_call_contract_interlocks interlocks
           JOIN workflow_calls calls ON calls.id = interlocks.call_id
           JOIN workflow_runs runs ON runs.id = calls.run_id
           WHERE calls.run_id = ? AND runs.workflow_artifact_live_changes = 1
             AND interlocks.${BLOCKING_INTERLOCK_PREDICATE}
           ORDER BY interlocks.required_sequence LIMIT 1`,
        ).get(input.runId) as ContractInterlockBlock | undefined) ?? null
      : blockingInterlock(db, input.sourceCallId);
    if (block !== null) {
      if (input.sourceCallId !== null) {
        retainStaleEvidence(db, {
          callId: input.sourceCallId,
          writer: "checkpoint",
          evidenceSnapshot: callContractSnapshot(db, input.sourceCallId),
          block,
          payloadJson: input.checkpointJson,
          error: null,
          now: Date.now(),
        });
      }
      return "stale";
    }
  }
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS count,
         COALESCE(SUM(length(CAST(checkpoint_json AS BLOB))), 0) AS bytes,
         COALESCE(SUM(CASE
           WHEN json_extract(checkpoint_json, '$.status') IN (${OPEN_CHECKPOINT_STATUS_SQL})
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
  const incomingInterruptionReserveBytes = incomingIsOpen ? 4 : 0;
  const nextReservedTotalBytes =
    totals.bytes +
    totals.interruptionReserveBytes -
    (existing?.bytes ?? 0) -
    (existing?.interruptionReserveBytes ?? 0) +
    checkpointBytes +
    incomingInterruptionReserveBytes;
  if (
    nextReservedTotalBytes > MAX_WORKFLOW_CHECKPOINT_BYTES_PER_RUN ||
    (existing === undefined && totals.count >= MAX_WORKFLOW_CHECKPOINTS_PER_RUN)
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
}

export interface ContractChangeRow {
  changeId: string;
  sequence: number;
  presentationThreadId: string;
  artifactId: string;
  artifactRevision: number;
  oldSnapshot: string | null;
  newSnapshot: string;
  admittedAt: number;
}

export interface ContractInterlockRow extends ContractInterlockBlock {
  callId: string;
}

export interface StaleEvidenceRow {
  id: string;
  callId: string;
  writer: StaleEvidenceWriter;
  evidenceSnapshot: string | null;
  blockingChangeId: string;
  blockingSequence: number;
  payloadJson: string | null;
  error: string | null;
  recordedAt: number;
}

export function getContractChange(
  db: Db,
  scope: ContractScope,
  changeId: string,
): ContractChangeRow | null {
  const row = db
    .prepare(
      `SELECT change_id AS changeId, sequence,
         presentation_thread_id AS presentationThreadId,
         artifact_id AS artifactId, artifact_revision AS artifactRevision,
         old_snapshot AS oldSnapshot, new_snapshot AS newSnapshot,
         admitted_at AS admittedAt
       FROM workflow_campaign_contract_changes
       WHERE campaign_id = @campaignId AND project_id = @projectId
         AND environment_id = @environmentId AND change_id = @changeId`,
    )
    .get({ ...scope, changeId }) as ContractChangeRow | undefined;
  return row ?? null;
}

export function listContractInterlocksForCall(
  db: Db,
  callId: string,
): ContractInterlockRow[] {
  return db
    .prepare(
      `SELECT change_id AS changeId, call_id AS callId,
         required_sequence AS requiredSequence, old_snapshot AS oldSnapshot,
         new_snapshot AS newSnapshot, state
       FROM workflow_call_contract_interlocks
       WHERE call_id = ? ORDER BY required_sequence`,
    )
    .all(callId) as ContractInterlockRow[];
}

export function listStaleEvidenceForCall(
  db: Db,
  callId: string,
): StaleEvidenceRow[] {
  return db
    .prepare(
      `SELECT id, call_id AS callId, writer, evidence_snapshot AS evidenceSnapshot,
         blocking_change_id AS blockingChangeId,
         blocking_sequence AS blockingSequence, payload_json AS payloadJson,
         error, recorded_at AS recordedAt
       FROM workflow_call_stale_evidence
       WHERE call_id = ? ORDER BY recorded_at, id`,
    )
    .all(callId) as StaleEvidenceRow[];
}

// ---------------------------------------------------------------------------
// Legacy-shaped verbs. Each is a one-line adapter over the entry point so
// existing importers keep their signatures; new code should call
// `settleWorkflowTransition` directly to see the full outcome.
// ---------------------------------------------------------------------------

export function claimQueuedRun(
  db: Db,
  maxActiveRuns: number,
): WorkflowRunRow | null {
  return settleWorkflowTransition(db, { kind: "claim-queued-run", maxActiveRuns });
}

export function settleRun(
  db: Db,
  args: {
    id: string;
    status: TerminalRunStatus;
    result: JsonValue | null;
    error: string | null;
  },
): WorkflowCallRow[] {
  return settleWorkflowTransition(db, { kind: "settle-run", ...args })
    .outstanding;
}

export function cancelRun(db: Db, id: string): boolean {
  return settleWorkflowTransition(db, { kind: "cancel-run", id });
}

export function recoverInterruptedRuns(db: Db): string[] {
  return settleWorkflowTransition(db, { kind: "recover-interrupted-runs" })
    .childThreadIds;
}

export function startCall(
  db: Db,
  args: Omit<StartCallInput, "replay"> & {
    replay: Omit<StartCallReplay, "contractSnapshot"> & {
      contractSnapshot?: string | null;
    } | null;
  },
): WorkflowCallRow {
  return settleWorkflowTransition(db, {
    kind: "start-call",
    ...args,
    replay:
      args.replay === null
        ? null
        : { ...args.replay, contractSnapshot: args.replay.contractSnapshot ?? null },
  });
}

export function attachCallThread(
  db: Db,
  callId: string,
  threadId: string,
): boolean {
  return settleWorkflowTransition(db, {
    kind: "attach-call-thread",
    callId,
    threadId,
  });
}

export function queueCallProviderRetry(
  db: Db,
  callId: string,
  error: string,
): WorkflowCallRow | null {
  return settleWorkflowTransition(db, {
    kind: "queue-call-provider-retry",
    callId,
    error,
  });
}

export function storeStructuredResult(
  db: Db,
  callId: string,
  result: JsonValue,
): StoreStructuredResultOutcome {
  return settleWorkflowTransition(db, {
    kind: "store-structured-result",
    callId,
    result,
  });
}

export function settleCall(
  db: Db,
  args: {
    id: string;
    status: TerminalCallStatus;
    result: JsonValue | null;
    error: string | null;
  },
): string | null {
  const outcome = settleWorkflowTransition(db, { kind: "settle-call", ...args });
  return outcome.kind === "settled" ? outcome.runId : null;
}

export function upsertWorkflowCheckpoint(
  db: Db,
  input: RecordCheckpointInput,
): UpsertWorkflowCheckpointOutcome {
  return settleWorkflowTransition(db, { kind: "record-checkpoint", ...input });
}
