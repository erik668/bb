import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import {
  reduceArtifactReviewV3,
  type ArtifactReviewV3Observation,
  type PluginMigrationPlanV3,
} from "@get-bb/plugin-sdk";
import { createArtifactRecoveryV3FakeAdapter } from "./artifact-recovery-v3-fake-adapter.js";
import type { ArtifactRecoveryV3FakeState } from "./artifact-recovery-v3-fake-projection.js";

export type C2PublicStimulus = Readonly<{
  nonce: string;
  operation: Readonly<Record<string, unknown> & { interface: string }>;
}>;

const forbiddenInputKeys = new Set([
  "caseId",
  "category",
  "expected",
  "expectedPath",
  "databasePath",
  "traceCatalog",
  "physicalCatalog",
  "priorOutcome",
  "ledger",
  "approval",
]);

const walkKeys = (value: unknown): void => {
  if (Array.isArray(value)) {
    for (const item of value) walkKeys(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenInputKeys.has(key)) throw new Error(`E_C2_PRIVATE_INPUT:${key}`);
    walkKeys(item);
  }
};

export const assertInputOnlyStimulus = (value: unknown): C2PublicStimulus => {
  walkKeys(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("E_C2_STIMULUS_SHAPE");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.nonce !== "string" ||
    !/^[0-9a-f]{64}$/u.test(row.nonce) ||
    row.operation === null ||
    typeof row.operation !== "object" ||
    Array.isArray(row.operation)
  ) {
    throw new Error("E_C2_STIMULUS_SHAPE");
  }
  const operation = row.operation as Record<string, unknown>;
  if (typeof operation.interface !== "string") {
    throw new Error("E_C2_STIMULUS_INTERFACE");
  }
  return value as C2PublicStimulus;
};

const observationFromOperationalInput = (
  input: Record<string, unknown>,
): ArtifactReviewV3Observation => ({
  planVersion: typeof input.version === "number" ? input.version : 3,
  capabilityAdmitted: input.capability !== "unknown",
  authorityAdmitted:
    input.authorityId !== "unknown" && input.authorityId !== null,
  staticDigestsAdmitted: input.digest === undefined,
  appliedMigrationIds: Array.isArray(input.migrationIds)
    ? (input.migrationIds as number[])
    : input.state === "full-ledger-no-completion"
      ? Array.from({ length: 23 }, (_, id) => id)
      : input.state === "prefix-0..16"
        ? Array.from({ length: 17 }, (_, id) => id)
        : input.state === "exact-prefix-0..17" ||
            input.state === "verified-test-predecessor-prefix-0..17"
          ? Array.from({ length: 18 }, (_, id) => id)
          : [],
  statementCount: 23,
  beforeMigrationId: 18,
  completion:
    typeof input.completion === "string"
      ? input.completion === "malformed" || input.completion === "duplicate"
        ? { state: input.completion }
        : { state: "mismatched" }
      : input.state === "completed-ordinary"
        ? {
            state: "present",
            outcome: "ordinary",
            predecessorAuthorityId: null,
            matchesAuthority: true,
          }
        : { state: "absent" },
  predecessorCompletionVerified:
    input.state === "verified-test-predecessor-prefix-0..17",
  recoveryEvidence: "absent",
  completedState: input.state === "completed-ordinary" ? "matching" : "unobserved",
  legacyEvidence: input.legacyEvidence === true,
  ordinaryMigration18Blocked:
    input.migration18Error === "E_MIGRATION_18_COMPATIBILITY_BLOCKED",
});

export const runReducerStimulus = (stimulusValue: unknown) => {
  const stimulus = assertInputOnlyStimulus(stimulusValue);
  const input = stimulus.operation.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("E_C2_REDUCER_OPERATION");
  }
  return reduceArtifactReviewV3(
    observationFromOperationalInput(input as Record<string, unknown>),
  );
};

