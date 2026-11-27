import type Database from "better-sqlite3";
import {
  createAutomation,
  migrations as AUTOMATIONS_MIGRATIONS,
} from "../../../../plugins/automations/src/data.js";
import {
  EMPTY_FAMILY_WEEKLY,
  providerSchema,
} from "../../../../plugins/account-pool/src/contracts.js";
import {
  PoolAffinityStore,
  QUOTA_MIGRATIONS,
  QuotaStore,
} from "../../../../plugins/account-pool/src/store.js";
import type { DbConnection } from "../../src/connection.js";
import { scaled } from "./case.js";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

const POOL_ACCOUNTS = 20;
export const POOL_AFFINITY_BINDINGS = 4_096;
export const POOL_AFFINITY_IDLE_TTL_MS = 65 * MINUTE_MS;

const AUTOMATIONS = 20;
const AUTOMATION_RUNS = 13_000;
const AUTOMATION_PROJECTS = 4;

export interface AccountPoolSeed {
  accountId: string;
  missingAccountId: string;
  bindingKey: string;
  now: number;
}

export interface AutomationsSeed {
  projectId: string;
  automationId: string;
  idleAutomation: { id: string; projectId: string; nextRunAt: number };
  runningRunId: string;
  runningRunThreadId: string;
  targetThreadId: string;
  idempotency: { automationId: string; key: string };
  cursor: { startedAt: number; id: string };
  now: number;
}

function migrateStatements(
  client: Database.Database,
  statements: readonly string[],
): void {
  for (const statement of statements) client.exec(statement);
}

function accountId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

export function seedAccountPool(
  db: DbConnection,
  scale: number,
): AccountPoolSeed {
  const client = db.$client;
  migrateStatements(client, QUOTA_MIGRATIONS);
  const now = Date.now();
  const accounts = scaled(POOL_ACCOUNTS, scale);
  const quotas = new QuotaStore(client);
  const affinity = new PoolAffinityStore(client);
  const bindings = scaled(POOL_AFFINITY_BINDINGS, scale);
  const insertBinding = client.prepare(
    "INSERT INTO pool_affinity (affinity_key, account_id, last_used_at) VALUES (?, ?, ?)",
  );
  client.transaction(() => {
    for (let index = 0; index < accounts; index += 1) {
      quotas.put({
        accountId: accountId(index),
        usageRestriction: null,
        extraUsage: null,
        representativeClaim: index % 2 === 0 ? "five_hour" : null,
        familyWeekly: EMPTY_FAMILY_WEEKLY,
        limitWindows: [
          {
            slot: "primary",
            windowMinutes: 300,
            utilization: (index % 10) / 10,
            resetAt: now + 3_600_000,
            status: "allowed",
            observedAt: now,
            source: "header",
          },
          {
            slot: "secondary",
            windowMinutes: 10_080,
            utilization: (index % 7) / 7,
            resetAt: now + 5 * DAY_MS,
            status: "allowed",
            observedAt: now,
            source: "header",
          },
        ],
        observedAt: now,
        heldUntil: null,
        error: null,
      });
    }
    for (let index = 0; index < bindings; index += 1) {
      insertBinding.run(
        `conversation-${index}`,
        accountId(index % accounts),
        now - Math.floor((index / bindings) * POOL_AFFINITY_IDLE_TTL_MS * 0.9),
      );
    }
    affinity.putActiveAccount("claude", accountId(0));
    affinity.putActiveAccount(
      providerSchema.options[1],
      accountId(accounts - 1),
    );
  })();
  return {
    accountId: accountId(0),
    missingAccountId: accountId(accounts + 1),
    bindingKey: `conversation-${bindings - 1}`,
    now,
  };
}

function automationProjectId(index: number): string {
  return `proj_automation_${index % AUTOMATION_PROJECTS}`;
}

