import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  LEGACY_UNKNOWN_MIGRATION_HASH,
  runPluginMigrations,
} from "../internal/migration-ledger.js";

/** A ledger holding a row at index 2 whose originating statement is unknown. */
function reservedLedgerDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE items (id INTEGER PRIMARY KEY); CREATE TABLE _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); INSERT INTO _bb_migrations VALUES (0, 1), (2, 1)",
  );
  runPluginMigrations(db, ["CREATE TABLE items (id INTEGER PRIMARY KEY)"]);
  return db;
}

function ledgerRows(db: Database.Database) {
  return db
    .prepare("SELECT id, statement_hash FROM _bb_migrations ORDER BY id")
    .all();
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) !== undefined
  );
}

describe("runPluginMigrations", () => {
  it("reserves an unidentified legacy index when no probe can release it", () => {
    const db = reservedLedgerDatabase();
    expect(ledgerRows(db)).toEqual([
      { id: 0, statement_hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { id: 2, statement_hash: LEGACY_UNKNOWN_MIGRATION_HASH },
    ]);

    expect(() =>
      runPluginMigrations(db, [
        "CREATE TABLE items (id INTEGER PRIMARY KEY)",
        "SELECT 1",
        "CREATE TABLE ghost (id INTEGER PRIMARY KEY)",
      ]),
    ).toThrow(/migration 2 is reserved by an unidentified legacy migration/);
    expect(tableExists(db, "ghost")).toBe(false);
  });

  it("adopts a reserved index when the probe proves the effect is present", () => {
    const db = reservedLedgerDatabase();
    runPluginMigrations(db, [
      "CREATE TABLE items (id INTEGER PRIMARY KEY)",
      "SELECT 1",
      {
        statement: "CREATE TABLE ghost (id INTEGER PRIMARY KEY)",
        adoptIfApplied: () => true,
      },
    ]);

    // The row is adopted, and the statement it names never runs — the probe
    // asserted the schema is already there.
    expect(ledgerRows(db)).toEqual([
      { id: 0, statement_hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { id: 1, statement_hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { id: 2, statement_hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
    expect(tableExists(db, "ghost")).toBe(false);
  });

  it("keeps reserving the index when the probe returns false", () => {
    const db = reservedLedgerDatabase();
    expect(() =>
      runPluginMigrations(db, [
        "CREATE TABLE items (id INTEGER PRIMARY KEY)",
        "SELECT 1",
        { statement: "SELECT 2", adoptIfApplied: () => false },
      ]),
    ).toThrow(/migration 2 is reserved by an unidentified legacy migration/);
    expect(ledgerRows(db)).toEqual([
      { id: 0, statement_hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { id: 2, statement_hash: LEGACY_UNKNOWN_MIGRATION_HASH },
    ]);
  });

  it("keeps reserving the index when the probe throws, preserving the cause", () => {
    const db = reservedLedgerDatabase();
    const probeFailure = new Error("no such column: missing");
    let thrown: unknown;
    try {
      runPluginMigrations(db, [
        "CREATE TABLE items (id INTEGER PRIMARY KEY)",
        "SELECT 1",
        {
          statement: "SELECT 2",
          adoptIfApplied: () => {
            throw probeFailure;
          },
        },
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(
      /migration 2 is reserved by an unidentified legacy migration/,
    );
    expect((thrown as Error).cause).toBe(probeFailure);
  });

  it("rejects a genuinely reused index even when a probe would allow it", () => {
    const db = new Database(":memory:");
    runPluginMigrations(db, ["CREATE TABLE items (id INTEGER PRIMARY KEY)"]);

    // A recorded real hash is evidence, not an unknown — a probe must not be
    // able to talk the host out of it.
    expect(() =>
      runPluginMigrations(db, [
        {
          statement: "CREATE TABLE replacements (id INTEGER PRIMARY KEY)",
          adoptIfApplied: () => true,
        },
      ]),
    ).toThrow(/migration 0 does not match the recorded statement/);
  });

  it("does not consult a probe when the recorded hash already matches", () => {
    const db = new Database(":memory:");
    let probeCalls = 0;
    const migration = {
      statement: "CREATE TABLE items (id INTEGER PRIMARY KEY)",
      adoptIfApplied: () => {
        probeCalls += 1;
        return true;
      },
    };
    runPluginMigrations(db, [migration]);
    expect(probeCalls).toBe(0);
    runPluginMigrations(db, [migration]);
    expect(probeCalls).toBe(0);
  });

  it("is idempotent after an adoption", () => {
    const db = reservedLedgerDatabase();
    const migrations = [
      "CREATE TABLE items (id INTEGER PRIMARY KEY)",
      "SELECT 1",
      { statement: "SELECT 2", adoptIfApplied: () => true },
    ];
    runPluginMigrations(db, migrations);
    const afterAdoption = ledgerRows(db);
    runPluginMigrations(db, migrations);
    expect(ledgerRows(db)).toEqual(afterAdoption);
  });
});
