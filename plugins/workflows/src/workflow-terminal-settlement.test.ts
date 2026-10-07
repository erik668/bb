import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { initializeWorkflowStorage } from "./artifact-storage.js";
import {
  ARTIFACT_REVISION_STATUSES,
  createRun,
  getCall,
  getRunRequired,
  listCallsForRun,
  migrations,
  type Db,
  type WorkflowCallRow,
} from "./data.js";
import { createWorkflowService } from "./service.js";
import { DEFAULT_WORKFLOW_SETTINGS } from "./settings.js";
import {
  callContractSnapshot,
  contractScopeOfRun,
  currentContractSnapshot,
  getContractChange,
  listContractInterlocksForCall,
  listStaleEvidenceForCall,
  settleWorkflowTransition,
  type ContractScope,
} from "./workflow-terminal-settlement.js";

// The approved walking skeleton (artifact-review-effectful-settlement-skeleton-v1)
// is proven here against the production service composition and the
// file-backed plugin database: one origin-scoped Requirements revision, one
// running call on snapshot S0, admission of S1 with its interlock, an actual
// S0 terminal result through the production settlement path, restart, and a
// wrong presentation grant.

async function eventually(
  assertion: () => void | Promise<void>,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

// A fresh run's campaign is the run itself; tests derive the origin scope
// from the started run rather than asserting a campaign id up front.
let ORIGIN_SCOPE: ContractScope = {
  campaignId: "unset",
  projectId: "project-test",
  environmentId: "environment-1",
};
const PRESENTATION_THREAD = "presentation-1";
const REQUIREMENTS_ARTIFACT = "requirements";

const STRUCTURED_SOURCE = `export const meta = {
  name: "settlement-skeleton",
  description: "Walking skeleton",
};
const result = await agent("Summarize the requirements", {
  outputSchema: {
    type: "object",
    required: ["answer"],
    properties: { answer: { type: "number" } }
  }
});
return result;`;

const LIVE_STRUCTURED_SOURCE = STRUCTURED_SOURCE.replace(
  'description: "Walking skeleton",',
  'description: "Walking skeleton",\n  workflowArtifactLiveChanges: true,',
);

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Pretend the (not yet installed) artifact repository stored a revision. */
function storeRequirementsRevision(
  db: Db,
  input: {
    revision: number;
    content: string;
    status: "admitted" | "accepted-pending-impact";
  },
): string {
  const now = Date.now();
  const blobSha256 = sha256(input.content);
  db.prepare(
    `INSERT OR IGNORE INTO workflow_artifact_blobs
       (sha256, content_type, content, byte_length, created_at)
     VALUES (?, 'text/markdown', ?, ?, ?)`,
  ).run(
    blobSha256,
    Buffer.from(input.content),
    Buffer.byteLength(input.content),
    now,
  );
  db.prepare(
    `INSERT OR IGNORE INTO workflow_artifacts
       (campaign_id, project_id, environment_id, presentation_thread_id, id,
        kind, title, content_type, created_at, updated_at)
     VALUES (@campaignId, @projectId, @environmentId, @presentationThreadId,
             @artifactId, 'requirements', 'Requirements', 'text/markdown',
             @now, @now)`,
  ).run({
    ...ORIGIN_SCOPE,
    presentationThreadId: PRESENTATION_THREAD,
    artifactId: REQUIREMENTS_ARTIFACT,
    now,
  });
  db.prepare(
    `INSERT INTO workflow_artifact_revisions
       (campaign_id, project_id, environment_id, presentation_thread_id,
        artifact_id, revision, blob_sha256, status, created_at)
     VALUES (@campaignId, @projectId, @environmentId, @presentationThreadId,
             @artifactId, @revision, @blobSha256, @status, @now)`,
  ).run({
    ...ORIGIN_SCOPE,
    presentationThreadId: PRESENTATION_THREAD,
    artifactId: REQUIREMENTS_ARTIFACT,
    revision: input.revision,
    blobSha256,
    status: input.status,
    now,
  });
  return blobSha256;
}

function revisionStatuses(db: Db): Array<{ revision: number; status: string }> {
  return db
    .prepare(
      `SELECT revision, status FROM workflow_artifact_revisions
       WHERE campaign_id = @campaignId AND project_id = @projectId
         AND environment_id = @environmentId AND artifact_id = @artifactId
       ORDER BY revision`,
    )
    .all({ ...ORIGIN_SCOPE, artifactId: REQUIREMENTS_ARTIFACT }) as Array<{
    revision: number;
    status: string;
  }>;
}

function setup() {
  let childCount = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "workflows",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            projectId: "project-test",
            environmentId: "environment-1",
            providerId: "codex",
          }),
        output: async () => ({ output: null }),
        timeline: async () =>
          ({
            rows: [],
            activePromptMode: null,
            activeThinking: null,
            activeWorkflows: [],
            activeBackgroundCommands: [],
            pendingTodos: null,
            goal: null,
            modelFallback: null,
            timelinePage: {
              kind: "latest",
              segmentLimit: 0,
              returnedSegmentCount: 0,
              hasOlderRows: false,
              olderCursor: null,
            },
            maxSeq: 0,
          }) as never,
        defaultExecutionOptions: async () => ({
          model: "gpt-test",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          source: "default",
        }),
        spawn: async () => {
          childCount += 1;
          return { id: `child-${childCount}` } as never;
        },
        send: async () => ({ ok: true }),
        stop: async () => ({ ok: true }),
      },
      providers: {
        list: async () => [
          {
            id: "codex",
            displayName: "Codex",
            logoUrl: null,
            available: true,
            capabilities: {
              supportsThreadArchive: true,
              supportsThreadRename: true,
              supportsServiceTier: true,
              supportsNativeUserQuestion: false,
              supportsFork: true,
              permissionModes: ["full"],
            },
            composerActions: [],
          },
        ],
        models: async () => ({
          providers: [],
          models: [
            {
              id: "gpt-test",
              model: "gpt-test",
              displayName: "GPT Test",
              description: "test",
              supportedReasoningEfforts: [
                { reasoningEffort: "medium", description: "test" },
              ],
              defaultReasoningEffort: "medium",
              isDefault: true,
            },
          ],
          selectedOnlyModels: [],
          modelLoadError: null,
        }),
      },
      environments: {
        get: async () =>
          ({
            id: "environment-1",
            projectId: "project-test",
            hostId: "host-1",
            path: "/workspace",
          }) as never,
      },
    },
  });

  /** The production composition from server.ts over the file-backed database. */
  function openProduction(api: BbPluginApi) {
    const db = api.storage.database();
    initializeWorkflowStorage(db);
    api.storage.migrate(db, migrations);
    return {
      db,
      service: createWorkflowService(api, db, DEFAULT_WORKFLOW_SETTINGS),
    };
  }

  return { bb, harness, openProduction };
}

