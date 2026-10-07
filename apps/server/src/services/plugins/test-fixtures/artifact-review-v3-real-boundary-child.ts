import { readFileSync } from "node:fs";
import type {
  PluginMigrationCandidateEffectsV3,
  PluginMigrationDomainEffectV3,
  PluginMigrationSqlValueV3,
} from "@get-bb/plugin-sdk";
import { createPluginApi } from "../plugin-api.js";

interface SerializedDomainEffectV3 {
  readonly sql: string;
  readonly values?: readonly (string | number | null)[];
}

interface ChildRequestV3 {
  readonly dataDir: string;
  readonly pluginId: string;
  readonly effects: {
    readonly version: 3;
    readonly statements: readonly string[];
    readonly gate: {
      readonly recorderNonce: string;
      readonly stimulusId: string;
    };
    readonly operation: { readonly kind: string; readonly payload: number[] };
    readonly launch: { readonly payload: number[] };
    readonly query: { readonly payload: number[] };
    readonly domainEffects: readonly SerializedDomainEffectV3[];
    readonly recoveryEffects: readonly SerializedDomainEffectV3[];
  };
}

function materializeDomainEffects(
  effects: readonly SerializedDomainEffectV3[],
): PluginMigrationDomainEffectV3[] {
  return effects.map((effect) => ({
    sql: effect.sql,
    values: effect.values as readonly PluginMigrationSqlValueV3[] | undefined,
  }));
}

function materializeEffects(
  serialized: ChildRequestV3["effects"],
): PluginMigrationCandidateEffectsV3 {
  return {
    version: 3,
    statements: serialized.statements,
    gate: serialized.gate,
    operation: {
      kind: serialized.operation.kind,
      payload: Uint8Array.from(serialized.operation.payload),
    },
    launch: { payload: Uint8Array.from(serialized.launch.payload) },
    query: { payload: Uint8Array.from(serialized.query.payload) },
    domainEffects: materializeDomainEffects(serialized.domainEffects),
    recoveryEffects: materializeDomainEffects(serialized.recoveryEffects),
  };
}

function main(): void {
  const requestPath = process.argv[2];
  if (!requestPath) throw new Error("V3 child requires a request JSON path");
  const request = JSON.parse(
    readFileSync(requestPath, "utf8"),
  ) as ChildRequestV3;
  const noop = () => undefined;
  const handle = createPluginApi({
    pluginId: request.pluginId,
    dataDir: request.dataDir,
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
  try {
    handle.api.storage.migrate(materializeEffects(request.effects));
    process.send?.({ type: "child-exiting" });
  } finally {
    for (const database of handle.databaseHandles) {
      if (database.open) database.close();
    }
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
}
