import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import {
  deletePluginKvValue,
  getPluginKvValue,
  listPluginKvKeys,
  setPluginKvValue,
  type DbConnection,
} from "@bb/db";
import {
  PLUGIN_INTERACTION_MAX_TITLE_LENGTH,
  type JsonValue,
} from "@bb/domain";
import type {
  BbPluginApi,
  PluginAgentConfiguration,
  PluginAgentConfigurationContext,
  PluginAgentToolContext,
  PluginAgentToolExperimentalStatusLabels,
  PluginAgentToolResult,
  PluginAgents,
  PluginBackground,
  PluginCli,
  PluginCliCommandInfo,
  PluginCliContext,
  PluginCliResult,
  PluginEvents,
  PluginHttp,
  PluginHttpAuthMode,
  PluginHttpHandler,
  PluginHosts,
  PluginKvStorage,
  PluginLogger,
  PluginMigrationCandidateEffectsV3,
  PluginMigrationDomainEffectV3,
  PluginMigrationPlanV2,
  PluginMentionItem,
  PluginMentionSearchContext,
  PluginMentionTrigger,
  PluginProviderDeclaration,
  PluginRealtime,
  PluginRpc,
  PluginServerApi,
  PluginSettingDescriptors,
  PluginSettingValue,
  PluginSettings,
  PluginSettingsValues,
  PluginStatusApi,
  PluginStorage,
  PluginThreadEventHandler,
  PluginThreadEventName,
  PluginUi,
  StandardSchemaV1,
  PluginRpcContract,
} from "@get-bb/plugin-sdk";
import {
  AGENT_TOOL_NAME_PATTERN,
  assertNoRecursiveJsonSchemaReferences,
  BACKGROUND_NAME_PATTERN,
  CLI_COMMAND_NAME_PATTERN,
  isZodSchemaLike,
  KV_VALUE_MAX_BYTES,
  MENTION_PROVIDER_ID_PATTERN,
  normalizeMentionProviderTriggers,
  PLUGIN_AGENT_STATIC_INSTRUCTIONS_MAX_CHARS,
  PLUGIN_AGENT_STATUS_LABEL_MAX_CHARS,
  PLUGIN_HTTP_METHODS,
  readRpcMethodContract,
  registerSettingDescriptors,
  RESERVED_AGENT_TOOL_NAMES,
  RESERVED_BB_CLI_COMMANDS,
  RPC_METHOD_PATTERN,
  isStandardSchema,
  summarizeParseIssues,
  validatePluginProviderDeclaration,
} from "@get-bb/plugin-sdk/internal/host-policy";
import type { BbSdk, ThreadForkArgs, ThreadSpawnArgs } from "@bb/sdk";
import type { ServerLogger } from "../../types.js";
import type { PluginInteractionResult } from "../interactions/pending-interactions.js";
import { appendPluginLogLine } from "./plugin-log.js";
import { readPluginSettingsValues } from "./plugin-settings.js";

// The backend plugin API contract lives in @get-bb/plugin-sdk (plugin authors
// compile against it); this module implements it. Re-exported so server code
// keeps one import site for plugin API types.
export type {
  BbPluginApi,
  PluginAgentConfigurationContext,
  PluginAgentToolContext,
  PluginCliCommandInfo,
  PluginCliContext,
  PluginMentionTrigger,
  PluginThreadEventName,
  PluginThreadEventPayloads,
} from "@get-bb/plugin-sdk";

/**
 * Thrown when a plugin calls into an API handle that has been invalidated by
 * reload/disable (pi's stale-context discipline): captured `bb` references
 * from a previous load fail loudly instead of acting on dead state.
 */
class PluginContextStaleError extends Error {
  constructor(pluginId: string) {
    super(
      `plugin "${pluginId}" used a stale API handle — it was reloaded or disabled; ` +
        `re-entry happens via a fresh factory call`,
    );
    this.name = "PluginContextStaleError";
  }
}

/**
 * An error thrown from a background service's `start()` to mark the plugin
 * `needs-configuration` (e.g. no API key yet) instead of crash-looping: the
 * service is not restarted until the plugin is reloaded or its settings are
 * saved (which reloads it). Matched by name, so plugin code without a
 * runtime import can `throw Object.assign(new Error(msg), { name:
 * "NeedsConfigurationError" })`.
 */