/**
 * Admits Requirements v1 as S0, creates a run in that scope, claims it, and
 * dispatches call 0 bound to S0 through the production transitions.
 */
function dispatchRunningCall(
  db: Db,
  name: string,
): { run: ReturnType<typeof createRun>; call: WorkflowCallRow; s0: string } {
  ORIGIN_SCOPE = { ...ORIGIN_SCOPE, campaignId: `campaign-${name}` };
  storeRequirementsRevision(db, {
    revision: 1,
    content: "# Requirements v1\n",
    status: "admitted",
  });
  const s0 = currentContractSnapshot(db, ORIGIN_SCOPE);
  if (s0 === null) throw new Error("S0 was not admitted");
  const run = createRun(db, {
    projectId: ORIGIN_SCOPE.projectId,
    originThreadId: "origin",
    presentationThreadId: PRESENTATION_THREAD,
    parentRunId: null,
    rootRunId: "",
    environmentId: ORIGIN_SCOPE.environmentId,
    originProvider: "codex",
    originModel: "gpt-test",
    originReasoningLevel: "medium",
    originPermissionMode: "full",
    name,
    source: LIVE_STRUCTURED_SOURCE,
    sourceHash: "hash",
    argsJson: "null",
    settingsJson: JSON.stringify(DEFAULT_WORKFLOW_SETTINGS),
    workflowArtifactLiveChanges: true,
    resumedFromRunId: null,
    campaignId: ORIGIN_SCOPE.campaignId,
  });
  expect(
    settleWorkflowTransition(db, { kind: "claim-queued-run", maxActiveRuns: 4 }),
  ).toMatchObject({ id: run.id });
  const call = startCallZero(db, run.id);
  expect(
    settleWorkflowTransition(db, {
      kind: "attach-call-thread",
      callId: call.id,
      threadId: "child-1",
    }),
  ).toBe(true);
  return { run, call, s0 };
}