const emptyFakeState = (): ArtifactRecoveryV3FakeState => ({
  schema: [],
  migrationLedger: [],
  completionLedger: [],
  recoveryLedger: [],
  rowsByTable: {},
  edges: [],
  grants: [],
  blobs: [],
  blobReferences: [],
});

export const runWorkflowsFakeStimulus = (stimulusValue: unknown) => {
  const stimulus = assertInputOnlyStimulus(stimulusValue);
  const adapter = createArtifactRecoveryV3FakeAdapter(emptyFakeState());
  const input = stimulus.operation.input;
  const observation = observationFromOperationalInput(
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {},
  );
  return {
    decision: adapter.decide(observation),
    recorderState: adapter.snapshot(),
  };
};

export type RecorderOwnedSdkFake = Readonly<{
  host: FakePluginHost;
  close: () => Promise<void>;
}>;

export const runSdkFakeMigration = (
  stimulusValue: unknown,
  plan: PluginMigrationPlanV3,
): RecorderOwnedSdkFake => {
  const stimulus = assertInputOnlyStimulus(stimulusValue);
  const host = createFakePluginHost({ pluginId: `c2-${stimulus.nonce.slice(0, 16)}` });
  const database = host.bb.storage.database();
  host.bb.storage.migrate(database, plan);
  return { host, close: () => host.harness.dispose() };
};

type ProductionHandle = Readonly<{
  api: { storage: { database(): unknown; migrate(database: unknown, plan: unknown): void } };
  databaseHandles: readonly { open: boolean; close(): void }[];
}>;

export type RecorderOwnedProduction = Readonly<{
  dataDir: string;
  handle: ProductionHandle;
  close: () => void;
}>;