export function seedAutomations(
  db: DbConnection,
  scale: number,
): AutomationsSeed {
  const client = db.$client;
  migrateStatements(client, AUTOMATIONS_MIGRATIONS);
  const now = Date.now();
  const automationCount = scaled(AUTOMATIONS, scale);
  const runCount = scaled(AUTOMATION_RUNS, scale);
  const runsPerAutomation = Math.max(1, Math.floor(runCount / automationCount));
  const automationIds: string[] = [];
  const insertRun = client.prepare(
    `INSERT INTO automation_runs (
       id, automation_id, run_mode, thread_id, status, trigger, skip_reason,
       error, output, exit_code, idempotency_key, scheduled_for, started_at,
       finished_at
     ) VALUES (
       @id, @automationId, @runMode, @threadId, @status, @trigger, @skipReason,
       @error, @output, @exitCode, @idempotencyKey, @scheduledFor, @startedAt,
       @finishedAt
     )`,
  );
  let runningRunId = "";
  let runningRunThreadId = "";
  let cursor = { startedAt: 0, id: "" };
  client.transaction(() => {
    for (let index = 0; index < automationCount; index += 1) {
      const script = index % 4 === 3;
      const once = index % 5 === 4;
      const id = `auto_${index.toString().padStart(6, "0")}`;
      automationIds.push(id);
      createAutomation(client, {
        id,
        projectId: automationProjectId(index),
        name: `Nightly ${index}`,
        enabled: index % 6 !== 5,
        trigger: once
          ? { triggerType: "once", runAt: now + (index - 2) * MINUTE_MS }
          : { triggerType: "schedule", cron: "0 * * * *", timezone: "UTC" },
        runMode: script ? "script" : "agent",
        execution: script
          ? {
              mode: "script",
              script: "pnpm test --filter=@bb/db",
              timeoutMs: 600_000,
              workingDirectory: { type: "automation-storage" },
            }
          : {
              mode: "agent",
              prompt:
                "Review yesterday's merged pull requests and report regressions.",
              providerId: "provider-a",
              model: "gpt-5",
              reasoningLevel: "medium",
              permissionMode: "accept-edits",
              environment: { type: "project-default" },
              targetThreadId: `thr_automation_target_${Math.floor(index / 2)}`,
            },
        origin: index % 3 === 0 ? "agent" : "human",
        createdByThreadId: index % 3 === 0 ? `thr_creator_${index}` : null,
        nextRunAt:
          now + (index % 3 === 0 ? -MINUTE_MS : (index + 1) * MINUTE_MS),
      });
      for (let run = 0; run < runsPerAutomation; run += 1) {
        const runIndex = index * runsPerAutomation + run;
        const newest = run === runsPerAutomation - 1;
        const running = newest && index % 2 === 0;
        const startedAt = now - (runsPerAutomation - run) * 3_600_000;
        const status = running
          ? "running"
          : run % 11 === 0
            ? "failed"
            : run % 7 === 0
              ? "skipped"
              : "succeeded";
        const runId = `arun_${runIndex.toString().padStart(8, "0")}`;
        const threadId = script ? null : `thr_automation_run_${runIndex}`;
        const manual = run % 10 === 0;
        insertRun.run({
          id: runId,
          automationId: id,
          runMode: script ? "script" : "agent",
          threadId,
          status,
          trigger: manual ? "manual" : "schedule",
          skipReason:
            status === "skipped" ? "previous run still running" : null,
          error: status === "failed" ? "Provider overloaded" : null,
          output: script ? "All 412 tests passed.\n".repeat(8) : null,
          exitCode: script && status !== "running" ? 0 : null,
          idempotencyKey: manual ? `manual-${runIndex}` : null,
          scheduledFor: startedAt,
          startedAt,
          finishedAt: running ? null : startedAt + 120_000,
        });
        if (running && runningRunId === "" && threadId !== null) {
          runningRunId = runId;
          runningRunThreadId = threadId;
        }
        if (index === 0 && run === Math.floor(runsPerAutomation / 2)) {
          cursor = { startedAt, id: runId };
        }
      }
    }
  })();
  const automationId = automationIds[0];
  const idleIndex = automationIds.findIndex(
    (_id, index) => index % 2 === 1 && index % 3 === 0 && index % 5 !== 4,
  );
  const idleId =
    idleIndex >= 0
      ? automationIds[idleIndex]
      : automationIds[automationCount - 1];
  if (automationId === undefined || idleId === undefined) {
    throw new Error("Expected seeded automations");
  }
  const idle = client
    .prepare(
      "SELECT project_id AS projectId, next_run_at AS nextRunAt FROM automations WHERE id = ?",
    )
    .get(idleId) as { projectId: string; nextRunAt: number };
  client
    .prepare(
      "UPDATE automation_runs SET status = 'succeeded', finished_at = started_at + 1 WHERE automation_id = ? AND status = 'running'",
    )
    .run(idleId);
  client
    .prepare(
      "UPDATE automations SET enabled = 1, trigger_type = 'schedule', trigger_config = ? WHERE id = ?",
    )
    .run(
      JSON.stringify({
        triggerType: "schedule",
        cron: "0 * * * *",
        timezone: "UTC",
      }),
      idleId,
    );
  if (runningRunId === "") {
    runningRunId = `arun_running_${automationId}`;
    runningRunThreadId = `thr_automation_running_${automationId}`;
    insertRun.run({
      id: runningRunId,
      automationId,
      runMode: "agent",
      threadId: runningRunThreadId,
      status: "running",
      trigger: "schedule",
      skipReason: null,
      error: null,
      output: null,
      exitCode: null,
      idempotencyKey: null,
      scheduledFor: now,
      startedAt: now,
      finishedAt: null,
    });
  }
  return {
    projectId: automationProjectId(0),
    automationId,
    idleAutomation: {
      id: idleId,
      projectId: idle.projectId,
      nextRunAt: idle.nextRunAt,
    },
    runningRunId,
    runningRunThreadId,
    targetThreadId: "thr_automation_target_0",
    idempotency: { automationId, key: "manual-new" },
    cursor,
    now,
  };
}