function startCallZero(db: Db, runId: string): WorkflowCallRow {
  return settleWorkflowTransition(db, {
    kind: "start-call",
    runId,
    callIndex: 0,
    cacheKey: "call-zero",
    prompt: "Summarize the requirements",
    options: {
      selection: null,
      outputSchema: null,
      contextRequirement: null,
      contextProfile: null,
      title: null,
      phase: null,
    },
    selection: {
      providerId: "codex",
      model: "gpt-test",
      reasoningLevel: "medium",
      permissionMode: "full",
    },
    replay: null,
  });
}

/** Seed artifact bytes, then exercise the production admission transaction. */
function seedCommittedContractTransition(
  db: Db,
  input: { revision: number; changeId: string; affectedCallIds: string[] },
): { sequence: number; oldSnapshot: string | null; newSnapshot: string } {
  storeRequirementsRevision(db, {
    revision: input.revision,
    content: `# Requirements v${input.revision}\n`,
    status: "accepted-pending-impact",
  });
  return settleWorkflowTransition(db, {
    kind: "admit-contract-change",
    scope: ORIGIN_SCOPE,
    changeId: input.changeId,
    presentationThreadId: PRESENTATION_THREAD,
    artifactId: REQUIREMENTS_ARTIFACT,
    artifactRevision: input.revision,
    affectedCallIds: input.affectedCallIds,
  });
}

