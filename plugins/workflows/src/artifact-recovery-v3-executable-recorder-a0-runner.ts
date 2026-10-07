import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { migrations } from "./data.js";
import {
  A0_BOUNDARY_MUTATIONS,
  assertCandidateInput,
  boundaryMutationDescriptor,
  reach,
  runKnownGoodReferenceAdapter,
  runReducerAdapter,
  runWorkflowsFakeAdapter,
  stableJson,
  type A0BoundaryMutationDescriptor,
  type A0CandidateInput,
  type A0Operation,
  type A0PublicStimulus,
  type A0Reachability,
} from "./artifact-recovery-v3-executable-recorder-a0-reference-and-fault-adapters.js";
import type { A0ObserverRequest } from "./artifact-recovery-v3-executable-recorder-a0-independent-observer.js";

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const command = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) => {
  const result = spawnSync(executable, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    executable,
    args,
    cwd: options.cwd,
    started: true as const,
    completed: result.status !== null,
    status: result.status,
    signal: result.signal,
    stdoutSha256: sha256(result.stdout ?? ""),
    stderr: result.stderr ?? "",
  };
};

type CommandReceipt = ReturnType<typeof command>;

export type A0ExecutionRecord = Readonly<{
  executionIdentity: string;
  nonce: string;
  ordinal: number;
  kind: "positive" | "control" | "target" | "manifest-newline";
  operation: A0Operation;
  stimulusDigest?: string;
  controlId?: string;
  candidateProcessId: number;
  candidateExit: { completed: boolean; status: number | null; signal: NodeJS.Signals | null };
  issuedRoots: {
    storeRoot: string;
    commandRoot: string;
    cleanConsumerRoot: string;
  };
  boundaryMutation?: { id: string; kind: string };
  operational: Record<string, unknown>;
  operationalSha256: string;
  reachability: readonly A0Reachability[];
  durableRecord: { path: string; byteLength: number; sha256: string };
  candidateCommand: CommandReceipt;
}>;

export type A0ObservationRecord = Readonly<{
  executionIdentity: string;
  observerProcessId: number;
  observerId: string;
  actual: Readonly<Record<string, unknown>>;
  operational: unknown;
  control?: {
    reached: true;
    killed: true;
    reason: string;
    boundary: unknown;
  };
  pipelineStages: readonly string[];
  pipelineIdentitySha256: string;
  durableObservation: { path: string; byteLength: number; sha256: string };
  observerCommand: CommandReceipt;
}>;

export type A0ControlReceipt = Readonly<{
  id: string;
  executionIdentity: string;
  killerStarted: true;
  killerCompleted: true;
  reached: true;
  killed: true;
  reason: string;
  receiptType: string;
  evidence: unknown;
}>;

type SdkIdentity = Readonly<{
  path: string;
  byteLength: number;
  sha256: string;
}>;

type SdkBuild = Readonly<{
  root: string;
  runtime: readonly SdkIdentity[];
  declarations: readonly SdkIdentity[];
  commands: readonly CommandReceipt[];
}>;

export type SdkBuildPair = Readonly<{
  first: SdkBuild;
  second: SdkBuild;
  identical: boolean;
  completeSetSha256: string;
}>;

type SdkExecutionMatrix = Readonly<{
  path: string;
  commands: readonly CommandReceipt[];
  surfaces: Readonly<Record<string, Record<string, unknown>>>;
}>;

export type A0LedgerRow = Readonly<{
  execution: A0ExecutionRecord;
  observation: A0ObservationRecord;
}>;

export type A0ReadinessRun = Readonly<{
  runIdentity: string;
  recorderProcessId: number;
  root: string;
  executions: readonly A0ExecutionRecord[];
  observations: readonly A0ObservationRecord[];
  controls: readonly A0ControlReceipt[];
  ledgerRows: readonly A0LedgerRow[];
  targetConstructionRed: A0LedgerRow;
  manifestNewlineControl: A0LedgerRow;
  sdkBuilds: SdkBuildPair;
  sdkMatrix: SdkExecutionMatrix;
  manifestEncoding: {
    recorder: { byteLength: number; sha256: string; terminalNewline: false };
    independent: { byteLength: number; sha256: string; terminalNewline: false };
    identical: true;
  };
  helperReachability: readonly A0Reachability[];
  cleanup: () => void;
}>;

const runtimePaths = [
  "dist/index.js",
  "dist/app.js",
  "dist/provider-bridge.js",
  "dist/host.js",
  "dist/internal/composer-customization-validation.js",
  "dist/internal/composer-view.js",
  "dist/internal/file-navigation-validation.js",
  "dist/internal/host-policy.js",
  "dist/internal/plugin-app-collector.js",
  "dist/testing/index.js",
  "dist/testing/app.js",
  "dist/testing/host.js",
] as const;

const declarationPaths = [
  "bundled-types/bb-plugin-sdk.d.ts",
  "bundled-types/bb-plugin-sdk-app.d.ts",
  "bundled-types/bb-plugin-sdk-provider-bridge.d.ts",
  "bundled-types/bb-plugin-sdk-host.d.ts",
  "bundled-types/bb-plugin-sdk-internal-composer-customization-validation.d.ts",
  "bundled-types/bb-plugin-sdk-internal-composer-view.d.ts",
  "bundled-types/bb-plugin-sdk-internal-file-navigation-validation.d.ts",
  "bundled-types/bb-plugin-sdk-internal-host-policy.d.ts",
  "bundled-types/bb-plugin-sdk-internal-plugin-app-collector.d.ts",
  "bundled-types/bb-plugin-sdk-testing.d.ts",
  "bundled-types/bb-plugin-sdk-testing-app.d.ts",
  "bundled-types/bb-plugin-sdk-testing-host.d.ts",
] as const;

const runtimeSurfacePaths = Object.fromEntries(
  [
    "index",
    "app",
    "provider-bridge",
    "host",
    "internal-composer-customization-validation",
    "internal-composer-view",
    "internal-file-navigation-validation",
    "internal-host-policy",
    "internal-plugin-app-collector",
    "testing-index",
    "testing-app",
    "testing-host",
  ].map((name, index) => [`runtime:${name}`, runtimePaths[index]!]),
) as Record<string, string>;

