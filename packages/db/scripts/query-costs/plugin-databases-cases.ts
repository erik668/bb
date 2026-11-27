import {
  PoolAffinityStore,
  QuotaStore,
} from "../../../../plugins/account-pool/src/store.js";
import {
  claimAutomationScheduledRun,
  closeAutomationRun,
  createAutomation,
  createManualRun,
  deleteAutomation,
  disableAutomationsForTargetThread,
  getAutomation,
  getAutomationForProject,
  getRunningAutomationRun,
  listAllAutomations,
  listAutomationRuns,
  listAutomationsForProject,
  listAutomationsTargetingThread,
  listDueAutomations,
  listRunningAutomationRuns,
  listRunningAutomationRunsByThread,
  setAutomationEnabled,
  setAutomationRunThread,
  updateAutomation,
} from "../../../../plugins/automations/src/data.js";
import { registerCostGroup, type QueryCostCase } from "./case.js";
import {
  POOL_AFFINITY_BINDINGS,
  POOL_AFFINITY_IDLE_TTL_MS,
  seedAccountPool,
  seedAutomations,
  type AccountPoolSeed,
  type AutomationsSeed,
} from "./plugin-databases-seed.js";

const ACCOUNT_POOL = "plugins/account-pool/src/store.ts";
const AUTOMATIONS = "plugins/automations/src/data.ts";
const AUTOMATION_RUNS_PAGE = 50;
const DUE_AUTOMATION_BATCH = 25;
const ACCOUNT_POOL_CASES: readonly QueryCostCase<AccountPoolSeed>[] = [
  {
    name: `${ACCOUNT_POOL}#QuotaStore.get`,
    run: (db, _fixture, seed) => new QuotaStore(db.$client).get(seed.accountId),
  },
  {
    name: `${ACCOUNT_POOL}#QuotaStore.get`,
    variant: "unknown account",
    run: (db, _fixture, seed) =>
      new QuotaStore(db.$client).get(seed.missingAccountId),
  },
  {
    name: `${ACCOUNT_POOL}#QuotaStore.put`,
    run: (db, _fixture, seed) => {
      const store = new QuotaStore(db.$client);
      store.put({ ...store.get(seed.accountId), heldUntil: seed.now + 60_000 });
    },
  },
  {
    name: `${ACCOUNT_POOL}#QuotaStore.remove`,
    run: (db, _fixture, seed) =>
      new QuotaStore(db.$client).remove(seed.accountId),
  },
  {
    name: `${ACCOUNT_POOL}#PoolAffinityStore.loadBindings`,
    growsWith: {
      history: `Loads every binding younger than the idle TTL, capped at ${POOL_AFFINITY_BINDINGS} by the hub, and the seed grows the bindings up to that cap`,
    },
    run: (db, _fixture, seed) =>
      new PoolAffinityStore(db.$client).loadBindings(
        seed.now - POOL_AFFINITY_IDLE_TTL_MS,
        POOL_AFFINITY_BINDINGS,
      ),
  },
  {
    name: `${ACCOUNT_POOL}#PoolAffinityStore.loadActiveAccounts`,
    run: (db) => new PoolAffinityStore(db.$client).loadActiveAccounts(),
  },
  {
    name: `${ACCOUNT_POOL}#PoolAffinityStore.putBinding`,
    run: (db, _fixture, seed) =>
      new PoolAffinityStore(db.$client).putBinding(seed.bindingKey, {
        accountId: seed.accountId,
        lastUsedAt: seed.now,
      }),
  },
  {
    name: `${ACCOUNT_POOL}#PoolAffinityStore.removeBinding`,
    run: (db, _fixture, seed) =>
      new PoolAffinityStore(db.$client).removeBinding(seed.bindingKey),
  },
  {
    name: `${ACCOUNT_POOL}#PoolAffinityStore.putActiveAccount`,
    run: (db, _fixture, seed) =>
      new PoolAffinityStore(db.$client).putActiveAccount(
        "claude",
        seed.accountId,
      ),
  },
];

