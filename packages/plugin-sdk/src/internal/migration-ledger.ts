import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Written into `_bb_migrations.statement_hash` when a ledger row exists at an
 * index the running build declares no statement for: the row proves something
 * was applied there, but not what. Reserved rather than left empty so a later
 * statement cannot silently claim the index and skip its own schema change.
 */
export const LEGACY_UNKNOWN_MIGRATION_HASH = "legacy-unknown";

/**
 * A migration statement, or a statement paired with a probe that can release a
 * reserved legacy index. The bare string is the common form; reach for the
 * object only when a database in the wild may already hold an unidentified
 * ledger row at this index.
 */
export type PluginMigration =
  | string
  | {
      statement: string;
      /**
       * Proves this migration's effect is ALREADY present in the database, so a
       * reserved legacy row at this index can be adopted instead of bricking
       * the plugin. Only consulted when the recorded hash is the legacy
       * sentinel, and the statement is not executed when it returns true.
       * Must be read-only.
       */
      adoptIfApplied?: (db: Database.Database) => boolean;
    };

export function migrationStatementHash(statement: string): string {
  return createHash("sha256").update(statement).digest("hex");
}

function migrationStatement(migration: PluginMigration): string {
  return typeof migration === "string" ? migration : migration.statement;
}

function migrationAdoptProbe(
  migration: PluginMigration | undefined,
): ((db: Database.Database) => boolean) | undefined {
  if (migration === undefined || typeof migration === "string")
    return undefined;
  return migration.adoptIfApplied;
}

function reservedLegacyIndexError(index: number, cause?: unknown): Error {
  const message =
    `migration ${index} is reserved by an unidentified legacy migration: this database ` +
    `already records a migration at index ${index} but not which statement produced it, ` +
    `so applying this one could skip a schema change it never ran. Declare ` +
    `adoptIfApplied on migration ${index} to prove its effect is already present.`;
  return cause === undefined
    ? new Error(message)
    : new Error(message, { cause });
}

/**
 * The one implementation of the `_bb_migrations` ledger, shared by the real
 * host and the fake plugin host so the two cannot drift.
 *
 * Statement index = migration id. A hash per row rejects a changed or reused
 * index; a row whose statement is unknown to this build is reserved, and only
 * an `adoptIfApplied` probe can release it.
 */
export function runPluginMigrations(
  database: Database.Database,
  migrations: readonly PluginMigration[],
): void {
  database.exec(
    "CREATE TABLE IF NOT EXISTS _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, statement_hash TEXT)",
  );
  const migrationColumns = database
    .prepare<[], { name: string }>("PRAGMA table_info(_bb_migrations)")
    .all();
  if (!migrationColumns.some((column) => column.name === "statement_hash")) {
    database.exec("ALTER TABLE _bb_migrations ADD COLUMN statement_hash TEXT");
  }
  const rows = database
    .prepare<[], { id: number; statement_hash: string | null }>(
      "SELECT id, statement_hash FROM _bb_migrations ORDER BY id",
    )
    .all();
  const applied = new Map<number, string | null>();
  for (const row of rows) applied.set(row.id, row.statement_hash);
  const statements = migrations.map(migrationStatement);
  const statementHashes = statements.map(migrationStatementHash);

  // Probes run here, before the write transaction, so they observe
  // pre-migration state and a rejection costs no writes.
  const legacyAdoptions = new Map<number, string>();
  statementHashes.forEach((statementHash, index) => {
    const recordedHash = applied.get(index);
    if (recordedHash === undefined || recordedHash === null) return;
    if (recordedHash === statementHash) return;
    if (recordedHash !== LEGACY_UNKNOWN_MIGRATION_HASH) {
      throw new Error(
        `migration ${index} does not match the recorded statement; append a new migration instead of changing or reusing an index`,
      );
    }
    const probe = migrationAdoptProbe(migrations[index]);
    if (!probe) throw reservedLegacyIndexError(index);
    let proven: boolean;
    try {
      proven = probe(database);
    } catch (error) {
      throw reservedLegacyIndexError(index, error);
    }
    if (!proven) throw reservedLegacyIndexError(index);
    legacyAdoptions.set(index, statementHash);
  });

  const adopt = database.prepare(
    "UPDATE _bb_migrations SET statement_hash = ? WHERE id = ? AND statement_hash IS NULL",
  );
  const adoptReserved = database.prepare(
    "UPDATE _bb_migrations SET statement_hash = ? WHERE id = ? AND statement_hash = ?",
  );
  const record = database.prepare(
    "INSERT INTO _bb_migrations (id, applied_at, statement_hash) VALUES (?, ?, ?)",
  );
  database.transaction(() => {
    for (const row of rows) {
      if (row.statement_hash !== null) continue;
      adopt.run(
        statementHashes[row.id] ?? LEGACY_UNKNOWN_MIGRATION_HASH,
        row.id,
      );
    }
    for (const [index, statementHash] of legacyAdoptions) {
      adoptReserved.run(statementHash, index, LEGACY_UNKNOWN_MIGRATION_HASH);
    }
    statements.forEach((statement, index) => {
      // A probe-adopted index is already in `applied`, so its statement is
      // recorded as run without being executed — the probe just proved it.
      if (applied.has(index)) return;
      database.exec(statement);
      record.run(index, Date.now(), statementHashes[index]);
    });
  })();
}