const declarationSpecifiers: Record<string, string> = {
  "declaration:bb-plugin-sdk": "@get-bb/plugin-sdk",
  "declaration:bb-plugin-sdk-app": "@get-bb/plugin-sdk/app",
  "declaration:bb-plugin-sdk-provider-bridge": "@get-bb/plugin-sdk/provider-bridge",
  "declaration:bb-plugin-sdk-host": "@get-bb/plugin-sdk/host",
  "declaration:composer-customization-validation": "@get-bb/plugin-sdk/internal/composer-customization-validation",
  "declaration:composer-view": "@get-bb/plugin-sdk/internal/composer-view",
  "declaration:file-navigation-validation": "@get-bb/plugin-sdk/internal/file-navigation-validation",
  "declaration:host-policy": "@get-bb/plugin-sdk/internal/host-policy",
  "declaration:plugin-app-collector": "@get-bb/plugin-sdk/internal/plugin-app-collector",
  "declaration:testing": "@get-bb/plugin-sdk/testing",
  "declaration:testing-app": "@get-bb/plugin-sdk/testing/app",
  "declaration:testing-host": "@get-bb/plugin-sdk/testing/host",
};

const fileIdentities = (root: string, paths: readonly string[]): SdkIdentity[] =>
  paths.map((path) => {
    const value = readFileSync(join(root, path));
    return { path, byteLength: value.byteLength, sha256: sha256(value) };
  });

const copySdkPackage = (repositoryRoot: string, buildRoot: string): string => {
  mkdirSync(join(buildRoot, "packages"), { recursive: true });
  const packageRoot = join(buildRoot, "packages", "plugin-sdk");
  cpSync(join(repositoryRoot, "packages", "plugin-sdk"), packageRoot, {
    recursive: true,
    filter: (source) =>
      !["dist", "bundled-types", "node_modules"].includes(
        source.split("/").at(-1) ?? "",
      ),
  });
  symlinkSync(join(repositoryRoot, "node_modules"), join(buildRoot, "node_modules"), "dir");
  symlinkSync(
    join(repositoryRoot, "packages", "plugin-sdk", "node_modules"),
    join(packageRoot, "node_modules"),
    "dir",
  );
  for (const name of readdirSync(join(repositoryRoot, "packages"))) {
    if (name === "plugin-sdk") continue;
    symlinkSync(join(repositoryRoot, "packages", name), join(buildRoot, "packages", name), "dir");
  }
  return packageRoot;
};

const buildSdkOnce = (repositoryRoot: string, root: string): SdkBuild => {
  const packageRoot = copySdkPackage(repositoryRoot, root);
  const runtime = command(process.execPath, [join(packageRoot, "scripts/build-runtime.mjs")], { cwd: packageRoot });
  if (runtime.status !== 0) throw new Error(`E_A0_RUNTIME_BUILDER:${runtime.stderr}`);
  const declarations = command(process.execPath, [join(packageRoot, "scripts/build-bundled-dts.mjs")], { cwd: packageRoot });
  if (declarations.status !== 0) throw new Error(`E_A0_DECLARATION_BUILDER:${declarations.stderr}`);
  return {
    root: packageRoot,
    runtime: fileIdentities(packageRoot, runtimePaths),
    declarations: fileIdentities(packageRoot, declarationPaths),
    commands: [runtime, declarations],
  };
};

export const runIsolatedSdkBuilders = (
  repositoryRoot: string,
  commandRoot: string,
): SdkBuildPair => {
  const first = buildSdkOnce(repositoryRoot, join(commandRoot, "sdk-build-a"));
  const second = buildSdkOnce(repositoryRoot, join(commandRoot, "sdk-build-b"));
  const firstSet = stableJson({ runtime: first.runtime, declarations: first.declarations });
  const secondSet = stableJson({ runtime: second.runtime, declarations: second.declarations });
  return {
    first,
    second,
    identical: firstSet === secondSet,
    completeSetSha256: sha256(firstSet),
  };
};

const createApi = async (input: A0CandidateInput, repositoryRoot: string) => {
  const loaded = (await import(
    pathToFileURL(resolve(repositoryRoot, "apps/server/src/services/plugins/plugin-api.ts")).href
  )) as {
    createPluginApi(options: Record<string, unknown>): {
      api: { storage: { database(): unknown; migrate(database: unknown, statements: unknown): void } };
      databaseHandles: Array<{ open: boolean; close(): void }>;
    };
  };
  const noop = () => undefined;
  return loaded.createPluginApi({
    pluginId: `a0-${input.nonce.slice(0, 16)}`,
    dataDir: input.storeRoot,
    db: {},
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    getSdk: () => undefined,
    getLoopbackBaseUrl: () => undefined,
    publishSignal: noop,
    reportNeedsConfiguration: noop,
    isAgentToolNameTaken: () => undefined,
    reportAgentToolProblem: noop,
    requestInteraction: async () => ({ outcome: "cancelled" }),
    ensureSharedPortTunnel: async () => ({}),
    validateSharedPortDeclaration: (_hostId: string, ports: readonly number[]) => ports,
    declareSharedPorts: noop,
    replaceDeclaredSharedPorts: noop,
    callPluginHost: async () => undefined,
    registerProvider: () => ({ dispose: noop }),
    isProviderIdTaken: () => false,
    assertProviderRegistrable: noop,
  });
};

const closeHandles = (handles: readonly { open: boolean; close(): void }[]): void => {
  for (const handle of handles) if (handle.open) handle.close();
};

const expectedDatabasePath = (input: A0CandidateInput): string =>
  join(input.storeRoot, "plugins", `a0-${input.nonce.slice(0, 16)}`, "data.db");

