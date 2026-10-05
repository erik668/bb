import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { migrations, stockMigrations, type Db } from "./data.js";
import { migrateWorkflowStorage } from "./migration-compatibility.js";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];

function host() {
  const runtime = createFakePluginHost({ pluginId: "workflows" });
  hosts.push(runtime);
  return runtime;
}

function ledger(db: Db) {
  return db.prepare("SELECT * FROM _bb_migrations ORDER BY id").all();
}

function seedRunAndCall(db: Db): void {
  db.exec(`
    INSERT INTO workflow_runs (
      id, project_id, origin_thread_id, environment_id, origin_provider,
      origin_model, origin_reasoning_level, origin_permission_mode, name, source,
      source_hash, args_json, status, created_at, finished_at
    ) VALUES ('run', 'project', 'origin', 'environment', 'codex', 'model', 'high',
      'default', 'retained', 'return null', 'source-hash', '{}', 'succeeded', 1, 2);
    INSERT INTO workflow_calls (
      id, run_id, call_index, cache_key, prompt, options_json, resolved_provider,
      resolved_model, resolved_reasoning_level, resolved_permission_mode,
      status, child_thread_id, created_at, finished_at
    ) VALUES ('call', 'run', 0, 'cache', 'retained prompt', '{}', 'codex', 'model',
      'high', 'default', 'succeeded', 'child', 1, 2);
  `);
}

afterEach(async () => {
  await Promise.all(
    hosts.splice(0).map((runtime) => runtime.harness.dispose()),
  );
});

