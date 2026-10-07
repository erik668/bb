import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PluginMigrationCandidateEffectsV3,
  PluginMigrationPlanV2,
} from "@get-bb/plugin-sdk";
import { createPluginApi, type PluginApiHandle } from "./plugin-api.js";

const roots: string[] = [];
const handles: PluginApiHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) {
    for (const database of handle.databaseHandles) {
      if (database.open) database.close();
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createHost(): PluginApiHandle {
  const dataDir = mkdtempSync(join(tmpdir(), "bb-plugin-recovery-host-"));
  roots.push(dataDir);
  const noop = () => undefined;
  const handle = createPluginApi({
    pluginId: "recovery-test",
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

function schemaFingerprint(
  database: ReturnType<PluginApiHandle["api"]["storage"]["database"]>,
) {
  return sha256(
    JSON.stringify(
      database
        .prepare(
          `SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master
           WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name, tbl_name`,
        )
        .all(),
    ),
  );
}

function blockedPlan(handle: PluginApiHandle): PluginMigrationPlanV2 {
  const database = handle.api.storage.database();
  const statements = [
    `CREATE TABLE source_rows (scope TEXT NOT NULL, value TEXT NOT NULL);`,
    ...Array.from(
      { length: 17 },
      (_, index) => `CREATE TABLE migration_${index + 1} (id INTEGER);`,
    ),
    `CREATE UNIQUE INDEX source_rows_scope_unique ON source_rows(scope);`,
    `CREATE TABLE migration_19 (id INTEGER);`,
    `CREATE TABLE migration_20 (id INTEGER);`,
    `CREATE TABLE migration_21 (dark INTEGER NOT NULL DEFAULT 0 CHECK(dark = 0));`,
    `CREATE TABLE migration_22 (receipt TEXT);`,
  ];
  handle.api.storage.migrate(database, statements.slice(0, 18));
  database
    .prepare(
      "INSERT INTO source_rows(scope, value) VALUES ('same', 'a'), ('same', 'b')",
    )
    .run();
  const recipeJson = JSON.stringify({
    recoveryId: "host-v2-test",
    action: "quarantine",
  });
  return {
    version: 2,
    statements,
    statementSha256: statements.map(sha256),
    recovery: {
      descriptor: {
        recoveryId: "host-v2-test",
        beforeMigrationId: 18,
        migration18Sha256: sha256(statements[18]!),
        preSchemaFingerprintAlgorithm:
          "SHA-256(JSON.stringify sqlite_master rows ordered by type,name,tbl_name; keys type,name,tableName,sql)",
        preSchemaFingerprintSha256: schemaFingerprint(database),
        recoveryRecipeSha256: sha256(recipeJson),
      },
      recoveryRecipeJson: recipeJson,
      recover(context) {
        context.database
          .prepare("DELETE FROM source_rows WHERE value = 'b'")
          .run();
        for (let id = 18; id <= 22; id += 1) context.executeMigration(id);
        return {
          activeGraphSha256: sha256("active"),
          quarantineGraphSha256: sha256("quarantine"),
          stagedRowCount: 1,
          restoredGrantCount: 0,
          receiptSha256: sha256("receipt"),
        };
      },
    },
  };
}

describe("production plugin migration V2 host", () => {
  it("owns one transaction for recovery migrations and the separate host receipt", () => {
    const handle = createHost();
    const database = handle.api.storage.database();
    const plan = blockedPlan(handle);
    handle.api.storage.migrate(database, plan);
    expect(
      database
        .prepare("SELECT id FROM _bb_migrations ORDER BY id")
        .pluck()
        .all(),
    ).toEqual(Array.from({ length: 23 }, (_, id) => id));
    expect(database.prepare("SELECT * FROM source_rows").all()).toEqual([
      { scope: "same", value: "a" },
    ]);
    expect(
      database
        .prepare(
          "SELECT recovery_id AS recoveryId FROM _bb_migration_recoveries",
        )
        .get(),
    ).toEqual({ recoveryId: "host-v2-test" });
  });

  it("rolls back every recovery mutation when the plugin recovery throws", () => {
    const handle = createHost();
    const database = handle.api.storage.database();
    const plan = blockedPlan(handle);
    const failing = {
      ...plan,
      recovery: {
        ...plan.recovery,
        recover(context: Parameters<typeof plan.recovery.recover>[0]) {
          plan.recovery.recover(context);
          throw new Error("recovery verifier fault");
        },
      },
    };
    expect(() => handle.api.storage.migrate(database, failing)).toThrow(
      /recovery verifier fault/,
    );
    expect(
      database.prepare("SELECT count(*) FROM source_rows").pluck().get(),
    ).toBe(2);
    expect(
      database.prepare("SELECT count(*) FROM _bb_migrations").pluck().get(),
    ).toBe(18);
    expect(
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name = '_bb_migration_recoveries'",
        )
        .get(),
    ).toBeUndefined();
  });
});

describe("production plugin migration V3 construction boundary", () => {
  it("[authority-host-owned-migrations] accepts only domain input and reopens a complete host-owned family", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-plugin-v3-host-"));
    roots.push(dataDir);
    const noop = () => undefined;
    const handle = createPluginApi({
      pluginId: "v3-host-owned-migrations",
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

    type DomainInputOnly = Omit<
      PluginMigrationCandidateEffectsV3,
      "statements"
    >;
    const input: DomainInputOnly = {
      version: 3,
      gate: {
        recorderNonce: "recorder-owned-nonce-host-migrations",
        stimulusId: "authority-host-owned-migrations",
      },
      operation: {
        kind: "ordinary",
        payload: Uint8Array.of(0x6f, 0x70),
      },
      launch: { payload: Uint8Array.of(0x6c) },
      query: { payload: Uint8Array.of(0x71) },
      domainEffects: [],
      recoveryEffects: [],
    };

    Reflect.apply(handle.api.storage.migrate, handle.api.storage, [input]);

    const reader = new Database(
      join(dataDir, "plugins", "v3-host-owned-migrations", "data.db"),
      { readonly: true, fileMustExist: true },
    );
    try {
      expect(
        reader.prepare("SELECT id FROM _bb_migrations ORDER BY id").pluck().all(),
      ).toEqual(Array.from({ length: 23 }, (_, id) => id));
      expect(
        reader
          .prepare(
            `SELECT count(*)
               FROM _bb_artifact_review_v3_complete_families f
               JOIN _bb_artifact_review_v3_operations o
                 ON o.operation_key = f.operation_key
               JOIN _bb_artifact_review_v3_gate_consumptions c
                 ON c.consumption_key = f.consumption_key
                AND c.operation_key = f.operation_key
               JOIN _bb_artifact_review_v3_receipts l
                 ON l.receipt_key = f.launch_receipt_key
                AND l.operation_key = f.operation_key
                AND l.receipt_kind = 'launch'
               JOIN _bb_artifact_review_v3_receipts q
                 ON q.receipt_key = f.query_receipt_key
                AND q.operation_key = f.operation_key
                AND q.receipt_kind = 'query'`,
          )
          .pluck()
          .get(),
      ).toBe(1);
    } finally {
      reader.close();
    }
  });
});