const runProductionBoundary = async (
  input: A0CandidateInput,
  repositoryRoot: string,
): Promise<Record<string, unknown>> => {
  const handle = await createApi(input, repositoryRoot);
  const databasePath = expectedDatabasePath(input);
  let faultObserved: string | null = null;
  let databaseAccessed = false;
  try {
    if (input.operation.interface === "production-admission") {
      const inaccessibleDatabase = new Proxy(
        {},
        { get: () => { throw new Error("E_A0_ADMISSION_TOUCHED_DATABASE"); } },
      );
      const plan = {
        version: 3,
        authorityId: "a0-unadmitted-authority",
        statements: [],
      };
      try {
        handle.api.storage.migrate(inaccessibleDatabase, plan);
      } catch (error) {
        faultObserved = error instanceof Error ? error.message : String(error);
        databaseAccessed = faultObserved === "E_A0_ADMISSION_TOUCHED_DATABASE";
      }
      return {
        kind: "production-admission",
        databasePath,
        factory: "createPluginApi",
        migrate: "storage.migrate",
        factoryInvoked: true,
        migrateInvoked: true,
        databaseAccessed,
        faultObserved,
        candidateHandleClosed: true,
      };
    }
    const database = handle.api.storage.database();
    databaseAccessed = true;
    const plan = [...migrations];
    const phase = input.operation.fault?.phase;
    const migrationFault = phase?.match(/^migration:(\d+)$/u);
    if (migrationFault !== undefined && migrationFault !== null) {
      const index = Number(migrationFault[1]);
      if (index >= 0 && index < plan.length) plan[index] = "A0 INVALID SQL BOUNDARY MUTATION";
    }
    const invokeCount = Number(input.operation.input?.invokeCount ?? 1);
    for (let invocation = 0; invocation < invokeCount; invocation += 1) {
      try {
        handle.api.storage.migrate(database, plan);
      } catch (error) {
        faultObserved = error instanceof Error ? error.message : String(error);
        break;
      }
    }
  } finally {
    closeHandles(handle.databaseHandles);
  }
  return {
    kind: "production",
    databasePath,
    factory: "createPluginApi",
    migrate: "storage.migrate",
    factoryInvoked: true,
    migrateInvoked: true,
    databaseAccessed,
    faultObserved,
    candidateHandleClosed: true,
  };
};

const runSdkFakeBoundary = async (input: A0CandidateInput): Promise<Record<string, unknown>> => {
  const before = new Set(readdirSync(input.storeRoot));
  const host = createFakePluginHost({ pluginId: `a0-${input.nonce.slice(0, 16)}` });
  const database = host.bb.storage.database();
  let faultObserved: string | null = null;
  try {
    host.bb.storage.migrate(database, [...migrations]);
  } catch (error) {
    faultObserved = error instanceof Error ? error.message : String(error);
  }
  const source = database.name;
  database.close();
  const durable = join(input.storeRoot, "sdk-fake-observer.db");
  copyFileSync(source, durable);
  await host.harness.dispose();
  const created = readdirSync(input.storeRoot).filter((name) => !before.has(name));
  return {
    kind: "sdk-fake",
    databasePath: durable,
    factory: "createFakePluginHost",
    migrate: "storage.migrate",
    factoryInvoked: true,
    migrateInvoked: true,
    recorderRootEntries: created,
    faultObserved,
    candidateHandleClosed: true,
  };
};

const setupCleanConsumer = (input: A0CandidateInput): string => {
  if (input.sdkBuildRoot === undefined) throw new Error("E_A0_SDK_BUILD_ROOT");
  mkdirSync(join(input.cleanConsumerRoot, "node_modules", "@get-bb"), { recursive: true });
  const link = join(input.cleanConsumerRoot, "node_modules", "@get-bb", "plugin-sdk");
  if (!existsSync(link)) symlinkSync(input.sdkBuildRoot, link, "dir");
  writeFileSync(join(input.cleanConsumerRoot, "package.json"), JSON.stringify({ type: "module", private: true }));
  return input.sdkBuildRoot;
};

const negativeImportProbe = async (): Promise<Record<string, unknown>> => {
  try {
    await import(`a0-intentionally-absent-${randomBytes(8).toString("hex")}`);
  } catch (error) {
    return { rejected: true, errorCode: (error as NodeJS.ErrnoException).code ?? "ERR_MODULE_NOT_FOUND" };
  }
  return { rejected: false };
};

const cleanConsumerEnvironment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  NODE_OPTIONS: (process.env.NODE_OPTIONS ?? "")
    .replaceAll("--conditions=source", "")
    .replaceAll(/\s+/gu, " ")
    .trim(),
});

const buildSdkExecutionMatrix = (
  repositoryRoot: string,
  root: string,
  buildRoot: string,
): SdkExecutionMatrix => {
  const consumerRoot = join(root, "consumer");
  mkdirSync(join(consumerRoot, "node_modules", "@get-bb"), { recursive: true });
  symlinkSync(
    buildRoot,
    join(consumerRoot, "node_modules", "@get-bb", "plugin-sdk"),
    "dir",
  );
  writeFileSync(
    join(consumerRoot, "package.json"),
    JSON.stringify({ type: "module", private: true }),
  );
  const declarationSources = Object.entries(declarationSpecifiers).map(
    ([surface, specifier]) => {
      const path = join(consumerRoot, `${surface.replaceAll(":", "-")}.ts`);
      writeFileSync(path, `import ${JSON.stringify(specifier)}; export {};\n`);
      return path;
    },
  );
  const declarationCommand = command(
    "pnpm",
    [
      "exec",
      "tsc",
      "--noEmit",
      "--ignoreConfig",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--skipLibCheck",
      ...declarationSources,
    ],
    { cwd: repositoryRoot },
  );
  if (declarationCommand.status !== 0)
    throw new Error(`E_A0_DECLARATION_MATRIX:${declarationCommand.stderr}`);
  const runtimeScript = join(consumerRoot, "runtime-matrix.mjs");
  writeFileSync(
    runtimeScript,
    [
      'import { createRequire } from "node:module";',
      "globalThis.require = createRequire(import.meta.url);",
      ...runtimePaths.map(
        (path) => `await import(${JSON.stringify(pathToFileURL(join(buildRoot, path)).href)});`,
      ),
    ].join("\n"),
  );
  const runtimeCommand = command(process.execPath, [runtimeScript], {
    cwd: consumerRoot,
    env: cleanConsumerEnvironment(),
  });
  if (runtimeCommand.status !== 0)
    throw new Error(`E_A0_RUNTIME_MATRIX:${runtimeCommand.stderr}`);
  const workflowsCommand = command(
    "pnpm",
    ["exec", "tsc", "--noEmit", "-p", "plugins/workflows/tsconfig.json"],
    { cwd: repositoryRoot },
  );
  if (workflowsCommand.status !== 0)
    throw new Error(`E_A0_WORKFLOWS_TYPECHECK:${workflowsCommand.stderr}`);
  const negativeScript = join(consumerRoot, "negative-resolution.mjs");
  writeFileSync(negativeScript, 'await import("a0-intentionally-absent-sdk-surface");\n');
  const negativeCommand = command(process.execPath, [negativeScript], {
    cwd: consumerRoot,
    env: cleanConsumerEnvironment(),
  });
  if (negativeCommand.status === 0)
    throw new Error("E_A0_SDK_NEGATIVE_PROBE_SURVIVED");
  const surfaces: Record<string, Record<string, unknown>> = {};
  for (const [surface, path] of Object.entries(runtimeSurfacePaths)) {
    surfaces[surface] = {
      kind: "sdk-surface",
      surface,
      positive: runtimeCommand,
      negative: negativeCommand,
      surfaceIdentity: fileIdentities(buildRoot, [path])[0],
      candidateHandleClosed: true,
    };
  }
  for (const [surface] of Object.entries(declarationSpecifiers)) {
    const declarationIndex = Object.keys(declarationSpecifiers).indexOf(surface);
    surfaces[surface] = {
      kind: "sdk-surface",
      surface,
      positive: declarationCommand,
      negative: negativeCommand,
      surfaceIdentity: fileIdentities(buildRoot, [declarationPaths[declarationIndex]!])[0],
      candidateHandleClosed: true,
    };
  }
  surfaces["bundled-bb-plugin-sdk-dts"] = {
    ...surfaces["declaration:bb-plugin-sdk"],
    surface: "bundled-bb-plugin-sdk-dts",
  };
  surfaces["workflows-tsconfig"] = {
    kind: "sdk-surface",
    surface: "workflows-tsconfig",
    positive: workflowsCommand,
    negative: negativeCommand,
    candidateHandleClosed: true,
  };
  const path = join(root, "sdk-execution-matrix.json");
  writeFileSync(path, JSON.stringify({ surfaces }));
  return {
    path,
    commands: [declarationCommand, runtimeCommand, workflowsCommand, negativeCommand],
    surfaces,
  };
};

