import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { migrations as currentWorkflowMigrations } from "../../../../../plugins/workflows/src/data.js";
import { BUILTIN_PLUGINS } from "./builtin-registry.js";
import { createPluginApi, type PluginApiHandle } from "./plugin-api.js";
import { inspectHostFoundationBytes } from "./artifact-review-v3-host-foundation-alternate-observer.js";
import { observeHostFoundationDatabase } from "./artifact-review-v3-host-foundation-reopen-observer.js";

type FixedHostPhase = "pre-commit" | "post-commit-pre-close";

interface MigrationRow {
  readonly byteLength: number;
  readonly id: number;
  readonly sha256: string;
  readonly statementUtf8: string;
}

interface MigrationVector {
  readonly byteLength: number;
  readonly encoding: string;
  readonly sha256: string;
  readonly value: string;
}

interface GeneratedAuthority {
  readonly architectureRevision: number;
  readonly migrations: readonly MigrationRow[];
  readonly migrationVector: MigrationVector;
  readonly pluginId: string;
  readonly serviceRevision: string;
  readonly v12ApprovalSha256: string;
  readonly v12LedgerSha256: string;
  readonly v12ManifestSha256: string;
}

type MutableAuthority = Omit<GeneratedAuthority, "migrations"> & {
  migrations: MigrationRow[];
};

interface ChildRequest {
  readonly attemptedOverrides?: Readonly<Record<string, unknown>>;
  readonly dataDir: string;
  readonly hostPluginId: string;
  readonly targetPhase: FixedHostPhase | null;
}

