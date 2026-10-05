import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { createConnection, migrate, type DbConnection } from "../src/index.js";
import { archiveRetiredWorkflowMigrations } from "../src/retired-workflow-migrations.js";

const retired = [
  { tag: "0113_workflow_supervision_v33", when: 1788754889832 },
  { tag: "0114_supervisor_notice_replay_v33", when: 1788755551148 },
  { tag: "0115_supervisor_binding_retention_v33", when: 1788756975692 },
];
const stableMigrations = readMigrationFiles({
  migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
});
const connections: DbConnection[] = [];

function connection(): DbConnection {
  const db = createConnection(":memory:");
  connections.push(db);
  return db;
}

function ledger(db: DbConnection): void {
  db.$client.exec(
    "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)",
  );
}

function recordRetired(db: DbConnection, index: number, hash?: string): void {
  const identity = retired[index];
  const sql = readFileSync(
    new URL(`./fixtures/retired-workflow/${identity.tag}.sql`, import.meta.url),
  );
  db.$client
    .prepare(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
    )
    .run(hash ?? createHash("sha256").update(sql).digest("hex"), identity.when);
}

function legacyFork(): DbConnection {
  const db = connection();
  ledger(db);
  db.$client.pragma("foreign_keys = OFF");
  for (const migration of stableMigrations.filter(
    (migration) => migration.folderMillis <= 1788280102293,
  )) {
    for (const sql of migration.sql) db.$client.exec(sql);
    db.$client
      .prepare(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      )
      .run(migration.hash, migration.folderMillis);
  }
  for (const [index, identity] of retired.entries()) {
    const sql = readFileSync(
      new URL(
        `./fixtures/retired-workflow/${identity.tag}.sql`,
        import.meta.url,
      ),
      "utf8",
    );
    db.$client.exec(sql);
    recordRetired(db, index);
  }
  db.$client.exec(`
    INSERT INTO projects (id, name, created_at, updated_at) VALUES ('project', 'Retained', 1, 1);
    INSERT INTO threads (id, project_id, provider_id, latest_attention_at, created_at, updated_at)
      VALUES ('manager', 'project', 'codex', 1, 1, 1), ('child', 'project', 'codex', 1, 1, 1);
    INSERT INTO thread_supervisors VALUES ('supervisor', 'manager', 'campaign', 'inbox', 'token-hash', 1);
    INSERT INTO thread_source_pins VALUES ('child', '{"source":"retained"}', 1);
    INSERT INTO thread_supervisor_bindings VALUES ('child', 'supervisor', 'task', 1);
    INSERT INTO thread_supervisor_inbox VALUES ('notice', 'supervisor', 'child', 'task', 'turn', 'completion', 'retained output', 'queued', 1);
  `);
  return db;
}

afterEach(() => {
  for (const db of connections.splice(0)) db.$client.close();
});