const runSdkSurface = async (
  input: A0CandidateInput,
  repositoryRoot: string,
): Promise<Record<string, unknown>> => {
  const buildRoot = setupCleanConsumer(input);
  const surface = input.operation.surface;
  if (surface === undefined) throw new Error("E_A0_SDK_SURFACE");
  if (input.boundaryMutation?.kind === "sdk-command-omission") {
    const intentPath = join(input.commandRoot, "sdk-command-intent.json");
    const receiptPath = join(input.commandRoot, "sdk-command-receipt.json");
    writeFileSync(
      intentPath,
      JSON.stringify({ executable: process.execPath, args: ["--version"] }),
    );
    return {
      kind: "sdk-surface",
      surface,
      sdkCommandIntentPath: intentPath,
      sdkCommandReceiptPath: receiptPath,
      negative: await negativeImportProbe(),
      candidateHandleClosed: true,
    };
  }
  if (input.sdkMatrixPath !== undefined) {
    const matrix = JSON.parse(readFileSync(input.sdkMatrixPath, "utf8")) as {
      surfaces: Record<string, Record<string, unknown>>;
    };
    const matrixReceipt = matrix.surfaces[surface];
    if (matrixReceipt !== undefined) return matrixReceipt;
  }
  let positive: Record<string, unknown>;
  if (surface === "source-index") {
    await import("@get-bb/plugin-sdk");
    positive = { resolved: true, sourceCondition: true };
  } else if (["normal-package-import", "direct-dist-index", "testing-entrypoint"].includes(surface)) {
    const specifier = surface === "normal-package-import"
      ? "@get-bb/plugin-sdk"
      : pathToFileURL(join(buildRoot, surface === "testing-entrypoint" ? "dist/testing/index.js" : "dist/index.js")).href;
    const script = join(input.cleanConsumerRoot, `${surface}.mjs`);
    writeFileSync(script, `await import(${JSON.stringify(specifier)});\n`);
    positive = command(process.execPath, [script], {
      cwd: input.cleanConsumerRoot,
      env: cleanConsumerEnvironment(),
    });
  } else if (surface === "workflows-tsconfig") {
    positive = command("pnpm", ["exec", "tsc", "--noEmit", "-p", "plugins/workflows/tsconfig.json"], { cwd: repositoryRoot });
  } else if (surface === "bundled-bb-plugin-sdk-dts" || declarationSpecifiers[surface] !== undefined) {
    const specifier = declarationSpecifiers[surface] ?? "@get-bb/plugin-sdk";
    const source = join(input.cleanConsumerRoot, `${surface.replaceAll(":", "-")}.ts`);
    writeFileSync(source, `import ${JSON.stringify(specifier)}; export {};\n`);
    positive = command("pnpm", [
      "exec", "tsc", "--noEmit", "--ignoreConfig", "--module", "NodeNext",
      "--moduleResolution", "NodeNext", "--target", "ES2022", "--skipLibCheck", source,
    ], { cwd: repositoryRoot });
  } else if (runtimeSurfacePaths[surface] !== undefined) {
    const modulePath = join(buildRoot, runtimeSurfacePaths[surface]!);
    const script = join(
      input.cleanConsumerRoot,
      `${surface.replaceAll(":", "-")}.mjs`,
    );
    writeFileSync(
      script,
      [
        'import { createRequire } from "node:module";',
        "globalThis.require = createRequire(import.meta.url);",
        `await import(${JSON.stringify(pathToFileURL(modulePath).href)});`,
      ].join("\n"),
    );
    positive = command(process.execPath, [script], {
      cwd: input.cleanConsumerRoot,
      env: cleanConsumerEnvironment(),
    });
  } else {
    throw new Error(`E_A0_UNKNOWN_SDK_SURFACE:${surface}`);
  }
  if (typeof positive.status === "number" && positive.status !== 0)
    throw new Error(`E_A0_SDK_COMMAND:${surface}:${String(positive.stderr)}`);
  return {
    kind: "sdk-surface",
    surface,
    positive,
    negative: await negativeImportProbe(),
    candidateHandleClosed: true,
  };
};