const AUTOMATIONS_CASES: readonly QueryCostCase<AutomationsSeed>[] = [
  {
    name: `${AUTOMATIONS}#createAutomation`,
    run: (db, _fixture, seed) =>
      createAutomation(db.$client, {
        projectId: seed.projectId,
        name: "Weekly dependency review",
        enabled: true,
        trigger: {
          triggerType: "schedule",
          cron: "0 9 * * 1",
          timezone: "UTC",
        },
        runMode: "agent",
        execution: {
          mode: "agent",
          prompt: "Review dependency updates.",
          providerId: "provider-a",
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "accept-edits",
          environment: { type: "project-default" },
        },
        origin: "human",
        createdByThreadId: null,
        nextRunAt: seed.now + 86_400_000,
      }),
  },
  {
    name: `${AUTOMATIONS}#getAutomation`,
    run: (db, _fixture, seed) => getAutomation(db.$client, seed.automationId),
  },
  {
    name: `${AUTOMATIONS}#getAutomationForProject`,
    run: (db, _fixture, seed) =>
      getAutomationForProject(db.$client, {
        projectId: seed.projectId,
        automationId: seed.automationId,
      }),
  },
  {
    name: `${AUTOMATIONS}#listAutomationsForProject`,
    growsWith: {
      history:
        "Returns every automation in the project by design, and the seed grows the automation count",
    },
    run: (db, _fixture, seed) =>
      listAutomationsForProject(db.$client, seed.projectId),
  },
  {
    name: `${AUTOMATIONS}#listAutomationsTargetingThread`,
    run: (db, _fixture, seed) =>
      listAutomationsTargetingThread(db.$client, seed.targetThreadId),
  },
  {
    name: `${AUTOMATIONS}#listAllAutomations`,
    growsWith: {
      history:
        "Returns every automation by design, and the seed grows the automation count",
    },
    run: (db) => listAllAutomations(db.$client),
  },
  {
    name: `${AUTOMATIONS}#updateAutomation`,
    run: (db, _fixture, seed) =>
      updateAutomation(db.$client, {
        projectId: seed.projectId,
        automationId: seed.automationId,
        patch: { name: "Renamed automation" },
      }),
  },
  {
    name: `${AUTOMATIONS}#setAutomationEnabled`,
    run: (db, _fixture, seed) =>
      setAutomationEnabled(db.$client, {
        projectId: seed.projectId,
        automationId: seed.automationId,
        enabled: false,
        nextRunAt: null,
      }),
  },
  {
    name: `${AUTOMATIONS}#deleteAutomation`,
    run: (db, _fixture, seed) =>
      deleteAutomation(db.$client, {
        projectId: seed.projectId,
        automationId: seed.automationId,
      }),
  },
  {
    name: `${AUTOMATIONS}#listDueAutomations`,
    run: (db, _fixture, seed) =>
      listDueAutomations(db.$client, {
        now: seed.now,
        limit: DUE_AUTOMATION_BATCH,
      }),
  },
  {
    name: `${AUTOMATIONS}#getRunningAutomationRun`,
    run: (db, _fixture, seed) =>
      getRunningAutomationRun(db.$client, seed.automationId),
  },
  {
    name: `${AUTOMATIONS}#claimAutomationScheduledRun`,
    run: (db, _fixture, seed) =>
      claimAutomationScheduledRun(db.$client, {
        automationId: seed.idleAutomation.id,
        expectedNextRunAt: seed.idleAutomation.nextRunAt,
        newNextRunAt: seed.idleAutomation.nextRunAt + 3_600_000,
        now: seed.now,
      }),
  },
  {
    name: `${AUTOMATIONS}#closeAutomationRun`,
    run: (db, _fixture, seed) =>
      closeAutomationRun(db.$client, {
        runId: seed.runningRunId,
        status: "failed",
        error: "Provider overloaded",
        now: seed.now,
      }),
  },
  {
    name: `${AUTOMATIONS}#createManualRun`,
    run: (db, _fixture, seed) =>
      createManualRun(db.$client, {
        automationId: seed.idleAutomation.id,
        runMode: "agent",
        idempotencyKey: seed.idempotency.key,
        now: seed.now,
      }),
  },
  {
    name: `${AUTOMATIONS}#setAutomationRunThread`,
    run: (db, _fixture, seed) =>
      setAutomationRunThread(db.$client, {
        runId: seed.runningRunId,
        threadId: seed.runningRunThreadId,
      }),
  },
  {
    name: `${AUTOMATIONS}#listRunningAutomationRuns`,
    run: (db) => listRunningAutomationRuns(db.$client),
  },
  {
    name: `${AUTOMATIONS}#listRunningAutomationRunsByThread`,
    run: (db, _fixture, seed) =>
      listRunningAutomationRunsByThread(db.$client, seed.runningRunThreadId),
  },
  {
    name: `${AUTOMATIONS}#listAutomationRuns`,
    run: (db, _fixture, seed) =>
      listAutomationRuns(db.$client, {
        automationId: seed.automationId,
        limit: AUTOMATION_RUNS_PAGE,
      }),
  },
  {
    name: `${AUTOMATIONS}#listAutomationRuns`,
    variant: "after a cursor",
    run: (db, _fixture, seed) =>
      listAutomationRuns(db.$client, {
        automationId: seed.automationId,
        limit: AUTOMATION_RUNS_PAGE,
        cursor: seed.cursor,
      }),
  },
  {
    name: `${AUTOMATIONS}#disableAutomationsForTargetThread`,
    run: (db, _fixture, seed) =>
      disableAutomationsForTargetThread(db.$client, {
        threadId: seed.targetThreadId,
        error: "Target thread was archived",
        now: seed.now,
      }),
  },
];

export const ACCOUNT_POOL_COST_GROUP = registerCostGroup({
  name: "account-pool",
  pluginDatabase: { auditedTables: [], allowedFindings: [] },
  seed: (db, _fixture, scale) => seedAccountPool(db, scale),
  cases: ACCOUNT_POOL_CASES,
});

export const AUTOMATIONS_COST_GROUP = registerCostGroup({
  name: "automations",
  pluginDatabase: {
    auditedTables: ["automation_runs"],
    allowedFindings: [
      {
        rule: "full-scan",
        table: "automation_runs",
        caller: `${AUTOMATIONS}#listRunningAutomationRuns`,
        reason:
          "Scans the partial single-flight index, which holds at most one running row per automation",
      },
    ],
  },
  seed: (db, _fixture, scale) => seedAutomations(db, scale),
  cases: AUTOMATIONS_CASES,
});