export function isNeedsConfigurationError(error: unknown): error is Error {
  return error instanceof Error && error.name === "NeedsConfigurationError";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function migrationSchemaFingerprint(database: Database.Database): string {
  const rows = database
    .prepare(
      `SELECT type, name, tbl_name AS tableName, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name, tbl_name`,
    )
    .all() as Array<{
    type: string;
    name: string;
    tableName: string;
    sql: string | null;
  }>;
  return sha256(JSON.stringify(rows));
}

function migrateWithPlanV2(
  database: Database.Database,
  plan: PluginMigrationPlanV2,
): void {
  const statements = [...plan.statements];
  if (
    plan.statementSha256.length !== statements.length ||
    statements.some(
      (statement, index) => sha256(statement) !== plan.statementSha256[index],
    )
  ) {
    throw new Error("Plugin migration V2 statement hash mismatch");
  }
  const { descriptor } = plan.recovery;
  if (
    descriptor.beforeMigrationId !== 18 ||
    descriptor.migration18Sha256 !== plan.statementSha256[18] ||
    sha256(plan.recovery.recoveryRecipeJson) !== descriptor.recoveryRecipeSha256
  ) {
    throw new Error("Plugin migration V2 recovery descriptor mismatch");
  }

  database.exec(
    "CREATE TABLE IF NOT EXISTS _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const appliedRows = database
    .prepare("SELECT id FROM _bb_migrations ORDER BY id")
    .all() as Array<{ id: number }>;
  const appliedIds = appliedRows.map(({ id }) => id);
  if (
    appliedIds.some(
      (id, index) =>
        !Number.isInteger(id) || id !== index || id >= statements.length,
    )
  ) {
    throw new Error("Plugin migration V2 ledger is noncontiguous or unknown");
  }
  const recoveryLedgerExists =
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_bb_migration_recoveries'",
      )
      .get() !== undefined;
  if (recoveryLedgerExists) {
    const rows = database
      .prepare(
        `SELECT recovery_id AS recoveryId, descriptor_sha256 AS descriptorSha256
         FROM _bb_migration_recoveries`,
      )
      .all() as Array<{ recoveryId: string; descriptorSha256: string }>;
    if (
      rows.length !== 1 ||
      rows[0]?.recoveryId !== descriptor.recoveryId ||
      rows[0]?.descriptorSha256 !== sha256(JSON.stringify(descriptor)) ||
      appliedIds.length !== statements.length
    ) {
      throw new Error(
        "Plugin migration V2 recovery ledger is partial or unknown",
      );
    }
  }

  const record = database.prepare(
    "INSERT INTO _bb_migrations (id, applied_at) VALUES (?, ?)",
  );
  try {
    database.transaction(() => {
      for (let id = appliedIds.length; id < statements.length; id += 1) {
        database.exec(statements[id]!);
        record.run(id, Date.now());
      }
    })();
    return;
  } catch (ordinaryError) {
    if (
      appliedIds.length !== descriptor.beforeMigrationId ||
      appliedIds.some((id, index) => id !== index) ||
      migrationSchemaFingerprint(database) !==
        descriptor.preSchemaFingerprintSha256
    ) {
      throw ordinaryError;
    }
  }

  database.transaction(() => {
    let nextMigrationId = descriptor.beforeMigrationId;
    const result = plan.recovery.recover({
      database,
      descriptor,
      executeMigration(migrationId) {
        if (
          migrationId !== nextMigrationId ||
          migrationId >= statements.length
        ) {
          throw new Error("Plugin migration V2 recovery order mismatch");
        }
        database.exec(statements[migrationId]!);
        record.run(migrationId, Date.now());
        nextMigrationId += 1;
      },
    });
    if (nextMigrationId !== statements.length) {
      throw new Error(
        "Plugin migration V2 recovery did not execute every migration",
      );
    }
    for (const value of [
      result.activeGraphSha256,
      result.quarantineGraphSha256,
      result.receiptSha256,
    ]) {
      if (!/^[a-f0-9]{64}$/.test(value)) {
        throw new Error(
          "Plugin migration V2 recovery returned an invalid hash",
        );
      }
    }
    if (result.stagedRowCount < 0 || result.restoredGrantCount < 0) {
      throw new Error("Plugin migration V2 recovery returned invalid counts");
    }
    database.exec(`CREATE TABLE _bb_migration_recoveries (
      recovery_id TEXT PRIMARY KEY,
      descriptor_sha256 TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL,
      recovered_at INTEGER NOT NULL
    )`);
    database
      .prepare(
        `INSERT INTO _bb_migration_recoveries
           (recovery_id, descriptor_sha256, receipt_sha256, recovered_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        descriptor.recoveryId,
        sha256(JSON.stringify(descriptor)),
        result.receiptSha256,
        Date.now(),
      );
  })();
}

const V3_SEAM_ID =
  "bb-artifact-review-v3-real-boundary-atomicity-c1:host-owned-sqlite-commit-reopen-oracle-v1";
const V3_SERVICE_REVISION = "bb-artifact-review-service:revision-1";
const V3_ARCHITECTURE_REVISION = 2;
const V3_RECOVERY_START = 18;
const V3_MIGRATION_SHA256 = [
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
  "89f614b25f424c27f61d6308f1d93373420fff3cea5a4958b471668bf31ccf24",
  "5c980eccd9a3a40da158ef41806df8f212b494cbc60b2768762bf05fe58c09c2",
  "5951a693ab7a49e5f1b4cecb2e4bc6385853584de204f48b974aaa3fb19e2bfa",
  "1767f3322d25f443f073ff49cada30950ace97d2d348d57696d1baeee7d7a3e3",
  "65e86c96105b3f48f8e0faa5f168e7f5e0d66f916cd4c1ea6d6f8a8a89111f83",
  "5b44b70d6b98aa04374afeefff2860733465d4a1156ac33917b15646073014d8",
  "d147cd626d4887587d4efa99fea9a9f801960d6c9c18b0fb8ac6c9a0b636f01e",
  "aa760982bf7d933ab902f867062d4c11482e64a177b49db5ccdf3ec56dc0f91d",
  "03afb93d68a7018bed783ce9bb72665b52a9c6f544564956d35dbda7d65997a3",
  "1d0f7ebcbc92d9bc7e175a4b70ac430ef42498191b4c57ff46620f82af17434e",
  "57defc2f33da6307d6887fcb357dcf030fd614b56a342f310796ae1fe2b81e14",
  "045811cf8748bb6ca9a33242449f58a2c72dc8e42972e4acc63f2807bef0053e",
] as const;

const V3_JOURNAL_TABLES = [
  "_bb_artifact_review_v3_operations",
  "_bb_artifact_review_v3_gate_consumptions",
  "_bb_artifact_review_v3_receipts",
  "_bb_artifact_review_v3_complete_families",
] as const;

function assertV3Text(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\0")
  ) {
    throw new Error(`E_V3_INVALID_INPUT:${field}`);
  }
}

function assertV3DomainEffect(
  effect: PluginMigrationDomainEffectV3,
  field: string,
): void {
  if (effect === null || typeof effect !== "object") {
    throw new Error(`E_V3_INVALID_INPUT:${field}`);
  }
  const sql = effect.sql?.trim();
  if (
    typeof sql !== "string" ||
    sql.length === 0 ||
    sql.length > 65_536 ||
    !/^(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\b/iu.test(
      sql,
    ) ||
    /_bb_/iu.test(sql) ||
    /\b(?:ATTACH|DETACH|PRAGMA|VACUUM|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|CREATE|ALTER|DROP|REINDEX)\b/iu.test(
      sql,
    ) ||
    /;\s*\S/u.test(sql)
  ) {
    throw new Error(`E_V3_INVALID_DOMAIN_EFFECT:${field}`);
  }
  const values = effect.values ?? [];
  if (!Array.isArray(values) || values.length > 256) {
    throw new Error(`E_V3_INVALID_INPUT:${field}.values`);
  }
  for (const value of values) {
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "bigint" &&
      !(value instanceof Uint8Array) &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new Error(`E_V3_INVALID_INPUT:${field}.values`);
    }
  }
}

function assertV3CandidateEffects(
  effects: PluginMigrationCandidateEffectsV3,
): void {
  if (
    effects === null ||
    typeof effects !== "object" ||
    effects.version !== 3
  ) {
    throw new Error("E_V3_INVALID_INPUT:version");
  }
  assertV3Text(effects.gate?.recorderNonce, "gate.recorderNonce");
  assertV3Text(effects.gate?.stimulusId, "gate.stimulusId");
  assertV3Text(effects.operation?.kind, "operation.kind");
  for (const [field, payload] of [
    ["operation.payload", effects.operation?.payload],
    ["launch.payload", effects.launch?.payload],
    ["query.payload", effects.query?.payload],
  ] as const) {
    if (!(payload instanceof Uint8Array) || payload.byteLength > 1_048_576) {
      throw new Error(`E_V3_INVALID_INPUT:${field}`);
    }
  }
  if (
    !Array.isArray(effects.statements) ||
    effects.statements.length !== V3_MIGRATION_SHA256.length ||
    effects.statements.some(
      (statement, index) =>
        typeof statement !== "string" ||
        sha256(statement) !== V3_MIGRATION_SHA256[index],
    )
  ) {
    throw new Error("E_V3_STATIC_MIGRATION_MISMATCH");
  }
  for (const [field, values] of [
    ["domainEffects", effects.domainEffects],
    ["recoveryEffects", effects.recoveryEffects],
  ] as const) {
    if (!Array.isArray(values) || values.length > 256) {
      throw new Error(`E_V3_INVALID_INPUT:${field}`);
    }
    values.forEach((effect, index) =>
      assertV3DomainEffect(effect, `${field}[${index}]`),
    );
  }
}

function resolveHostDatabasePathV3(dataDir: string, pluginId: string): string {
  const canonicalDataDir = resolve(dataDir);
  const pluginsDir = resolve(canonicalDataDir, "plugins");
  const pluginDir = resolve(pluginsDir, pluginId);
  if (dirname(pluginDir) !== pluginsDir)
    throw new Error("E_V3_PATH_SUBSTITUTION");
  mkdirSync(pluginDir, { recursive: true });
  if (
    realpathSync.native(canonicalDataDir) !== canonicalDataDir ||
    realpathSync.native(pluginsDir) !== pluginsDir ||
    realpathSync.native(pluginDir) !== pluginDir
  ) {
    throw new Error("E_V3_PATH_SUBSTITUTION");
  }
  const databasePath = join(pluginDir, "data.db");
  if (existsSync(databasePath) && lstatSync(databasePath).isSymbolicLink()) {
    throw new Error("E_V3_PATH_SUBSTITUTION");
  }
  return databasePath;
}

function configureV3Writer(database: Database.Database): void {
  if (
    !database.open ||
    database.memory ||
    database.readonly ||
    database.inTransaction
  ) {
    throw new Error("E_V3_WRITER_SUBSTITUTION");
  }
  const journalMode = database.pragma("journal_mode = WAL", {
    simple: true,
  });
  database.pragma("synchronous = FULL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  if (
    journalMode !== "wal" ||
    database.pragma("synchronous", { simple: true }) !== 2 ||
    database.pragma("foreign_keys", { simple: true }) !== 1 ||
    Number(database.pragma("busy_timeout", { simple: true })) < 5000
  ) {
    throw new Error("E_V3_PRAGMA_MISMATCH");
  }
}

function createV3JournalTables(database: Database.Database): void {
  database.exec(`CREATE TABLE IF NOT EXISTS _bb_artifact_review_v3_operations (
    operation_key INTEGER PRIMARY KEY,
    seam_id TEXT NOT NULL,
    service_revision TEXT NOT NULL,
    architecture_revision INTEGER NOT NULL,
    plugin_id TEXT NOT NULL,
    recorder_nonce TEXT NOT NULL,
    stimulus_id TEXT NOT NULL,
    operation_kind TEXT NOT NULL,
    operation_payload BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS _bb_artifact_review_v3_gate_consumptions (
    consumption_key INTEGER PRIMARY KEY,
    operation_key INTEGER NOT NULL UNIQUE,
    seam_id TEXT NOT NULL,
    service_revision TEXT NOT NULL,
    architecture_revision INTEGER NOT NULL,
    plugin_id TEXT NOT NULL,
    recorder_nonce TEXT NOT NULL,
    stimulus_id TEXT NOT NULL,
    consumed_at INTEGER NOT NULL,
    UNIQUE(seam_id, service_revision, architecture_revision, plugin_id, recorder_nonce, stimulus_id),
    UNIQUE(consumption_key, operation_key),
    FOREIGN KEY(operation_key) REFERENCES _bb_artifact_review_v3_operations(operation_key)
  );
  CREATE TABLE IF NOT EXISTS _bb_artifact_review_v3_receipts (
    receipt_key INTEGER PRIMARY KEY,
    operation_key INTEGER NOT NULL,
    receipt_kind TEXT NOT NULL CHECK(receipt_kind IN ('launch','query')),
    receipt_payload BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(operation_key, receipt_kind),
    UNIQUE(receipt_key, operation_key, receipt_kind),
    FOREIGN KEY(operation_key) REFERENCES _bb_artifact_review_v3_operations(operation_key)
  );
  CREATE TABLE IF NOT EXISTS _bb_artifact_review_v3_complete_families (
    family_key INTEGER PRIMARY KEY,
    operation_key INTEGER NOT NULL UNIQUE,
    consumption_key INTEGER NOT NULL UNIQUE,
    launch_receipt_key INTEGER NOT NULL UNIQUE,
    launch_kind TEXT NOT NULL DEFAULT 'launch' CHECK(launch_kind = 'launch'),
    query_receipt_key INTEGER NOT NULL UNIQUE,
    query_kind TEXT NOT NULL DEFAULT 'query' CHECK(query_kind = 'query'),
    completed_at INTEGER NOT NULL,
    FOREIGN KEY(operation_key) REFERENCES _bb_artifact_review_v3_operations(operation_key),
    FOREIGN KEY(consumption_key, operation_key) REFERENCES _bb_artifact_review_v3_gate_consumptions(consumption_key, operation_key),
    FOREIGN KEY(launch_receipt_key, operation_key, launch_kind) REFERENCES _bb_artifact_review_v3_receipts(receipt_key, operation_key, receipt_kind),
    FOREIGN KEY(query_receipt_key, operation_key, query_kind) REFERENCES _bb_artifact_review_v3_receipts(receipt_key, operation_key, receipt_kind)
  )`);
}

const V3_JOURNAL_COLUMNS: Readonly<
  Record<(typeof V3_JOURNAL_TABLES)[number], readonly string[]>
> = {
  _bb_artifact_review_v3_operations: [
    "operation_key:INTEGER:0:1",
    "seam_id:TEXT:1:0",
    "service_revision:TEXT:1:0",
    "architecture_revision:INTEGER:1:0",
    "plugin_id:TEXT:1:0",
    "recorder_nonce:TEXT:1:0",
    "stimulus_id:TEXT:1:0",
    "operation_kind:TEXT:1:0",
    "operation_payload:BLOB:1:0",
    "created_at:INTEGER:1:0",
  ],
  _bb_artifact_review_v3_gate_consumptions: [
    "consumption_key:INTEGER:0:1",
    "operation_key:INTEGER:1:0",
    "seam_id:TEXT:1:0",
    "service_revision:TEXT:1:0",
    "architecture_revision:INTEGER:1:0",
    "plugin_id:TEXT:1:0",
    "recorder_nonce:TEXT:1:0",
    "stimulus_id:TEXT:1:0",
    "consumed_at:INTEGER:1:0",
  ],
  _bb_artifact_review_v3_receipts: [
    "receipt_key:INTEGER:0:1",
    "operation_key:INTEGER:1:0",
    "receipt_kind:TEXT:1:0",
    "receipt_payload:BLOB:1:0",
    "created_at:INTEGER:1:0",
  ],
  _bb_artifact_review_v3_complete_families: [
    "family_key:INTEGER:0:1",
    "operation_key:INTEGER:1:0",
    "consumption_key:INTEGER:1:0",
    "launch_receipt_key:INTEGER:1:0",
    "launch_kind:TEXT:1:0",
    "query_receipt_key:INTEGER:1:0",
    "query_kind:TEXT:1:0",
    "completed_at:INTEGER:1:0",
  ],
};

const V3_JOURNAL_UNIQUE_COLUMNS: Readonly<
  Partial<Record<(typeof V3_JOURNAL_TABLES)[number], readonly string[]>>
> = {
  _bb_artifact_review_v3_gate_consumptions: [
    "architecture_revision,plugin_id,recorder_nonce,seam_id,service_revision,stimulus_id",
    "consumption_key,operation_key",
    "operation_key",
  ],
  _bb_artifact_review_v3_receipts: [
    "operation_key,receipt_kind",
    "operation_key,receipt_key,receipt_kind",
  ],
  _bb_artifact_review_v3_complete_families: [
    "consumption_key",
    "launch_receipt_key",
    "operation_key",
    "query_receipt_key",
  ],
};

const V3_JOURNAL_FOREIGN_KEYS: Readonly<
  Partial<Record<(typeof V3_JOURNAL_TABLES)[number], readonly string[]>>
> = {
  _bb_artifact_review_v3_gate_consumptions: [
    "operation_key>_bb_artifact_review_v3_operations.operation_key",
  ],
  _bb_artifact_review_v3_receipts: [
    "operation_key>_bb_artifact_review_v3_operations.operation_key",
  ],
  _bb_artifact_review_v3_complete_families: [
    "consumption_key>_bb_artifact_review_v3_gate_consumptions.consumption_key",
    "launch_kind>_bb_artifact_review_v3_receipts.receipt_kind",
    "launch_receipt_key>_bb_artifact_review_v3_receipts.receipt_key",
    "operation_key>_bb_artifact_review_v3_gate_consumptions.operation_key",
    "operation_key>_bb_artifact_review_v3_operations.operation_key",
    "operation_key>_bb_artifact_review_v3_receipts.operation_key",
    "operation_key>_bb_artifact_review_v3_receipts.operation_key",
    "query_kind>_bb_artifact_review_v3_receipts.receipt_kind",
    "query_receipt_key>_bb_artifact_review_v3_receipts.receipt_key",
  ],
};

function assertV3JournalSchema(database: Database.Database): void {
  for (const table of V3_JOURNAL_TABLES) {
    const columns = (
      database.pragma(`table_info(${table})`) as Array<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>
    ).map(
      ({ name, type, notnull, pk }) =>
        `${name}:${type.toUpperCase()}:${notnull}:${pk}`,
    );
    if (JSON.stringify(columns) !== JSON.stringify(V3_JOURNAL_COLUMNS[table])) {
      throw new Error("E_V3_JOURNAL_SCHEMA_MISMATCH");
    }

    const uniqueIndexes = (
      database.pragma(`index_list(${table})`) as Array<{
        name: string;
        unique: number;
      }>
    )
      .filter(({ unique }) => unique === 1)
      .map(({ name }) =>
        (
          database.pragma(`index_info(${name})`) as Array<{
            name: string;
          }>
        )
          .map((row) => row.name)
          .sort()
          .join(","),
      )
      .sort();
    if (
      JSON.stringify(uniqueIndexes) !==
      JSON.stringify([...(V3_JOURNAL_UNIQUE_COLUMNS[table] ?? [])].sort())
    ) {
      throw new Error("E_V3_JOURNAL_SCHEMA_MISMATCH");
    }

    const foreignKeys = (
      database.pragma(`foreign_key_list(${table})`) as Array<{
        table: string;
        from: string;
        to: string;
      }>
    )
      .map(({ table: parent, from, to }) => `${from}>${parent}.${to}`)
      .sort();
    if (
      JSON.stringify(foreignKeys) !==
      JSON.stringify([...(V3_JOURNAL_FOREIGN_KEYS[table] ?? [])].sort())
    ) {
      throw new Error("E_V3_JOURNAL_SCHEMA_MISMATCH");
    }
  }
}

function assertV3JournalClosure(database: Database.Database): void {
  const violations = database.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) throw new Error("E_V3_FOREIGN_KEY_MISMATCH");
  const counts = database
    .prepare(
      `SELECT
         (SELECT count(*) FROM _bb_artifact_review_v3_operations) AS operations,
         (SELECT count(*) FROM _bb_artifact_review_v3_gate_consumptions) AS consumptions,
         (SELECT count(*) FROM _bb_artifact_review_v3_receipts) AS receipts,
         (SELECT count(*) FROM _bb_artifact_review_v3_complete_families) AS families,
         (SELECT count(*)
            FROM _bb_artifact_review_v3_complete_families f
            JOIN _bb_artifact_review_v3_gate_consumptions c
              ON c.consumption_key = f.consumption_key AND c.operation_key = f.operation_key
            JOIN _bb_artifact_review_v3_receipts l
              ON l.receipt_key = f.launch_receipt_key AND l.operation_key = f.operation_key AND l.receipt_kind = 'launch'
            JOIN _bb_artifact_review_v3_receipts q
              ON q.receipt_key = f.query_receipt_key AND q.operation_key = f.operation_key AND q.receipt_kind = 'query') AS joinedFamilies`,
    )
    .get() as {
    operations: number;
    consumptions: number;
    receipts: number;
    families: number;
    joinedFamilies: number;
  };
  if (
    counts.operations !== counts.families ||
    counts.consumptions !== counts.families ||
    counts.receipts !== counts.families * 2 ||
    counts.joinedFamilies !== counts.families
  ) {
    throw new Error("E_V3_PARTIAL_FAMILY");
  }
}

function runV3DomainEffects(
  database: Database.Database,
  effects: readonly PluginMigrationDomainEffectV3[],
): void {
  for (const effect of effects) {
    const statement = database.prepare(effect.sql);
    if (statement.reader || statement.readonly) {
      throw new Error("E_V3_INVALID_DOMAIN_EFFECT");
    }
    statement.run(
      ...(effect.values ?? []).map((value) =>
        value instanceof Uint8Array ? Buffer.from(value) : value,
      ),
    );
  }
}

function migrateWithCandidateEffectsV3(
  database: Database.Database,
  pluginId: string,
  effects: PluginMigrationCandidateEffectsV3,
): void {
  const execute = database.transaction(() => {
    const existingJournalTables = database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (${V3_JOURNAL_TABLES.map(() => "?").join(",")})
         ORDER BY name`,
      )
      .pluck()
      .all(...V3_JOURNAL_TABLES) as string[];
    if (
      existingJournalTables.length !== 0 &&
      existingJournalTables.length !== V3_JOURNAL_TABLES.length
    ) {
      throw new Error("E_V3_PARTIAL_FAMILY");
    }
    database.exec(
      "CREATE TABLE IF NOT EXISTS _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    createV3JournalTables(database);
    assertV3JournalSchema(database);
    assertV3JournalClosure(database);

    const spent = database
      .prepare(
        `SELECT 1
           FROM _bb_artifact_review_v3_gate_consumptions c
           JOIN _bb_artifact_review_v3_complete_families f
             ON f.consumption_key = c.consumption_key AND f.operation_key = c.operation_key
          WHERE c.seam_id = ? AND c.service_revision = ?
            AND c.architecture_revision = ? AND c.plugin_id = ?
            AND c.recorder_nonce = ? AND c.stimulus_id = ?`,
      )
      .get(
        V3_SEAM_ID,
        V3_SERVICE_REVISION,
        V3_ARCHITECTURE_REVISION,
        pluginId,
        effects.gate.recorderNonce,
        effects.gate.stimulusId,
      );
    if (spent !== undefined) throw new Error("E_V3_GATE_SPENT");

    const migrationIds = database
      .prepare("SELECT id FROM _bb_migrations ORDER BY id")
      .pluck()
      .all() as number[];
    if (
      migrationIds.some(
        (id, index) => !Number.isSafeInteger(id) || id !== index,
      ) ||
      migrationIds.length > V3_MIGRATION_SHA256.length
    ) {
      throw new Error("E_V3_MIGRATION_LEDGER_MISMATCH");
    }
    if (
      effects.recoveryEffects.length > 0 &&
      migrationIds.length !== V3_RECOVERY_START
    ) {
      throw new Error("E_V3_RECOVERY_PREFIX_MISMATCH");
    }

    const now = Date.now();
    const operationKey = database
      .prepare(
        `INSERT INTO _bb_artifact_review_v3_operations
           (seam_id, service_revision, architecture_revision, plugin_id,
            recorder_nonce, stimulus_id, operation_kind, operation_payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        V3_SEAM_ID,
        V3_SERVICE_REVISION,
        V3_ARCHITECTURE_REVISION,
        pluginId,
        effects.gate.recorderNonce,
        effects.gate.stimulusId,
        effects.operation.kind,
        Buffer.from(effects.operation.payload),
        now,
      ).lastInsertRowid;
    const consumptionKey = database
      .prepare(
        `INSERT INTO _bb_artifact_review_v3_gate_consumptions
           (operation_key, seam_id, service_revision, architecture_revision,
            plugin_id, recorder_nonce, stimulus_id, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operationKey,
        V3_SEAM_ID,
        V3_SERVICE_REVISION,
        V3_ARCHITECTURE_REVISION,
        pluginId,
        effects.gate.recorderNonce,
        effects.gate.stimulusId,
        now,
      ).lastInsertRowid;

    if (effects.recoveryEffects.length > 0) {
      runV3DomainEffects(database, effects.recoveryEffects);
    }
    const recordMigration = database.prepare(
      "INSERT INTO _bb_migrations (id, applied_at) VALUES (?, ?)",
    );
    for (
      let id = migrationIds.length;
      id < effects.statements.length;
      id += 1
    ) {
      database.exec(effects.statements[id]!);
      recordMigration.run(id, Date.now());
    }
    runV3DomainEffects(database, effects.domainEffects);

    const insertReceipt = database.prepare(
      `INSERT INTO _bb_artifact_review_v3_receipts
         (operation_key, receipt_kind, receipt_payload, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    const launchKey = insertReceipt.run(
      operationKey,
      "launch",
      Buffer.from(effects.launch.payload),
      Date.now(),
    ).lastInsertRowid;
    const queryKey = insertReceipt.run(
      operationKey,
      "query",
      Buffer.from(effects.query.payload),
      Date.now(),
    ).lastInsertRowid;
    database
      .prepare(
        `INSERT INTO _bb_artifact_review_v3_complete_families
           (operation_key, consumption_key, launch_receipt_key, query_receipt_key, completed_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(operationKey, consumptionKey, launchKey, queryKey, Date.now());
    assertV3JournalClosure(database);
  });
  execute.immediate();
}

function verifyClosedV3Family(
  databasePath: string,
  pluginId: string,
  gate: PluginMigrationCandidateEffectsV3["gate"],
): void {
  const reader = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    reader.pragma("foreign_keys = ON");
    reader.pragma("busy_timeout = 5000");
    assertV3JournalClosure(reader);
    const count = reader
      .prepare(
        `SELECT count(*)
           FROM _bb_artifact_review_v3_gate_consumptions c
           JOIN _bb_artifact_review_v3_complete_families f
             ON f.consumption_key = c.consumption_key AND f.operation_key = c.operation_key
          WHERE c.seam_id = ? AND c.service_revision = ?
            AND c.architecture_revision = ? AND c.plugin_id = ?
            AND c.recorder_nonce = ? AND c.stimulus_id = ?`,
      )
      .pluck()
      .get(
        V3_SEAM_ID,
        V3_SERVICE_REVISION,
        V3_ARCHITECTURE_REVISION,
        pluginId,
        gate.recorderNonce,
        gate.stimulusId,
      ) as number;
    if (count !== 1) throw new Error("E_V3_REOPEN_MISMATCH");
  } finally {
    reader.close();
  }
}

/** Per-event handler lists recorded by `bb.events.on`; dropped with the handle. */
type PluginThreadEventHandlers = {
  [E in PluginThreadEventName]: Array<PluginThreadEventHandler<E>>;
};

/**
 * Wire surfaces (design §4.6/§4.7). Registration is load-safe: routes and
 * rpc handlers are recorded on the handle; the boot-time dispatcher in
 * routes/plugins.ts looks them up live per request, so reload swaps them
 * without touching Hono's routing table.
 */
export interface PluginHttpRouteRecord {
  /** Uppercased HTTP method. */
  method: string;
  /** Exact-match path starting with "/" (no params/wildcards in V1). */
  path: string;
  auth: PluginHttpAuthMode;
  handler: PluginHttpHandler;
}

/** Runtime shape of a registered rpc method; inputs arrive JSON-parsed. */
export interface PluginRpcHandler {
  inputSchema: StandardSchemaV1;
  outputSchema: StandardSchemaV1;
  handler: (input: never) => unknown;
}

/** Runtime record of a registered native tool. */
export interface PluginAgentToolRecord {
  name: string;
  description: string;
  /** Native timeline labels, null when the standard BB title should render. */
  experimentalStatusLabels: PluginAgentToolExperimentalStatusLabels | null;
  /** Instructions snippet for the thread-instructions assembly; null when
   * the registration carried none (description-only). */
  instructions: string | null;
  /** JSON-schema object sent to providers as the tool's input schema. */
  inputSchema: unknown;
  /** Validates raw arguments: zod-backed for zod registrations,
   * pass-through for raw JSON-schema ones. */
  parse(
    input: unknown,
  ): { ok: true; value: unknown } | { ok: false; error: string };
  execute(
    params: unknown,
    ctx: PluginAgentToolContext,
  ): PluginAgentToolResult | Promise<PluginAgentToolResult>;
}

export { RESERVED_AGENT_TOOL_NAMES };

/** Runtime record of a registered mention provider. */
interface PluginMentionProviderRecord {
  id: string;
  label: string;
  triggers: readonly PluginMentionTrigger[];
  search: (
    ctx: PluginMentionSearchContext,
  ) => PluginMentionItem[] | Promise<PluginMentionItem[]>;
  resolve: (
    itemId: string,
  ) => { context: string } | Promise<{ context: string }>;
}

/** Runtime record of a registered background service. */
export interface PluginBackgroundServiceRecord {
  name: string;
  start: (signal: AbortSignal) => void | Promise<void>;
}

/** Runtime record of a registered schedule; cron is validated at registration. */
interface PluginScheduleRecord {
  name: string;
  cron: string;
  fn: () => void | Promise<void>;
}

/** Validated record of the plugin's `bb.cli.register` call. */
interface PluginCliRegistrationRecord {
  name: string;
  summary: string;
  commands: PluginCliCommandInfo[];
  run: (
    argv: string[],
    ctx: PluginCliContext,
  ) => PluginCliResult | Promise<PluginCliResult>;
}

type PluginSettingsListener = (
  next: Record<string, PluginSettingValue | undefined>,
  prev: Record<string, PluginSettingValue | undefined>,
) => void;

export interface PluginApiHandle {
  api: BbPluginApi;
  /** Dispose hooks in registration order (runner executes them LIFO). */
  disposeHooks: Array<() => void | Promise<void>>;
  /** Settings schema + change listeners recorded by `settings.define`. */
  settings: {
    descriptors: PluginSettingDescriptors;
    listeners: PluginSettingsListener[];
  };
  /** Every database handle vended by `storage.database()`; closed on dispose. */
  databaseHandles: Database.Database[];
  /** Thread lifecycle handlers recorded by `bb.events.on`. */
  threadEventHandlers: PluginThreadEventHandlers;
  /** HTTP routes recorded by `bb.http.route`; dropped with the handle. */
  httpRoutes: PluginHttpRouteRecord[];
  /** RPC handlers recorded by `bb.rpc.register`; dropped with the handle. */
  rpcHandlers: Map<string, PluginRpcHandler>;
  /** Unexpected host-worker exit handlers registered by this generation. */
  hostWorkerExitHandlers: PluginHostWorkerExitHandler[];
  /** Typed host signals registered by this generation. */
  hostSignalHandlers: PluginHostSignalHandler[];
  /** Background services recorded by `bb.background.service`. */
  backgroundServices: PluginBackgroundServiceRecord[];
  /** Schedules recorded by `bb.background.schedule`. */
  schedules: PluginScheduleRecord[];
  /** The plugin's CLI command (`bb.cli.register`); null when none. */
  cli: { registration: PluginCliRegistrationRecord | null };
  /** Native tools recorded by `bb.agents.registerTool`. */
  agentTools: PluginAgentToolRecord[];
  /** Undisposed provider declarations staged by the factory. */
  listProviderDeclarations(): PluginProviderDeclaration[];
  /** Per-resolution selector from `bb.agents.configure` (at most one). */
  agentConfigurationProvider: PluginAgentConfigurationProvider | null;
  /**
   * Dynamic thread-instructions provider from
   * `bb.agents.contributeInstructions` (at most one; null when none).
   */
  instructionProvider: PluginInstructionProvider | null;
  /** Mention providers recorded by `bb.ui.registerMentionProvider`. */
  mentionProviders: PluginMentionProviderRecord[];
  /** Publish factory-time host declarations and status only after commit. */
  activate(): void;
  /** Poison every method on the handle. */
  invalidate(): void;
}

type PluginHostWorkerExitHandler = (event: {
  hostId: string;
}) => void | Promise<void>;

interface PluginHostSignalHandler {
  signal: string;
  payloadSchema: StandardSchemaV1;
  handler: (event: {
    hostId: string;
    payload: unknown;
  }) => void | Promise<void>;
}

/** Provider registered by `bb.agents.contributeInstructions`. */
type PluginInstructionProvider = (ctx: {
  threadId: string;
  projectId: string;
}) => string | null;

/** Provider registered by `bb.agents.configure`. */
type PluginAgentConfigurationProvider = (
  context: PluginAgentConfigurationContext,
) => PluginAgentConfiguration;

/**
 * Wrap the shared server-bound SDK for one plugin: thread creation gets
 * default attribution (`origin: "plugin"`, `originPluginId: <plugin id>`)
 * unless the plugin sets those fields explicitly.
 */
function wrapSdkForPlugin(sdk: BbSdk, pluginId: string): BbSdk {
  return {
    ...sdk,
    threads: {
      ...sdk.threads,
      fork(args: ThreadForkArgs) {
        const origin = args.origin ?? "plugin";
        return sdk.threads.fork({
          ...args,
          origin,
          ...(origin === "plugin"
            ? { originPluginId: args.originPluginId ?? pluginId }
            : {}),
        });
      },
      spawn(args: ThreadSpawnArgs) {
        const origin = args.origin ?? "plugin";
        return sdk.threads.spawn({
          ...args,
          origin,
          ...(origin === "plugin"
            ? { originPluginId: args.originPluginId ?? pluginId }
            : {}),
        });
      },
    },
  };
}

export function createPluginApi(options: {
  pluginId: string;
  logger: ServerLogger;
  db: DbConnection;
  dataDir: string;
  /** Undefined until the server is listening (bb.sdk is bind-gated). */
  getSdk: () => BbSdk | undefined;
  /** Undefined until the server is listening (bb.server is bind-gated too). */
  getLoopbackBaseUrl: () => string | undefined;
  /** Broadcasts a plugin-signal WS message (hub.notifyPluginSignal). */
  publishSignal: (channel: string, payload: unknown) => void;
  /** Marks the plugin needs-configuration in the loader's status table. */
  reportNeedsConfiguration: (message: string) => void;
  /** Returns the owning plugin id when another plugin already registered
   * this agent tool name (cross-plugin collisions lose, design §4.4). */
  isAgentToolNameTaken: (name: string) => string | undefined;
  /** Records an agent-tool registration problem as the plugin's status
   * detail; the plugin itself keeps running. */
  reportAgentToolProblem: (message: string) => void;
  requestInteraction: (args: {
    threadId: string;
    rendererId: string;
    title: string;
    payload: JsonValue;
    timeoutMs: number;
    signal?: AbortSignal;
  }) => Promise<PluginInteractionResult>;
  ensureSharedPortTunnel: PluginHosts["ensureSharedPortTunnel"];
  validateSharedPortDeclaration: (
    hostId: string,
    ports: readonly number[],
  ) => readonly number[];
  declareSharedPorts: PluginHosts["declareSharedPorts"];
  replaceDeclaredSharedPorts: (
    declarations: readonly {
      hostId: string;
      ports: readonly number[];
    }[],
  ) => void;
  callPluginHost: (args: {
    contract: PluginRpcContract;
    method: string;
    input: unknown;
    hostId: string;
    signal?: AbortSignal;
  }) => Promise<unknown>;
  /** Registers one validated provider declaration with the server's provider
   * registry, bound to this plugin's id. Throws on a live id collision. */
  registerProvider: (declaration: PluginProviderDeclaration) => {
    dispose(): void;
  };
  /** True when a LIVE registration owned by core or another plugin already
   * claims this provider id — the call-time collision check for staged
   * registrations (this plugin's own previous-load entries are ignored:
   * they are disposed before the staged replacements flush at activate). */
  isProviderIdTaken: (providerId: string) => boolean;
  /** Throws unless this plugin may register this provider id at all: the id
   * is not reserved for another (first-party) plugin, and this load can
   * actually execute it — a bridge artifact it built, or an id the daemon
   * bundles a bridge for. A declaration with no implementation behind it
   * would list a provider whose every turn dies on the host. */
  assertProviderRegistrable: (providerId: string) => void;
}): PluginApiHandle {
  const {
    pluginId,
    logger,
    db,
    dataDir,
    getSdk,
    getLoopbackBaseUrl,
    publishSignal,
    reportNeedsConfiguration,
    isAgentToolNameTaken,
    reportAgentToolProblem,
    requestInteraction,
    ensureSharedPortTunnel,
    validateSharedPortDeclaration,
    declareSharedPorts,
    replaceDeclaredSharedPorts,
    callPluginHost,
    registerProvider,
    isProviderIdTaken,
    assertProviderRegistrable,
  } = options;
  let invalidated = false;
  let activated = false;
  let wrappedSdk: BbSdk | undefined;
  let pendingNeedsConfiguration: string | null = null;
  const pendingAgentToolProblems: string[] = [];
  const pendingSharedPorts = new Map<string, readonly number[]>();
  const disposeHooks: Array<() => void | Promise<void>> = [];
  const settingsRecord: PluginApiHandle["settings"] = {
    descriptors: {},
    listeners: [],
  };
  const databaseHandles: Database.Database[] = [];
  const threadEventHandlers: PluginThreadEventHandlers = {
    "thread.created": [],
    "thread.active": [],
    "thread.idle": [],
    "thread.failed": [],
    "thread.archived": [],
    "thread.deleted": [],
  };
  const httpRoutes: PluginHttpRouteRecord[] = [];
  const rpcHandlers = new Map<string, PluginRpcHandler>();
  const hostWorkerExitHandlers: PluginHostWorkerExitHandler[] = [];
  const hostSignalHandlers: PluginHostSignalHandler[] = [];
  const backgroundServices: PluginBackgroundServiceRecord[] = [];
  const schedules: PluginScheduleRecord[] = [];

  function assertLive(): void {
    if (invalidated) throw new PluginContextStaleError(pluginId);
  }

  const prefix = `[plugin:${pluginId}]`;
  // Every bb.log line goes to the prefixed server log and, as JSONL, to the
  // per-plugin log file served by GET /plugins/:id/logs (`bb plugin logs`).
  function emitLog(
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ): void {
    logger[level](`${prefix} ${message}`);
    appendPluginLogLine(dataDir, pluginId, level, message);
  }
  const log: PluginLogger = {
    debug: (message) => emitLog("debug", message),
    info: (message) => emitLog("info", message),
    warn: (message) => emitLog("warn", message),
    error: (message) => emitLog("error", message),
  };

  async function requestInput(
    request: Parameters<PluginUi["requestInput"]>[0],
    requestOptions?: Parameters<PluginUi["requestInput"]>[1],
  ) {
    assertLive();
    if (!request || typeof request !== "object") {
      throw new Error("ui.requestInput requires an options object");
    }
    if (typeof request.threadId !== "string" || request.threadId.length === 0) {
      throw new Error("ui.requestInput threadId must be a non-empty string");
    }
    if (
      typeof request.rendererId !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(request.rendererId)
    ) {
      throw new Error(
        "ui.requestInput rendererId must use letters, digits, '-' or '_'",
      );
    }
    if (
      typeof request.title !== "string" ||
      request.title.trim().length === 0 ||
      request.title.trim().length > PLUGIN_INTERACTION_MAX_TITLE_LENGTH
    ) {
      throw new Error(
        `ui.requestInput title must be 1-${PLUGIN_INTERACTION_MAX_TITLE_LENGTH} characters`,
      );
    }
    let payload: JsonValue;
    try {
      const json = JSON.stringify(request.payload);
      if (json === undefined) throw new Error();
      if (Buffer.byteLength(json, "utf8") > 64 * 1024) {
        throw new Error("ui.requestInput payload exceeds 64 KiB");
      }
      payload = JSON.parse(json) as JsonValue;
    } catch (error) {
      if (error instanceof Error && error.message.includes("64 KiB"))
        throw error;
      throw new Error("ui.requestInput payload must be JSON-serializable");
    }
    const timeoutMs = request.timeoutMs ?? 10 * 60 * 1000;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 60 * 60 * 1000
    ) {
      throw new Error(
        "ui.requestInput timeoutMs must be between 1 and 3600000",
      );
    }
    return requestInteraction({
      threadId: request.threadId,
      rendererId: request.rendererId,
      title: request.title.trim(),
      payload,
      timeoutMs,
      signal: requestOptions?.signal,
    });
  }

  const kv: PluginKvStorage = {
    async get(key) {
      assertLive();
      const raw = getPluginKvValue(db, pluginId, key);
      if (raw === undefined) return undefined;
      return JSON.parse(raw);
    },
    async set(key, value) {
      assertLive();
      const json = JSON.stringify(value);
      if (json === undefined) {
        throw new Error(`kv value for "${key}" is not JSON-serializable`);
      }
      const bytes = Buffer.byteLength(json, "utf8");
      if (bytes > KV_VALUE_MAX_BYTES) {
        throw new Error(
          `kv value for "${key}" is ${bytes} bytes; the limit is ${KV_VALUE_MAX_BYTES} (256KB). ` +
            `Store large data in storage.database() instead.`,
        );
      }
      setPluginKvValue(db, pluginId, key, json);
    },
    async delete(key) {
      assertLive();
      deletePluginKvValue(db, pluginId, key);
    },
    async list(kvPrefix) {
      assertLive();
      return listPluginKvKeys(db, pluginId, kvPrefix);
    },
  };

  // One reused handle per plugin load: the SDK contract and the fake host
  // both promise reuse, and a handle per call leaks fds until dispose (#1919).
  // A plugin that closes the handle itself gets a fresh one on the next call.
  let databaseHandle: Database.Database | undefined;
  const storage: PluginStorage = {
    kv,
    database() {
      assertLive();
      if (databaseHandle?.open) return databaseHandle;
      if (databaseHandle) {
        // The plugin closed it; drop the dead wrapper so repeated
        // close-and-reopen calls do not grow the list until dispose.
        const index = databaseHandles.indexOf(databaseHandle);
        if (index !== -1) databaseHandles.splice(index, 1);
      }
      const dir = join(dataDir, "plugins", pluginId);
      mkdirSync(dir, { recursive: true });
      const database = new Database(join(dir, "data.db"));
      database.pragma("journal_mode = WAL");
      database.pragma("busy_timeout = 5000");
      databaseHandle = database;
      databaseHandles.push(database);
      return database;
    },
    migrate(
      databaseOrEffects: Database.Database | PluginMigrationCandidateEffectsV3,
      statements?: string[] | PluginMigrationPlanV2,
    ) {
      assertLive();
      if (statements === undefined) {
        const effects = databaseOrEffects as PluginMigrationCandidateEffectsV3;
        assertV3CandidateEffects(effects);
        const databasePath = resolveHostDatabasePathV3(dataDir, pluginId);
        let writer: Database.Database;
        if (databaseHandle?.open) {
          if (databaseHandle.name !== databasePath) {
            throw new Error("E_V3_WRITER_SUBSTITUTION");
          }
          writer = databaseHandle;
        } else {
          if (databaseHandle) {
            const index = databaseHandles.indexOf(databaseHandle);
            if (index !== -1) databaseHandles.splice(index, 1);
          }
          writer = new Database(databasePath);
          databaseHandle = writer;
          databaseHandles.push(writer);
        }
        try {
          configureV3Writer(writer);
          migrateWithCandidateEffectsV3(writer, pluginId, effects);
        } finally {
          if (writer.open) writer.close();
        }
        verifyClosedV3Family(databasePath, pluginId, effects.gate);
        return;
      }
      const database = databaseOrEffects as Database.Database;
      if (!Array.isArray(statements)) {
        if (statements.version !== 2) {
          throw new Error("Unknown plugin migration plan version");
        }
        migrateWithPlanV2(database, statements);
        return;
      }
      database.exec(
        "CREATE TABLE IF NOT EXISTS _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
      );
      const applied = new Set(
        (
          database.prepare("SELECT id FROM _bb_migrations").all() as Array<{
            id: number;
          }>
        ).map((row) => row.id),
      );
      const record = database.prepare(
        "INSERT INTO _bb_migrations (id, applied_at) VALUES (?, ?)",
      );
      database.transaction(() => {
        statements.forEach((statement, index) => {
          if (applied.has(index)) return;
          database.exec(statement);
          record.run(index, Date.now());
        });
      })();
    },
  };

  const settings: PluginSettings = {
    define(descriptors) {
      assertLive();
      const validated = registerSettingDescriptors(
        settingsRecord.descriptors,
        descriptors as Record<string, unknown>,
      );
      type Values = PluginSettingsValues<typeof descriptors>;
      return {
        async get() {
          assertLive();
          // The runtime record is untyped; the descriptor generics are the
          // real contract, re-applied at this boundary.
          return (await readPluginSettingsValues({
            db,
            dataDir,
            pluginId,
            descriptors: validated,
          })) as Values;
        },
        onChange(listener) {
          assertLive();
          settingsRecord.listeners.push(listener as PluginSettingsListener);
        },
      };
    },
  };

  // Plugin sources are untyped at runtime (jiti-loaded TS): every wire
  // registration validates loudly instead of failing at dispatch time.
  const http: PluginHttp = {
    route(method, path, handler, opts) {
      assertLive();
      const normalizedMethod = String(method).toUpperCase();
      if (!PLUGIN_HTTP_METHODS.has(normalizedMethod)) {
        throw new Error(
          `invalid http method "${String(method)}" — use one of: ${[...PLUGIN_HTTP_METHODS].join(", ")}`,
        );
      }
      if (typeof path !== "string" || !path.startsWith("/")) {
        throw new Error(
          `http route path must be a string starting with "/", got ${JSON.stringify(path)}`,
        );
      }
      if (typeof handler !== "function") {
        throw new Error(
          `http route handler for ${normalizedMethod} ${path} must be a function`,
        );
      }
      const auth = opts?.auth ?? "local";
      if (auth !== "local" && auth !== "token" && auth !== "none") {
        throw new Error(
          `invalid auth mode "${String(auth)}" for ${normalizedMethod} ${path} — use "local", "token", or "none"`,
        );
      }
      if (
        httpRoutes.some(
          (route) => route.method === normalizedMethod && route.path === path,
        )
      ) {
        throw new Error(
          `http route ${normalizedMethod} ${path} is already registered`,
        );
      }
      httpRoutes.push({ method: normalizedMethod, path, auth, handler });
    },
  };

  const rpc: PluginRpc = {
    register(contract, handlers) {
      assertLive();
      if (
        typeof contract !== "object" ||
        contract === null ||
        Array.isArray(contract)
      ) {
        throw new Error("rpc.register contract must be an object");
      }
      if (
        typeof handlers !== "object" ||
        handlers === null ||
        Array.isArray(handlers)
      ) {
        throw new Error("rpc.register handlers must be an object");
      }

      const pending: Array<[string, PluginRpcHandler]> = [];
      const contractEntries = Object.entries(contract);
      const contractNames = new Set(contractEntries.map(([name]) => name));
      for (const extraName of Object.keys(handlers)) {
        if (!contractNames.has(extraName)) {
          throw new Error(
            `rpc handler "${extraName}" has no matching contract method`,
          );
        }
      }
      for (const [name, methodContractValue] of contractEntries) {
        if (!RPC_METHOD_PATTERN.test(name)) {
          throw new Error(
            `invalid rpc method name "${name}" — use letters, digits, "-" and "_"`,
          );
        }
        const methodContract = readRpcMethodContract(name, methodContractValue);
        const handler = Reflect.get(handlers, name);
        if (typeof handler !== "function") {
          throw new Error(
            `rpc method "${name}" must provide a handler function`,
          );
        }
        if (rpcHandlers.has(name)) {
          throw new Error(`rpc method "${name}" is already registered`);
        }
        pending.push([
          name,
          {
            inputSchema: methodContract.input,
            outputSchema: methodContract.output,
            handler: handler as (input: never) => unknown,
          },
        ]);
      }
      for (const [name, record] of pending) {
        rpcHandlers.set(name, record);
      }
    },
  };

  const realtime: PluginRealtime = {
    publish(channel, payload) {
      assertLive();
      if (typeof channel !== "string" || channel.length === 0) {
        throw new Error("realtime channel must be a non-empty string");
      }
      // JSON round-trip up front: enforces serializability with a clear
      // error at the publish site and strips prototypes/getters before the
      // payload crosses the WS boundary.
      let normalized: unknown = null;
      if (payload !== undefined) {
        let json: string | undefined;
        try {
          json = JSON.stringify(payload);
        } catch {
          json = undefined;
        }
        if (json === undefined) {
          throw new Error(
            `realtime payload for channel "${channel}" is not JSON-serializable`,
          );
        }
        normalized = JSON.parse(json);
      }
      publishSignal(channel, normalized);
    },
  };

  const background: PluginBackground = {
    service(name, service) {
      assertLive();
      if (typeof name !== "string" || !BACKGROUND_NAME_PATTERN.test(name)) {
        throw new Error(
          `invalid service name ${JSON.stringify(name)} — use letters, digits, "-" and "_"`,
        );
      }
      if (backgroundServices.some((record) => record.name === name)) {
        throw new Error(`background service "${name}" is already registered`);
      }
      if (typeof service?.start !== "function") {
        throw new Error(
          `background service "${name}" must provide a start(signal) function`,
        );
      }
      backgroundServices.push({ name, start: service.start.bind(service) });
    },
    schedule(name, cron, fn) {
      assertLive();
      if (typeof name !== "string" || !BACKGROUND_NAME_PATTERN.test(name)) {
        throw new Error(
          `invalid schedule name ${JSON.stringify(name)} — use letters, digits, "-" and "_"`,
        );
      }
      if (schedules.some((record) => record.name === name)) {
        throw new Error(`schedule "${name}" is already registered`);
      }
      try {
        CronExpressionParser.parse(String(cron));
      } catch (error) {
        throw new Error(
          `invalid cron ${JSON.stringify(cron)} for schedule "${name}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (typeof fn !== "function") {
        throw new Error(`schedule "${name}" must provide a function`);
      }
      schedules.push({ name, cron: String(cron), fn });
    },
  };

  const agentTools: PluginAgentToolRecord[] = [];
  /** Provider registrations from `experimental_registerProvider`, keyed by
   * provider id. Entries staged before activation (`disposer === null`) are
   * flushed into the registry at activate(), mirroring the declareSharedPorts
   * staging pattern; each registration's dispose also rides disposeHooks so
   * unload/reload removes the providers. */
  const providerRegistrations = new Map<
    string,
    {
      declaration: PluginProviderDeclaration;
      disposer: { dispose(): void } | null;
      disposed: boolean;
    }
  >();
  let agentConfigurationProvider: PluginAgentConfigurationProvider | null =
    null;
  let instructionProvider: PluginInstructionProvider | null = null;
  const agents: PluginAgents = {
    configure(provider) {
      assertLive();
      if (agentConfigurationProvider !== null) {
        throw new Error("agent configuration is already registered");
      }
      if (typeof provider !== "function") {
        throw new Error(
          "configure requires a provider function (context) => ({ tools, skills, instructions? })",
        );
      }
      agentConfigurationProvider = provider;
    },
    contributeInstructions(provider) {
      assertLive();
      if (instructionProvider !== null) {
        throw new Error("agent instructions are already registered");
      }
      if (typeof provider !== "function") {
        throw new Error(
          "contributeInstructions requires a provider function (ctx) => string | null",
        );
      }
      instructionProvider = provider;
    },
    experimental_registerProvider(declaration) {
      assertLive();
      // Shared host policy: the fake host validates identically.
      const normalized = validatePluginProviderDeclaration(declaration);
      assertProviderRegistrable(normalized.id);
      if (providerRegistrations.has(normalized.id)) {
        throw new Error(
          `Provider "${normalized.id}" is already registered; a plugin cannot shadow an existing provider.`,
        );
      }
      const entry = {
        declaration: normalized,
        disposer: null as { dispose(): void } | null,
        disposed: false,
      };
      if (activated) {
        // Live registration: the registry enforces collisions itself.
        entry.disposer = registerProvider(normalized);
      } else if (isProviderIdTaken(normalized.id)) {
        // Staged registration: surface the collision at call time so it
        // fails the factory (and therefore the plugin load) like every other
        // registration error, instead of exploding after the load commits.
        throw new Error(
          `Provider "${normalized.id}" is already registered; a plugin cannot shadow an existing provider.`,
        );
      }
      providerRegistrations.set(normalized.id, entry);
      const dispose = (): void => {
        if (entry.disposed) return;
        entry.disposed = true;
        entry.disposer?.dispose();
        if (providerRegistrations.get(normalized.id) === entry) {
          providerRegistrations.delete(normalized.id);
        }
      };
      disposeHooks.push(dispose);
      return { dispose };
    },
    registerTool(tool: {
      name: string;
      description: string;
      instructions?: string;
      experimental_statusLabels?: PluginAgentToolExperimentalStatusLabels;
      parameters: unknown;
      execute(
        params: never,
        ctx: PluginAgentToolContext,
      ): PluginAgentToolResult | Promise<PluginAgentToolResult>;
    }) {
      assertLive();
      const name = tool?.name;
      if (typeof name !== "string" || !AGENT_TOOL_NAME_PATTERN.test(name)) {
        throw new Error(
          `invalid tool name ${JSON.stringify(name)} — use letters, digits, "-" and "_"`,
        );
      }
      if (RESERVED_AGENT_TOOL_NAMES.includes(name)) {
        throw new Error(
          `tool name "${name}" is a built-in bb tool — pick another name`,
        );
      }
      if (
        typeof tool.description !== "string" ||
        tool.description.trim().length === 0
      ) {
        throw new Error(`tool "${name}" must provide a description`);
      }
      if (
        tool.instructions !== undefined &&
        typeof tool.instructions !== "string"
      ) {
        throw new Error(`tool "${name}" instructions must be a string`);
      }
      if (
        typeof tool.instructions === "string" &&
        tool.instructions.length > PLUGIN_AGENT_STATIC_INSTRUCTIONS_MAX_CHARS
      ) {
        throw new Error(
          `tool "${name}" instructions exceed the ${PLUGIN_AGENT_STATIC_INSTRUCTIONS_MAX_CHARS}-character limit`,
        );
      }
      const experimentalStatusLabels = tool.experimental_statusLabels;
      if (experimentalStatusLabels !== undefined) {
        if (
          typeof experimentalStatusLabels !== "object" ||
          experimentalStatusLabels === null ||
          typeof experimentalStatusLabels.pending !== "string" ||
          typeof experimentalStatusLabels.completed !== "string" ||
          experimentalStatusLabels.pending.trim().length === 0 ||
          experimentalStatusLabels.completed.trim().length === 0
        ) {
          throw new Error(
            `tool "${name}" experimental_statusLabels must provide non-empty pending and completed strings`,
          );
        }
        if (
          experimentalStatusLabels.pending.length >
            PLUGIN_AGENT_STATUS_LABEL_MAX_CHARS ||
          experimentalStatusLabels.completed.length >
            PLUGIN_AGENT_STATUS_LABEL_MAX_CHARS
        ) {
          throw new Error(
            `tool "${name}" experimental_statusLabels exceed the ${PLUGIN_AGENT_STATUS_LABEL_MAX_CHARS}-character limit`,
          );
        }
      }
      if (typeof tool.execute !== "function") {
        throw new Error(
          `tool "${name}" must provide an execute(params, ctx) function`,
        );
      }
      const parameters: unknown = tool.parameters;
      let inputSchema: unknown;
      let parse: PluginAgentToolRecord["parse"];
      if (isZodSchemaLike(parameters)) {
        // The server's own zod 4 converts the schema; a schema from an
        // incompatible zod copy inside the plugin fails here with a clear
        // registration error instead of a broken wire schema later.
        try {
          inputSchema = z.toJSONSchema(parameters as z.ZodType, {
            io: "input",
          });
        } catch (error) {
          throw new Error(
            `tool "${name}" parameters look like a zod schema but could not be converted to JSON Schema (${
              error instanceof Error ? error.message : String(error)
            }) — use zod 4, or pass a plain JSON-schema object`,
          );
        }
        parse = (input) => {
          const result = (parameters as z.ZodType).safeParse(input);
          if (result.success) return { ok: true, value: result.data };
          return { ok: false, error: summarizeParseIssues(result.error) };
        };
      } else if (
        typeof parameters === "object" &&
        parameters !== null &&
        !Array.isArray(parameters)
      ) {
        // Raw JSON-schema escape hatch: round-trip enforces serializability
        // (the schema rides thread.start commands) and strips prototypes.
        try {
          inputSchema = JSON.parse(JSON.stringify(parameters));
        } catch {
          throw new Error(
            `tool "${name}" parameters JSON schema is not JSON-serializable`,
          );
        }
        parse = (input) => ({ ok: true, value: input });
      } else {
        throw new Error(
          `tool "${name}" parameters must be a zod schema or a JSON-schema object`,
        );
      }
      assertNoRecursiveJsonSchemaReferences(
        inputSchema,
        `tool "${name}" parameters`,
      );
      const owner = isAgentToolNameTaken(name);
      if (owner !== undefined) {
        // Cross-plugin collision: the earlier registration wins; this one
        // is dropped and surfaced as a status detail (design §4.4).
        const problem = `tool "${name}" is already registered by plugin "${owner}" — not registered`;
        if (activated) reportAgentToolProblem(problem);
        else pendingAgentToolProblems.push(problem);
        return;
      }
      if (agentTools.some((existing) => existing.name === name)) {
        throw new Error(`tool "${name}" is already registered`);
      }
      const record: PluginAgentToolRecord = {
        name,
        description: tool.description,
        experimentalStatusLabels:
          experimentalStatusLabels === undefined
            ? null
            : {
                pending: experimentalStatusLabels.pending,
                completed: experimentalStatusLabels.completed,
              },
        instructions:
          tool.instructions !== undefined && tool.instructions.trim().length > 0
            ? tool.instructions
            : null,
        inputSchema,
        parse,
        execute: (
          tool.execute as (
            params: unknown,
            ctx: PluginAgentToolContext,
          ) => PluginAgentToolResult | Promise<PluginAgentToolResult>
        ).bind(tool),
      };
      agentTools.push(record);
    },
  };

  const mentionProviders: PluginMentionProviderRecord[] = [];
  const ui: PluginUi = {
    requestInput,
    registerMentionProvider(provider) {
      assertLive();
      const id = provider?.id;
      if (typeof id !== "string" || !MENTION_PROVIDER_ID_PATTERN.test(id)) {
        throw new Error(
          `invalid mention provider id ${JSON.stringify(id)} — use letters, digits, "-" and "_"`,
        );
      }
      if (mentionProviders.some((record) => record.id === id)) {
        throw new Error(`mention provider "${id}" is already registered`);
      }
      if (
        typeof provider.label !== "string" ||
        provider.label.trim().length === 0
      ) {
        throw new Error(`mention provider "${id}" must provide a label`);
      }
      if (typeof provider.search !== "function") {
        throw new Error(
          `mention provider "${id}" must provide a search({ query, projectId, threadId }) function`,
        );
      }
      if (typeof provider.resolve !== "function") {
        throw new Error(
          `mention provider "${id}" must provide a resolve(itemId) function`,
        );
      }
      mentionProviders.push({
        id,
        label: provider.label.trim(),
        triggers: normalizeMentionProviderTriggers(id, provider.triggers),
        search: provider.search.bind(provider),
        resolve: provider.resolve.bind(provider),
      });
    },
  };

  const cliRecord: PluginApiHandle["cli"] = { registration: null };
  const cli: PluginCli = {
    register(registration) {
      assertLive();
      if (cliRecord.registration !== null) {
        throw new Error("cli command is already registered");
      }
      const name = registration?.name;
      if (typeof name !== "string" || !CLI_COMMAND_NAME_PATTERN.test(name)) {
        throw new Error(
          `invalid cli command name ${JSON.stringify(name)} — use lowercase letters, digits, and "-"`,
        );
      }
      if (RESERVED_BB_CLI_COMMANDS.includes(name)) {
        throw new Error(
          `cli command name "${name}" is reserved by the bb CLI — pick another name`,
        );
      }
      if (
        typeof registration.summary !== "string" ||
        registration.summary.trim().length === 0
      ) {
        throw new Error(`cli command "${name}" must provide a summary`);
      }
      const commands = registration.commands ?? [];
      if (!Array.isArray(commands)) {
        throw new Error(`cli command "${name}" commands must be an array`);
      }
      const validatedCommands = commands.map((command, index) => {
        if (
          typeof command?.name !== "string" ||
          !CLI_COMMAND_NAME_PATTERN.test(command.name) ||
          typeof command.summary !== "string" ||
          typeof command.usage !== "string"
        ) {
          throw new Error(
            `cli command "${name}" commands[${index}] must be { name: [a-z0-9-]+, summary, usage }`,
          );
        }
        return {
          name: command.name,
          summary: command.summary,
          usage: command.usage,
        };
      });
      if (typeof registration.run !== "function") {
        throw new Error(
          `cli command "${name}" must provide a run(argv, ctx) function`,
        );
      }
      cliRecord.registration = {
        name,
        summary: registration.summary,
        commands: validatedCommands,
        run: registration.run.bind(registration),
      };
    },
  };

  const status: PluginStatusApi = {
    needsConfiguration(message) {
      assertLive();
      const normalized =
        typeof message === "string" && message.length > 0
          ? message
          : "needs configuration";
      if (activated) reportNeedsConfiguration(normalized);
      else pendingNeedsConfiguration = normalized;
    },
  };

  const server: PluginServerApi = {
    get loopbackBaseUrl(): string {
      assertLive();
      const baseUrl = getLoopbackBaseUrl();
      if (baseUrl === undefined) {
        throw new Error(
          "bb.server.loopbackBaseUrl is not available until the server is listening — " +
            "use it inside handlers, services, or timers, not at factory load time",
        );
      }
      return baseUrl;
    },
  };

  const hosts: PluginHosts = {
    experimental_client({ contract, experimental_signals }) {
      assertLive();
      return {
        async call(method, input, callOptions) {
          assertLive();
          if (!activated) {
            throw new Error(
              "host plugin calls are unavailable during factory registration; call from a handler, service, or timer",
            );
          }
          if (typeof method !== "string" || contract[method] === undefined) {
            throw new Error(`unknown host rpc method "${String(method)}"`);
          }
          if (
            typeof callOptions !== "object" ||
            callOptions === null ||
            typeof callOptions.hostId !== "string" ||
            callOptions.hostId.length === 0
          ) {
            throw new Error(`host rpc method "${method}" requires a host id`);
          }
          return callPluginHost({
            contract,
            method,
            input,
            hostId: callOptions.hostId,
            ...(callOptions.signal === undefined
              ? {}
              : { signal: callOptions.signal }),
          });
        },
        experimental_onWorkerExit(handler) {
          assertLive();
          if (typeof handler !== "function") {
            throw new Error("host worker exit subscription requires a handler");
          }
          hostWorkerExitHandlers.push(handler);
          let subscribed = true;
          return () => {
            if (!subscribed) return;
            subscribed = false;
            const index = hostWorkerExitHandlers.indexOf(handler);
            if (index >= 0) hostWorkerExitHandlers.splice(index, 1);
          };
        },
        experimental_onSignal(signal, handler) {
          assertLive();
          const descriptor = experimental_signals?.[signal];
          if (
            typeof signal !== "string" ||
            signal.length === 0 ||
            typeof descriptor !== "object" ||
            descriptor === null ||
            !isStandardSchema(descriptor.payload)
          ) {
            throw new Error(`unknown host signal "${String(signal)}"`);
          }
          if (typeof handler !== "function") {
            throw new Error("host signal subscription requires a handler");
          }
          const record: PluginHostSignalHandler = {
            signal,
            payloadSchema: descriptor.payload,
            handler,
          };
          hostSignalHandlers.push(record);
          let subscribed = true;
          return () => {
            if (!subscribed) return;
            subscribed = false;
            const index = hostSignalHandlers.indexOf(record);
            if (index >= 0) hostSignalHandlers.splice(index, 1);
          };
        },
      };
    },
    ensureSharedPortTunnel(hostId) {
      assertLive();
      return ensureSharedPortTunnel(hostId);
    },
    declareSharedPorts(hostId, ports) {
      assertLive();
      if (activated) declareSharedPorts(hostId, ports);
      else {
        pendingSharedPorts.set(
          hostId,
          validateSharedPortDeclaration(hostId, ports),
        );
      }
    },
  };
  const events: PluginEvents = {
    on(event, handler) {
      assertLive();
      const handlers = threadEventHandlers[event];
      if (handlers === undefined) {
        // Plugin sources are untyped at runtime; fail loudly at registration
        // instead of silently never firing.
        throw new Error(
          `unknown event "${String(event)}" — supported events: ${Object.keys(
            threadEventHandlers,
          ).join(", ")}`,
        );
      }
      handlers.push(handler);
    },
  };

  const api: BbPluginApi = {
    pluginId,
    log,
    settings,
    storage,
    http,
    rpc,
    realtime,
    background,
    cli,
    agents,
    ui,
    events,
    status,
    server,
    hosts,
    get sdk(): BbSdk {
      assertLive();
      const sdk = getSdk();
      if (!sdk) {
        throw new Error(
          "bb.sdk is not available until the server is listening — " +
            "use it inside handlers, services, or timers, not at factory load time",
        );
      }
      wrappedSdk ??= wrapSdkForPlugin(sdk, pluginId);
      return wrappedSdk;
    },
    onDispose(hook) {
      assertLive();
      disposeHooks.push(hook);
    },
  };

  return {
    api,
    disposeHooks,
    settings: settingsRecord,
    databaseHandles,
    threadEventHandlers,
    httpRoutes,
    rpcHandlers,
    hostWorkerExitHandlers,
    hostSignalHandlers,
    backgroundServices,
    schedules,
    cli: cliRecord,
    agentTools,
    listProviderDeclarations() {
      return [...providerRegistrations.values()]
        .filter((entry) => !entry.disposed)
        .map((entry) => entry.declaration);
    },
    get agentConfigurationProvider() {
      return agentConfigurationProvider;
    },
    get instructionProvider() {
      return instructionProvider;
    },
    mentionProviders,
    activate() {
      if (activated) return;
      assertLive();
      replaceDeclaredSharedPorts(
        [...pendingSharedPorts].map(([hostId, ports]) => ({ hostId, ports })),
      );
      // Flush staged provider registrations into the live registry. On
      // reload the previous instance was disposed before this runs, so
      // re-declared ids are free again.
      for (const entry of providerRegistrations.values()) {
        if (!entry.disposed && entry.disposer === null) {
          entry.disposer = registerProvider(entry.declaration);
        }
      }
      activated = true;
      pendingSharedPorts.clear();
      for (const problem of pendingAgentToolProblems) {
        reportAgentToolProblem(problem);
      }
      pendingAgentToolProblems.length = 0;
      if (pendingNeedsConfiguration !== null) {
        reportNeedsConfiguration(pendingNeedsConfiguration);
        pendingNeedsConfiguration = null;
      }
    },
    invalidate() {
      invalidated = true;
    },
  };
}