interface ChildDeath {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

const EXPECTED_BINDINGS = {
  architectureRevision: 2,
  serviceRevision: "bb-artifact-review-service:revision-1",
  v12ApprovalSha256:
    "c28b4884022b615491ba826ca6a6a2604d97c39b914d4ee44fdc406e30ea28e0",
  v12LedgerSha256:
    "ee24d026bffba3b976dfbc0363193459b0c7d98c22f362b2d9a18b01b0c1e1d7",
  v12ManifestSha256:
    "c074fc850151672da17f2b6478782a90becacef0a5641154c731033cb90a8a3b",
} as const;
const EXPECTED_VECTOR_ENCODING =
  "id-colon-sha256-semicolon-no-terminal";
const GENERATED_AUTHORITY_URL = new URL(
  "./generated/workflows-plugin-migration-authority.generated.ts",
  import.meta.url,
);
const REGISTRY_URL = new URL(
  "./plugin-migration-authority-registry.ts",
  import.meta.url,
);
const PHASE_CONTROLLER_URL = new URL(
  "./host-transaction-phase-controller.ts",
  import.meta.url,
);
const CHILD_PATH = fileURLToPath(
  new URL(
    "./test-fixtures/artifact-review-v3-host-foundation-child.ts",
    import.meta.url,
  ),
);
const V12_PATH = fileURLToPath(
  new URL(
    "./migration-authorities/workflows-artifact-review-recovery-v12.json",
    import.meta.url,
  ),
);
const scratchRoot = mkdtempSync(join(tmpdir(), "bb-f1-oracle-"));
const handles: PluginApiHandle[] = [];

afterAll(() => {
  for (const handle of handles.splice(0)) {
    for (const database of handle.databaseHandles) {
      if (database.open) database.close();
    }
  }
  rmSync(scratchRoot, { recursive: true });
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseFrozenV12(): {
  readonly migrations: readonly MigrationRow[];
  readonly vector: MigrationVector;
} {
  const value: unknown = JSON.parse(readFileSync(V12_PATH, "utf8"));
  if (value === null || typeof value !== "object") {
    throw new Error("F1_V12_AUTHORITY_NOT_OBJECT");
  }
  const authority = (value as Record<string, unknown>).authority;
  if (authority === null || typeof authority !== "object") {
    throw new Error("F1_V12_AUTHORITY_MISSING");
  }
  const record = authority as Record<string, unknown>;
  if (!Array.isArray(record.migrationCatalog)) {
    throw new Error("F1_V12_CATALOG_MISSING");
  }
  const migrations = record.migrationCatalog.map((row, index) => {
    if (row === null || typeof row !== "object") {
      throw new Error(`F1_V12_ROW_INVALID:${index}`);
    }
    const candidate = row as Record<string, unknown>;
    if (
      typeof candidate.id !== "number" ||
      typeof candidate.statementUtf8 !== "string" ||
      typeof candidate.byteLength !== "number" ||
      typeof candidate.sha256 !== "string"
    ) {
      throw new Error(`F1_V12_ROW_INVALID:${index}`);
    }
    return {
      byteLength: candidate.byteLength,
      id: candidate.id,
      sha256: candidate.sha256,
      statementUtf8: candidate.statementUtf8,
    };
  });
  const rawVector = record.migrationVectorIdentity;
  if (rawVector === null || typeof rawVector !== "object") {
    throw new Error("F1_V12_VECTOR_MISSING");
  }
  const candidate = rawVector as Record<string, unknown>;
  if (
    typeof candidate.byteLength !== "number" ||
    typeof candidate.encoding !== "string" ||
    typeof candidate.sha256 !== "string" ||
    typeof candidate.value !== "string"
  ) {
    throw new Error("F1_V12_VECTOR_INVALID");
  }
  return {
    migrations,
    vector: {
      byteLength: candidate.byteLength,
      encoding: candidate.encoding,
      sha256: candidate.sha256,
      value: candidate.value,
    },
  };
}

function assertGeneratedAuthority(
  value: unknown,
): asserts value is GeneratedAuthority {
  if (value === null || typeof value !== "object") {
    throw new Error("F1_GENERATED_AUTHORITY_INVALID");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.architectureRevision !== "number" ||
    typeof candidate.pluginId !== "string" ||
    typeof candidate.serviceRevision !== "string" ||
    typeof candidate.v12ApprovalSha256 !== "string" ||
    typeof candidate.v12LedgerSha256 !== "string" ||
    typeof candidate.v12ManifestSha256 !== "string" ||
    !Array.isArray(candidate.migrations) ||
    candidate.migrationVector === null ||
    typeof candidate.migrationVector !== "object"
  ) {
    throw new Error("F1_GENERATED_AUTHORITY_INVALID");
  }
  for (const [index, row] of candidate.migrations.entries()) {
    if (row === null || typeof row !== "object") {
      throw new Error(`F1_GENERATED_AUTHORITY_ROW_INVALID:${index}`);
    }
    const migration = row as Record<string, unknown>;
    if (
      typeof migration.byteLength !== "number" ||
      typeof migration.id !== "number" ||
      typeof migration.sha256 !== "string" ||
      typeof migration.statementUtf8 !== "string"
    ) {
      throw new Error(`F1_GENERATED_AUTHORITY_ROW_INVALID:${index}`);
    }
  }
  const vector = candidate.migrationVector as Record<string, unknown>;
  if (
    typeof vector.byteLength !== "number" ||
    typeof vector.encoding !== "string" ||
    typeof vector.sha256 !== "string" ||
    typeof vector.value !== "string"
  ) {
    throw new Error("F1_GENERATED_AUTHORITY_VECTOR_INVALID");
  }
}

async function loadGeneratedAuthority(): Promise<GeneratedAuthority> {
  try {
    const module = await import(/* @vite-ignore */ GENERATED_AUTHORITY_URL.href);
    const authority: unknown = module.WORKFLOWS_PLUGIN_MIGRATION_AUTHORITY;
    assertGeneratedAuthority(authority);
    return authority;
  } catch (error) {
    throw new Error("F1_MISSING_GENERATED_HOST_AUTHORITY", { cause: error });
  }
}

function migrationVector(rows: readonly MigrationRow[]): MigrationVector {
  const value = rows.map((row) => `${row.id}:${row.sha256}`).join(";");
  return {
    byteLength: Buffer.byteLength(value, "utf8"),
    encoding: EXPECTED_VECTOR_ENCODING,
    sha256: sha256(value),
    value,
  };
}

function adjudicateAuthority(
  authority: GeneratedAuthority,
  frozen: ReturnType<typeof parseFrozenV12>,
): void {
  if (
    authority.architectureRevision !== EXPECTED_BINDINGS.architectureRevision ||
    authority.serviceRevision !== EXPECTED_BINDINGS.serviceRevision ||
    authority.v12ManifestSha256 !== EXPECTED_BINDINGS.v12ManifestSha256 ||
    authority.v12ApprovalSha256 !== EXPECTED_BINDINGS.v12ApprovalSha256 ||
    authority.v12LedgerSha256 !== EXPECTED_BINDINGS.v12LedgerSha256
  ) {
    throw new Error("F1_AUTHORITY_STALE_BINDING");
  }
  if (authority.pluginId !== "workflows") {
    throw new Error("F1_AUTHORITY_WRONG_PLUGIN");
  }
  if (authority.migrations.length < frozen.migrations.length) {
    throw new Error("F1_AUTHORITY_MISSING_ROW");
  }
  if (authority.migrations.length > frozen.migrations.length) {
    throw new Error("F1_AUTHORITY_EXTRA_ROW");
  }
  authority.migrations.forEach((row, index) => {
    const expected = frozen.migrations[index];
    if (!expected || row.id !== expected.id) {
      throw new Error(`F1_AUTHORITY_REORDERED_ROW:${index}`);
    }
    if (
      row.statementUtf8 !== expected.statementUtf8 ||
      Buffer.byteLength(row.statementUtf8, "utf8") !== expected.byteLength ||
      row.byteLength !== expected.byteLength
    ) {
      throw new Error(`F1_AUTHORITY_CHANGED_BYTES:${index}`);
    }
    if (sha256(row.statementUtf8) !== row.sha256 || row.sha256 !== expected.sha256) {
      throw new Error(`F1_AUTHORITY_FORGED_ROW_HASH:${index}`);
    }
  });
  const computed = migrationVector(authority.migrations);
  if (
    authority.migrationVector.encoding !== EXPECTED_VECTOR_ENCODING ||
    authority.migrationVector.value !== computed.value ||
    authority.migrationVector.byteLength !== computed.byteLength ||
    authority.migrationVector.sha256 !== computed.sha256 ||
    authority.migrationVector.value !== frozen.vector.value ||
    authority.migrationVector.byteLength !== frozen.vector.byteLength ||
    authority.migrationVector.sha256 !== frozen.vector.sha256
  ) {
    throw new Error("F1_AUTHORITY_FORGED_VECTOR");
  }
  if (
    currentWorkflowMigrations.length !== authority.migrations.length ||
    currentWorkflowMigrations.some(
      (statement, index) => statement !== authority.migrations[index]?.statementUtf8,
    )
  ) {
    throw new Error("F1_CURRENT_WORKFLOWS_SOURCE_DIVERGED");
  }
}

function executeAuthority(authority: GeneratedAuthority): void {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    const execute = database.transaction(() => {
      database.exec(
        "CREATE TABLE _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
      );
      const record = database.prepare(
        "INSERT INTO _bb_migrations(id, applied_at) VALUES (?, 1)",
      );
      for (const migration of authority.migrations) {
        database.exec(migration.statementUtf8);
        record.run(migration.id);
      }
    });
    execute.immediate();
    expect(
      database.prepare("SELECT id FROM _bb_migrations ORDER BY id").pluck().all(),
    ).toEqual(Array.from({ length: 23 }, (_, id) => id));
  } finally {
    database.close();
  }
}

function cloneAuthority(authority: GeneratedAuthority): MutableAuthority {
  return structuredClone(authority) as MutableAuthority;
}

function verifyAuthorityFaultClosure(
  authority: GeneratedAuthority,
  frozen: ReturnType<typeof parseFrozenV12>,
): void {
  const stale = cloneAuthority(authority);
  Object.assign(stale, { v12ManifestSha256: "0".repeat(64) });
  const changed = cloneAuthority(authority);
  Object.assign(changed.migrations[7]!, {
    statementUtf8: `${changed.migrations[7]!.statementUtf8} `,
  });
  const reordered = cloneAuthority(authority);
  [reordered.migrations[4], reordered.migrations[5]] = [
    reordered.migrations[5]!,
    reordered.migrations[4]!,
  ];
  const extra = cloneAuthority(authority);
  extra.migrations.push({ ...extra.migrations[22]!, id: 23 });
  const missing = cloneAuthority(authority);
  missing.migrations.pop();
  const forgedRow = cloneAuthority(authority);
  Object.assign(forgedRow.migrations[9]!, { sha256: "f".repeat(64) });
  const forgedVector = cloneAuthority(authority);
  Object.assign(forgedVector.migrationVector, { sha256: "e".repeat(64) });
  for (const [mutant, expected] of [
    [stale, "F1_AUTHORITY_STALE_BINDING"],
    [changed, "F1_AUTHORITY_CHANGED_BYTES:7"],
    [reordered, "F1_AUTHORITY_REORDERED_ROW:4"],
    [extra, "F1_AUTHORITY_EXTRA_ROW"],
    [missing, "F1_AUTHORITY_MISSING_ROW"],
    [forgedRow, "F1_AUTHORITY_FORGED_ROW_HASH:9"],
    [forgedVector, "F1_AUTHORITY_FORGED_VECTOR"],
  ] as const) {
    expect(() => adjudicateAuthority(mutant, frozen)).toThrow(expected);
  }
}

async function verifyHostRegistry(authority: GeneratedAuthority): Promise<void> {
  const module = await import(/* @vite-ignore */ REGISTRY_URL.href);
  const select = module.getPluginMigrationAuthority;
  expect(typeof select).toBe("function");
  const workflowPluginId = BUILTIN_PLUGINS.find(
    (plugin) => plugin.name === "workflows",
  )?.pluginId;
  expect(workflowPluginId).toBe("workflows");
  expect(Reflect.apply(select, undefined, [workflowPluginId])).toEqual(authority);
  for (const foreignIdentity of [
    "workflow",
    "builtin:workflows",
    "../workflows",
    "/workflows",
    "WORKFLOWS",
  ]) {
    expect(() =>
      Reflect.apply(select, undefined, [foreignIdentity]),
    ).not.toReturnWith(authority);
  }
  expect(() =>
    Reflect.apply(select, undefined, [
      { pluginId: "workflows", statements: authority.migrations },
    ]),
  ).not.toReturnWith(authority);
  expect(
    Reflect.apply(select, undefined, ["workflows", {
      databasePath: "/tmp/foreign.db",
      statements: ["SELECT 1"],
    }]),
  ).toEqual(authority);
}

function databasePath(dataDir: string, pluginId = "workflows"): string {
  return join(dataDir, "plugins", pluginId, "data.db");
}

function writeChildRequest(request: ChildRequest): string {
  const requestPath = join(
    scratchRoot,
    `request-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  writeFileSync(requestPath, JSON.stringify(request), { flag: "wx" });
  return requestPath;
}

function spawnFixture(request: ChildRequest): {
  readonly child: ChildProcess;
  readonly stderr: () => string;
} {
  const requestPath = writeChildRequest(request);
  const child = fork(CHILD_PATH, [requestPath], {
    cwd: resolve(dirname(CHILD_PATH), "../../../../../.."),
    execArgv: ["--conditions=source", "--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let errorText = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    errorText += chunk.toString();
  });
  return { child, stderr: () => errorText };
}

function waitForBarrier(
  spawned: ReturnType<typeof spawnFixture>,
  expectedPhase: FixedHostPhase,
): Promise<ChildProcess> {
  return new Promise((resolveBarrier, rejectBarrier) => {
    const timer = setTimeout(() => {
      spawned.child.kill("SIGKILL");
      rejectBarrier(new Error("F1_SETUP_FAILURE:barrier-timeout"));
    }, 12_000);
    const reject = (error: Error) => {
      clearTimeout(timer);
      rejectBarrier(error);
    };
    spawned.child.once("error", (error) =>
      reject(new Error("F1_SETUP_FAILURE:child-error", { cause: error })),
    );
    spawned.child.once("exit", (code, signal) =>
      reject(
        new Error(
          `F1_SETUP_FAILURE:death-before-barrier:code=${String(code)}:signal=${String(signal)}:${spawned.stderr()}`,
        ),
      ),
    );
    spawned.child.on("message", (message: unknown) => {
      if (
        message !== null &&
        typeof message === "object" &&
        (message as Record<string, unknown>).type === "phase-barrier" &&
        (message as Record<string, unknown>).phase === expectedPhase
      ) {
        clearTimeout(timer);
        resolveBarrier(spawned.child);
        return;
      }
      reject(new Error("F1_SETUP_FAILURE:unexpected-child-message"));
    });
  });
}

function waitForDeath(
  spawned: ReturnType<typeof spawnFixture>,
): Promise<ChildDeath> {
  return new Promise((resolveDeath, rejectDeath) => {
    const timer = setTimeout(() => {
      spawned.child.kill("SIGKILL");
      rejectDeath(new Error("F1_SETUP_FAILURE:exit-timeout"));
    }, 12_000);
    spawned.child.once("error", (error) => {
      clearTimeout(timer);
      rejectDeath(new Error("F1_SETUP_FAILURE:child-error", { cause: error }));
    });
    spawned.child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveDeath({ code, signal, stderr: spawned.stderr() });
    });
    spawned.child.once("message", () => {
      spawned.child.kill("SIGKILL");
      clearTimeout(timer);
      rejectDeath(new Error("F1_SETUP_FAILURE:unexpected-success-or-barrier-message"));
    });
  });
}

function killBarrierChild(
  spawned: ReturnType<typeof spawnFixture>,
  signal: NodeJS.Signals,
): Promise<ChildDeath> {
  const death = waitForDeath(spawned);
  spawned.child.kill(signal);
  return death;
}

function requireSigkill(death: ChildDeath): void {
  if (death.code !== null || death.signal !== "SIGKILL") {
    throw new Error(
      `F1_AMBIGUOUS_PROCESS_DEATH:code=${String(death.code)}:signal=${String(death.signal)}`,
    );
  }
}

async function runToExit(request: ChildRequest): Promise<ChildDeath> {
  const spawned = spawnFixture(request);
  return waitForDeath(spawned);
}

function expectZeroEffectsIfCreated(path: string): void {
  if (!existsSync(path)) return;
  expect(observeHostFoundationDatabase(path).migrationIds).toEqual([]);
  expect(observeHostFoundationDatabase(path).sentinel).toBeNull();
  expect(inspectHostFoundationBytes(path).descendingMigrationEncoding).toBe("");
  expect(inspectHostFoundationBytes(path).sentinelHex).toEqual([]);
}

async function verifySubstitutionControls(): Promise<void> {
  const foreignPluginRoot = mkdtempSync(join(scratchRoot, "foreign-plugin-"));
  const foreignPlugin = await runToExit({
    dataDir: foreignPluginRoot,
    hostPluginId: "not-workflows",
    targetPhase: null,
  });
  expect(foreignPlugin.code).not.toBe(0);
  expectZeroEffectsIfCreated(databasePath(foreignPluginRoot, "not-workflows"));

  const overrideRoot = mkdtempSync(join(scratchRoot, "request-control-"));
  const divertedRoot = mkdtempSync(join(scratchRoot, "diverted-"));
  const override = await runToExit({
    attemptedOverrides: {
      databasePath: join(divertedRoot, "foreign.db"),
      pluginAlias: "builtin:workflows",
      requestPluginId: "workflows",
      statements: ["CREATE TABLE request_owned_authority(value TEXT)"],
    },
    dataDir: overrideRoot,
    hostPluginId: "workflows",
    targetPhase: null,
  });
  expect(override.code).not.toBe(0);
  expectZeroEffectsIfCreated(databasePath(overrideRoot));
  expect(existsSync(join(divertedRoot, "foreign.db"))).toBe(false);

  const realRoot = mkdtempSync(join(scratchRoot, "real-root-"));
  const aliasRoot = join(scratchRoot, "alias-root");
  symlinkSync(realRoot, aliasRoot, "dir");
  const alias = await runToExit({
    dataDir: aliasRoot,
    hostPluginId: "workflows",
    targetPhase: null,
  });
  expect(alias.code).not.toBe(0);
  expectZeroEffectsIfCreated(databasePath(realRoot));
}

function expectCommittedFoundation(path: string): void {
  const primary = observeHostFoundationDatabase(path);
  const alternate = inspectHostFoundationBytes(path);
  expect(primary.journalMode).toBe("wal");
  expect(primary.migrationIds).toEqual(
    Array.from({ length: 23 }, (_, id) => id),
  );
  expect(primary.sentinel).toEqual({
    foreignKeys: 1,
    journalMode: "wal",
    marker: "complete",
    synchronousLevel: 2,
  });
  expect(alternate.durableMode).toBe("wal");
  expect(alternate.descendingMigrationEncoding).toBe(
    Array.from({ length: 23 }, (_, index) => String(22 - index)).join("|"),
  );
  expect(alternate.sentinelHex).toEqual([
    "636F6D706C657465:77616C:02:01",
  ]);
}

async function verifyCrashPhases(): Promise<void> {
  const preCommitRoot = mkdtempSync(join(scratchRoot, "pre-commit-"));
  const preCommit = spawnFixture({
    dataDir: preCommitRoot,
    hostPluginId: "workflows",
    targetPhase: "pre-commit",
  });
  await waitForBarrier(preCommit, "pre-commit");
  const preDeath = await killBarrierChild(preCommit, "SIGKILL");
  requireSigkill(preDeath);
  const prePath = databasePath(preCommitRoot);
  const primaryZero = observeHostFoundationDatabase(prePath);
  const alternateZero = inspectHostFoundationBytes(prePath);
  expect(primaryZero.migrationIds).toEqual([]);
  expect(primaryZero.sentinel).toBeNull();
  expect(alternateZero.descendingMigrationEncoding).toBe("");
  expect(alternateZero.sentinelHex).toEqual([]);

  const retry = await runToExit({
    dataDir: preCommitRoot,
    hostPluginId: "workflows",
    targetPhase: null,
  });
  expect(retry).toMatchObject({ code: 0, signal: null });
  expectCommittedFoundation(prePath);

  const postCommitRoot = mkdtempSync(join(scratchRoot, "post-commit-"));
  const postCommit = spawnFixture({
    dataDir: postCommitRoot,
    hostPluginId: "workflows",
    targetPhase: "post-commit-pre-close",
  });
  await waitForBarrier(postCommit, "post-commit-pre-close");
  const postDeath = await killBarrierChild(postCommit, "SIGKILL");
  requireSigkill(postDeath);
  expectCommittedFoundation(databasePath(postCommitRoot));

  const ambiguousRoot = mkdtempSync(join(scratchRoot, "ambiguous-"));
  const ambiguous = spawnFixture({
    dataDir: ambiguousRoot,
    hostPluginId: "workflows",
    targetPhase: "pre-commit",
  });
  await waitForBarrier(ambiguous, "pre-commit");
  const ambiguousDeath = await killBarrierChild(ambiguous, "SIGTERM");
  expect(() => requireSigkill(ambiguousDeath)).toThrow(
    "F1_AMBIGUOUS_PROCESS_DEATH",
  );
}

function createV2Host(): PluginApiHandle {
  const dataDir = mkdtempSync(join(scratchRoot, "v2-"));
  const noop = () => undefined;
  const handle = createPluginApi({
    pluginId: "f1-v2-control",
    dataDir,
    db: {} as never,
    logger: { debug: noop, info: noop, warn: noop, error: noop } as never,
    getSdk: () => undefined,
    getLoopbackBaseUrl: () => undefined,
    publishSignal: noop,
    reportNeedsConfiguration: noop,
    isAgentToolNameTaken: () => undefined,
    reportAgentToolProblem: noop,
    requestInteraction: async () => ({ outcome: "cancelled" }) as never,
    ensureSharedPortTunnel: async () => ({}) as never,
    validateSharedPortDeclaration: (_hostId, ports) => ports,
    declareSharedPorts: noop,
    replaceDeclaredSharedPorts: noop,
    callPluginHost: async () => undefined,
    registerProvider: () => ({ dispose: noop }),
    isProviderIdTaken: () => false,
    assertProviderRegistrable: noop,
  });
  handles.push(handle);
  return handle;
}

function verifyV2Unchanged(): void {
  const handle = createV2Host();
  const database = handle.api.storage.database();
  handle.api.storage.migrate(database, [
    "CREATE TABLE f1_v2_control(value TEXT NOT NULL)",
    "INSERT INTO f1_v2_control(value) VALUES ('unchanged')",
  ]);
  expect(database.prepare("SELECT value FROM f1_v2_control").pluck().all()).toEqual([
    "unchanged",
  ]);
  expect(database.prepare("SELECT id FROM _bb_migrations ORDER BY id").pluck().all()).toEqual([
    0,
    1,
  ]);
}

async function verifyPhasePrivacyAndDarkness(): Promise<void> {
  const phaseModule = await import(/* @vite-ignore */ PHASE_CONTROLLER_URL.href);
  expect(typeof phaseModule.createHostTransactionPhaseController).toBe(
    "function",
  );
  const seen: unknown[][] = [];
  const controller = phaseModule.createHostTransactionPhaseController(
    (...args: unknown[]) => {
      seen.push(args);
      return { authority: "poison", result: "poison" };
    },
  );
  const result = Reflect.apply(controller, undefined, ["pre-commit"]);
  expect(result).toBeUndefined();
  expect(seen).toEqual([["pre-commit"]]);

  const sdk = await import("@get-bb/plugin-sdk");
  const workflowServer = await import(
    "../../../../../plugins/workflows/src/server.js"
  );
  const forbidden = /(?:host.*transaction|transaction.*phase|migration.*authority|authority.*migration)/iu;
  expect(Object.keys(sdk).filter((key) => forbidden.test(key))).toEqual([]);
  expect(Object.keys(workflowServer).filter((key) => forbidden.test(key))).toEqual(
    [],
  );

  const handle = createV2Host();
  expect(
    Object.keys(handle.api.storage).filter((key) => forbidden.test(key)),
  ).toEqual([]);
  const sdkManifest = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../../../../packages/plugin-sdk/package.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as { exports: Record<string, unknown> };
  const workflowManifest = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../../../../plugins/workflows/package.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as { bb: Record<string, unknown> };
  expect(Object.keys(sdkManifest.exports).filter((key) => forbidden.test(key))).toEqual(
    [],
  );
  expect(Object.keys(workflowManifest.bb).filter((key) => forbidden.test(key))).toEqual(
    [],
  );
}

describe("F1 host migration authority and commit phase oracle", () => {
  it(
    "admits only exact private authority and SIGKILL-proven host transaction phases",
    { timeout: 60_000 },
    async () => {
      const frozen = parseFrozenV12();
      expect(frozen.migrations).toHaveLength(23);
      expect(frozen.migrations.map((row) => row.id)).toEqual(
        Array.from({ length: 23 }, (_, id) => id),
      );
      const authority = await loadGeneratedAuthority();
      adjudicateAuthority(authority, frozen);
      expect(Object.isFrozen(authority)).toBe(true);
      expect(Object.isFrozen(authority.migrations)).toBe(true);
      expect(authority.migrations.every((row) => Object.isFrozen(row))).toBe(true);
      executeAuthority(authority);
      verifyAuthorityFaultClosure(authority, frozen);
      await verifyHostRegistry(authority);
      await verifySubstitutionControls();
      await verifyCrashPhases();
      await verifyPhasePrivacyAndDarkness();
      verifyV2Unchanged();
    },
  );
});