describe("workflow storage migration compatibility", () => {
  it("keeps exact fork SQL history and upgrades its retained records through stock worker migrations", () => {
    const { bb } = host();
    const db = bb.storage.database();
    const expectedForkHashes = [
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
      "dc422856846666b37e2709dedd2d7973cc095ed79580cbd2f87eaf0b54c95151",
      "945b003293b16141dbde72f445b2c75902283e07259d86dd84a3a64eea18c072",
      "bf1a3a285d2e1b69ee1b34a3b0bef85eb5c9d4f185acd931b56c79a38442ed97",
      "dc422856846666b37e2709dedd2d7973cc095ed79580cbd2f87eaf0b54c95151",
    ];
    const forkMigrations = migrations.slice(0, 18);
    expect(
      forkMigrations.map((sql) =>
        createHash("sha256").update(sql).digest("hex"),
      ),
    ).toEqual(expectedForkHashes);
    bb.storage.migrate(db, forkMigrations);
    seedRunAndCall(db);
    db.exec(`
      INSERT INTO workflow_checkpoints VALUES ('checkpoint', 'run', 'checkpoint-id', '{"retained":true}', 'phase', 'call', 0, 1, 1);
      INSERT INTO workflow_acceptance_approvals VALUES ('approval', 'campaign', 'checkpoint-id', '{"retained":true}', 'owner-thread', 'settings', 1);
      INSERT INTO workflow_artifact_blobs VALUES ('blob-hash', X'72657461696e6564', 8, 1);
      INSERT INTO workflow_artifacts VALUES ('artifact', 'campaign', 'project', 'environment', 'origin', 'run', 'requirements', 'Retained', 1, 1, 1);
      INSERT INTO workflow_artifact_revisions VALUES ('revision', 'artifact', 1, 'blob-hash', 'admitted', 'owner-thread', 1);
    `);
    const retainedTables = [
      "workflow_runs",
      "workflow_calls",
      "workflow_checkpoints",
      "workflow_acceptance_approvals",
      "workflow_artifact_blobs",
      "workflow_artifacts",
      "workflow_artifact_revisions",
    ];
    const before = retainedTables.map((table) =>
      db.prepare(`SELECT * FROM ${table}`).all(),
    );
    const beforeLedger = ledger(db);

    migrateWorkflowStorage(bb.storage, db);

    expect(
      retainedTables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
    ).toEqual(before);
    expect(ledger(db).slice(0, 18)).toEqual(beforeLedger);
    expect(
      db
        .prepare(
          "SELECT thread_id, run_id, call_id, origin_thread_id, cleanup_attempts FROM workflow_workers",
        )
        .all(),
    ).toEqual([
      {
        thread_id: "child",
        run_id: "run",
        call_id: "call",
        origin_thread_id: "origin",
        cleanup_attempts: 0,
      },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    const upgraded = ledger(db);
    migrateWorkflowStorage(bb.storage, db);
    expect(ledger(db)).toEqual(upgraded);
    expect(
      retainedTables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
    ).toEqual(before);
  });

  it.each([9, 10])(
    "adopts a stock installation with %i applied migrations without replaying worker SQL",
    (count) => {
      const { bb } = host();
      const db = bb.storage.database();
      bb.storage.migrate(db, stockMigrations.slice(0, 8));
      seedRunAndCall(db);
      bb.storage.migrate(db, stockMigrations.slice(0, count));
      db.prepare(
        "UPDATE workflow_workers SET archived_at = 5, next_cleanup_at = 6",
      ).run();
      if (count === 10)
        db.prepare("UPDATE workflow_workers SET cleanup_attempts = 7").run();
      const beforeWorkers = db
        .prepare(
          "SELECT thread_id, run_id, call_id, origin_thread_id, archived_at, next_cleanup_at FROM workflow_workers",
        )
        .all();
      const beforeLedger = db
        .prepare<
          [],
          { id: number; applied_at: number; statement_hash: string }
        >("SELECT * FROM _bb_migrations ORDER BY id")
        .all();

      migrateWorkflowStorage(bb.storage, db);

      expect(
        db
          .prepare(
            "SELECT thread_id, run_id, call_id, origin_thread_id, archived_at, next_cleanup_at FROM workflow_workers",
          )
          .all(),
      ).toEqual(beforeWorkers);
      expect(
        db.prepare("SELECT cleanup_attempts FROM workflow_workers").get(),
      ).toEqual({ cleanup_attempts: count === 10 ? 7 : 0 });
      expect(ledger(db).slice(0, 8)).toEqual(beforeLedger.slice(0, 8));
      expect(
        db
          .prepare(
            "SELECT original_id, adopted_id, applied_at, statement_hash FROM _bb_workflow_migration_lineage ORDER BY original_id",
          )
          .all(),
      ).toEqual(
        beforeLedger.slice(8).map((row) => ({
          original_id: row.id,
          adopted_id: row.id + 10,
          applied_at: row.applied_at,
          statement_hash: row.statement_hash,
        })),
      );
      expect(
        db
          .prepare(
            "SELECT id, applied_at, statement_hash FROM _bb_migrations WHERE id >= 18 ORDER BY id",
          )
          .all()
          .slice(0, count - 8),
      ).toEqual(
        beforeLedger.slice(8).map((row) => ({ ...row, id: row.id + 10 })),
      );
      const upgraded = ledger(db);
      migrateWorkflowStorage(bb.storage, db);
      expect(ledger(db)).toEqual(upgraded);
    },
  );

  it.each(["unknown", null])(
    "rejects an unrecognized divergent stock hash %s without changing history",
    (hash) => {
      const { bb } = host();
      const db = bb.storage.database();
      bb.storage.migrate(db, stockMigrations);
      db.prepare(
        "UPDATE _bb_migrations SET statement_hash = ? WHERE id = 8",
      ).run(hash);
      const before = ledger(db);
      expect(() => migrateWorkflowStorage(bb.storage, db)).toThrow(
        "lineage is unknown",
      );
      expect(ledger(db)).toEqual(before);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = '_bb_workflow_migration_lineage'",
          )
          .get(),
      ).toBeUndefined();
    },
  );

  it("rejects a mixed stock/fork history before moving either stock row", () => {
    const { bb } = host();
    const db = bb.storage.database();
    bb.storage.migrate(db, stockMigrations);
    db.prepare(
      "UPDATE _bb_migrations SET statement_hash = 'unknown' WHERE id = 9",
    ).run();
    const before = ledger(db);
    expect(() => migrateWorkflowStorage(bb.storage, db)).toThrow(
      "Unrecognized stock workflow migration 9",
    );
    expect(ledger(db)).toEqual(before);
  });

  it("refuses divergent legacy history whose ledger has no statement hashes", () => {
    const { bb } = host();
    const db = bb.storage.database();
    bb.storage.migrate(db, stockMigrations);
    db.exec("ALTER TABLE _bb_migrations DROP COLUMN statement_hash");
    const before = ledger(db);
    expect(() => migrateWorkflowStorage(bb.storage, db)).toThrow(
      "lineage is unknown",
    );
    expect(ledger(db)).toEqual(before);
    expect(db.prepare("PRAGMA table_info(_bb_migrations)").all()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "statement_hash" }),
      ]),
    );
  });

  it("rolls stock adoption and schema changes back if an appended historical migration fails", () => {
    const { bb } = host();
    const db = bb.storage.database();
    bb.storage.migrate(db, stockMigrations);
    db.exec("CREATE TABLE workflow_checkpoints (id TEXT PRIMARY KEY)");
    const beforeLedger = ledger(db);
    const beforeCalls = db.prepare("PRAGMA table_info(workflow_calls)").all();
    expect(() => migrateWorkflowStorage(bb.storage, db)).toThrow();
    expect(ledger(db)).toEqual(beforeLedger);
    expect(db.prepare("PRAGMA table_info(workflow_calls)").all()).toEqual(
      beforeCalls,
    );
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = '_bb_workflow_migration_lineage'",
        )
        .get(),
    ).toBeUndefined();
  });
});