const mutateControlBoundary = async (
  input: A0CandidateInput,
  operational: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const mutation = input.boundaryMutation;
  if (mutation === undefined) return operational;
  if (mutation.kind === "private-authority-capability") {
    let observedError: string | null = null;
    try {
      assertCandidateInput({ ...input, operation: { interface: "reducer", input: { expected: "private" } } });
    } catch (error) {
      observedError = error instanceof Error ? error.message : String(error);
    }
    return {
      ...operational,
      privateAuthorityAccessReceipt: {
        attemptedKey: "expected",
        observedError,
      },
    };
  }
  if (mutation.kind === "candidate-database-root") {
    const selected = join(input.commandRoot, "candidate-selected", "data.db");
    mkdirSync(dirname(selected), { recursive: true });
    if (typeof operational.databasePath === "string" && existsSync(operational.databasePath)) copyFileSync(operational.databasePath, selected);
    else writeFileSync(selected, "candidate-selected-database");
    return { ...operational, databasePath: selected };
  }
  if (mutation.kind === "candidate-observation-cache")
    return { ...operational, claimedObserverProcessId: process.pid, serializedCandidateCache: { processId: process.pid } };
  if (mutation.kind === "committed-uncommitted-marker" || mutation.kind === "committed-rollback-marker") {
    const databasePath = String(operational.databasePath);
    const Database = (await import("better-sqlite3")).default;
    const database = new Database(databasePath);
    try {
      database.exec("CREATE TABLE IF NOT EXISTS a0_transaction_markers (kind TEXT NOT NULL)");
      database.prepare("INSERT INTO a0_transaction_markers VALUES (?)").run(
        mutation.kind === "committed-uncommitted-marker" ? "uncommitted" : "rollback",
      );
    } finally {
      database.close();
    }
    return operational;
  }
  if (mutation.kind === "rejected-admission-database") {
    const databasePath = String(operational.databasePath);
    mkdirSync(dirname(databasePath), { recursive: true });
    writeFileSync(databasePath, "created-by-rejected-admission-mutant");
    return operational;
  }
  if (mutation.kind === "runtime-output-staleness" || mutation.kind === "declaration-output-staleness") {
    if (input.sdkBuildRoot === undefined) throw new Error("E_A0_SDK_BUILD_ROOT");
    const path = mutation.kind === "runtime-output-staleness" ? runtimePaths[0] : declarationPaths[0];
    const source = join(input.sdkBuildRoot, path);
    const copy = join(input.commandRoot, path.replaceAll("/", "-"));
    const original = readFileSync(source);
    writeFileSync(copy, Buffer.concat([original, Buffer.from("\nA0_STALE_OUTPUT_MUTANT")]));
    return { ...operational, expectedSha256: sha256(original), observedSha256: sha256(readFileSync(copy)), mutatedPath: copy };
  }
  if (mutation.kind === "isolated-builder-divergence") {
    if (input.sdkBuildRoot === undefined || input.sdkBuildRootSecond === undefined) throw new Error("E_A0_SDK_BUILD_ROOT");
    const firstSet = stableJson({ runtime: fileIdentities(input.sdkBuildRoot, runtimePaths), declarations: fileIdentities(input.sdkBuildRoot, declarationPaths) });
    const target = join(input.commandRoot, "mutated-runtime-index.js");
    const secondBytes = readFileSync(join(input.sdkBuildRootSecond, runtimePaths[0]));
    writeFileSync(target, Buffer.concat([secondBytes, Buffer.from("\nA0_REGEN_MUTANT")]));
    const second = fileIdentities(input.sdkBuildRootSecond, runtimePaths).map((identity, index) => index === 0 ? { ...identity, byteLength: readFileSync(target).byteLength, sha256: sha256(readFileSync(target)) } : identity);
    const secondSet = stableJson({ runtime: second, declarations: fileIdentities(input.sdkBuildRootSecond, declarationPaths) });
    return { ...operational, firstSetSha256: sha256(firstSet), secondSetSha256: sha256(secondSet), mutatedPath: target };
  }
  if (mutation.kind === "registration-map-substitution") {
    const baseline = ["workflow.cli", "workflow.rpc"].sort();
    const observed = [...baseline, "artifactReview.rpc"].sort();
    const registrationPath = join(input.commandRoot, "registrations.json");
    writeFileSync(registrationPath, JSON.stringify({ keys: observed }));
    return { ...operational, registrationPath, expectedDigest: sha256(JSON.stringify(baseline)), observedDigest: sha256(JSON.stringify(observed)) };
  }
  if (["rpc-consumer-registration", "ui-consumer-registration", "renderer-consumer-registration", "live-change-consumer-registration"].includes(mutation.kind)) {
    const injectedConsumerPath = join(input.commandRoot, "injected-consumer.mjs");
    writeFileSync(injectedConsumerPath, `export function registerConsumer(){return [${JSON.stringify(input.operation.surface)}]};\n`);
    return { ...operational, injectedConsumerPath };
  }
  return operational;
};

const attemptTargetBoundary = async (input: A0CandidateInput, repositoryRoot: string): Promise<Record<string, unknown>> => {
  const modulePath = resolve(repositoryRoot, "plugins/workflows/src/artifact-review-service.ts");
  const before = [...readdirSync(input.storeRoot)].sort();
  try {
    const loaded = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
    const factory = loaded.createArtifactReviewAcceptanceDriver;
    if (typeof factory === "function") {
      (factory as () => unknown)();
      throw new Error("E_A0_TARGET_CONSTRUCTION_PRESENT");
    }
    return { classification: "typed-expected-construction-red", code: "E_A0_TARGET_CONSTRUCTION_ABSENT", attemptedBoundary: "artifact-review-service/createArtifactReviewAcceptanceDriver", modulePresent: true, factoryType: typeof factory, sideEffects: [], candidateHandleClosed: true };
  } catch (error) {
    if (existsSync(modulePath)) throw error;
    const after = [...readdirSync(input.storeRoot)].sort();
    if (stableJson(before) !== stableJson(after)) throw new Error("E_A0_TARGET_ABSENCE_SIDE_EFFECT");
    return { classification: "typed-expected-construction-red", code: "E_A0_TARGET_CONSTRUCTION_ABSENT", attemptedBoundary: "artifact-review-service/createArtifactReviewAcceptanceDriver", modulePresent: false, importErrorSha256: sha256(error instanceof Error ? error.message : String(error)), sideEffects: [], candidateHandleClosed: true };
  }
};

