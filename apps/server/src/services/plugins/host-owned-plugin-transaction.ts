import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  createHostTransactionPhaseController,
  type HostTransactionPhaseController,
} from "./host-transaction-phase-controller.js";
import { getPluginMigrationAuthority } from "./plugin-migration-authority-registry.js";

interface HostOwnedPluginTransactionInput {
  readonly body: (database: Database.Database) => void;
  readonly dataDir: string;
  readonly hostPluginId: string;
  readonly phaseController?: HostTransactionPhaseController;
}

const ALLOWED_INPUT_KEYS = new Set([
  "body",
  "dataDir",
  "hostPluginId",
  "phaseController",
]);

function assertPlainInput(
  value: unknown,
): asserts value is HostOwnedPluginTransactionInput {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("F1_HOST_TRANSACTION_INPUT_SUBSTITUTION");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !ALLOWED_INPUT_KEYS.has(key))) {
    throw new Error("F1_HOST_TRANSACTION_INPUT_SUBSTITUTION");
  }
  if (
    typeof input.body !== "function" ||
    typeof input.dataDir !== "string" ||
    typeof input.hostPluginId !== "string" ||
    (input.phaseController !== undefined &&
      typeof input.phaseController !== "function")
  ) {
    throw new Error("F1_HOST_TRANSACTION_INPUT_SUBSTITUTION");
  }
}

function assertRealDirectory(path: string): void {
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("F1_HOST_DATABASE_PATH_SUBSTITUTION");
  }
}

function resolveHostDatabasePath(
  dataDir: string,
  hostPluginId: string,
): string {
  if (!isAbsolute(dataDir) || resolve(dataDir) !== dataDir) {
    throw new Error("F1_HOST_DATABASE_PATH_SUBSTITUTION");
  }
  assertRealDirectory(dataDir);
  const pluginsDir = join(dataDir, "plugins");
  const pluginDir = join(pluginsDir, hostPluginId);
  mkdirSync(pluginDir, { recursive: true });
  assertRealDirectory(pluginsDir);
  assertRealDirectory(pluginDir);
  if (
    realpathSync.native(pluginDir) !==
    join(realpathSync.native(dataDir), "plugins", hostPluginId)
  ) {
    throw new Error("F1_HOST_DATABASE_PATH_SUBSTITUTION");
  }
  const databasePath = join(pluginDir, "data.db");
  if (existsSync(databasePath) && lstatSync(databasePath).isSymbolicLink()) {
    throw new Error("F1_HOST_DATABASE_PATH_SUBSTITUTION");
  }
  return databasePath;
}

function configureWriter(database: Database.Database): void {
  if (
    !database.open ||
    database.memory ||
    database.readonly ||
    database.inTransaction
  ) {
    throw new Error("F1_HOST_DATABASE_WRITER_SUBSTITUTION");
  }
  const journalMode = database.pragma("journal_mode = WAL", { simple: true });
  database.pragma("synchronous = FULL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  if (
    journalMode !== "wal" ||
    database.pragma("synchronous", { simple: true }) !== 2 ||
    database.pragma("foreign_keys", { simple: true }) !== 1 ||
    Number(database.pragma("busy_timeout", { simple: true })) < 5_000
  ) {
    throw new Error("F1_HOST_DATABASE_PRAGMA_MISMATCH");
  }
}

function executeMigrations(
  database: Database.Database,
  authority: ReturnType<typeof getPluginMigrationAuthority>,
): void {
  database.exec(
    "CREATE TABLE IF NOT EXISTS _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const appliedIds = database
    .prepare("SELECT id FROM _bb_migrations ORDER BY id ASC")
    .pluck()
    .all() as number[];
  if (appliedIds.some((id, index) => id !== index)) {
    throw new Error("F1_HOST_MIGRATION_HISTORY_SUBSTITUTION");
  }
  if (appliedIds.length > authority.migrations.length) {
    throw new Error("F1_HOST_MIGRATION_HISTORY_SUBSTITUTION");
  }
  const record = database.prepare(
    "INSERT INTO _bb_migrations(id, applied_at) VALUES (?, ?)",
  );
  for (let id = appliedIds.length; id < authority.migrations.length; id += 1) {
    const migration = authority.migrations[id];
    if (migration === undefined || migration.id !== id) {
      throw new Error("F1_HOST_MIGRATION_AUTHORITY_SUBSTITUTION");
    }
    database.exec(migration.statementUtf8);
    record.run(migration.id, Date.now());
  }
}

function verifyReadonlyReopen(databasePath: string): void {
  const reader = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  reader.close();
}

/**
 * Runs the host registry migrations and one server-authored body in one native
 * BEGIN IMMEDIATE transaction. This module is intentionally not re-exported.
 */
export function runHostOwnedPluginTransaction(input: unknown): void {
  assertPlainInput(input);
  const authority = getPluginMigrationAuthority(input.hostPluginId);
  const databasePath = resolveHostDatabasePath(
    input.dataDir,
    input.hostPluginId,
  );
  const signalPhase =
    input.phaseController ?? createHostTransactionPhaseController();
  const writer = new Database(databasePath);
  try {
    configureWriter(writer);
    const execute = writer.transaction(() => {
      executeMigrations(writer, authority);
      input.body(writer);
      signalPhase("pre-commit");
    });
    execute.immediate();
    signalPhase("post-commit-pre-close");
  } finally {
    if (writer.open) writer.close();
  }
  verifyReadonlyReopen(databasePath);
}