export const runProductionMigration = async (
  stimulusValue: unknown,
  plan: PluginMigrationPlanV3,
): Promise<RecorderOwnedProduction> => {
  const stimulus = assertInputOnlyStimulus(stimulusValue);
  const dataDir = mkdtempSync(join(tmpdir(), "bb-c2-recorder-production-"));
  const moduleUrl = new URL(
    "../../../apps/server/src/services/plugins/plugin-api.ts",
    new URL("../../../", import.meta.url),
  );
  const loaded = (await import(/* @vite-ignore */ pathToFileURL(moduleUrl.pathname).href)) as {
    createPluginApi(options: Record<string, unknown>): ProductionHandle;
  };
  const noop = () => undefined;
  const handle = loaded.createPluginApi({
    pluginId: `c2-${stimulus.nonce.slice(0, 16)}`,
    dataDir,
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
  const database = handle.api.storage.database();
  handle.api.storage.migrate(database, plan);
  return {
    dataDir,
    handle,
    close: () => {
      for (const item of handle.databaseHandles) if (item.open) item.close();
    },
  };
};

const runtimePaths: Readonly<Record<string, string>> = {
  "runtime:index": "packages/plugin-sdk/dist/index.js",
  "runtime:app": "packages/plugin-sdk/dist/app.js",
  "runtime:provider-bridge": "packages/plugin-sdk/dist/provider-bridge.js",
  "runtime:host": "packages/plugin-sdk/dist/host.js",
  "runtime:internal-composer-customization-validation": "packages/plugin-sdk/dist/internal/composer-customization-validation.js",
  "runtime:internal-composer-view": "packages/plugin-sdk/dist/internal/composer-view.js",
  "runtime:internal-file-navigation-validation": "packages/plugin-sdk/dist/internal/file-navigation-validation.js",
  "runtime:internal-host-policy": "packages/plugin-sdk/dist/internal/host-policy.js",
  "runtime:internal-plugin-app-collector": "packages/plugin-sdk/dist/internal/plugin-app-collector.js",
  "runtime:testing-index": "packages/plugin-sdk/dist/testing/index.js",
  "runtime:testing-app": "packages/plugin-sdk/dist/testing/app.js",
  "runtime:testing-host": "packages/plugin-sdk/dist/testing/host.js",
};

const declarationPaths: Readonly<Record<string, string>> = {
  "declaration:bb-plugin-sdk": "packages/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts",
  "declaration:bb-plugin-sdk-app": "packages/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts",
  "declaration:bb-plugin-sdk-provider-bridge": "packages/plugin-sdk/bundled-types/bb-plugin-sdk-provider-bridge.d.ts",
  "declaration:bb-plugin-sdk-host": "packages/plugin-sdk/bundled-types/bb-plugin-sdk-host.d.ts",
  "declaration:composer-customization-validation": "packages/plugin-sdk/bundled-types/bb-plugin-sdk-internal-composer-customization-validation.d.ts",
  "declaration:composer-view": "packages/plugin-sdk/bundled-types/bb-plugin-sdk-internal-composer-view.d.ts",
  "declaration:file-navigation-validation": "packages/plugin-sdk/bundled-types/bb-plugin-sdk-internal-file-navigation-validation.d.ts",
  "declaration:host-policy": "packages/plugin-sdk/bundled-types/bb-plugin-sdk-internal-host-policy.d.ts",
  "declaration:plugin-app-collector": "packages/plugin-sdk/bundled-types/bb-plugin-sdk-internal-plugin-app-collector.d.ts",
  "declaration:testing": "packages/plugin-sdk/bundled-types/bb-plugin-sdk-testing.d.ts",
  "declaration:testing-app": "packages/plugin-sdk/bundled-types/bb-plugin-sdk-testing-app.d.ts",
  "declaration:testing-host": "packages/plugin-sdk/bundled-types/bb-plugin-sdk-testing-host.d.ts",
};

export const executeSdkSurface = async (
  stimulusValue: unknown,
  repositoryRoot: string,
): Promise<{ status: "executed"; surface: string; positive: true; negative: true }> => {
  const stimulus = assertInputOnlyStimulus(stimulusValue);
  const surface = stimulus.operation.surface;
  if (typeof surface !== "string") throw new Error("E_C2_SDK_SURFACE");
  if (surface === "source-index") await import("@get-bb/plugin-sdk");
  else if (surface === "normal-package-import") {
    createRequire(join(repositoryRoot, "package.json")).resolve("@get-bb/plugin-sdk");
  } else if (surface === "direct-dist-index") {
    await import(/* @vite-ignore */ pathToFileURL(join(repositoryRoot, "packages/plugin-sdk/dist/index.js")).href);
  } else if (surface === "testing-entrypoint") await import("@get-bb/plugin-sdk/testing");
  else if (surface === "bundled-bb-plugin-sdk-dts") {
    const result = spawnSync("pnpm", ["exec", "tsc", "--noEmit", "--ignoreConfig", join(repositoryRoot, "packages/plugin-sdk/scripts/public-api-stub.d.ts")], { cwd: repositoryRoot, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`E_C2_BUNDLED_DTS:${result.stderr}`);
  } else if (surface === "workflows-tsconfig") {
    const result = spawnSync("pnpm", ["exec", "tsc", "--noEmit", "-p", "plugins/workflows/tsconfig.json"], { cwd: repositoryRoot, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`E_C2_WORKFLOWS_TYPECHECK:${result.stderr}`);
  } else if (runtimePaths[surface] !== undefined) {
    await import(/* @vite-ignore */ pathToFileURL(join(repositoryRoot, runtimePaths[surface])).href);
  } else if (declarationPaths[surface] !== undefined) {
    const text = readFileSync(join(repositoryRoot, declarationPaths[surface]), "utf8");
    if (!/\b(export|declare)\b/u.test(text)) throw new Error("E_C2_DECLARATION_POSITIVE");
    if (/C2_MISSING_DECLARATION/u.test(text)) throw new Error("E_C2_DECLARATION_NEGATIVE");
  } else throw new Error(`E_C2_UNKNOWN_SDK_SURFACE:${surface}`);
  return { status: "executed", surface, positive: true, negative: true };
};

export const disposeRecorderRoot = (root: string): void => {
  rmSync(root, { recursive: true, force: true });
};