const executeCandidate = async (
  input: A0CandidateInput,
  repositoryRoot: string,
): Promise<{ candidateProcessId: number; operational: Record<string, unknown>; operationalSha256: string; reachability: A0Reachability[] }> => {
  assertCandidateInput(input);
  const reachability: A0Reachability[] = [reach("recorder-owned-candidate-runner", "candidate-boundary-started", { executionIdentity: input.executionIdentity, interface: input.operation.interface })];
  if (input.operation.interface === "target-construction") {
    const operational = await attemptTargetBoundary(input, repositoryRoot);
    reachability.push(reach("target-construction-boundary", "target-construction-boundary-attempted", operational));
    return { candidateProcessId: process.pid, operational, operationalSha256: sha256(stableJson(operational)), reachability };
  }
  if (input.operation.interface === "manifest-boundary") {
    const canonical = Buffer.from(String(input.operation.input?.canonicalBytesBase64), "base64");
    const mutant = Buffer.concat([canonical, Buffer.from("\n")]);
    const mutantPath = join(input.commandRoot, "manifest-newline-mutant.bin");
    writeFileSync(mutantPath, mutant);
    const operational = { mutantPath, originalByteLength: canonical.byteLength, originalSha256: sha256(canonical), mutantByteLength: mutant.byteLength, mutantSha256: sha256(mutant), terminalByte: mutant.at(-1), candidateHandleClosed: true };
    reachability.push(reach("manifest-byte-boundary-mutator", "manifest-terminal-byte-mutated", operational));
    return { candidateProcessId: process.pid, operational, operationalSha256: sha256(stableJson(operational)), reachability };
  }
  const diagnostic = runKnownGoodReferenceAdapter(input.operation);
  reachability.push(...diagnostic.reachability);
  let operational: Record<string, unknown>;
  if (input.boundaryMutation?.kind === "production-executor-substitution") {
    operational = await runSdkFakeBoundary(input);
    reachability.push(reach("sdk-fake-executor", "production-executor-substituted", operational));
  } else if (input.operation.interface === "production" || input.operation.interface === "production-reopen" || input.operation.interface === "production-admission" || input.operation.interface === "independent-observer") {
    operational = await runProductionBoundary(input, repositoryRoot);
    reachability.push(reach(input.operation.interface === "production-admission" ? "production-admission-adapter" : input.operation.interface === "independent-observer" ? "independent-observer-reference-adapter" : "production-reference-adapter", "production-factory-and-migrate-invoked", operational));
  } else if (input.operation.interface === "sdk-fake") {
    operational = await runSdkFakeBoundary(input);
    reachability.push(reach("sdk-fake-executor", "sdk-fake-and-migrate-invoked", operational));
  } else if (input.operation.interface === "workflows-fake") {
    const result = runWorkflowsFakeAdapter(input.operation);
    operational = { kind: "workflows-fake", result, candidateHandleClosed: true };
    reachability.push(result.reachability);
  } else if (input.operation.interface === "reducer") {
    const result = runReducerAdapter(input.operation);
    operational = { kind: "shared-reducer", result, candidateHandleClosed: true };
    reachability.push(result.reachability);
  } else if (input.operation.interface === "sdk-surface") {
    operational = await runSdkSurface(input, repositoryRoot);
    reachability.push(reach("sdk-surface-executor", "sdk-command-started-and-completed", operational));
  } else {
    operational = { kind: "darkness-dispatch", surface: input.operation.surface, candidateHandleClosed: true };
    reachability.push(reach("darkness-observer-dispatch", "darkness-consumer-dispatched", operational));
  }
  operational = await mutateControlBoundary(input, operational);
  const withDiagnostic = { ...operational, diagnosticReferenceActualSha256: sha256(stableJson(diagnostic.actual)) };
  return { candidateProcessId: process.pid, operational: withDiagnostic, operationalSha256: sha256(stableJson(withDiagnostic)), reachability };
};

type DispatchKind = "positive" | "control" | "target" | "manifest-newline";

const spawnCandidate = (
  repositoryRoot: string,
  input: A0CandidateInput,
): { output: Awaited<ReturnType<typeof executeCandidate>>; command: CommandReceipt } => {
  const inputPath = join(input.commandRoot, "candidate-input.json");
  const outputPath = join(input.commandRoot, "candidate-output.json");
  writeFileSync(inputPath, JSON.stringify(input));
  const receipt = command(process.execPath, [
    "--import", "tsx",
    resolve(repositoryRoot, "plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0-runner.ts"),
    "--candidate", inputPath, outputPath, repositoryRoot,
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, TMPDIR: "/tmp", NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --conditions=source`.trim() },
  });
  if (receipt.status !== 0) throw new Error(`E_A0_CANDIDATE_CHILD:${receipt.stderr}`);
  return { output: JSON.parse(readFileSync(outputPath, "utf8")), command: receipt };
};

const spawnObserver = (
  repositoryRoot: string,
  commandRoot: string,
  request: A0ObserverRequest,
): { observation: Record<string, unknown>; command: CommandReceipt; path: string; byteLength: number; sha256: string } => {
  const requestPath = join(commandRoot, "observer-request.json");
  const outputPath = join(commandRoot, "observation-record.json");
  writeFileSync(requestPath, JSON.stringify(request));
  const receipt = command(process.execPath, [
    "--import", "tsx",
    resolve(repositoryRoot, "plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0-independent-observer.ts"),
    "--observe", requestPath, outputPath,
  ], { cwd: repositoryRoot, env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --conditions=source`.trim() } });
  if (receipt.status !== 0) throw new Error(`E_A0_OBSERVER_CHILD:${receipt.stderr}:${existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "missing"}`);
  const bytes = readFileSync(outputPath);
  const wrapper = JSON.parse(bytes.toString("utf8")) as { ok: boolean; observation?: Record<string, unknown>; error?: string };
  if (!wrapper.ok || wrapper.observation === undefined) throw new Error(wrapper.error ?? "E_A0_OBSERVER_OUTPUT");
  return { observation: wrapper.observation, command: receipt, path: outputPath, byteLength: bytes.byteLength, sha256: sha256(bytes) };
};

