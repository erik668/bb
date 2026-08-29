import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  attachCallThread,
  cancelRun,
  countCallsForRun,
  countRunsForCampaign,
  createRun,
  deleteTerminalRuns,
  getCall,
  getLatestRunForThread,
  getFirstRunForCampaignScope,
  getRunRequired,
  incrementRepairAttempts,
  listWorkflowCheckpointsForRun,
  listActiveRunsForThread,
  listCallsForRunPage,
  listExpiredTerminalRuns,
  listAcceptanceApprovals,
  listRunsForCampaign,
  migrations,
  recordAcceptanceApproval,
  queueCallProviderRetry,
  recordCallContextUsage,
  recoverInterruptedRuns,
  settleCall,
  settleRun,
  startCall,
  storeStructuredResult,
  upsertWorkflowCheckpoint,
} from "./data.js";
import {
  MAX_WORKFLOW_CHECKPOINT_BYTES_PER_RUN,
  MAX_WORKFLOW_CHECKPOINTS_PER_RUN,
  canonicalizeAcceptanceCriteria,
  type WorkflowAcceptanceCriterion,
} from "./workflow-checkpoint.js";

describe("workflow durable data", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(migrations.join("\n"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  function sweepExpired(now: number, limit: number): number {
    return deleteTerminalRuns(
      db,
      listExpiredTerminalRuns(db, now, limit).runIds,
    );
  }

  function newRun() {
    return createRun(db, {
      projectId: "project-1",
      originThreadId: "thread-1",
      presentationThreadId: "thread-1",
      parentRunId: null,
      rootRunId: "",
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

  // SHA-256 of migration IDs 0..10 from the installed production build.
  // These IDs are immutable because the host migration ledger records only IDs.
  const productionMigrationHashes = [
    "cb3f719d56d0d09658bef9a0f021ed11496d29c58d9d9c078d239f9dbe78afa6",
    "25757204d3d451e18471a5122c763c0713f59ea85372aa0ed49400bf599e5071",
    "caf5bb39ebbd7372639f2421d50ce8427231529489c25c30d1ca71c105ac603d",
    "d2b6765d51e13028cc32da4b8668d00468a97ae02be20bce217099d6362d3ea1",
    "ba7ff8bfedbd1f8dc16210aede0bd5deeeb4b340090022355629730d6dd54c14",
    "8f7b44eb0118c659b96d5f867e01b4fb2a126891c5f3a6dc499641be742337b1",
    "e2cfdd1965dbb3320046ee9ea102f118a1392a570bc5074ca058ae5e507d7465",
    "eac1a950ae997157aaa3c69c13065ee3d8e74e4e733b1e371c290160a71b9337",
    "a8fb5039dfa92cad024ee86cd5982e28ac541c7c4a96b0b0db5544889372c1d2",
    "e9288122a6224c3e6d88f56a45c88900157d7161425fefcf83ead399db6f9b89",
    "bc4f2cb47b1c15a87b574678dadf01ea9dbe424a2e71253cbeb1a9cec9829c4d",
  ] as const;

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

  it("upgrades the production migration ledger without losing context telemetry", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "workflows" });
    const productionDb = bb.storage.database();
    try {
      const productionMigrationCount = 11;
      expect(
        migrations
          .slice(0, productionMigrationCount)
          .map((sql) => createHash("sha256").update(sql).digest("hex")),
      ).toEqual(productionMigrationHashes);
      bb.storage.migrate(
        productionDb,
        migrations.slice(0, productionMigrationCount),
      );

      expect(
        productionDb
          .prepare("SELECT id FROM _bb_migrations ORDER BY id")
          .pluck()
          .all(),
      ).toEqual(
        Array.from({ length: productionMigrationCount }, (_, id) => id),
      );
      expect(
        productionDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_checkpoints'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        productionDb
          .prepare("PRAGMA table_info(workflow_runs)")
          .all()
          .map((column) => (column as { name: string }).name),
      ).not.toContain("presentation_thread_id");

      productionDb
        .prepare(
          `INSERT INTO workflow_runs (
             id, project_id, origin_thread_id, environment_id,
             origin_provider, origin_model, origin_reasoning_level,
             origin_permission_mode, name, source, source_hash, args_json,
             status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "wfr_legacy",
          "project-1",
          "thread-legacy",
          "environment-1",
          "codex",
          "gpt-test",
          "medium",
          "full",
          "legacy-workflow",
          "return null",
          "hash",
          "null",
          "queued",
          1,
        );

      productionDb
        .prepare(
          `INSERT INTO workflow_calls (
             id, run_id, call_index, cache_key, prompt, options_json,
             resolved_provider, resolved_model, resolved_reasoning_level,
             resolved_permission_mode, status, prompt_bytes,
             observed_context_used_tokens, observed_model_context_window,
             context_usage_estimated, context_minimum_tokens,
             context_profile_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "wfc_legacy",
          "wfr_legacy",
          0,
          "legacy-cache-key",
          "legacy prompt",
          "{}",
          "codex",
          "gpt-test",
          "medium",
          "full",
          "succeeded",
          321,
          12_345,
          114_688,
          1,
          65_536,
          '{"profile":"production-sentinel"}',
          2,
        );

      bb.storage.migrate(productionDb, migrations);

      expect(
        productionDb
          .prepare("SELECT id FROM _bb_migrations ORDER BY id")
          .pluck()
          .all(),
      ).toEqual(Array.from({ length: migrations.length }, (_, id) => id));
      expect(migrations).toHaveLength(15);
      expect(getRunRequired(productionDb, "wfr_legacy")).toMatchObject({
        originThreadId: "thread-legacy",
        presentationThreadId: "thread-legacy",
        parentRunId: null,
        rootRunId: "wfr_legacy",
        campaignId: "wfr_legacy",
      });
      expect(getLatestRunForThread(productionDb, "thread-legacy")?.id).toBe(
        "wfr_legacy",
      );
      expect(
        listActiveRunsForThread(productionDb, "thread-legacy").map(
          (run) => run.id,
        ),
      ).toEqual(["wfr_legacy"]);
      expect(
        productionDb
          .prepare(
            `SELECT prompt_bytes AS promptBytes,
               observed_context_used_tokens AS observedContextUsedTokens,
               observed_model_context_window AS observedModelContextWindow,
               context_usage_estimated AS contextUsageEstimated,
               context_minimum_tokens AS contextMinimumTokens,
               context_profile_json AS contextProfileJson
             FROM workflow_calls WHERE id = ?`,
          )
          .get("wfc_legacy"),
      ).toEqual({
        promptBytes: 321,
        observedContextUsedTokens: 12_345,
        observedModelContextWindow: 114_688,
        contextUsageEstimated: 1,
        contextMinimumTokens: 65_536,
        contextProfileJson: '{"profile":"production-sentinel"}',
      });
      expect(
        productionDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_checkpoints'",
          )
          .get(),
      ).toEqual({ name: "workflow_checkpoints" });
      expect(
        productionDb
          .prepare("PRAGMA table_info(workflow_runs)")
          .all()
          .map((column) => (column as { name: string }).name),
      ).toEqual(
        expect.arrayContaining([
          "presentation_thread_id",
          "parent_run_id",
          "root_run_id",
          "campaign_id",
        ]),
      );

      expect(() => bb.storage.migrate(productionDb, migrations)).not.toThrow();
      expect(
        productionDb
          .prepare("SELECT id FROM _bb_migrations ORDER BY id")
          .pluck()
          .all(),
      ).toEqual(Array.from({ length: migrations.length }, (_, id) => id));

      productionDb
        .prepare(
          `INSERT INTO workflow_runs (
             id, project_id, origin_thread_id, environment_id,
             origin_provider, origin_model, origin_reasoning_level,
             origin_permission_mode, name, source, source_hash, args_json,
             status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "wfr_rollback_legacy",
          "project-1",
          "thread-rollback-legacy",
          "environment-1",
          "codex",
          "gpt-test",
          "medium",
          "full",
          "rollback-legacy-workflow",
          "return null",
          "rollback-hash",
          "null",
          "queued",
          3,
        );

      const rollbackLegacy = getRunRequired(
        productionDb,
        "wfr_rollback_legacy",
      );
      expect(rollbackLegacy).toMatchObject({
        presentationThreadId: "thread-rollback-legacy",
        parentRunId: null,
        rootRunId: "wfr_rollback_legacy",
        campaignId: "wfr_rollback_legacy",
      });
      expect(
        getFirstRunForCampaignScope(productionDb, {
          campaignId: rollbackLegacy.campaignId,
          projectId: rollbackLegacy.projectId,
          environmentId: rollbackLegacy.environmentId,
        })?.id,
      ).toBe(rollbackLegacy.id);
      expect(
        countRunsForCampaign(productionDb, rollbackLegacy.campaignId),
      ).toBe(1);
      expect(
        listRunsForCampaign(productionDb, {
          campaignId: rollbackLegacy.campaignId,
          projectId: rollbackLegacy.projectId,
          environmentId: rollbackLegacy.environmentId,
          presentationThreadId: rollbackLegacy.presentationThreadId,
        }).map((run) => run.id),
      ).toEqual([rollbackLegacy.id]);
      expect(
        createRun(productionDb, {
          projectId: rollbackLegacy.projectId,
          originThreadId: "thread-current-child",
          presentationThreadId: rollbackLegacy.presentationThreadId,
          parentRunId: rollbackLegacy.id,
          rootRunId: rollbackLegacy.rootRunId,
          environmentId: rollbackLegacy.environmentId,
          originProvider: "codex",
          originModel: "gpt-test",
          originReasoningLevel: "medium",
          originPermissionMode: "full",
          name: "current-child-workflow",
          source: "return null",
          sourceHash: "child-hash",
          argsJson: "null",
          settingsJson: "{}",
          resumedFromRunId: null,
          campaignId: rollbackLegacy.campaignId,
        }),
      ).toMatchObject({
        presentationThreadId: "thread-rollback-legacy",
        parentRunId: "wfr_rollback_legacy",
        rootRunId: "wfr_rollback_legacy",
        campaignId: "wfr_rollback_legacy",
      });
      expect(
        countRunsForCampaign(productionDb, rollbackLegacy.campaignId),
      ).toBe(2);
    } finally {
      await harness.dispose();
    }
  });

  it("upserts the latest checkpoint state without duplicating its position", () => {
    const run = newRun();
    markRunning(run.id);
    const call = startCall(db, {
      runId: run.id,
      callIndex: 0,
      cacheKey: "checkpoint",
      prompt: "report progress",
      options: {
        selection: null,
        outputSchema: null,
        contextRequirement: null,
        contextProfile: null,
        title: "Implement",
        phase: "Execute",
      },
      selection: resolvedSelection,
      replay: null,
    });

    upsertWorkflowCheckpoint(db, {
      runId: run.id,
      checkpointId: "section-1",
      checkpointJson: '{"kind":"work-item","status":"running"}',
      phase: "Execute",
      sourceCallId: call.id,
    });
    const created = listWorkflowCheckpointsForRun(db, run.id)[0]!;

    upsertWorkflowCheckpoint(db, {
      runId: run.id,
      checkpointId: "section-1",
      checkpointJson: '{"kind":"work-item","status":"succeeded"}',
      phase: "Verify",
      sourceCallId: null,
    });

    expect(listWorkflowCheckpointsForRun(db, run.id)).toEqual([
      expect.objectContaining({
        id: created.id,
        checkpointId: "section-1",
        checkpointJson: '{"kind":"work-item","status":"succeeded"}',
        phase: "Verify",
        sourceCallId: call.id,
        createdAt: created.createdAt,
      }),
    ]);
  });

  it("rejects cross-worker and worker-to-orchestrator checkpoint overwrites", () => {
    const run = newRun();
    markRunning(run.id);
    const firstCall = startCall(db, {
      runId: run.id,
      callIndex: 0,
      cacheKey: "first-checkpoint-owner",
      prompt: "first",
      options: {
        selection: null,
        outputSchema: null,
        contextRequirement: null,
        contextProfile: null,
        title: "First",
        phase: "Execute",
      },
      selection: resolvedSelection,
      replay: null,
    });
    const secondCall = startCall(db, {
      runId: run.id,
      callIndex: 1,
      cacheKey: "second-checkpoint-owner",
      prompt: "second",
      options: {
        selection: null,
        outputSchema: null,
        contextRequirement: null,
        contextProfile: null,
        title: "Second",
        phase: "Execute",
      },
      selection: resolvedSelection,
      replay: null,
    });

    expect(
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId: "worker-progress",
        checkpointJson: '{"kind":"work-item","status":"running"}',
        phase: "Execute",
        sourceCallId: firstCall.id,
      }),
    ).toBe("accepted");
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId: "worker-progress",
        checkpointJson: '{"kind":"work-item","status":"failed"}',
        phase: "Execute",
        sourceCallId: secondCall.id,
      }),
    ).toBe("ownership_conflict");

    expect(
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId: "selected-plan",
        checkpointJson: '{"kind":"plan","status":"succeeded"}',
        phase: "Plan",
        sourceCallId: null,
      }),
    ).toBe("accepted");
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId: "selected-plan",
        checkpointJson: '{"kind":"plan","status":"failed"}',
        phase: "Plan",
        sourceCallId: firstCall.id,
      }),
    ).toBe("ownership_conflict");

    expect(
      listWorkflowCheckpointsForRun(db, run.id).map((row) => ({
        checkpointId: row.checkpointId,
        checkpointJson: row.checkpointJson,
        sourceCallId: row.sourceCallId,
      })),
    ).toEqual([
      {
        checkpointId: "worker-progress",
        checkpointJson: '{"kind":"work-item","status":"running"}',
        sourceCallId: firstCall.id,
      },
      {
        checkpointId: "selected-plan",
        checkpointJson: '{"kind":"plan","status":"succeeded"}',
        sourceCallId: null,
      },
    ]);
  });

  it("rejects changing checkpoint kind for a stable ID", () => {
    const run = newRun();
    markRunning(run.id);
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId: "stable-id",
        checkpointJson: '{"kind":"work-item","status":"running"}',
        phase: "Execute",
        sourceCallId: null,
      }),
    ).toBe("accepted");
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId: "stable-id",
        checkpointJson: '{"kind":"verification","status":"running"}',
        phase: "Verify",
        sourceCallId: null,
      }),
    ).toBe("kind_conflict");
  });

  // The acceptance contract is the only checkpoint the campaign is measured
  // against, so these guard the write path that keeps an orchestrator from
  // quietly agreeing with itself.
  function acceptanceCriteria(
    ids: readonly string[],
  ): WorkflowAcceptanceCriterion[] {
    return ids.map((id) => ({
      id,
      statement: `Criterion ${id} holds`,
      provenBy: "command",
      detail: null,
    }));
  }

  function acceptanceJson(
    criteria: readonly string[],
    amends?: { supersedes: string; reason: string },
  ): string {
    return JSON.stringify({
      kind: "acceptance",
      id: "ignored-by-the-data-layer",
      title: "Acceptance",
      status: "succeeded",
      summary: null,
      criteria: acceptanceCriteria(criteria),
      ...(amends === undefined ? {} : { amends }),
    });
  }

  it("refuses an in-place rewrite of the acceptance contract", () => {
    const run = newRun();
    markRunning(run.id);
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId: "campaign-acceptance",
        checkpointJson: acceptanceJson(["cli", "grader"]),
        phase: "Acceptance",
        sourceCallId: null,
      }),
    ).toBe("accepted");

    // Reordering is not a change, and a resumed run legitimately republishes
    // the contract it already published.
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId: "campaign-acceptance",
        checkpointJson: acceptanceJson(["grader", "cli"]),
        phase: "Acceptance",
        sourceCallId: null,
      }),
    ).toBe("accepted");

    // This is the silent vector: the same ID UPDATEs the row in place, so
    // accepting it would destroy the original and leave nothing to report.
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId: "campaign-acceptance",
        checkpointJson: acceptanceJson(["containment"]),
        phase: "Acceptance",
        sourceCallId: null,
      }),
    ).toBe("acceptance_conflict");

    // Even declaring an amendment cannot rescue an in-place overwrite.
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId: "campaign-acceptance",
        checkpointJson: acceptanceJson(["containment"], {
          supersedes: "campaign-acceptance",
          reason: "Scope changed",
        }),
        phase: "Acceptance",
        sourceCallId: null,
      }),
    ).toBe("acceptance_conflict");

    expect(
      listWorkflowCheckpointsForRun(db, run.id).map((row) =>
        JSON.parse(row.checkpointJson),
      ),
    ).toMatchObject([{ criteria: [{ id: "grader" }, { id: "cli" }] }]);
  });

  it("accepts a changed contract only when it names what it supersedes", () => {
    const run = newRun();
    markRunning(run.id);
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId: "campaign-acceptance",
        checkpointJson: acceptanceJson(["cli"]),
        phase: "Acceptance",
        sourceCallId: null,
      }),
    ).toBe("accepted");
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId: "campaign-acceptance-v2",
        checkpointJson: acceptanceJson(["containment"]),
        phase: "Acceptance",
        sourceCallId: null,
      }),
    ).toBe("acceptance_conflict");
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId: "campaign-acceptance-v2",
        checkpointJson: acceptanceJson(["containment"], {
          supersedes: "campaign-acceptance",
          reason: "The CLI outcome moved to phase 1",
        }),
        phase: "Acceptance",
        sourceCallId: null,
      }),
    ).toBe("accepted");

    // A fabricated chain is not an amendment.
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId: "campaign-acceptance-v3",
        checkpointJson: acceptanceJson(["something-else"], {
          supersedes: "campaign-acceptance-that-never-existed",
          reason: "Scope changed",
        }),
        phase: "Acceptance",
        sourceCallId: null,
      }),
    ).toBe("acceptance_conflict");
  });

  it("scopes acceptance immutability to the campaign, not the run", () => {
    const first = newRun();
    markRunning(first.id);
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: first.id,
        checkpointId: "campaign-acceptance",
        checkpointJson: acceptanceJson(["cli"]),
        phase: "Acceptance",
        sourceCallId: null,
      }),
    ).toBe("accepted");

    const later = createRun(db, {
      projectId: "project-1",
      originThreadId: "thread-1",
      presentationThreadId: "thread-1",
      parentRunId: first.id,
      rootRunId: first.id,
      campaignId: first.campaignId,
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
    markRunning(later.id);

    // A later run in the same campaign restating the contract is harmless;
    // changing it there is the same rewrite one level out.
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: later.id,
        checkpointId: "campaign-acceptance",
        checkpointJson: acceptanceJson(["cli"]),
        phase: "Acceptance",
        sourceCallId: null,
      }),
    ).toBe("accepted");
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: later.id,
        checkpointId: "campaign-acceptance-run-2",
        checkpointJson: acceptanceJson(["containment"]),
        phase: "Acceptance",
        sourceCallId: null,
      }),
    ).toBe("acceptance_conflict");

    // The sibling-run vector a run-scoped guard lets through. This amendment
    // names a predecessor the campaign really published, so the chain check
    // passes; what it also does is reuse an acceptance ID that already holds a
    // different body in another run. Rows are unique per (run_id,
    // checkpoint_id), so nothing is overwritten — the ID simply comes to name
    // two contracts, and an approval issued against the body a reader saw
    // would silently authorize the other.
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: first.id,
        checkpointId: "campaign-acceptance-v2",
        checkpointJson: acceptanceJson(["containment"], {
          supersedes: "campaign-acceptance",
          reason: "Narrowed to containment",
        }),
        phase: "Acceptance",
        sourceCallId: null,
      }),
    ).toBe("accepted");
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: later.id,
        checkpointId: "campaign-acceptance-v2",
        checkpointJson: acceptanceJson(["anything-goes"], {
          supersedes: "campaign-acceptance",
          reason: "Narrowed to containment",
        }),
        phase: "Acceptance",
        sourceCallId: null,
      }),
    ).toBe("acceptance_conflict");

    // A different campaign is unconstrained by this one's contract.
    const unrelated = newRun();
    markRunning(unrelated.id);
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: unrelated.id,
        checkpointId: "campaign-acceptance",
        checkpointJson: acceptanceJson(["containment"]),
        phase: "Acceptance",
        sourceCallId: null,
      }),
    ).toBe("accepted");
  });

  // A gate exists to hold a phase open. These guard the write path that keeps
  // an orchestrator from walking through its own gate while the outcomes the
  // gate names are still open.
  function planJson(
    items: readonly {
      id: string;
      satisfies?: string[];
      requiresClosed?: string[];
    }[],
  ): string {
    return JSON.stringify({
      kind: "plan",
      id: "ignored-by-the-data-layer",
      title: "Selected plan",
      status: "succeeded",
      summary: null,
      detail: null,
      items: items.map((item) => ({
        id: item.id,
        title: item.id,
        objective: `Advance ${item.id}`,
        detail: null,
        ticketRef: null,
        ...(item.satisfies === undefined ? {} : { satisfies: item.satisfies }),
        ...(item.requiresClosed === undefined
          ? {}
          : { nodeType: "gate", requiresClosed: item.requiresClosed }),
      })),
    });
  }

  function workItemJson(status: "succeeded" | "failed" | "running"): string {
    return JSON.stringify({
      kind: "work-item",
      id: "ignored-by-the-data-layer",
      title: "Work",
      status,
      summary: null,
      ticketRef: null,
      changedFiles: [],
      blocker: null,
    });
  }

  function verificationJson(acceptanceId: string): string {
    return JSON.stringify({
      kind: "verification",
      id: `verify-${acceptanceId}`,
      title: `Verify ${acceptanceId}`,
      status: "succeeded",
      summary: null,
      workItemId: null,
      acceptanceId,
      command: "pnpm test",
      counts: null,
    });
  }

  it("refuses a gate reported as succeeded while a criterion it requires is open", () => {
    const run = newRun();
    markRunning(run.id);
    const write = (checkpointId: string, checkpointJson: string) =>
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId,
        checkpointJson,
        phase: "Execute",
        sourceCallId: null,
      });

    expect(
      write("campaign-acceptance", acceptanceJson(["cli", "grader"])),
    ).toBe("accepted");
    expect(
      write(
        "campaign-plan",
        planJson([
          { id: "cli-unit", satisfies: ["cli"] },
          { id: "phase-gate", requiresClosed: ["cli", "grader"] },
        ]),
      ),
    ).toBe("accepted");

    // Ordinary work is untouched; only a gate carries requirements.
    expect(write("cli-unit", workItemJson("succeeded"))).toBe("accepted");

    expect(write("phase-gate", workItemJson("succeeded"))).toEqual({
      kind: "gate_conflict",
      openCriterionIds: ["cli", "grader"],
    });

    // Reporting the gate honestly is always allowed — that is the behaviour
    // this refusal is steering toward, so it must not be blocked too.
    expect(write("phase-gate", workItemJson("failed"))).toBe("accepted");
    expect(write("phase-gate", workItemJson("running"))).toBe("accepted");

    expect(write("verify-cli", verificationJson("cli"))).toBe("accepted");
    expect(write("phase-gate", workItemJson("succeeded"))).toEqual({
      kind: "gate_conflict",
      openCriterionIds: ["grader"],
    });

    expect(write("verify-grader", verificationJson("grader"))).toBe("accepted");
    expect(write("phase-gate", workItemJson("succeeded"))).toBe("accepted");
  });

  it("holds a gate whose requirement no contract declares, across the campaign", () => {
    const first = newRun();
    markRunning(first.id);
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: first.id,
        checkpointId: "campaign-plan",
        checkpointJson: planJson([
          { id: "phase-gate", requiresClosed: ["cli"] },
        ]),
        phase: "Plan",
        sourceCallId: null,
      }),
    ).toBe("accepted");

    // No acceptance contract has been published, so "cli" cannot be closed by
    // anything. Failing closed means a gate declared against a criterion that
    // does not exist stays shut instead of quietly passing.
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: first.id,
        checkpointId: "phase-gate",
        checkpointJson: workItemJson("succeeded"),
        phase: "Execute",
        sourceCallId: null,
      }),
    ).toEqual({ kind: "gate_conflict", openCriterionIds: ["cli"] });

    // The gate belongs to the campaign, not the run that declared it, so a
    // later run cannot pass it by starting fresh.
    const later = createRun(db, {
      projectId: "project-1",
      originThreadId: "thread-1",
      presentationThreadId: "thread-1",
      parentRunId: first.id,
      rootRunId: first.id,
      campaignId: first.campaignId,
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
    markRunning(later.id);
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: later.id,
        checkpointId: "phase-gate",
        checkpointJson: workItemJson("succeeded"),
        phase: "Execute",
        sourceCallId: null,
      }),
    ).toEqual({ kind: "gate_conflict", openCriterionIds: ["cli"] });
  });

  // An amendment the workflow declared about itself is a claim; only an
  // approval issued from outside the worker's tool path authorizes it.
  it("records an approval only for an amendment the campaign declared", () => {
    const run = newRun();
    markRunning(run.id);
    const write = (checkpointId: string, checkpointJson: string) =>
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId,
        checkpointJson,
        phase: "Acceptance",
        sourceCallId: null,
      });
    expect(
      write("campaign-acceptance", acceptanceJson(["cli", "grader"])),
    ).toBe("accepted");
    expect(
      write(
        "campaign-acceptance-v2",
        acceptanceJson(["cli"], {
          supersedes: "campaign-acceptance",
          reason: "Grader moved to phase 2",
        }),
      ),
    ).toBe("accepted");

    const approve = (acceptanceCheckpointId: string) =>
      recordAcceptanceApproval(db, {
        runId: run.id,
        acceptanceCheckpointId,
        approvedByThreadId: "thread-human",
        surface: "panel" as const,
      });

    expect(approve("campaign-acceptance-that-never-existed")).toEqual({
      kind: "unknown_acceptance",
    });
    // The original contract is not a change, so there is nothing to authorize.
    expect(approve("campaign-acceptance")).toEqual({
      kind: "not_an_amendment",
    });
    // The canonical body comes back with the approval, so a caller can show
    // which contract it just bound to instead of only its ID.
    const approvedBody = canonicalizeAcceptanceCriteria(
      acceptanceCriteria(["cli"]),
    );
    expect(approve("campaign-acceptance-v2")).toEqual({
      kind: "approved",
      newlyApproved: true,
      supersedes: "campaign-acceptance",
      contractCanonical: approvedBody,
    });
    // Clicking twice is not two approvals.
    expect(approve("campaign-acceptance-v2")).toEqual({
      kind: "approved",
      newlyApproved: false,
      supersedes: "campaign-acceptance",
      contractCanonical: approvedBody,
    });

    expect(
      listAcceptanceApprovals(db, { campaignId: run.campaignId }).map(
        (approval) => ({
          acceptanceId: approval.acceptanceId,
          approvedByThreadId: approval.approvedByThreadId,
          surface: approval.surface,
        }),
      ),
    ).toEqual([
      {
        acceptanceId: "campaign-acceptance-v2",
        approvedByThreadId: "thread-human",
        surface: "panel",
      },
    ]);
  });

  it("drops an approval row whose surface is not one this build issues", () => {
    const run = newRun();
    markRunning(run.id);
    db.prepare(
      `INSERT INTO workflow_acceptance_approvals (
         id, campaign_id, acceptance_checkpoint_id, contract_canonical,
         approved_by_thread_id, surface, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "wfa_smuggled",
      run.campaignId,
      "campaign-acceptance-v2",
      "canonical",
      "thread-1",
      "worker-tool",
      Date.now(),
    );

    // Dropping the row makes the amendment pending again, which is the safe
    // direction: an unreadable approval must not read as consent.
    expect(listAcceptanceApprovals(db, { campaignId: run.campaignId })).toEqual(
      [],
    );
  });

  it("refuses to approve an acceptance ID that names two bodies", () => {
    const run = newRun();
    markRunning(run.id);
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId: "campaign-acceptance",
        checkpointJson: acceptanceJson(["cli"]),
        phase: "Acceptance",
        sourceCallId: null,
      }),
    ).toBe("accepted");
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId: "campaign-acceptance-v2",
        checkpointJson: acceptanceJson(["containment"], {
          supersedes: "campaign-acceptance",
          reason: "Narrowed to containment",
        }),
        phase: "Acceptance",
        sourceCallId: null,
      }),
    ).toBe("accepted");

    // The write path refuses this, so reaching it means the ledger was written
    // another way. Written directly, the same ID now carries two contracts.
    const sibling = newRun();
    db.prepare(
      `UPDATE workflow_runs SET campaign_id = ? WHERE id = ?`,
    ).run(run.campaignId, sibling.id);
    db.prepare(
      `INSERT INTO workflow_checkpoints
         (id, run_id, checkpoint_id, checkpoint_json, phase, source_call_id,
          ordinal, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
    ).run(
      "wfc_smuggled",
      sibling.id,
      "campaign-acceptance-v2",
      acceptanceJson(["anything-goes"], {
        supersedes: "campaign-acceptance",
        reason: "Narrowed to containment",
      }),
      "Acceptance",
      Date.now(),
      Date.now(),
    );

    // Fail closed rather than pick one. Approving the newest row would bind the
    // campaign to a contract the approver may never have read, and that is the
    // whole value of the approval.
    expect(
      recordAcceptanceApproval(db, {
        runId: run.id,
        acceptanceCheckpointId: "campaign-acceptance-v2",
        approvedByThreadId: "thread-human",
        surface: "panel",
      }),
    ).toEqual({ kind: "ambiguous_body" });
    expect(listAcceptanceApprovals(db, { campaignId: run.campaignId })).toEqual(
      [],
    );
  });

  it("refuses a plan that retires a gate the campaign is stuck behind", () => {
    const run = newRun();
    markRunning(run.id);
    const write = (checkpointId: string, checkpointJson: string) =>
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId,
        checkpointJson,
        phase: "Execute",
        sourceCallId: null,
      });
    expect(write("campaign-acceptance", acceptanceJson(["cli", "grader"]))).toBe(
      "accepted",
    );
    expect(
      write(
        "campaign-plan",
        planJson([{ id: "phase-gate", requiresClosed: ["cli", "grader"] }]),
      ),
    ).toBe("accepted");
    expect(write("verify-cli", verificationJson("cli"))).toBe("accepted");

    // Demoting the gate to a work node is the same move as walking through it,
    // one level out: the human approval that guards the contract would guard
    // nothing if the plan that gates on it could be rewritten by the same agent
    // through the same tool.
    expect(
      write("campaign-plan", planJson([{ id: "phase-gate" }])),
    ).toEqual({
      kind: "gate_weakened",
      gateId: "phase-gate",
      droppedCriterionIds: ["grader"],
    });
    // Dropping one requirement and keeping the rest is the same weakening.
    expect(
      write(
        "campaign-plan",
        planJson([{ id: "phase-gate", requiresClosed: ["cli"] }]),
      ),
    ).toEqual({
      kind: "gate_weakened",
      gateId: "phase-gate",
      droppedCriterionIds: ["grader"],
    });
    // Removing the gate item from the plan entirely is too.
    expect(write("campaign-plan", planJson([{ id: "other-work" }]))).toEqual({
      kind: "gate_weakened",
      gateId: "phase-gate",
      droppedCriterionIds: ["grader"],
    });
    // Restating the same gate is not a weakening.
    expect(
      write(
        "campaign-plan",
        planJson([{ id: "phase-gate", requiresClosed: ["cli", "grader"] }]),
      ),
    ).toBe("accepted");
  });

  it("does not let an approved narrowing open a gate the plan still holds", () => {
    const run = newRun();
    markRunning(run.id);
    const write = (checkpointId: string, checkpointJson: string) =>
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId,
        checkpointJson,
        phase: "Execute",
        sourceCallId: null,
      });
    expect(
      write("campaign-acceptance", acceptanceJson(["cli", "grader"])),
    ).toBe("accepted");
    expect(
      write(
        "campaign-plan",
        planJson([{ id: "phase-gate", requiresClosed: ["cli", "grader"] }]),
      ),
    ).toBe("accepted");
    expect(write("verify-cli", verificationJson("cli"))).toBe("accepted");

    // The rewrite a gated run would reach for: redefine done so the open
    // criterion is no longer part of it.
    expect(
      write(
        "campaign-acceptance-v2",
        acceptanceJson(["cli"], {
          supersedes: "campaign-acceptance",
          reason: "Grader is out of scope",
        }),
      ),
    ).toBe("accepted");
    expect(write("phase-gate", workItemJson("succeeded"))).toEqual({
      kind: "gate_conflict",
      openCriterionIds: ["grader"],
    });

    expect(
      recordAcceptanceApproval(db, {
        runId: run.id,
        acceptanceCheckpointId: "campaign-acceptance-v2",
        approvedByThreadId: "thread-human",
        surface: "cli",
      }),
    ).toMatchObject({ kind: "approved" });

    // Approval alone does not open the gate: the plan still requires "grader",
    // and a criterion the approved contract no longer declares can never close.
    expect(write("phase-gate", workItemJson("succeeded"))).toEqual({
      kind: "gate_conflict",
      openCriterionIds: ["grader"],
    });

    // Restating the plan against the approved contract is the second, explicit
    // step. Both the contract change and the gate change are on the record.
    expect(
      write(
        "campaign-plan",
        planJson([{ id: "phase-gate", requiresClosed: ["cli"] }]),
      ),
    ).toBe("accepted");
    expect(write("phase-gate", workItemJson("succeeded"))).toBe("accepted");
  });

  it("rejects checkpoint writes after the run becomes terminal", () => {
    const run = newRun();
    markRunning(run.id);
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId: "section-1",
        checkpointJson: '{"kind":"work-item","status":"running"}',
        phase: "Execute",
        sourceCallId: null,
      }),
    ).toBe("accepted");
    db.prepare(
      `UPDATE workflow_runs SET status = 'succeeded' WHERE id = ?`,
    ).run(run.id);

    expect(
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId: "section-1",
        checkpointJson: '{"kind":"work-item","status":"failed"}',
        phase: "Deliver",
        sourceCallId: null,
      }),
    ).toBe("inactive");
    expect(listWorkflowCheckpointsForRun(db, run.id)[0]).toMatchObject({
      checkpointJson: '{"kind":"work-item","status":"running"}',
      phase: "Execute",
    });
  });

  it("terminalizes unfinished call checkpoints without overwriting completed state", () => {
    const run = newRun();
    markRunning(run.id);
    const call = startCall(db, {
      runId: run.id,
      callIndex: 0,
      cacheKey: "terminal-checkpoint",
      prompt: "report progress",
      options: {
        selection: null,
        outputSchema: null,
        contextRequirement: null,
        contextProfile: null,
        title: "Implement",
        phase: "Execute",
      },
      selection: resolvedSelection,
      replay: null,
    });
    for (const [checkpointId, status] of [
      ["unfinished", "running"],
      ["finished", "succeeded"],
    ] as const) {
      expect(
        upsertWorkflowCheckpoint(db, {
          runId: run.id,
          checkpointId,
          checkpointJson: JSON.stringify({ kind: "work-item", status }),
          phase: "Execute",
          sourceCallId: call.id,
        }),
      ).toBe("accepted");
    }

    settleCall(db, {
      id: call.id,
      status: "failed",
      result: null,
      error: "worker deleted",
    });

    expect(
      listWorkflowCheckpointsForRun(db, run.id).map((row) => [
        row.checkpointId,
        JSON.parse(row.checkpointJson).status,
      ]),
    ).toEqual([
      ["unfinished", "interrupted"],
      ["finished", "succeeded"],
    ]);
  });

  it("terminalizes unfinished orchestrator checkpoints when the run settles", () => {
    const run = newRun();
    markRunning(run.id);
    for (const [checkpointId, status] of [
      ["pending-plan", "pending"],
      ["blocked-item", "blocked"],
    ] as const) {
      expect(
        upsertWorkflowCheckpoint(db, {
          runId: run.id,
          checkpointId,
          checkpointJson: JSON.stringify({ kind: "work-item", status }),
          phase: "Execute",
          sourceCallId: null,
        }),
      ).toBe("accepted");
    }

    expect(cancelRun(db, run.id)).toBe(true);

    expect(
      listWorkflowCheckpointsForRun(db, run.id).map((row) => [
        row.checkpointId,
        JSON.parse(row.checkpointJson).status,
      ]),
    ).toEqual([
      ["pending-plan", "interrupted"],
      ["blocked-item", "blocked"],
    ]);

    const timedOutRun = newRun();
    markRunning(timedOutRun.id);
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: timedOutRun.id,
        checkpointId: "timed-out-check",
        checkpointJson: '{"kind":"verification","status":"running"}',
        phase: "Verify",
        sourceCallId: null,
      }),
    ).toBe("accepted");
    settleRun(db, {
      id: timedOutRun.id,
      status: "failed",
      result: null,
      error: "Workflow run timed out",
    });
    expect(
      JSON.parse(
        listWorkflowCheckpointsForRun(db, timedOutRun.id)[0]!.checkpointJson,
      ).status,
    ).toBe("interrupted");
  });

  it("preserves insertion order for same-millisecond checkpoints and upserts", () => {
    vi.spyOn(Date, "now").mockReturnValue(123);
    const run = newRun();
    markRunning(run.id);
    for (const checkpointId of ["second-by-name", "first-by-name"]) {
      expect(
        upsertWorkflowCheckpoint(db, {
          runId: run.id,
          checkpointId,
          checkpointJson: '{"kind":"work-item","status":"running"}',
          phase: "Execute",
          sourceCallId: null,
        }),
      ).toBe("accepted");
    }
    const before = listWorkflowCheckpointsForRun(db, run.id);
    expect(before.map((row) => row.checkpointId)).toEqual([
      "second-by-name",
      "first-by-name",
    ]);

    expect(
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId: "second-by-name",
        checkpointJson: '{"kind":"work-item","status":"succeeded"}',
        phase: "Verify",
        sourceCallId: null,
      }),
    ).toBe("accepted");
    expect(
      listWorkflowCheckpointsForRun(db, run.id).map((row) => row.ordinal),
    ).toEqual(before.map((row) => row.ordinal));
  });

  it("enforces row and aggregate-byte limits while allowing updates at the cap", () => {
    const rowLimitedRun = newRun();
    markRunning(rowLimitedRun.id);
    for (let index = 0; index < MAX_WORKFLOW_CHECKPOINTS_PER_RUN; index += 1) {
      expect(
        upsertWorkflowCheckpoint(db, {
          runId: rowLimitedRun.id,
          checkpointId: `item-${index}`,
          checkpointJson: "{}",
          phase: null,
          sourceCallId: null,
        }),
      ).toBe("accepted");
    }
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: rowLimitedRun.id,
        checkpointId: "one-over",
        checkpointJson: "{}",
        phase: null,
        sourceCallId: null,
      }),
    ).toBe("limit_exceeded");
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: rowLimitedRun.id,
        checkpointId: "item-0",
        checkpointJson: '{"updated":true}',
        phase: null,
        sourceCallId: null,
      }),
    ).toBe("accepted");

    const byteLimitedRun = newRun();
    markRunning(byteLimitedRun.id);
    const atByteLimit = JSON.stringify(
      "x".repeat(MAX_WORKFLOW_CHECKPOINT_BYTES_PER_RUN - 2),
    );
    expect(Buffer.byteLength(atByteLimit, "utf8")).toBe(
      MAX_WORKFLOW_CHECKPOINT_BYTES_PER_RUN,
    );
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: byteLimitedRun.id,
        checkpointId: "at-byte-limit",
        checkpointJson: atByteLimit,
        phase: null,
        sourceCallId: null,
      }),
    ).toBe("accepted");
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: byteLimitedRun.id,
        checkpointId: "one-over",
        checkpointJson: "0",
        phase: null,
        sourceCallId: null,
      }),
    ).toBe("limit_exceeded");
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: byteLimitedRun.id,
        checkpointId: "at-byte-limit",
        checkpointJson: JSON.stringify(
          "x".repeat(MAX_WORKFLOW_CHECKPOINT_BYTES_PER_RUN - 3),
        ),
        phase: null,
        sourceCallId: null,
      }),
    ).toBe("accepted");
  });

  it("reserves aggregate byte headroom for interrupted terminalization", () => {
    const run = newRun();
    markRunning(run.id);
    const prefix = '{"kind":"work-item","status":"running","padding":"';
    const suffix = '"}';
    const targetBytes = MAX_WORKFLOW_CHECKPOINT_BYTES_PER_RUN - 4;
    const checkpointJson = `${prefix}${"x".repeat(
      targetBytes - Buffer.byteLength(prefix + suffix, "utf8"),
    )}${suffix}`;
    expect(Buffer.byteLength(checkpointJson, "utf8")).toBe(targetBytes);
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId: "near-terminal-limit",
        checkpointJson,
        phase: "Execute",
        sourceCallId: null,
      }),
    ).toBe("accepted");
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: run.id,
        checkpointId: "would-consume-reserve",
        checkpointJson: "0",
        phase: null,
        sourceCallId: null,
      }),
    ).toBe("limit_exceeded");

    settleRun(db, {
      id: run.id,
      status: "cancelled",
      result: null,
      error: null,
    });
    const terminalJson = listWorkflowCheckpointsForRun(db, run.id)[0]!
      .checkpointJson;
    expect(JSON.parse(terminalJson)).toMatchObject({ status: "interrupted" });
    expect(Buffer.byteLength(terminalJson, "utf8")).toBe(
      MAX_WORKFLOW_CHECKPOINT_BYTES_PER_RUN,
    );
  });

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
    for (const [checkpointId, status] of [
      ["restart-running", "running"],
      ["restart-finished", "succeeded"],
    ] as const) {
      expect(
        upsertWorkflowCheckpoint(db, {
          runId: run.id,
          checkpointId,
          checkpointJson: JSON.stringify({ kind: "work-item", status }),
          phase: "Execute",
          sourceCallId: call.id,
        }),
      ).toBe("accepted");
    }

    expect(recoverInterruptedRuns(db)).toEqual(["child-1"]);
    expect(getRunRequired(db, run.id).status).toBe("queued");
    expect(getCall(db, run.id, 0)).toMatchObject({
      status: "cancelled",
      error: "Plugin restarted",
    });
    expect(
      listWorkflowCheckpointsForRun(db, run.id).map((row) => [
        row.checkpointId,
        JSON.parse(row.checkpointJson).status,
      ]),
    ).toEqual([
      ["restart-running", "interrupted"],
      ["restart-finished", "succeeded"],
    ]);
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
      presentationThreadId: "thread-1",
      parentRunId: null,
      rootRunId: "",
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
      presentationThreadId: "thread-1",
      parentRunId: null,
      rootRunId: "",
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
    markRunning(expired.id);
    expect(
      upsertWorkflowCheckpoint(db, {
        runId: expired.id,
        checkpointId: "expired-plan",
        checkpointJson: '{"kind":"plan"}',
        phase: "Plan",
        sourceCallId: null,
      }),
    ).toBe("accepted");
    db.prepare(
      `UPDATE workflow_runs SET status = 'failed', notification_sent = 1,
       finished_at = ?, settings_json = json_set(settings_json, '$.retentionDays', 1)
       WHERE id = ?`,
    ).run(Date.now() - 3 * 86_400_000, expired.id);

    expect(sweepExpired(Date.now(), 100)).toBe(1);
    expect(getRunRequired(db, parent.id).id).toBe(parent.id);
    expect(getRunRequired(db, parent.id).replayBarrierIndex).toBeNull();
    expect(getRunRequired(db, retainedChild.id).status).toBe("queued");
    expect(() => getRunRequired(db, expired.id)).toThrow(
      "Unknown workflow run",
    );
    expect(listWorkflowCheckpointsForRun(db, expired.id)).toEqual([]);
  });

  it("deletes an entirely expired resume chain in one bounded sweep", () => {
    const parent = newRun();
    const child = createRun(db, {
      projectId: "project-1",
      originThreadId: "thread-1",
      presentationThreadId: "thread-1",
      parentRunId: null,
      rootRunId: "",
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

    expect(sweepExpired(Date.now(), 100)).toBe(2);
    expect(() => getRunRequired(db, parent.id)).toThrow("Unknown workflow run");
    expect(() => getRunRequired(db, child.id)).toThrow("Unknown workflow run");
  });
});