describe("effectful settlement walking skeleton", () => {
  const harnesses: Array<ReturnType<typeof setup>["harness"]> = [];

  afterEach(async () => {
    await Promise.all(harnesses.map((harness) => harness.dispose()));
    harnesses.length = 0;
  });

  it("retains an S0 result as stale evidence across restart", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const { db, service } = test.openProduction(test.bb);

    const run = await service.start({
      projectId: "project-test",
      originThreadId: "origin",
      source: LIVE_STRUCTURED_SOURCE,
      args: null,
      resumedFromRunId: null,
      campaignId: null,
      presentationThreadId: PRESENTATION_THREAD,
    });
    ORIGIN_SCOPE = contractScopeOfRun(getRunRequired(db, run.id));
    expect(ORIGIN_SCOPE).toEqual({
      campaignId: run.id,
      projectId: "project-test",
      environmentId: "environment-1",
    });
    expect(getRunRequired(db, run.id).presentationThreadId).toBe(
      PRESENTATION_THREAD,
    );

    // Revision 1 admitted before dispatch: the call is scheduled on S0.
    storeRequirementsRevision(db, {
      revision: 1,
      content: "# Requirements v1\n",
      status: "admitted",
    });
    const s0 = currentContractSnapshot(db, ORIGIN_SCOPE);
    expect(s0).toMatch(/^cs1:[0-9a-f]{64}$/);

    const controller = new AbortController();
    const worker = service.runWorker(controller.signal);
    // A failed assertion must still stop the worker before the harness
    // closes the database.
    const stopWorker = async () => {
      controller.abort();
      await worker;
    };
    let call!: WorkflowCallRow;
    let s1: string | null = null;
    try {
      await eventually(() => {
        expect(listCallsForRun(db, run.id)).toMatchObject([
          { status: "running", childThreadId: "child-1" },
        ]);
      });
      call = listCallsForRun(db, run.id)[0]!;
      expect(callContractSnapshot(db, call.id)).toBe(s0);

      // U6's already-committed transition is fixture-seeded; U0 consumes its
      // revision, change, and interlock rows without owning admission.
      const admission = seedCommittedContractTransition(db, {
        revision: 2,
        changeId: "change-1",
        affectedCallIds: [call.id],
      });
      expect(admission).toMatchObject({
        sequence: 1,
        oldSnapshot: s0,
      });
      s1 = currentContractSnapshot(db, ORIGIN_SCOPE);
      expect(s1).toMatch(/^cs1:[0-9a-f]{64}$/);
      expect(s1).not.toBe(s0);
      expect(revisionStatuses(db)).toEqual([
        { revision: 1, status: "superseded" },
        { revision: 2, status: "admitted" },
      ]);
      expect(listContractInterlocksForCall(db, call.id)).toMatchObject([
        {
          changeId: "change-1",
          requiredSequence: 1,
          oldSnapshot: s0,
          newSnapshot: s1,
          state: "pending",
        },
      ]);

      // The worker submits its S0 result through the production settlement path.
      const sendsBeforeSubmission =
        test.harness.sdk.callsTo("threads.send").length;
      const submitted = await service.submitStructuredResult("child-1", {
        answer: 42,
      });
      expect(submitted).toMatchObject({ ok: false, terminal: false });
      if (submitted.ok) throw new Error("unreachable");
      expect(submitted.error).toMatch(/stale evidence/);

      // Retained, but neither settled nor promoted.
      expect(getCall(db, run.id, 0)).toMatchObject({
        status: "running",
        resultJson: null,
        error: null,
      });
      expect(getRunRequired(db, run.id)).toMatchObject({
        status: "running",
        resultJson: null,
      });
      expect(listStaleEvidenceForCall(db, call.id)).toMatchObject([
        {
          writer: "structured-result",
          evidenceSnapshot: s0,
          blockingChangeId: "change-1",
          blockingSequence: 1,
          payloadJson: JSON.stringify({ answer: 42 }),
        },
      ]);
      // A stale result never wakes the workflow into a repair turn either.
      expect(test.harness.sdk.callsTo("threads.send")).toHaveLength(
        sendsBeforeSubmission,
      );
    } catch (error) {
      await stopWorker();
      throw error;
    }
    // Production shutdown: the worker's recovery pass must not promote the
    // interlocked call.
    await stopWorker();
    expect(getCall(db, run.id, 0)).toMatchObject({
      status: "cancelled",
      resultJson: null,
    });
    expect(getRunRequired(db, run.id).status).toBe("queued");

    // Close and reopen the file-backed database through the production
    // composition; the ledger is append-only so nothing re-applies.
    db.close();
    const reopened = test.openProduction(test.bb);
    expect(reopened.db).not.toBe(db);
    expect(reopened.db.open).toBe(true);

    expect(currentContractSnapshot(reopened.db, ORIGIN_SCOPE)).toBe(s1);
    expect(revisionStatuses(reopened.db)).toEqual([
      { revision: 1, status: "superseded" },
      { revision: 2, status: "admitted" },
    ]);
    expect(
      getContractChange(reopened.db, ORIGIN_SCOPE, "change-1"),
    ).toMatchObject({
      changeId: "change-1",
      sequence: 1,
      presentationThreadId: PRESENTATION_THREAD,
      artifactId: REQUIREMENTS_ARTIFACT,
      artifactRevision: 2,
      oldSnapshot: s0,
      newSnapshot: s1,
    });
    expect(listContractInterlocksForCall(reopened.db, call.id)).toMatchObject([
      {
        changeId: "change-1",
        state: "pending",
        oldSnapshot: s0,
        newSnapshot: s1,
      },
    ]);
    expect(listStaleEvidenceForCall(reopened.db, call.id)).toMatchObject([
      {
        writer: "structured-result",
        evidenceSnapshot: s0,
        blockingChangeId: "change-1",
      },
    ]);
    expect(callContractSnapshot(reopened.db, call.id)).toBe(s0);
    expect(getCall(reopened.db, run.id, 0)).toMatchObject({
      status: "cancelled",
      resultJson: null,
    });

  });

  it("does not let restart recovery auto-succeed a stored S0 result behind an interlock", () => {
    const test = setup();
    harnesses.push(test.harness);
    const { db } = test.openProduction(test.bb);
    ORIGIN_SCOPE = { ...ORIGIN_SCOPE, campaignId: "campaign-1" };
    storeRequirementsRevision(db, {
      revision: 1,
      content: "# Requirements v1\n",
      status: "admitted",
    });
    const s0 = currentContractSnapshot(db, ORIGIN_SCOPE);

    const run = createRun(db, {
      projectId: ORIGIN_SCOPE.projectId,
      originThreadId: "origin",
      presentationThreadId: PRESENTATION_THREAD,
      parentRunId: null,
      rootRunId: "",
      environmentId: ORIGIN_SCOPE.environmentId,
      originProvider: "codex",
      originModel: "gpt-test",
      originReasoningLevel: "medium",
      originPermissionMode: "full",
      name: "recovery",
      source: LIVE_STRUCTURED_SOURCE,
      sourceHash: "hash",
      argsJson: "null",
      settingsJson: JSON.stringify(DEFAULT_WORKFLOW_SETTINGS),
      workflowArtifactLiveChanges: true,
      resumedFromRunId: null,
      campaignId: ORIGIN_SCOPE.campaignId,
    });
    expect(
      settleWorkflowTransition(db, {
        kind: "claim-queued-run",
        maxActiveRuns: 4,
      }),
    ).toMatchObject({ id: run.id });
    const call = settleWorkflowTransition(db, {
      kind: "start-call",
      runId: run.id,
      callIndex: 0,
      cacheKey: "recovery-call",
      prompt: "Summarize the requirements",
      options: {
        selection: null,
        outputSchema: null,
        contextRequirement: null,
        contextProfile: null,
        title: null,
        phase: null,
      },
      selection: {
        providerId: "codex",
        model: "gpt-test",
        reasoningLevel: "medium",
        permissionMode: "full",
      },
      replay: null,
    });
    expect(
      settleWorkflowTransition(db, {
        kind: "attach-call-thread",
        callId: call.id,
        threadId: "child-1",
      }),
    ).toBe(true);
    // The result lands on S0 before the change is admitted: a legitimate
    // pre-settlement window that restart recovery would otherwise promote.
    expect(
      settleWorkflowTransition(db, {
        kind: "store-structured-result",
        callId: call.id,
        result: { answer: 7 },
      }),
    ).toBe("accepted");
    expect(
      seedCommittedContractTransition(db, {
        revision: 2,
        changeId: "change-1",
        affectedCallIds: [call.id],
      }),
    ).toMatchObject({ sequence: 1 });

    const recovered = settleWorkflowTransition(db, {
      kind: "recover-interrupted-runs",
    });
    expect(recovered).toEqual({
      childThreadIds: ["child-1"],
      staleResultsRetained: 1,
    });
    expect(getCall(db, run.id, 0)).toMatchObject({ status: "cancelled" });
    expect(getRunRequired(db, run.id).status).toBe("queued");
    expect(listStaleEvidenceForCall(db, call.id)).toMatchObject([
      {
        writer: "recovery",
        evidenceSnapshot: s0,
        blockingChangeId: "change-1",
        payloadJson: JSON.stringify({ answer: 7 }),
      },
    ]);
    expect(listContractInterlocksForCall(db, call.id)).toMatchObject([
      { state: "pending" },
    ]);
  });

  it("keeps feature-off runs on a null snapshot and settles them unchanged", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const { db, service } = test.openProduction(test.bb);
    const run = await service.start({
      projectId: "project-test",
      originThreadId: "origin",
      source: STRUCTURED_SOURCE,
      args: null,
      resumedFromRunId: null,
      campaignId: null,
      presentationThreadId: null,
    });
    ORIGIN_SCOPE = contractScopeOfRun(run);
    storeRequirementsRevision(db, {
      revision: 1,
      content: "# Admitted but dark\n",
      status: "admitted",
    });
    expect(currentContractSnapshot(db, ORIGIN_SCOPE)).not.toBeNull();
    const controller = new AbortController();
    const worker = service.runWorker(controller.signal);
    await eventually(() => {
      expect(listCallsForRun(db, run.id)).toMatchObject([
        { status: "running" },
      ]);
    });
    const call = listCallsForRun(db, run.id)[0]!;
    expect(callContractSnapshot(db, call.id)).toBeNull();
    expect(
      await service.submitStructuredResult(call.childThreadId!, { answer: 1 }),
    ).toEqual({ ok: true });
    await eventually(() => {
      expect(getRunRequired(db, run.id)).toMatchObject({
        status: "succeeded",
        resultJson: JSON.stringify({ answer: 1 }),
      });
    });
    expect(listStaleEvidenceForCall(db, call.id)).toEqual([]);

    // A feature-off resumed run preserves the pre-interlock replay identity:
    // the null snapshot matches the source call, so production reuses its
    // result without creating another child worker.
    const resumed = await service.start({
      projectId: "project-test",
      originThreadId: "origin",
      source: STRUCTURED_SOURCE,
      args: null,
      resumedFromRunId: run.id,
      campaignId: null,
      presentationThreadId: null,
    });
    await eventually(() => {
      expect(getRunRequired(db, resumed.id)).toMatchObject({
        status: "succeeded",
        resultJson: JSON.stringify({ answer: 1 }),
      });
    });
    expect(listCallsForRun(db, resumed.id)).toMatchObject([
      {
        status: "succeeded",
        replayedFromCallId: call.id,
        replaySource: "resumed-run",
      },
    ]);
    expect(test.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    controller.abort();
    await worker;
  });

  it("keeps a redispatched call pending until a later acknowledgement advances its exact edge", () => {
    const test = setup();
    harnesses.push(test.harness);
    const { db } = test.openProduction(test.bb);
    const { run, call, s0 } = dispatchRunningCall(db, "redispatch");
    expect(
      seedCommittedContractTransition(db, {
        revision: 2,
        changeId: "change-1",
        affectedCallIds: [call.id],
      }),
    ).toMatchObject({ sequence: 1, oldSnapshot: s0 });
    const s1 = currentContractSnapshot(db, ORIGIN_SCOPE);
    expect(s1).not.toBe(s0);

    // Restart: the interlocked call is cancelled and the run requeued.
    expect(
      settleWorkflowTransition(db, { kind: "recover-interrupted-runs" }),
    ).toEqual({ childThreadIds: ["child-1"], staleResultsRetained: 0 });
    expect(getCall(db, run.id, 0)).toMatchObject({ status: "cancelled" });
    expect(listContractInterlocksForCall(db, call.id)).toMatchObject([
      { changeId: "change-1", state: "pending" },
    ]);

    // Reclaim and re-dispatch binds S1 but never constitutes adoption.
    expect(
      settleWorkflowTransition(db, { kind: "claim-queued-run", maxActiveRuns: 4 }),
    ).toMatchObject({ id: run.id });
    const redispatched = startCallZero(db, run.id);
    expect(redispatched.id).toBe(call.id);
    expect(redispatched.status).toBe("queued");
    expect(callContractSnapshot(db, call.id)).toBe(s1);
    // Admission won this dispatch race: the production pre-spawn claim leaves
    // the call queued, so service.ts cannot create a child side effect.
    expect(
      settleWorkflowTransition(db, {
        kind: "claim-call-dispatch",
        callId: call.id,
      }),
    ).toMatchObject({ kind: "blocked", block: { changeId: "change-1" } });
    expect(listContractInterlocksForCall(db, call.id)).toMatchObject([
      { changeId: "change-1", oldSnapshot: s0, newSnapshot: s1, state: "pending" },
    ]);
    expect(
      settleWorkflowTransition(db, {
        kind: "attach-call-thread",
        callId: call.id,
        threadId: "child-2",
      }),
    ).toBe(true);
    expect(
      settleWorkflowTransition(db, {
        kind: "store-structured-result",
        callId: call.id,
        result: { answer: 1 },
      }),
    ).toBe("stale");
    expect(
      settleWorkflowTransition(db, {
        kind: "settle-call",
        id: call.id,
        status: "succeeded",
        result: { answer: 1 },
        error: null,
      }),
    ).toMatchObject({ kind: "stale", runId: run.id });
    expect(getCall(db, run.id, 0)).toMatchObject({
      status: "running",
      resultJson: null,
    });
    // Both receipts can share a millisecond timestamp; their stable storage
    // order is not their terminal-writer contract. Assert the retained set.
    expect(
      listStaleEvidenceForCall(db, call.id).sort((left, right) =>
        left.writer.localeCompare(right.writer),
      ),
    ).toMatchObject([
      { writer: "settle-call", blockingChangeId: "change-1" },
      { writer: "structured-result", blockingChangeId: "change-1" },
    ]);
  });

  it("chains stacked interlocks, dedupes affected calls, and retains identical stale evidence once", () => {
    const test = setup();
    harnesses.push(test.harness);
    const { db } = test.openProduction(test.bb);
    const { run, call, s0 } = dispatchRunningCall(db, "chain");

    // Duplicate affected ids collapse to one interlock instead of a
    // primary-key violation.
    expect(
      seedCommittedContractTransition(db, {
        revision: 2,
        changeId: "change-1",
        affectedCallIds: [call.id, call.id],
      }),
    ).toMatchObject({ sequence: 1 });
    const s1 = currentContractSnapshot(db, ORIGIN_SCOPE);
    // N+1 while N is unsettled bridges from N's newSnapshot, not from the
    // call's still-bound S0.
    expect(
      seedCommittedContractTransition(db, {
        revision: 3,
        changeId: "change-2",
        affectedCallIds: [call.id],
      }),
    ).toMatchObject({ sequence: 2 });
    const s2 = currentContractSnapshot(db, ORIGIN_SCOPE);
    expect(new Set([s0, s1, s2]).size).toBe(3);
    expect(listContractInterlocksForCall(db, call.id)).toMatchObject([
      { changeId: "change-1", requiredSequence: 1, oldSnapshot: s0, newSnapshot: s1, state: "pending" },
      { changeId: "change-2", requiredSequence: 2, oldSnapshot: s1, newSnapshot: s2, state: "pending" },
    ]);
    expect(callContractSnapshot(db, call.id)).toBe(s0);

    // The worker retries the same stale result: still stale, one receipt.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(
        settleWorkflowTransition(db, {
          kind: "store-structured-result",
          callId: call.id,
          result: { answer: 9 },
        }),
      ).toBe("stale");
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        settleWorkflowTransition(db, {
          kind: "settle-call",
          id: call.id,
          status: "succeeded",
          result: { answer: 9 },
          error: null,
        }),
      ).toMatchObject({ kind: "stale", block: { changeId: "change-1" } });
    }
    // Rows written in the same millisecond tie on recorded_at; compare by writer.
    expect(
      listStaleEvidenceForCall(db, call.id).sort((left, right) =>
        left.writer.localeCompare(right.writer),
      ),
    ).toMatchObject([
      { writer: "settle-call", blockingChangeId: "change-1", blockingSequence: 1, payloadJson: JSON.stringify({ answer: 9 }) },
      { writer: "structured-result", blockingChangeId: "change-1", blockingSequence: 1, payloadJson: JSON.stringify({ answer: 9 }) },
    ]);
    // A different payload is new evidence.
    expect(
      settleWorkflowTransition(db, {
        kind: "store-structured-result",
        callId: call.id,
        result: { answer: 10 },
      }),
    ).toBe("stale");
    expect(listStaleEvidenceForCall(db, call.id)).toHaveLength(3);
    expect(getCall(db, run.id, 0)).toMatchObject({ status: "running", resultJson: null });
  });

  it("derives revision-status literals from the closed set enforced by the artifact schema", () => {
    const test = setup();
    harnesses.push(test.harness);
    const { db } = test.openProduction(test.bb);
    const { sql } = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_artifact_revisions'`,
      )
      .get() as { sql: string };
    const check = /status\s+TEXT\s+NOT\s+NULL\s+CHECK\(status\s+IN\s+\(([^)]*)\)\)/.exec(sql);
    expect(check).not.toBeNull();
    const schemaStatuses = check![1]!
      .split(",")
      .map((literal) => literal.trim().replace(/^'|'$/g, ""));
    expect(schemaStatuses).toEqual([...ARTIFACT_REVISION_STATUSES]);
  });

  it("keeps admission and dispatch claims in the production terminal kernel", () => {
    const sourceDirectory = join(__dirname);
    const kernel = readFileSync(
      join(sourceDirectory, "workflow-terminal-settlement.ts"),
      "utf8",
    );
    expect(kernel).toMatch(/admitContractChangeTransition/);
    expect(kernel).toMatch(/claimCallDispatchTransition/);
    const callers: string[] = [];
    for (const file of readdirSync(sourceDirectory)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      if (file === "workflow-terminal-settlement.ts") continue;
      if (/\badmitContractChangeTransition\b|\bclaimCallDispatchTransition\b/.test(readFileSync(join(sourceDirectory, file), "utf8"))) {
        callers.push(file);
      }
    }
    expect(callers).toEqual([]);
  });

  it("owns every run/call status and result writer", () => {
    const sourceDirectory = join(__dirname);
    const offenders: string[] = [];
    for (const file of readdirSync(sourceDirectory)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      if (file === "workflow-terminal-settlement.ts") continue;
      const source = readFileSync(join(sourceDirectory, file), "utf8");
      for (const match of source.matchAll(
        /UPDATE\s+workflow_(?:runs|calls)\s+SET\s+([\s\S]*?)\s+WHERE/g,
      )) {
        if (/\b(?:status|result_json)\s*=/.test(match[1]!)) {
          offenders.push(`${file}: ${match[0].replace(/\s+/g, " ")}`);
        }
      }
      if (/INSERT\s+INTO\s+workflow_calls\b/.test(source)) {
        offenders.push(`${file}: INSERT INTO workflow_calls`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