const dispatchOne = async (args: {
  kind: DispatchKind;
  ordinal: number;
  operation: A0Operation;
  nonce: string;
  stimulusDigest?: string;
  descriptor?: A0BoundaryMutationDescriptor;
  sdkMatrixPath: string;
  runRoot: string;
  repositoryRoot: string;
  builds: SdkBuildPair;
}): Promise<A0LedgerRow> => {
  const executionIdentity = sha256(`${randomBytes(32).toString("hex")}\0${args.nonce}\0${args.kind}\0${args.ordinal}`);
  const rowRoot = join(args.runRoot, `${args.kind}-${String(args.ordinal).padStart(3, "0")}${args.descriptor === undefined ? "" : `-${args.descriptor.id}`}`);
  const storeRoot = join(rowRoot, "store");
  const commandRoot = join(rowRoot, "commands");
  const cleanConsumerRoot = join(rowRoot, "consumer");
  for (const path of [storeRoot, commandRoot, cleanConsumerRoot]) mkdirSync(path, { recursive: true });
  writeFileSync(
    join(storeRoot, "recorder-root-attestation.json"),
    JSON.stringify({ executionIdentity, nonce: args.nonce, rootKind: "store" }),
  );
  const input: A0CandidateInput = {
    executionIdentity,
    nonce: args.nonce,
    operation: args.operation,
    storeRoot,
    commandRoot,
    cleanConsumerRoot,
    sdkBuildRoot: args.builds.first.root,
    sdkBuildRootSecond: args.builds.second.root,
    sdkMatrixPath: args.sdkMatrixPath,
    boundaryMutation: args.descriptor === undefined ? undefined : { id: args.descriptor.id, kind: args.descriptor.kind },
  };
  const candidate = spawnCandidate(args.repositoryRoot, input);
  const originalOperational = candidate.output.operational;
  const operational = args.descriptor?.kind === "serialized-operational-receipt"
    ? { ...originalOperational, recorderTamper: sha256(`${executionIdentity}:tamper`) }
    : originalOperational;
  const base = {
    executionIdentity,
    nonce: args.nonce,
    ordinal: args.ordinal,
    kind: args.kind,
    operation: args.operation,
    stimulusDigest: args.stimulusDigest,
    controlId: args.descriptor?.id,
    candidateProcessId: candidate.output.candidateProcessId,
    candidateExit: {
      completed: candidate.command.completed,
      status: candidate.command.status,
      signal: candidate.command.signal,
    },
    issuedRoots: { storeRoot, commandRoot, cleanConsumerRoot },
    boundaryMutation: input.boundaryMutation,
    operational,
    operationalSha256: candidate.output.operationalSha256,
    reachability: [
      reach("recorder-owned-dispatcher", "dispatch-identity-and-roots-issued", { executionIdentity, kind: args.kind, storeRoot, commandRoot, cleanConsumerRoot }),
      ...candidate.output.reachability,
    ],
  };
  const recordPath = join(commandRoot, "execution-record.json");
  const recordBytes = Buffer.from(JSON.stringify(base));
  writeFileSync(recordPath, recordBytes);
  const recordDigest = sha256(recordBytes);
  const observed = spawnObserver(args.repositoryRoot, commandRoot, {
    kind: "execution",
    recordPath,
    expectedSha256: recordDigest,
    repositoryRoot: args.repositoryRoot,
  });
  const execution: A0ExecutionRecord = {
    ...base,
    durableRecord: { path: recordPath, byteLength: recordBytes.byteLength, sha256: recordDigest },
    candidateCommand: candidate.command,
  };
  const observation = {
    ...(observed.observation as Omit<A0ObservationRecord, "durableObservation" | "observerCommand">),
    durableObservation: { path: observed.path, byteLength: observed.byteLength, sha256: observed.sha256 },
    observerCommand: observed.command,
  } as A0ObservationRecord;
  if (observation.executionIdentity !== executionIdentity) throw new Error("E_A0_OBSERVATION_JOIN");
  return { execution, observation };
};

const manifestMemberPathsRecorder = [
  "apps/server/src/services/plugins/migration-authorities/workflows-artifact-review-v3-executable-recorder-a0.json",
  "plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0-public-stimuli.json",
  "plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0-private-authority.json",
  "plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0-reference-and-fault-adapters.ts",
  "plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0-runner.ts",
  "plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0-independent-observer.ts",
  "plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0.schema.json",
  "plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0-oracle.test.ts",
  "output/artifact-review-shakedown/oracle/recovery-v3-executable-recorder-a0-prefreeze-provenance.json",
] as const;

const encodeManifestRecorder = (repositoryRoot: string): Buffer => {
  const members = [...manifestMemberPathsRecorder].sort().map((path) => {
    const bytes = readFileSync(join(repositoryRoot, path));
    return { path, byteLength: bytes.byteLength, sha256: sha256(bytes) };
  });
  return Buffer.from(stableJson({ schemaVersion: "a0-prefreeze-manifest-rehearsal-v1", members }));
};