describe("retired workflow core migration compatibility", () => {
  it("upgrades the fork through every stock migration while retaining all custom rows", () => {
    const db = legacyFork();
    const tables = [
      "thread_supervisors",
      "thread_source_pins",
      "thread_supervisor_bindings",
      "thread_supervisor_inbox",
    ];
    const before = tables.map((table) =>
      db.$client.prepare(`SELECT * FROM ${table}`).all(),
    );
    const forkLedger = db.$client
      .prepare(
        "SELECT rowid AS ledger_rowid, id, hash, created_at FROM __drizzle_migrations WHERE created_at > 1788280102293 ORDER BY created_at",
      )
      .all();

    migrate(db);

    expect(
      tables.map((table) => db.$client.prepare(`SELECT * FROM ${table}`).all()),
    ).toEqual(before);
    expect(
      db.$client
        .prepare(
          "SELECT ledger_rowid, id, hash, created_at FROM __bb_retired_workflow_migrations ORDER BY created_at",
        )
        .all(),
    ).toEqual(forkLedger);
    const applied = db.$client
      .prepare<[], { hash: string; created_at: number }>(
        "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at",
      )
      .all();
    expect(applied).toEqual(
      stableMigrations.map((migration) => ({
        hash: migration.hash,
        created_at: migration.folderMillis,
      })),
    );
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
    migrate(db);
    expect(
      tables.map((table) => db.$client.prepare(`SELECT * FROM ${table}`).all()),
    ).toEqual(before);
    expect(
      db.$client
        .prepare(
          "SELECT COUNT(*) AS count FROM __bb_retired_workflow_migrations",
        )
        .get(),
    ).toEqual({ count: 3 });
  });

  it("leaves an ordinary stock installation and its ledger unchanged", () => {
    const db = connection();
    migrate(db);
    const before = db.$client
      .prepare("SELECT rowid, * FROM __drizzle_migrations ORDER BY rowid")
      .all();
    migrate(db);
    expect(
      db.$client
        .prepare("SELECT rowid, * FROM __drizzle_migrations ORDER BY rowid")
        .all(),
    ).toEqual(before);
    expect(
      db.$client
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = '__bb_retired_workflow_migrations'",
        )
        .get(),
    ).toBeUndefined();
  });

  it("refuses a known timestamp with unknown bytes before archiving any row", () => {
    const db = connection();
    ledger(db);
    recordRetired(db, 0);
    recordRetired(db, 1, "unrecognized");
    const before = db.$client
      .prepare("SELECT rowid, * FROM __drizzle_migrations")
      .all();
    expect(() => archiveRetiredWorkflowMigrations(db)).toThrow(
      "Unrecognized retired workflow migration",
    );
    expect(
      db.$client.prepare("SELECT rowid, * FROM __drizzle_migrations").all(),
    ).toEqual(before);
    expect(
      db.$client
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = '__bb_retired_workflow_migrations'",
        )
        .get(),
    ).toBeUndefined();
  });

  it("archives a partial known fork history while leaving a matching hash at another timestamp untouched", () => {
    const db = connection();
    ledger(db);
    recordRetired(db, 0);
    const known = db.$client
      .prepare<[], { hash: string }>("SELECT hash FROM __drizzle_migrations")
      .get();
    if (known === undefined) throw new Error("Missing fixture migration");
    db.$client
      .prepare(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      )
      .run(known.hash, retired[0].when + 1);
    const unrelated = db.$client
      .prepare("SELECT rowid, * FROM __drizzle_migrations WHERE created_at = ?")
      .get(retired[0].when + 1);
    archiveRetiredWorkflowMigrations(db);
    expect(
      db.$client.prepare("SELECT rowid, * FROM __drizzle_migrations").all(),
    ).toEqual([unrelated]);
    expect(
      db.$client
        .prepare(
          "SELECT COUNT(*) AS count FROM __bb_retired_workflow_migrations",
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("rolls back every ledger move when archival fails after the first row", () => {
    const db = connection();
    ledger(db);
    recordRetired(db, 0);
    recordRetired(db, 1);
    db.$client.exec(`
      CREATE TABLE __bb_retired_workflow_migrations (ledger_rowid INTEGER PRIMARY KEY, id INTEGER, hash TEXT NOT NULL, created_at NUMERIC NOT NULL, archived_at INTEGER NOT NULL);
      CREATE TRIGGER reject_second_archive BEFORE INSERT ON __bb_retired_workflow_migrations
        WHEN new.created_at = 1788755551148 BEGIN SELECT RAISE(ABORT, 'fixture archival failure'); END;
    `);
    const before = db.$client
      .prepare("SELECT rowid, * FROM __drizzle_migrations")
      .all();
    expect(() => archiveRetiredWorkflowMigrations(db)).toThrow(
      "fixture archival failure",
    );
    expect(
      db.$client.prepare("SELECT rowid, * FROM __drizzle_migrations").all(),
    ).toEqual(before);
    expect(
      db.$client
        .prepare("SELECT * FROM __bb_retired_workflow_migrations")
        .all(),
    ).toEqual([]);
  });
});
