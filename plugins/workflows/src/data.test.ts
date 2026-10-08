import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  attachCallThread,
  cancelRun,
  countCallsForRun,
  createRun,
  deleteExpiredTerminalRuns,
  getCall,
  getRunRequired,
  incrementRepairAttempts,
  listCallsForRunPage,
  migrations,
  queueCallProviderRetry,
  recordCallContextUsage,
  recoverInterruptedRuns,
  settleCall,
  settleRun,
  startCall,
  storeStructuredResult,
} from "./data.js";

describe("workflow durable data", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(migrations.join("\n"));
  });

  afterEach(() => db.close());

  function newRun() {
    return createRun(db, {
      projectId: "project-1",
      originThreadId: "thread-1",
      environmentId: "environment-1",
      originProvider: "codex",
      originModel: "gpt-test",
      originReasoningLevel: "medium",
      originPermissionMode: "full",
      name: "test-workflow",
      source: "return null",
      sourceHash: "hash",
      argsJson: "null",
      settingsJson:
        '{"maxActiveRuns":4,"maxConcurrentAgents":8,"maxAgentCalls":100,"totalRunTimeoutMs":86400000,"retentionDays":30,"maxNotificationBytes":16384}',
      resumedFromRunId: null,
    });
  }

  function markRunning(runId: string): void {
    db.prepare(`UPDATE workflow_runs SET status = 'running' WHERE id = ?`).run(
      runId,
    );
  }

  const resolvedSelection = {
    providerId: "codex",
    model: "gpt-test",
    reasoningLevel: "medium",
    permissionMode: "full",
  } as const;

  // Frozen compatibility fixture from the strict stored-options reader in
  // the base build. New durable fields must not leak into options_json.
  const baseStoredAgentOptionsSchema = z
    .object({
      selection: z
        .object({
          provider: z.string().min(1),
          model: z.string().min(1),
          reasoningLevel: z.string().min(1),
        })
        .strict()
        .nullable(),
      outputSchema: z.unknown().nullable(),
      title: z.string().min(1).nullable(),
      phase: z.string().min(1).nullable(),
    })
    .strict();

  it("records replay safety without a concurrency barrier", () => {
    const run = newRun();
    expect(getRunRequired(db, run.id)).toMatchObject({
      replaySafetyVersion: 1,
      replayBarrierIndex: null,
    });

    markRunning(run.id);
    expect(recoverInterruptedRuns(db)).toEqual([]);
    expect(getRunRequired(db, run.id)).toMatchObject({
      status: "queued",
      replaySafetyVersion: 1,
      replayBarrierIndex: null,
    });

    db.prepare(
      `UPDATE workflow_runs SET replay_safety_version = 0,
       replay_barrier_index = NULL WHERE id = ?`,
    ).run(run.id);
    expect(getRunRequired(db, run.id)).toMatchObject({
      replaySafetyVersion: 0,
      replayBarrierIndex: null,
    });
  });

  it("backfills UTF-8 prompt bytes when adding context telemetry", () => {
    const legacy = new Database(":memory:");
    try {
      legacy.pragma("foreign_keys = ON");
      legacy.exec(migrations.slice(0, -3).join("\n"));
      const run = createRun(legacy, {
        projectId: "project-1",
        originThreadId: "thread-1",
        environmentId: "environment-1",
        originProvider: "codex",
        originModel: "gpt-test",
        originReasoningLevel: "medium",
        originPermissionMode: "full",
        name: "legacy-workflow",
        source: "return null",
        sourceHash: "hash",
        argsJson: "null",
        settingsJson:
          '{"maxActiveRuns":4,"maxConcurrentAgents":8,"maxAgentCalls":100,"totalRunTimeoutMs":86400000,"retentionDays":30,"maxNotificationBytes":16384}',
        resumedFromRunId: null,
      });
      legacy
        .prepare(
          `INSERT INTO workflow_calls (
             id, run_id, call_index, cache_key, prompt, options_json,
             resolved_provider, resolved_model, resolved_reasoning_level,
             resolved_permission_mode, status, created_at
           ) VALUES (?, ?, 0, 'cache', ?, '{}', 'codex', 'gpt-test',
             'medium', 'full', 'succeeded', 1)`,
        )
        .run("wfc_legacy", run.id, "é");

      legacy.exec(migrations.at(-3)!);

      expect(
        legacy
          .prepare(
            `SELECT prompt_bytes AS promptBytes,
                    observed_context_used_tokens AS usedTokens,
                    observed_model_context_window AS modelContextWindow,
                    context_usage_estimated AS estimated
             FROM workflow_calls WHERE id = ?`,
          )
          .get("wfc_legacy"),
      ).toEqual({
        promptBytes: 2,
        usedTokens: null,
        modelContextWindow: null,
        estimated: null,
      });
    } finally {
      legacy.close();
    }
  });

  it("adds context requirements without rewriting legacy call options", () => {
    const legacy = new Database(":memory:");
    try {
      legacy.pragma("foreign_keys = ON");
      legacy.exec(migrations.slice(0, -2).join("\n"));
      const run = createRun(legacy, {
        projectId: "project-1",
        originThreadId: "thread-1",
        environmentId: "environment-1",
        originProvider: "codex",
        originModel: "gpt-test",
        originReasoningLevel: "medium",
        originPermissionMode: "full",
        name: "legacy-workflow",
        source: "return null",
        sourceHash: "hash",
        argsJson: "null",
        settingsJson:
          '{"maxActiveRuns":4,"maxConcurrentAgents":8,"maxAgentCalls":100,"totalRunTimeoutMs":86400000,"retentionDays":30,"maxNotificationBytes":16384}',
        resumedFromRunId: null,
      });
      legacy
        .prepare(
          `INSERT INTO workflow_calls (
             id, run_id, call_index, cache_key, prompt, options_json,
             resolved_provider, resolved_model, resolved_reasoning_level,
             resolved_permission_mode, status, created_at
           ) VALUES (?, ?, 0, 'cache', 'inspect', ?, 'codex', 'gpt-test',
             'medium', 'full', 'succeeded', 1)`,
        )
        .run(
          "wfc_legacy_options",
          run.id,
          '{"selection":null,"outputSchema":null,"title":null,"phase":null}',
        );

      legacy.exec(migrations.at(-2)!);

      expect(
        legacy
          .prepare(
            `SELECT options_json AS optionsJson,
                    context_minimum_tokens AS contextMinimumTokens
             FROM workflow_calls WHERE id = ?`,
          )
          .get("wfc_legacy_options"),
      ).toEqual({
        optionsJson:
          '{"selection":null,"outputSchema":null,"title":null,"phase":null}',
        contextMinimumTokens: null,
      });
    } finally {
      legacy.close();
    }
  });

  it("adds phase context profiles without rewriting legacy call options", () => {
    const legacy = new Database(":memory:");
    try {
      legacy.pragma("foreign_keys = ON");
      legacy.exec(migrations.slice(0, -1).join("\n"));
      const run = createRun(legacy, {
        projectId: "project-1",
        originThreadId: "thread-1",
        environmentId: "environment-1",
        originProvider: "codex",
        originModel: "gpt-test",
        originReasoningLevel: "medium",
        originPermissionMode: "full",
        name: "legacy-workflow",
        source: "return null",
        sourceHash: "hash",
        argsJson: "null",
        settingsJson:
          '{"maxActiveRuns":4,"maxConcurrentAgents":8,"maxAgentCalls":100,"totalRunTimeoutMs":86400000,"retentionDays":30,"maxNotificationBytes":16384}',
        resumedFromRunId: null,
      });
      legacy
        .prepare(
          `INSERT INTO workflow_calls (
             id, run_id, call_index, cache_key, prompt, options_json,
             resolved_provider, resolved_model, resolved_reasoning_level,
             resolved_permission_mode, status, created_at
           ) VALUES (?, ?, 0, 'cache', 'inspect', ?, 'codex', 'gpt-test',
             'medium', 'full', 'succeeded', 1)`,
        )
        .run(
          "wfc_legacy_profile",
          run.id,
          '{"selection":null,"outputSchema":null,"title":null,"phase":null}',
        );

      legacy.exec(migrations.at(-1)!);

      expect(
        legacy
          .prepare(
            `SELECT options_json AS optionsJson,
                    context_profile_json AS contextProfileJson
             FROM workflow_calls WHERE id = ?`,
          )
          .get("wfc_legacy_profile"),
      ).toEqual({
        optionsJson:
          '{"selection":null,"outputSchema":null,"title":null,"phase":null}',
        contextProfileJson: null,
      });
    } finally {
      legacy.close();
    }
  });

  it("stores successful calls for deterministic replay", () => {
    const run = newRun();
    markRunning(run.id);
    const call = startCall(db, {
      runId: run.id,
      callIndex: 0,
      cacheKey: "cache",
      prompt: "inspect",
      options: {
        selection: null,
        outputSchema: null,
        contextRequirement: null,
        contextProfile: null,
        title: null,
        phase: null,
      },
      selection: resolvedSelection,
      replay: null,
    });
    settleCall(db, {
      id: call.id,
      status: "succeeded",
      result: { answer: 42 },
      error: null,
    });

    expect(getCall(db, run.id, 0)).toMatchObject({
      cacheKey: "cache",
      optionsJson:
        '{"selection":null,"outputSchema":null,"title":null,"phase":null}',
      promptBytes: 7,
      resolvedProvider: "codex",
      resolvedModel: "gpt-test",
      resolvedReasoningLevel: "medium",
      resolvedPermissionMode: "full",
      status: "succeeded",
      resultJson: '{"answer":42}',
      replaySource: null,
    });
  });

  it("stores context requirements and phase profiles outside rollback-readable options JSON", () => {
    const run = newRun();
    markRunning(run.id);
    const call = startCall(db, {
      runId: run.id,
      callIndex: 0,
      cacheKey: "rollback-readable-options",
      prompt: "inspect",
      options: {
        selection: null,
        outputSchema: null,
        contextRequirement: { minimumTokens: 1_000_000 },
        contextProfile: {
          requiredSkills: ["implementation-loop"],
          memoryQueries: ["workflow replay"],
          artifactRefs: [".architect/design/approved.md"],
          stopCondition: "targeted verification passes",
        },
        title: null,
        phase: null,
      },
      selection: resolvedSelection,
      replay: null,
    });

    const stored = db
      .prepare(
        `SELECT options_json AS optionsJson,
                context_minimum_tokens AS contextMinimumTokens,
                context_profile_json AS contextProfileJson
         FROM workflow_calls WHERE id = ?`,
      )
      .get(call.id) as {
      optionsJson: string;
      contextMinimumTokens: number | null;
      contextProfileJson: string | null;
    };
    expect(stored).toEqual({
      optionsJson:
        '{"selection":null,"outputSchema":null,"title":null,"phase":null}',
      contextMinimumTokens: 1_000_000,
      contextProfileJson:
        '{"requiredSkills":["implementation-loop"],"memoryQueries":["workflow replay"],"artifactRefs":[".architect/design/approved.md"],"stopCondition":"targeted verification passes"}',
    });
    expect(() =>
      baseStoredAgentOptionsSchema.parse(JSON.parse(stored.optionsJson)),
    ).not.toThrow();
    expect(getCall(db, run.id, 0)).toMatchObject({
      contextMinimumTokens: 1_000_000,
      contextProfileJson:
        '{"requiredSkills":["implementation-loop"],"memoryQueries":["workflow replay"],"artifactRefs":[".architect/design/approved.md"],"stopCondition":"targeted verification passes"}',
      optionsJson:
        '{"selection":null,"outputSchema":null,"title":null,"phase":null}',
    });
  });

  it("retains a coherent peak context observation", () => {
    const run = newRun();
    markRunning(run.id);
    const call = startCall(db, {
      runId: run.id,
      callIndex: 0,
      cacheKey: "context-fit",
      prompt: "inspect é",
      options: {
        selection: null,
        outputSchema: null,
        contextRequirement: { minimumTokens: 1_000_000 },
        contextProfile: null,
        title: null,
        phase: null,
      },
      selection: resolvedSelection,
      replay: null,
    });

    recordCallContextUsage(db, call.id, {
      usedTokens: null,
      modelContextWindow: null,
      estimated: true,
    });
    recordCallContextUsage(db, call.id, {
      usedTokens: 180_000,
      modelContextWindow: 258_400,
      estimated: true,
    });
    recordCallContextUsage(db, call.id, {
      usedTokens: 160_000,
      modelContextWindow: null,
      estimated: false,
    });

    expect(getCall(db, run.id, 0)).toMatchObject({
      promptBytes: Buffer.byteLength("inspect é", "utf8"),
      observedContextUsedTokens: 180_000,
      observedModelContextWindow: 258_400,
      contextUsageEstimated: true,
    });

    recordCallContextUsage(db, call.id, {
      usedTokens: 180_000,
      modelContextWindow: 1_000_000,
      estimated: false,
    });
    recordCallContextUsage(db, call.id, {
      usedTokens: 180_000,
      modelContextWindow: 200_000,
      estimated: true,
    });
    expect(getCall(db, run.id, 0)).toMatchObject({
      observedContextUsedTokens: 180_000,
      observedModelContextWindow: 1_000_000,
      contextUsageEstimated: false,
    });

    const laterPeak = startCall(db, {
      runId: run.id,
      callIndex: 1,
      cacheKey: "context-fit-later-peak",
      prompt: "inspect later",
      options: {
        selection: null,
        outputSchema: null,
        contextRequirement: null,
        contextProfile: null,
        title: null,
        phase: null,
      },
      selection: resolvedSelection,
      replay: null,
    });
    recordCallContextUsage(db, laterPeak.id, {
      usedTokens: 160_000,
      modelContextWindow: 1_000_000,
      estimated: false,
    });
    recordCallContextUsage(db, laterPeak.id, {
      usedTokens: 180_000,
      modelContextWindow: 258_400,
      estimated: true,
    });
    expect(getCall(db, run.id, 1)).toMatchObject({
      observedContextUsedTokens: 180_000,
      observedModelContextWindow: 258_400,
      contextUsageEstimated: true,
    });
  });

  it("copies context observations into a resumed replay row", () => {
    const sourceRun = newRun();
    markRunning(sourceRun.id);
    const source = startCall(db, {
      runId: sourceRun.id,
      callIndex: 0,
      cacheKey: "context-replay",
      prompt: "inspect",
      options: {
        selection: null,
        outputSchema: null,
        contextRequirement: { minimumTokens: 1_000_000 },
        contextProfile: null,
        title: null,
        phase: null,
      },
      selection: resolvedSelection,
      replay: null,
    });
    recordCallContextUsage(db, source.id, {
      usedTokens: 300_000,
      modelContextWindow: 1_000_000,
      estimated: false,
    });
    settleCall(db, {
      id: source.id,
      status: "succeeded",
      result: { answer: 42 },
      error: null,
    });
    const measuredSource = getCall(db, sourceRun.id, 0);
    expect(measuredSource).not.toBeNull();

    const resumedRun = newRun();
    markRunning(resumedRun.id);
    const replay = startCall(db, {
      runId: resumedRun.id,
      callIndex: 0,
      cacheKey: "context-replay",
      prompt: "inspect",
      options: {
        selection: null,
        outputSchema: null,
        contextRequirement: { minimumTokens: 1_000_000 },
        contextProfile: null,
        title: null,
        phase: null,
      },
      selection: resolvedSelection,
      replay: {
        callId: source.id,
        result: { answer: 42 },
        observedContextUsedTokens: measuredSource!.observedContextUsedTokens,
        observedModelContextWindow: measuredSource!.observedModelContextWindow,
        contextUsageEstimated: measuredSource!.contextUsageEstimated,
      },
    });

    expect(replay).toMatchObject({
      status: "succeeded",
      replayedFromCallId: source.id,
      replaySource: "resumed-run",
      observedContextUsedTokens: 300_000,
      observedModelContextWindow: 1_000_000,
      contextUsageEstimated: false,
    });
  });

  it("persists provider retry attempts across worker replacements", () => {
    const run = newRun();
    markRunning(run.id);
    const call = startCall(db, {
      runId: run.id,
      callIndex: 0,
      cacheKey: "retry",
      prompt: "inspect",
      options: {
        selection: null,
        outputSchema: null,
        contextRequirement: null,
        contextProfile: null,
        title: null,
        phase: null,
      },
      selection: resolvedSelection,
      replay: null,
    });
    expect(attachCallThread(db, call.id, "child-1")).toBe(true);
    settleCall(db, {
      id: call.id,
      status: "failed",
      result: null,
      error: "provider overloaded",
    });

    expect(
      queueCallProviderRetry(db, call.id, "provider overloaded"),
    ).toMatchObject({
      status: "queued",
      childThreadId: null,
      providerRetryAttempts: 1,
      error: "provider overloaded",
    });
    expect(attachCallThread(db, call.id, "child-2")).toBe(true);
    expect(getCall(db, run.id, 0)).toMatchObject({
      status: "running",
      childThreadId: "child-2",
      providerRetryAttempts: 1,
      error: null,
    });
  });

  it("pages calls by stable index and counts statuses without loading history", () => {
    const run = newRun();
    markRunning(run.id);
    const calls = [0, 1, 2].map((callIndex) =>
      startCall(db, {
        runId: run.id,
        callIndex,
        cacheKey: `cache-${callIndex}`,
        prompt: `inspect ${callIndex}`,
        options: {
          selection: null,
          outputSchema: null,
          contextRequirement: null,
          contextProfile: null,
          title: null,
          phase: null,
        },
        selection: resolvedSelection,
        replay: null,
      }),
    );
    settleCall(db, {
      id: calls[0]!.id,
      status: "succeeded",
      result: "done",
      error: null,
    });
    settleCall(db, {
      id: calls[1]!.id,
      status: "failed",
      result: null,
      error: "failed",
    });
    expect(attachCallThread(db, calls[2]!.id, "child-2")).toBe(true);

    expect(
      listCallsForRunPage(db, {
        runId: run.id,
        afterCallIndex: -1,
        limit: 2,
      }).map((call) => call.callIndex),
    ).toEqual([0, 1]);
    expect(
      listCallsForRunPage(db, {
        runId: run.id,
        afterCallIndex: 1,
        limit: 2,
      }).map((call) => call.callIndex),
    ).toEqual([2]);
    expect(countCallsForRun(db, run.id)).toEqual({
      total: 3,
      queued: 0,
      running: 1,
      succeeded: 1,
      failed: 1,
      cancelled: 0,
    });
  });

  it("requeues interrupted runs and records orphan workers", () => {
    const run = newRun();
    markRunning(run.id);
    const call = startCall(db, {
      runId: run.id,
      callIndex: 0,
      cacheKey: "cache",
      prompt: "inspect",
      options: {
        selection: null,
        outputSchema: null,
        contextRequirement: null,
        contextProfile: null,
        title: null,
        phase: null,
      },
      selection: resolvedSelection,
      replay: null,
    });
    db.prepare(
      `UPDATE workflow_calls SET status = 'running', child_thread_id = 'child-1' WHERE id = ?`,
    ).run(call.id);

    expect(recoverInterruptedRuns(db)).toEqual(["child-1"]);
    expect(getRunRequired(db, run.id).status).toBe("queued");
    expect(getCall(db, run.id, 0)).toMatchObject({
      status: "cancelled",
      error: "Plugin restarted",
    });
  });

  it("persists JSON null but requires it to rerun instead of replaying", () => {
    const first = newRun();
    markRunning(first.id);
    const original = startCall(db, {
      runId: first.id,
      callIndex: 0,
      cacheKey: "null-cache",
      prompt: "return null",
      options: {
        selection: null,
        outputSchema: null,
        contextRequirement: null,
        contextProfile: null,
        title: null,
        phase: null,
      },
      selection: resolvedSelection,
      replay: null,
    });
    settleCall(db, {
      id: original.id,
      status: "succeeded",
      result: null,
      error: null,
    });
    expect(getCall(db, first.id, 0)?.resultJson).toBe("null");
    const second = createRun(db, {
      projectId: "project-1",
      originThreadId: "thread-1",
      environmentId: "environment-1",
      originProvider: "codex",
      originModel: "gpt-test",
      originReasoningLevel: "medium",
      originPermissionMode: "full",
      name: "test-workflow",
      source: "return null",
      sourceHash: "hash-2",
      argsJson: "null",
      settingsJson:
        '{"maxActiveRuns":4,"maxConcurrentAgents":8,"maxAgentCalls":100,"totalRunTimeoutMs":86400000,"retentionDays":30,"maxNotificationBytes":16384}',
      resumedFromRunId: first.id,
    });
    markRunning(second.id);
    startCall(db, {
      runId: second.id,
      callIndex: 0,
      cacheKey: "null-cache",
      prompt: "return null",
      options: {
        selection: null,
        outputSchema: null,
        contextRequirement: null,
        contextProfile: null,
        title: null,
        phase: null,
      },
      selection: resolvedSelection,
      replay: null,
    });

    expect(getCall(db, second.id, 0)).toMatchObject({
      status: "queued",
      resultJson: null,
      replayedFromCallId: null,
    });
  });

  it("atomically preserves the first structured value", () => {
    const run = newRun();
    markRunning(run.id);
    const call = startCall(db, {
      runId: run.id,
      callIndex: 0,
      cacheKey: "structured",
      prompt: "answer",
      options: {
        selection: null,
        outputSchema: { type: "object" },
        contextRequirement: null,
        contextProfile: null,
        title: null,
        phase: null,
      },
      selection: resolvedSelection,
      replay: null,
    });
    expect(attachCallThread(db, call.id, "child-structured")).toBe(true);

    expect(storeStructuredResult(db, call.id, { a: 1, b: 2 })).toBe("accepted");
    expect(storeStructuredResult(db, call.id, { b: 2, a: 1 })).toBe(
      "idempotent",
    );
    expect(storeStructuredResult(db, call.id, { a: 2, b: 1 })).toBe("conflict");
    expect(getCall(db, run.id, 0)?.resultJson).toBe('{"a":1,"b":2}');

    settleCall(db, {
      id: call.id,
      status: "succeeded",
      result: { a: 99 },
      error: null,
    });
    expect(storeStructuredResult(db, call.id, { b: 2, a: 1 })).toBe(
      "idempotent",
    );
    expect(storeStructuredResult(db, call.id, { a: 99 })).toBe("conflict");
  });

  it("uses one guarded repair counter and preserves accepted results on restart", () => {
    const run = newRun();
    markRunning(run.id);
    const call = startCall(db, {
      runId: run.id,
      callIndex: 0,
      cacheKey: "repair",
      prompt: "answer",
      options: {
        selection: null,
        outputSchema: { type: "number" },
        contextRequirement: null,
        contextProfile: null,
        title: null,
        phase: null,
      },
      selection: resolvedSelection,
      replay: null,
    });
    attachCallThread(db, call.id, "child-repair");

    expect(incrementRepairAttempts(db, call.id)).toBe(1);
    expect(incrementRepairAttempts(db, call.id)).toBe(2);
    expect(storeStructuredResult(db, call.id, null)).toBe("accepted");
    expect(incrementRepairAttempts(db, call.id)).toBeNull();

    expect(recoverInterruptedRuns(db)).toEqual(["child-repair"]);
    expect(getRunRequired(db, run.id).status).toBe("queued");
    expect(getCall(db, run.id, 0)).toMatchObject({
      status: "succeeded",
      repairAttempts: 2,
      resultJson: "null",
      error: null,
    });
  });

  it("persists a successful run result of JSON null and keeps terminal transitions idempotent", () => {
    const run = newRun();
    expect(cancelRun(db, run.id)).toBe(true);
    expect(cancelRun(db, run.id)).toBe(false);
    expect(
      settleRun(db, {
        id: run.id,
        status: "succeeded",
        result: "too late",
        error: null,
      }),
    ).toEqual([]);
    expect(getRunRequired(db, run.id)).toMatchObject({
      status: "cancelled",
      resultJson: null,
    });

    const successful = newRun();
    markRunning(successful.id);
    settleRun(db, {
      id: successful.id,
      status: "succeeded",
      result: null,
      error: null,
    });
    expect(getRunRequired(db, successful.id)).toMatchObject({
      status: "succeeded",
      resultJson: "null",
    });
  });

  it("atomically cancels outstanding calls when a parent settles", () => {
    const run = newRun();
    markRunning(run.id);
    const call = startCall(db, {
      runId: run.id,
      callIndex: 0,
      cacheKey: "fire-and-forget",
      prompt: "slow",
      options: {
        selection: null,
        outputSchema: null,
        contextRequirement: null,
        contextProfile: null,
        title: null,
        phase: null,
      },
      selection: resolvedSelection,
      replay: null,
    });
    db.prepare(
      `UPDATE workflow_calls SET status = 'running', child_thread_id = 'orphan' WHERE id = ?`,
    ).run(call.id);

    expect(
      settleRun(db, {
        id: run.id,
        status: "succeeded",
        result: "done",
        error: null,
      }),
    ).toMatchObject([{ id: call.id, childThreadId: "orphan" }]);
    expect(getRunRequired(db, run.id).status).toBe("succeeded");
    expect(getCall(db, run.id, 0)).toMatchObject({
      status: "cancelled",
      error: "Parent workflow finished before this call",
    });
  });

  it("allows call creation and attachment only while the parent is running", () => {
    const statuses = [
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ] as const;

    for (const status of statuses) {
      const creationRun = newRun();
      db.prepare(`UPDATE workflow_runs SET status = ? WHERE id = ?`).run(
        status,
        creationRun.id,
      );
      const create = () =>
        startCall(db, {
          runId: creationRun.id,
          callIndex: 0,
          cacheKey: `creation-${status}`,
          prompt: "state matrix",
          options: {
            selection: null,
            outputSchema: null,
            contextRequirement: null,
            contextProfile: null,
            title: null,
            phase: null,
          },
          selection: resolvedSelection,
          replay: null,
        });
      if (status === "running") {
        expect(create).not.toThrow();
        expect(getCall(db, creationRun.id, 0)).toMatchObject({
          status: "queued",
        });
      } else {
        expect(create).toThrow("is not running");
        expect(getCall(db, creationRun.id, 0)).toBeNull();
      }

      const attachmentRun = newRun();
      markRunning(attachmentRun.id);
      const call = startCall(db, {
        runId: attachmentRun.id,
        callIndex: 0,
        cacheKey: `attachment-${status}`,
        prompt: "state matrix",
        options: {
          selection: null,
          outputSchema: null,
          contextRequirement: null,
          contextProfile: null,
          title: null,
          phase: null,
        },
        selection: resolvedSelection,
        replay: null,
      });
      db.prepare(`UPDATE workflow_runs SET status = ? WHERE id = ?`).run(
        status,
        attachmentRun.id,
      );
      expect(attachCallThread(db, call.id, `matrix-child-${status}`)).toBe(
        status === "running",
      );
      expect(getCall(db, attachmentRun.id, 0)).toMatchObject({
        status: status === "running" ? "running" : "queued",
        childThreadId: status === "running" ? `matrix-child-${status}` : null,
      });
    }
  });

  it("retains active resume ancestry while deleting unrelated expired runs", () => {
    const parent = newRun();
    db.prepare(
      `UPDATE workflow_runs SET status = 'succeeded', notification_sent = 1,
       finished_at = ?, settings_json = json_set(settings_json, '$.retentionDays', 1)
       WHERE id = ?`,
    ).run(Date.now() - 3 * 86_400_000, parent.id);
    const retainedChild = createRun(db, {
      projectId: "project-1",
      originThreadId: "thread-1",
      environmentId: "environment-1",
      originProvider: "codex",
      originModel: "gpt-test",
      originReasoningLevel: "medium",
      originPermissionMode: "full",
      name: "retained-child",
      source: "return null",
      sourceHash: "child-hash",
      argsJson: "null",
      settingsJson:
        '{"maxActiveRuns":4,"maxConcurrentAgents":8,"maxAgentCalls":100,"totalRunTimeoutMs":86400000,"retentionDays":1,"maxNotificationBytes":16384}',
      resumedFromRunId: parent.id,
    });
    const expired = newRun();
    db.prepare(
      `UPDATE workflow_runs SET status = 'failed', notification_sent = 1,
       finished_at = ?, settings_json = json_set(settings_json, '$.retentionDays', 1)
       WHERE id = ?`,
    ).run(Date.now() - 3 * 86_400_000, expired.id);

    expect(deleteExpiredTerminalRuns(db, Date.now(), 100)).toBe(1);
    expect(getRunRequired(db, parent.id).id).toBe(parent.id);
    expect(getRunRequired(db, parent.id).replayBarrierIndex).toBeNull();
    expect(getRunRequired(db, retainedChild.id).status).toBe("queued");
    expect(() => getRunRequired(db, expired.id)).toThrow(
      "Unknown workflow run",
    );
  });

  it("deletes an entirely expired resume chain in one bounded sweep", () => {
    const parent = newRun();
    const child = createRun(db, {
      projectId: "project-1",
      originThreadId: "thread-1",
      environmentId: "environment-1",
      originProvider: "codex",
      originModel: "gpt-test",
      originReasoningLevel: "medium",
      originPermissionMode: "full",
      name: "expired-child",
      source: "return null",
      sourceHash: "expired-child-hash",
      argsJson: "null",
      settingsJson:
        '{"maxActiveRuns":4,"maxConcurrentAgents":8,"maxAgentCalls":100,"totalRunTimeoutMs":86400000,"retentionDays":1,"maxNotificationBytes":16384}',
      resumedFromRunId: parent.id,
    });
    db.prepare(
      `UPDATE workflow_runs SET status = 'succeeded', notification_sent = 1,
       finished_at = ?, settings_json = json_set(settings_json, '$.retentionDays', 1)
       WHERE id IN (?, ?)`,
    ).run(Date.now() - 3 * 86_400_000, parent.id, child.id);

    expect(deleteExpiredTerminalRuns(db, Date.now(), 100)).toBe(2);
    expect(() => getRunRequired(db, parent.id)).toThrow("Unknown workflow run");
    expect(() => getRunRequired(db, child.id)).toThrow("Unknown workflow run");
  });
});
