import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { migrations, stockMigrations, type Db } from "./data.js";

interface MigrationRow {
  id: number;
  appliedAt: number;
  hash: string | null;
}

const stockMigrationIdentities = [
  {
    id: 8,
    adoptedId: 18,
    hash: "d65e699006bf110e5bac4d680270d701f17508bce413899987d8275e7a40d813",
  },
  {
    id: 9,
    adoptedId: 19,
    hash: "ccdc406c9146c6e599f0e32714b505a342a6d2782fa172cf543cec1e06e6ba6f",
  },
] as const;

function hashStatement(statement: string): string {
  return createHash("sha256").update(statement).digest("hex");
}

function adoptStockWorkflowMigrationHistory(db: Db): void {
  const ledger = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_bb_migrations'",
    )
    .get();
  if (ledger === undefined) return;
  const columns = db
    .prepare<[], { name: string }>("PRAGMA table_info(_bb_migrations)")
    .all();
  if (!columns.some((column) => column.name === "statement_hash")) {
    const divergentRow = db
      .prepare("SELECT 1 FROM _bb_migrations WHERE id >= 8 LIMIT 1")
      .get();
    if (divergentRow !== undefined)
      throw new Error(
        "Workflow migration lineage is unknown at index 8; history was not changed",
      );
    return;
  }
  const rows = db
    .prepare<[], MigrationRow>(
      "SELECT id, applied_at AS appliedAt, statement_hash AS hash FROM _bb_migrations ORDER BY id",
    )
    .all();
  const divergent = rows.find((row) => row.id === 8);
  if (divergent === undefined) return;
  if (divergent.hash === hashStatement(migrations[8])) return;
  if (divergent.hash !== stockMigrationIdentities[0].hash) {
    throw new Error(
      "Workflow migration lineage is unknown at index 8; history was not changed",
    );
  }
  for (const row of rows) {
    const expected =
      row.id < 8
        ? stockMigrations[row.id]
        : stockMigrationIdentities.find((identity) => identity.id === row.id)
            ?.hash;
    const expectedHash =
      row.id < 8 && expected !== undefined ? hashStatement(expected) : expected;
    if (expectedHash === undefined || row.hash !== expectedHash) {
      throw new Error(
        `Unrecognized stock workflow migration ${row.id}; history was not changed`,
      );
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS _bb_workflow_migration_lineage (
    original_id INTEGER PRIMARY KEY,
    adopted_id INTEGER NOT NULL UNIQUE,
    applied_at INTEGER NOT NULL,
    statement_hash TEXT NOT NULL,
    adopted_at INTEGER NOT NULL
  )`);
  const archive = db.prepare<[number, number, number, string, number]>(
    "INSERT INTO _bb_workflow_migration_lineage (original_id, adopted_id, applied_at, statement_hash, adopted_at) VALUES (?, ?, ?, ?, ?)",
  );
  const move = db.prepare<[number, number, string]>(
    "UPDATE _bb_migrations SET id = ? WHERE id = ? AND statement_hash = ?",
  );
  for (const identity of stockMigrationIdentities) {
    const row = rows.find((candidate) => candidate.id === identity.id);
    if (row === undefined) continue;
    if (hashStatement(migrations[identity.adoptedId]) !== identity.hash) {
      throw new Error(
        `Appended stock workflow migration ${identity.adoptedId} changed`,
      );
    }
    archive.run(
      row.id,
      identity.adoptedId,
      row.appliedAt,
      identity.hash,
      Date.now(),
    );
    if (move.run(identity.adoptedId, row.id, identity.hash).changes !== 1) {
      throw new Error(
        `Stock workflow migration ${row.id} changed during adoption`,
      );
    }
  }
}

export function migrateWorkflowStorage(
  storage: Pick<BbPluginApi["storage"], "migrate">,
  db: Db,
): void {
  db.transaction(() => {
    adoptStockWorkflowMigrationHistory(db);
    storage.migrate(db, migrations);
  })();
}
