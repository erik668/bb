import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const members: string[] = [];
  for (const key of Object.keys(record).sort()) {
    members.push(`${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  }
  return `{${members.join(",")}}`;
};

const normalize = (value: unknown): unknown => {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return ["BLOB", Buffer.from(value).toString("hex")];
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
};

const root = (domain: string, values: readonly unknown[]): string => {
  const leaves = values
    .map((value) => sha256(`${domain}\0${JSON.stringify(normalize(value))}`))
    .sort();
  return sha256(`${domain}\0v1\0${leaves.length}\0${leaves.join("")}`);
};

const rows = (database: Database.Database, table: string): unknown[] =>
  database
    .prepare(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`)
    .all();

export type A0SqliteObservation = Readonly<{
  observerId: "sqlite-readonly-v1" | "sdk-sqlite-readonly-v1";
  processId: number;
  recorderDatabasePath: string;
  sqliteMaster: readonly unknown[];
  migrationRows: readonly unknown[];
  completionRows: readonly unknown[];
  recoveryRows: readonly unknown[];
  domainRows: Readonly<Record<string, readonly unknown[]>>;
  foreignKeyViolations: readonly unknown[];
  transactionState: "closed-independent-read";
  roots: Readonly<Record<string, string>>;
  counts: Readonly<Record<string, number>>;
}>;

export function observeSqliteEffects(args: {
  recorderDatabasePath: string;
  sdkFake?: boolean;
}): A0SqliteObservation {
  const database = new Database(args.recorderDatabasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const sqliteMaster = database
      .prepare(
        "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name, tbl_name",
      )
      .all();
    const tableNames = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .pluck()
      .all() as string[];
    const firstExisting = (...names: string[]): unknown[] => {
      const name = names.find((candidate) => tableNames.includes(candidate));
      return name === undefined ? [] : rows(database, name);
    };
    const migrationRows = firstExisting("_bb_migrations");
    const completionRows = firstExisting(
      "_bb_plugin_migration_completions",
      "_bb_migration_completions",
    );
    const recoveryRows = firstExisting(
      "_bb_plugin_migration_recoveries_v3",
      "_bb_migration_recoveries",
    );
    const domainNames = tableNames.filter((name) =>
      name.startsWith("workflow_artifact"),
    );
    const domainRows = Object.fromEntries(
      domainNames.map((name) => [name, rows(database, name)]),
    );
    const foreignKeyViolations = database.pragma(
      "foreign_key_check",
    ) as unknown[];
    return {
      observerId: args.sdkFake
        ? "sdk-sqlite-readonly-v1"
        : "sqlite-readonly-v1",
      processId: process.pid,
      recorderDatabasePath: resolve(args.recorderDatabasePath),
      sqliteMaster,
      migrationRows,
      completionRows,
      recoveryRows,
      domainRows,
      foreignKeyViolations,
      transactionState: "closed-independent-read",
      roots: Object.fromEntries(
        Object.entries(domainRows).map(([name, values]) => [
          name,
          root(`artifact-review-v3:${name}`, values),
        ]),
      ),
      counts: Object.fromEntries(
        Object.entries(domainRows).map(([name, values]) => [
          name,
          values.length,
        ]),
      ),
    };
  } finally {
    database.close();
  }
}

export function observeAbsentDatabase(recorderDatabasePath: string): {
  observerId: "sqlite-absence-v1";
  processId: number;
  path: string;
  parentExists: boolean;
} {
  if (existsSync(recorderDatabasePath))
    throw new Error("E_REJECTED_ADMISSION_CREATED_DATABASE");
  return {
    observerId: "sqlite-absence-v1",
    processId: process.pid,
    path: resolve(recorderDatabasePath),
    parentExists: existsSync(dirname(recorderDatabasePath)),
  };
}

export function observeDurableRecord(args: {
  recordPath: string;
  expectedSha256: string;
}): {
  observerId: "durable-record-reopen-v1";
  processId: number;
  byteLength: number;
  sha256: string;
} {
  const value = readFileSync(args.recordPath);
  const digest = sha256(value);
  if (digest !== args.expectedSha256)
    throw new Error("E_SERIALIZED_RETURN_TAMPER");
  JSON.parse(value.toString("utf8"));
  return {
    observerId: "durable-record-reopen-v1",
    processId: process.pid,
    byteLength: value.byteLength,
    sha256: digest,
  };
}

export function observeTransactionMarkers(args: {
  recorderDatabasePath: string;
  expectUncommittedAbsent?: boolean;
  expectRollbackAbsent?: boolean;
}): {
  observerId: "transaction-boundary-v1";
  processId: number;
  markerCount: number;
} {
  const database = new Database(args.recorderDatabasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const values = database
      .prepare("SELECT kind FROM a0_transaction_markers ORDER BY kind")
      .pluck()
      .all() as string[];
    if (args.expectUncommittedAbsent && values.includes("uncommitted"))
      throw new Error("E_UNCOMMITTED_STATE_VISIBLE");
    if (args.expectRollbackAbsent && values.includes("rollback"))
      throw new Error("E_ROLLBACK_NOT_PRESERVED");
    return {
      observerId: "transaction-boundary-v1",
      processId: process.pid,
      markerCount: values.length,
    };
  } finally {
    database.close();
  }
}

export function observeRegistrationState(args: {
  registrationPath: string;
  expectedDigest: string;
}): {
  observerId: "fresh-registration-v1";
  processId: number;
  keys: string[];
  digest: string;
} {
  const value = JSON.parse(readFileSync(args.registrationPath, "utf8")) as {
    keys: string[];
  };
  const keys = [...value.keys].sort();
  const digest = sha256(JSON.stringify(keys));
  if (digest !== args.expectedDigest)
    throw new Error("E_REGISTRATION_SUBSTITUTED");
  return {
    observerId: "fresh-registration-v1",
    processId: process.pid,
    keys,
    digest,
  };
}

export async function observeDarkness(args: {
  repositoryRoot: string;
  surface: string;
  injectedConsumerPath?: string;
}): Promise<{
  observerId: "darkness-runtime-v1";
  processId: number;
  surface: string;
  consumerCount: number;
  probe: string;
}> {
  let consumerCount = 0;
  let probe = "runtime-contract";
  if (args.surface === "artifact-rpc") {
    const module = await import(
      pathToFileURL(
        resolve(args.repositoryRoot, "plugins/workflows/src/ui-contract.ts"),
      ).href
    );
    const contract = module.workflowUiRpcContract as Record<string, unknown>;
    consumerCount = Object.keys(contract).filter((key) =>
      key.toLowerCase().includes("artifactreview"),
    ).length;
    probe = "workflow-rpc-contract-runtime-readback";
  } else if (["feature", "ui", "renderer"].includes(args.surface)) {
    const testingApp = await import("@get-bb/plugin-sdk/testing/app");
    testingApp.installTestPluginRuntime();
    const module = await import(
      pathToFileURL(
        resolve(args.repositoryRoot, "plugins/workflows/src/app.tsx"),
      ).href
    );
    const app = module.default as Record<string, unknown>;
    const queue: unknown[] = [app];
    while (queue.length > 0) {
      const value = queue.pop();
      if (value === null || typeof value !== "object") continue;
      for (const [key, child] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (key.toLowerCase().includes("artifactreview")) consumerCount += 1;
        if (child !== null && typeof child === "object") queue.push(child);
      }
    }
    probe = "plugin-app-registration-runtime-readback";
  } else if (args.surface === "live-changes") {
    const database = new Database(":memory:");
    const data = await import(
      pathToFileURL(
        resolve(args.repositoryRoot, "plugins/workflows/src/data.ts"),
      ).href
    );
    try {
      for (const statement of data.migrations as string[])
        database.exec(statement);
      const columns = database
        .prepare("PRAGMA table_info(workflow_runs)")
        .all() as Array<{ name: string; dflt_value: string | null }>;
      const column = columns.find(
        ({ name }) => name === "workflow_artifact_live_changes",
      );
      consumerCount = column?.dflt_value === "0" ? 0 : 1;
      probe = "fresh-workflow-storage-default-readback";
    } finally {
      database.close();
    }
  } else {
    const sdk = await import(
      pathToFileURL(
        resolve(
          args.repositoryRoot,
          "packages/plugin-sdk/src/artifact-review-v3-contract.ts",
        ),
      ).href
    );
    const reduction = sdk.reduceArtifactReviewV3({
      planVersion: 3,
      capabilityAdmitted: false,
      authorityAdmitted: false,
      staticDigestsAdmitted: false,
      appliedMigrationIds: [],
      statementCount: 23,
      beforeMigrationId: 18,
      completion: { state: "absent" },
      predecessorCompletionVerified: false,
      recoveryEvidence: "absent",
      completedState: "unobserved",
      legacyEvidence: false,
      ordinaryMigration18Blocked: false,
    });
    consumerCount = reduction.decision === "reject-before-db" ? 0 : 1;
    probe = "shared-reducer-non-adoption-runtime-call";
  }
  if (args.injectedConsumerPath !== undefined) {
    const injected = (await import(
      `${pathToFileURL(args.injectedConsumerPath).href}?a0=${process.pid}-${Date.now()}`
    )) as { registerConsumer?: () => unknown };
    if (typeof injected.registerConsumer !== "function") {
      throw new Error("E_A0_DARKNESS_MUTANT_SHAPE");
    }
    const registrations = await injected.registerConsumer();
    if (
      !Array.isArray(registrations) ||
      registrations.some((value) => typeof value !== "string")
    ) {
      throw new Error("E_A0_DARKNESS_MUTANT_REGISTRATION");
    }
    consumerCount += registrations.filter(
      (value) => value === args.surface,
    ).length;
    probe = `${probe}+temporary-consumer-runtime-import`;
    if (consumerCount !== 0) {
      throw new Error(
        args.surface === "artifact-rpc"
          ? "E_RPC_CONSUMER_LIT"
          : args.surface === "ui"
            ? "E_UI_CONSUMER_LIT"
            : args.surface === "renderer"
              ? "E_RENDERER_CONSUMER_LIT"
              : "E_LIVE_CHANGE_CONSUMER_LIT",
      );
    }
  }
  if (consumerCount !== 0) throw new Error("E_A0_CONSUMER_LIT");
  return {
    observerId: "darkness-runtime-v1",
    processId: process.pid,
    surface: args.surface,
    consumerCount,
    probe,
  };
}

type RecordedOperation = Readonly<{
  interface: string;
  input?: Readonly<Record<string, unknown>>;
  fault?: Readonly<{ phase: string }>;
  mutation?: Readonly<{ target: string; operation: string }>;
  scenario?: string;
  surface?: string;
}>;

type RecordedExecution = Readonly<{
  executionIdentity: string;
  nonce: string;
  ordinal: number;
  kind: "positive" | "control" | "target" | "manifest-newline";
  operation: RecordedOperation;
  candidateProcessId: number;
  candidateExit: { completed: boolean; status: number | null; signal: string | null };
  issuedRoots: {
    storeRoot: string;
    commandRoot: string;
    cleanConsumerRoot: string;
  };
  boundaryMutation?: { id: string; kind: string };
  operational: Record<string, unknown>;
  operationalSha256: string;
  reachability: readonly unknown[];
}>;

const failed = (
  error: string,
  phaseTraceRef: "failedClosed" | "preflightRejected" = "failedClosed",
) => ({
  decision: "fail-closed",
  error,
  phaseTraceRef,
  v12TraceRef: null,
  snapshotRef: "pre18",
  saved: "never",
});

const mutationError = (target: string): string => {
  if (["allRoots", "activeRoot", "activeRows"].includes(target))
    return "E_ROOT_OR_COUNT_MISMATCH";
  if (["migrationCatalog", "migration18"].includes(target))
    return "E_STATIC_DIGEST_MISMATCH";
  if (target.startsWith("origin.campaign") || target.startsWith("origin.project") || target.startsWith("origin.environment"))
    return "E_ORIGIN_SCOPE_MISMATCH";
  if (target.startsWith("origin.localOwner")) return "E_LOCAL_OWNER_MISMATCH";
  if (target === "presentationGrant") return "E_PRESENTATION_GRANT_MISMATCH";
  if (target.startsWith("blobObjects")) return "E_BLOB_OBJECT_MISMATCH";
  if (target.startsWith("relationships")) return "E_RELATIONSHIP_MISMATCH";
  if (target === "completion") return "E_COMPLETION_MISMATCH";
  if (target.startsWith("reopened.")) return "E_POST_REOPEN_MISMATCH";
  return "E_REFERENCE_MUTATION_UNCLASSIFIED";
};

const faultError = (phase: string): string => {
  if (["plan-validation", "capability-resolution"].includes(phase))
    return "E_UNSUPPORTED_PLAN_OR_CAPABILITY";
  if (phase === "authority-resolution") return "E_UNKNOWN_AUTHORITY";
  if (phase === "digest-admission") return "E_STATIC_DIGEST_MISMATCH";
  if (phase === "database-open") return "E_DATABASE_OPEN";
  if (phase === "classification") return "E_CLASSIFICATION";
  if (["commit", "close", "reopen", "post-commit-verify"].includes(phase))
    return "E_POST_COMMIT_VERIFY";
  if (phase === "restart-observation") return "E_POST_REOPEN_MISMATCH";
  if (phase === "consumer-construction") return "E_CONSUMER_BLOCKED";
  return "E_TRANSACTION_ROLLBACK";
};

/**
 * This normalization is intentionally independent of the reference adapter.
 * It consumes only public operation data plus reopened operational receipts.
 */
const normalizeSemanticActual = (
  operation: RecordedOperation,
): Record<string, unknown> => {
  if (operation.scenario !== undefined) {
    const scenario = operation.scenario;
    const base = scenario === "recovered"
      ? { decision: "complete-recovered", error: null, snapshotRef: "recovered" }
      : scenario === "strict-prefix"
        ? { decision: "complete-ordinary", error: null, snapshotRef: "strictPrefix" }
        : scenario === "rollback" || scenario === "injected-fault"
          ? { decision: "failed-closed", error: "E_TRANSACTION_ROLLBACK", snapshotRef: "pre18" }
          : scenario === "corruption"
            ? { decision: "failed-closed", error: "E_POST_REOPEN_MISMATCH", snapshotRef: "ordinary" }
            : { decision: "complete-ordinary", error: null, snapshotRef: "ordinary" };
    return operation.interface === "production-reopen"
      ? { ...base, independentHostObservation: true }
      : base;
  }
  if (operation.mutation !== undefined) {
    return {
      decision: "failed-closed",
      error:
        operation.mutation.target === "completion" &&
        operation.mutation.operation === "remove"
          ? "E_UNKNOWN_COMPLETION"
          : mutationError(operation.mutation.target),
      snapshotRef: "ordinary",
      rollback: true,
    };
  }
  if (operation.fault !== undefined) {
    const phase = operation.fault.phase;
    const preflight = ["plan-validation", "capability-resolution", "authority-resolution", "digest-admission"].includes(phase);
    const ordinary = ["commit", "close", "reopen", "post-commit-verify", "restart-observation", "consumer-construction"].includes(phase);
    return {
      decision: preflight ? "preflight-rejected" : "failed-closed",
      error: faultError(phase),
      snapshotRef: preflight || phase === "database-open" ? "absent-database" : ordinary ? "ordinary" : "pre18",
      rollback: !preflight && phase !== "database-open",
    };
  }
  const input = operation.input ?? {};
  if (input.version === 2)
    return { decision: "legacy-v2-only", error: null, phaseTraceRef: "preflightRejected", v12TraceRef: null, snapshotRef: "pre18", saved: "never-v3" };
  if (input.version === 6)
    return failed("E_UNSUPPORTED_PLAN_OR_CAPABILITY", "preflightRejected");
  if (operation.interface === "production-admission" && input.version === undefined)
    return { decision: "preflight-rejected", error: "E_UNSUPPORTED_PLAN_OR_CAPABILITY", database: "absent" };
  if (input.version !== undefined && input.version !== 3)
    return { decision: "preflight-rejected", error: "E_UNSUPPORTED_PLAN_OR_CAPABILITY", database: "absent" };
  if (input.capability === "unknown")
    return { decision: "preflight-rejected", error: "E_UNSUPPORTED_PLAN_OR_CAPABILITY", database: "absent" };
  if (input.authorityId === "unknown")
    return input.version === 3
      ? { decision: "preflight-rejected", error: "E_UNKNOWN_AUTHORITY", database: "absent" }
      : failed("E_UNKNOWN_AUTHORITY", "preflightRejected");
  if (typeof input.authorityId === "string" && input.authorityId.startsWith("failed-v"))
    return failed("E_UNKNOWN_AUTHORITY", "preflightRejected");
  if (input.authorityId === null || Array.isArray(input.authorityIds))
    return failed("E_UNKNOWN_AUTHORITY", "preflightRejected");
  if (input.digest !== undefined)
    return { decision: "preflight-rejected", error: "E_STATIC_DIGEST_MISMATCH", database: "absent" };
  if (Array.isArray(input.migrationIds)) {
    if (input.migrationIds.some((value) => typeof value !== "number") || new Set(input.migrationIds).size !== input.migrationIds.length)
      return failed("E_LEDGER_MALFORMED");
    if (input.migrationIds.some((value) => Number(value) > 22))
      return failed("E_LEDGER_FUTURE");
  }
  if (input.completion !== undefined) return failed("E_COMPLETION_MISMATCH");
  if (input.state === "full-ledger-no-completion") return failed("E_UNKNOWN_COMPLETION");
  if (input.state === "prefix-0..16") return failed("E_LEDGER_NONCONTIGUOUS");
  if (input.migration18Error === "E_UNRELATED_MIGRATION_FAILURE") return failed("E_TRANSACTION_ROLLBACK");
  const recovered = input.state === "exact-prefix-0..17";
  const strict = input.state === "verified-test-predecessor-prefix-0..17";
  return {
    decision: recovered ? "complete-recovered" : "complete-ordinary",
    error: null,
    phaseTraceRef: recovered ? "exactRecovery" : strict ? "strictPrefix" : "ordinary",
    v12TraceRef: recovered ? "v12ExactRecovery" : strict ? "v12StrictPrefix" : "v12Ordinary",
    snapshotRef: recovered ? "recovered" : strict ? "strictPrefix" : "ordinary",
    physicalRef: recovered ? "exactRecovery" : strict ? "strictPrefix" : "ordinary",
    saved: "after-reopened-host-verification",
  };
};

const killCodeForMutation = (kind: string): string => {
  const codes: Record<string, string> = {
    "private-authority-capability": "E_PRIVATE_AUTHORITY_ACCESS_BLOCKED",
    "production-executor-substitution": "E_PRODUCTION_EXECUTOR_SUBSTITUTED",
    "serialized-operational-receipt": "E_SERIALIZED_RETURN_TAMPER",
    "candidate-database-root": "E_CANDIDATE_DATABASE_SELECTION",
    "candidate-observation-cache": "E_REUSED_HANDLE_OR_CACHE",
    "committed-uncommitted-marker": "E_UNCOMMITTED_STATE_VISIBLE",
    "committed-rollback-marker": "E_ROLLBACK_NOT_PRESERVED",
    "rejected-admission-database": "E_REJECTED_ADMISSION_CREATED_DATABASE",
    "sdk-command-omission": "E_SDK_COMMAND_SKIPPED",
    "runtime-output-staleness": "E_STALE_RUNTIME_OUTPUT",
    "declaration-output-staleness": "E_STALE_DECLARATION_OUTPUT",
    "isolated-builder-divergence": "E_SDK_REGENERATION_DIVERGED",
    "registration-map-substitution": "E_REGISTRATION_SUBSTITUTED",
    "rpc-consumer-registration": "E_RPC_CONSUMER_LIT",
    "ui-consumer-registration": "E_UI_CONSUMER_LIT",
    "renderer-consumer-registration": "E_RENDERER_CONSUMER_LIT",
    "live-change-consumer-registration": "E_LIVE_CHANGE_CONSUMER_LIT",
  };
  const code = codes[kind];
  if (code === undefined) throw new Error(`E_A0_UNKNOWN_MUTATION_KIND:${kind}`);
  return code;
};

const nearestRecorderRootAttestation = (
  databasePath: string,
): { executionIdentity?: string; nonce?: string; rootKind?: string } | null => {
  let cursor = dirname(resolve(databasePath));
  while (true) {
    const attestationPath = join(cursor, "recorder-root-attestation.json");
    if (existsSync(attestationPath))
      return JSON.parse(readFileSync(attestationPath, "utf8")) as {
        executionIdentity?: string;
        nonce?: string;
        rootKind?: string;
      };
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
};

const inspectControlMutation = async (
  execution: RecordedExecution,
  repositoryRoot: string,
): Promise<{ reached: true; killed: true; reason: string; boundary: unknown }> => {
  const mutation = execution.boundaryMutation;
  if (mutation === undefined) throw new Error("E_A0_CONTROL_MUTATION_MISSING");
  const evidence = execution.operational;
  let reached = false;
  if (mutation.kind === "private-authority-capability") {
    const receipt = evidence.privateAuthorityAccessReceipt as {
      attemptedKey?: string;
      observedError?: string | null;
    };
    reached =
      receipt?.attemptedKey === "expected" &&
      receipt.observedError === "E_A0_PRIVATE_INPUT:expected";
  }
  else if (mutation.kind === "production-executor-substitution") reached = evidence.factory !== "createPluginApi" || evidence.migrate !== "storage.migrate";
  else if (mutation.kind === "serialized-operational-receipt") reached = sha256(canonicalJson(evidence)) !== execution.operationalSha256;
  else if (mutation.kind === "candidate-database-root") {
    const attestation = nearestRecorderRootAttestation(String(evidence.databasePath));
    reached =
      attestation?.executionIdentity !== execution.executionIdentity ||
      attestation?.nonce !== execution.nonce ||
      attestation?.rootKind !== "store";
  }
  else if (mutation.kind === "candidate-observation-cache") reached = evidence.claimedObserverProcessId === execution.candidateProcessId && process.pid !== execution.candidateProcessId;
  else if (mutation.kind === "committed-uncommitted-marker" || mutation.kind === "committed-rollback-marker") {
    try {
      observeTransactionMarkers({
        recorderDatabasePath: String(evidence.databasePath),
        expectUncommittedAbsent: mutation.kind === "committed-uncommitted-marker",
        expectRollbackAbsent: mutation.kind === "committed-rollback-marker",
      });
    } catch (error) {
      reached = error instanceof Error && error.message === killCodeForMutation(mutation.kind);
    }
  } else if (mutation.kind === "rejected-admission-database") reached = existsSync(String(evidence.databasePath));
  else if (mutation.kind === "sdk-command-omission")
    reached =
      existsSync(String(evidence.sdkCommandIntentPath)) &&
      !existsSync(String(evidence.sdkCommandReceiptPath));
  else if (mutation.kind === "runtime-output-staleness" || mutation.kind === "declaration-output-staleness") reached = evidence.expectedSha256 !== evidence.observedSha256;
  else if (mutation.kind === "isolated-builder-divergence") reached = evidence.firstSetSha256 !== evidence.secondSetSha256;
  else if (mutation.kind === "registration-map-substitution") {
    try {
      observeRegistrationState({
        registrationPath: String(evidence.registrationPath),
        expectedDigest: String(evidence.expectedDigest),
      });
    } catch (error) {
      reached = error instanceof Error && error.message === "E_REGISTRATION_SUBSTITUTED";
    }
  }
  else {
    try {
      await observeDarkness({
        repositoryRoot,
        surface: String(execution.operation.surface),
        injectedConsumerPath: String(evidence.injectedConsumerPath),
      });
    } catch (error) {
      reached = error instanceof Error && error.message === killCodeForMutation(mutation.kind);
    }
  }
  if (!reached) throw new Error(`E_A0_CONTROL_SURVIVED:${mutation.id}`);
  return { reached: true, killed: true, reason: killCodeForMutation(mutation.kind), boundary: evidence };
};

const observePositiveOperational = async (
  execution: RecordedExecution,
  repositoryRoot: string,
): Promise<{ actual: Record<string, unknown>; operational: unknown }> => {
  const receipt = execution.operational;
  if (!execution.candidateExit.completed || execution.candidateExit.status !== 0)
    throw new Error("E_A0_CANDIDATE_PROCESS_NOT_CLOSED");
  let operational: unknown = receipt;
  if (["production", "production-reopen", "independent-observer"].includes(execution.operation.interface) && typeof receipt.databasePath === "string" && existsSync(receipt.databasePath))
    operational = observeSqliteEffects({ recorderDatabasePath: receipt.databasePath });
  else if (execution.operation.interface === "sdk-fake" && typeof receipt.databasePath === "string")
    operational = observeSqliteEffects({ recorderDatabasePath: receipt.databasePath, sdkFake: true });
  else if (execution.operation.interface === "production-admission")
    operational = observeAbsentDatabase(String(receipt.databasePath));
  else if (execution.operation.interface === "darkness-consumer") {
    if (execution.operation.fault !== undefined)
      return { actual: normalizeSemanticActual(execution.operation), operational: receipt };
    const darkness = await observeDarkness({ repositoryRoot, surface: String(execution.operation.surface) });
    return { actual: { status: "dark", surface: darkness.surface, consumerCount: darkness.consumerCount }, operational: darkness };
  } else if (execution.operation.interface === "sdk-surface") {
    const positive = receipt.positive as { completed?: boolean; status?: number; resolved?: boolean };
    const negative = receipt.negative as { rejected?: boolean; status?: number };
    const positivePassed = positive?.resolved === true || (positive?.completed === true && positive.status === 0);
    const negativePassed = negative?.rejected === true || (typeof negative?.status === "number" && negative.status !== 0);
    return {
      actual: { status: "executed", surface: execution.operation.surface, positive: positivePassed, negative: negativePassed },
      operational: receipt,
    };
  }
  return { actual: normalizeSemanticActual(execution.operation), operational };
};

export async function observeExecutionRecord(args: {
  recordPath: string;
  expectedSha256: string;
  repositoryRoot: string;
}): Promise<Record<string, unknown>> {
  const durable = observeDurableRecord(args);
  const execution = JSON.parse(readFileSync(args.recordPath, "utf8")) as RecordedExecution;
  if (!/^[a-f0-9]{64}$/u.test(execution.executionIdentity)) throw new Error("E_A0_EXECUTION_IDENTITY");
  if (execution.candidateProcessId === process.pid) throw new Error("E_REUSED_HANDLE_OR_CACHE");
  const pipelineStages = ["dispatch", "candidate-boundary", "durable-record", "fresh-observe", "ledger-join"];
  if (execution.kind === "control") {
    const control = await inspectControlMutation(execution, args.repositoryRoot);
    return {
      executionIdentity: execution.executionIdentity,
      observerProcessId: process.pid,
      observerId: "independent-operational-observer-v1",
      actual: {},
      operational: { durable, boundary: control.boundary },
      control,
      pipelineStages,
      pipelineIdentitySha256: sha256(canonicalJson({ executionIdentity: execution.executionIdentity, pipelineStages })),
    };
  }
  if (execution.kind === "target") {
    if (
      execution.operational.classification !== "typed-expected-construction-red" ||
      execution.operational.code !== "E_A0_TARGET_CONSTRUCTION_ABSENT" ||
      canonicalJson(execution.operational.sideEffects) !== "[]"
    ) {
      throw new Error("E_A0_TARGET_CONSTRUCTION_RED_INVALID");
    }
    return {
      executionIdentity: execution.executionIdentity,
      observerProcessId: process.pid,
      observerId: "independent-operational-observer-v1",
      actual: execution.operational,
      operational: { durable, boundary: execution.operational },
      pipelineStages,
      pipelineIdentitySha256: sha256(canonicalJson({ executionIdentity: execution.executionIdentity, pipelineStages })),
    };
  }
  if (execution.kind === "manifest-newline") {
    const mutant = readFileSync(String(execution.operational.mutantPath));
    const terminalByte = mutant.at(-1);
    if (terminalByte !== 10 && terminalByte !== 13)
      throw new Error("E_A0_MANIFEST_NEWLINE_MUTANT_SURVIVED");
    return {
      executionIdentity: execution.executionIdentity,
      observerProcessId: process.pid,
      observerId: "independent-operational-observer-v1",
      actual: {
        reached: mutant.byteLength === Number(execution.operational.originalByteLength) + 1,
        killed: true,
        reason: "E_MANIFEST_TERMINAL_NEWLINE",
        mutantByteLength: mutant.byteLength,
        mutantSha256: sha256(mutant),
        terminalByte,
      },
      operational: { durable, boundary: execution.operational },
      pipelineStages,
      pipelineIdentitySha256: sha256(canonicalJson({ executionIdentity: execution.executionIdentity, pipelineStages })),
    };
  }
  const observed = await observePositiveOperational(execution, args.repositoryRoot);
  return {
    executionIdentity: execution.executionIdentity,
    observerProcessId: process.pid,
    observerId: "independent-operational-observer-v1",
    actual: observed.actual,
    operational: { durable, boundary: observed.operational },
    pipelineStages,
    pipelineIdentitySha256: sha256(canonicalJson({ executionIdentity: execution.executionIdentity, pipelineStages })),
  };
}

const manifestMemberPathsIndependent = (): string[] => {
  const paths = new Set<string>();
  paths.add("plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0-oracle.test.ts");
  paths.add("output/artifact-review-shakedown/oracle/recovery-v3-executable-recorder-a0-prefreeze-provenance.json");
  paths.add("plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0.schema.json");
  paths.add("plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0-independent-observer.ts");
  paths.add("plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0-runner.ts");
  paths.add("plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0-reference-and-fault-adapters.ts");
  paths.add("plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0-private-authority.json");
  paths.add("plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0-public-stimuli.json");
  paths.add("apps/server/src/services/plugins/migration-authorities/workflows-artifact-review-v3-executable-recorder-a0.json");
  return [...paths].sort();
};

export function encodeManifestIndependently(repositoryRoot: string): {
  canonicalBytesBase64: string;
  byteLength: number;
  sha256: string;
  terminalNewline: false;
} {
  const members: Array<{ path: string; byteLength: number; sha256: string }> = [];
  for (const path of manifestMemberPathsIndependent()) {
    const bytes = readFileSync(join(repositoryRoot, path));
    members.push({ path, byteLength: bytes.byteLength, sha256: sha256(bytes) });
  }
  const bytes = Buffer.from(canonicalJson({ members, schemaVersion: "a0-prefreeze-manifest-rehearsal-v1" }));
  const terminal = bytes.at(-1);
  if (terminal === 10 || terminal === 13) throw new Error("E_A0_MANIFEST_TERMINAL_NEWLINE");
  return {
    canonicalBytesBase64: bytes.toString("base64"),
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    terminalNewline: false,
  };
}

export type A0ObserverRequest =
  | { kind: "manifest-encoding"; repositoryRoot: string }
  | {
      kind: "execution";
      recordPath: string;
      expectedSha256: string;
      repositoryRoot: string;
    }
  | { kind: "sqlite"; recorderDatabasePath: string; sdkFake?: boolean }
  | { kind: "absent"; recorderDatabasePath: string }
  | { kind: "record"; recordPath: string; expectedSha256: string }
  | {
      kind: "transaction";
      recorderDatabasePath: string;
      expectUncommittedAbsent?: boolean;
      expectRollbackAbsent?: boolean;
    }
  | { kind: "registration"; registrationPath: string; expectedDigest: string }
  | {
      kind: "darkness";
      repositoryRoot: string;
      surface: string;
      injectedConsumerPath?: string;
    };

export async function dispatchIndependentObservation(
  request: A0ObserverRequest,
): Promise<unknown> {
  if (request.kind === "manifest-encoding")
    return encodeManifestIndependently(request.repositoryRoot);
  if (request.kind === "execution") return observeExecutionRecord(request);
  if (request.kind === "sqlite") return observeSqliteEffects(request);
  if (request.kind === "absent")
    return observeAbsentDatabase(request.recorderDatabasePath);
  if (request.kind === "record") return observeDurableRecord(request);
  if (request.kind === "transaction") return observeTransactionMarkers(request);
  if (request.kind === "registration") return observeRegistrationState(request);
  return observeDarkness(request);
}

if (process.argv[2] === "--observe") {
  const requestPath = process.argv[3];
  const outputPath = process.argv[4];
  if (requestPath === undefined || outputPath === undefined)
    throw new Error("E_A0_OBSERVER_CLI_ARGS");
  const request = JSON.parse(
    readFileSync(requestPath, "utf8"),
  ) as A0ObserverRequest;
  try {
    const observation = await dispatchIndependentObservation(request);
    writeFileSync(outputPath, JSON.stringify({ ok: true, observation }));
  } catch (error) {
    writeFileSync(
      outputPath,
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 2;
  }
}