const observeManifestEncoding = (
  repositoryRoot: string,
  root: string,
): { bytes: Buffer; command: CommandReceipt } => {
  const commandRoot = join(root, "manifest-independent-encoder");
  mkdirSync(commandRoot, { recursive: true });
  const requestPath = join(commandRoot, "request.json");
  const outputPath = join(commandRoot, "output.json");
  writeFileSync(requestPath, JSON.stringify({ kind: "manifest-encoding", repositoryRoot }));
  const receipt = command(process.execPath, ["--import", "tsx", resolve(repositoryRoot, "plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0-independent-observer.ts"), "--observe", requestPath, outputPath], { cwd: repositoryRoot, env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --conditions=source`.trim() } });
  if (receipt.status !== 0) throw new Error(`E_A0_MANIFEST_OBSERVER:${receipt.stderr}`);
  const wrapper = JSON.parse(readFileSync(outputPath, "utf8")) as { ok: boolean; observation: { canonicalBytesBase64: string } };
  if (!wrapper.ok) throw new Error("E_A0_MANIFEST_OBSERVER");
  return { bytes: Buffer.from(wrapper.observation.canonicalBytesBase64, "base64"), command: receipt };
};

export async function runPrefreezeReadiness(args: {
  repositoryRoot: string;
  publicStimuli: readonly A0PublicStimulus[];
  controlIds: readonly string[];
  root: string;
}): Promise<A0ReadinessRun> {
  if (args.publicStimuli.length !== 134) throw new Error("E_A0_SELECTION_COUNT");
  if (args.controlIds.length !== 17 || new Set(args.controlIds).size !== 17) throw new Error("E_A0_CONTROL_SELECTION");
  if (stableJson(args.controlIds) !== stableJson(A0_BOUNDARY_MUTATIONS.map(({ id }) => id))) throw new Error("E_A0_CONTROL_ORDER");
  mkdirSync(args.root, { recursive: true });
  const builds = runIsolatedSdkBuilders(args.repositoryRoot, join(args.root, "sdk-builds"));
  if (!builds.identical || builds.first.runtime.length !== 12 || builds.first.declarations.length !== 12) throw new Error("E_SDK_REGENERATION_DIVERGED");
  const sdkMatrix = buildSdkExecutionMatrix(
    args.repositoryRoot,
    join(args.root, "sdk-matrix"),
    builds.first.root,
  );
  const recorderManifestBytes = encodeManifestRecorder(args.repositoryRoot);
  const independentManifest = observeManifestEncoding(args.repositoryRoot, args.root);
  if (!recorderManifestBytes.equals(independentManifest.bytes)) throw new Error("E_A0_MANIFEST_ENCODER_DIVERGENCE");
  if ([recorderManifestBytes.at(-1), independentManifest.bytes.at(-1)].some((value) => value === 10 || value === 13)) throw new Error("E_A0_MANIFEST_TERMINAL_NEWLINE");
  const positiveRows: A0LedgerRow[] = [];
  for (const [ordinal, stimulus] of args.publicStimuli.entries()) {
    positiveRows.push(await dispatchOne({ kind: "positive", ordinal, operation: stimulus.operation, nonce: stimulus.nonce, stimulusDigest: sha256(stableJson(stimulus)), runRoot: args.root, repositoryRoot: args.repositoryRoot, builds, sdkMatrixPath: sdkMatrix.path }));
  }
  const controlRows: A0LedgerRow[] = [];
  for (const [ordinal, id] of args.controlIds.entries()) {
    const descriptor = boundaryMutationDescriptor(id);
    controlRows.push(await dispatchOne({ kind: "control", ordinal, operation: descriptor.operation, nonce: randomBytes(32).toString("hex"), descriptor, runRoot: args.root, repositoryRoot: args.repositoryRoot, builds, sdkMatrixPath: sdkMatrix.path }));
  }
  const target = await dispatchOne({ kind: "target", ordinal: 0, operation: { interface: "target-construction" } as A0Operation, nonce: randomBytes(32).toString("hex"), runRoot: args.root, repositoryRoot: args.repositoryRoot, builds, sdkMatrixPath: sdkMatrix.path });
  const manifestNewline = await dispatchOne({ kind: "manifest-newline", ordinal: 0, operation: { interface: "manifest-boundary", input: { canonicalBytesBase64: recorderManifestBytes.toString("base64") } } as A0Operation, nonce: randomBytes(32).toString("hex"), runRoot: args.root, repositoryRoot: args.repositoryRoot, builds, sdkMatrixPath: sdkMatrix.path });
  const controls = controlRows.map(({ execution, observation }, index): A0ControlReceipt => {
    const descriptor = boundaryMutationDescriptor(args.controlIds[index]!);
    if (observation.control === undefined || observation.control.reason !== descriptor.killCode) throw new Error(`E_A0_CONTROL_WRONG_KILL:${descriptor.id}`);
    if (!execution.candidateCommand.completed || !observation.observerCommand.completed)
      throw new Error(`E_A0_CONTROL_KILLER_INCOMPLETE:${descriptor.id}`);
    return {
      id: descriptor.id,
      executionIdentity: execution.executionIdentity,
      killerStarted: execution.candidateCommand.started,
      killerCompleted: true,
      reached: observation.control.reached,
      killed: observation.control.killed,
      reason: observation.control.reason,
      receiptType: descriptor.receiptType,
      evidence: { pipelineIdentitySha256: observation.pipelineIdentitySha256, stages: observation.pipelineStages, operational: observation.operational },
    };
  });
  const ledgerRows = [...positiveRows, ...controlRows, target, manifestNewline];
  const helperReachability = ledgerRows.flatMap(({ execution, observation }) => [
    ...execution.reachability,
    reach("fresh-independent-observer", "execution-record-reopened-and-operational-boundary-observed", { executionIdentity: execution.executionIdentity, observerProcessId: observation.observerProcessId }),
  ]).concat([
    reach("canonical-manifest-encoder-recorder", "canonical-manifest-encoded", { byteLength: recorderManifestBytes.byteLength, sha256: sha256(recorderManifestBytes) }),
    reach("canonical-manifest-encoder-observer", "canonical-manifest-independently-encoded", { byteLength: independentManifest.bytes.byteLength, sha256: sha256(independentManifest.bytes) }),
  ]);
  return {
    runIdentity: sha256(`${randomBytes(32).toString("hex")}\0${args.root}`),
    recorderProcessId: process.pid,
    root: args.root,
    executions: positiveRows.map(({ execution }) => execution),
    observations: positiveRows.map(({ observation }) => observation),
    controls,
    ledgerRows,
    targetConstructionRed: target,
    manifestNewlineControl: manifestNewline,
    sdkBuilds: builds,
    sdkMatrix,
    manifestEncoding: {
      recorder: { byteLength: recorderManifestBytes.byteLength, sha256: sha256(recorderManifestBytes), terminalNewline: false },
      independent: { byteLength: independentManifest.bytes.byteLength, sha256: sha256(independentManifest.bytes), terminalNewline: false },
      identical: true,
    },
    helperReachability,
    cleanup: () => rmSync(args.root, { recursive: true, force: true }),
  };
}

if (process.argv[2] === "--candidate") {
  const inputPath = process.argv[3];
  const outputPath = process.argv[4];
  const repositoryRoot = process.argv[5];
  if (inputPath === undefined || outputPath === undefined || repositoryRoot === undefined) throw new Error("E_A0_CANDIDATE_ARGS");
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as A0CandidateInput;
  process.env.TMPDIR = input.storeRoot;
  const output = await executeCandidate(input, repositoryRoot);
  writeFileSync(outputPath, JSON.stringify(output));
}
