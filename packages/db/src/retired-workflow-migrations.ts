import type { DbConnection } from "./connection.js";

const retiredWorkflowMigrationIdentities = [
  {
    createdAt: 1788754889832,
    hash: "12fc3337869416d5893b76cc0d3cc2f80659ca7f0d3f464b0aa4278c248a4b04",
  },
  {
    createdAt: 1788755551148,
    hash: "eca37b28bedc2649770bd34f7a1ae44d3e88e0800df8210c68dc7e6b58b603ef",
  },
  {
    createdAt: 1788756975692,
    hash: "60eff5586bba692d548d889d48a7dd8134cd7883e37669fea987e107de89155c",
  },
] as const;

interface RetiredMigrationRow {
  ledgerRowid: number;
  id: number | null;
  createdAt: number;
  hash: string;
}

export function archiveRetiredWorkflowMigrations(db: DbConnection): void {
  const sqlite = db.$client;
  const ledger = sqlite
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
    )
    .get();
  if (ledger === undefined) return;

  sqlite.transaction(() => {
    const rows = sqlite
      .prepare<number[], RetiredMigrationRow>(
        "SELECT rowid AS ledgerRowid, id, hash, created_at AS createdAt FROM __drizzle_migrations WHERE created_at IN (?, ?, ?) ORDER BY created_at, rowid",
      )
      .all(
        ...retiredWorkflowMigrationIdentities.map(
          (identity) => identity.createdAt,
        ),
      );
    if (rows.length === 0) return;
    for (const row of rows) {
      if (
        !retiredWorkflowMigrationIdentities.some(
          (identity) =>
            identity.createdAt === row.createdAt && identity.hash === row.hash,
        )
      ) {
        throw new Error(
          `Unrecognized retired workflow migration at ${row.createdAt}; migration history was not changed`,
        );
      }
    }

    sqlite.exec(`CREATE TABLE IF NOT EXISTS __bb_retired_workflow_migrations (
      ledger_rowid INTEGER PRIMARY KEY,
      id INTEGER,
      hash TEXT NOT NULL,
      created_at NUMERIC NOT NULL,
      archived_at INTEGER NOT NULL
    )`);
    const archive = sqlite.prepare<
      [number, number | null, string, number, number]
    >(
      "INSERT INTO __bb_retired_workflow_migrations (ledger_rowid, id, hash, created_at, archived_at) VALUES (?, ?, ?, ?, ?)",
    );
    const remove = sqlite.prepare<[number, string, number]>(
      "DELETE FROM __drizzle_migrations WHERE rowid = ? AND hash = ? AND created_at = ?",
    );
    const archivedAt = Date.now();
    for (const row of rows) {
      archive.run(row.ledgerRowid, row.id, row.hash, row.createdAt, archivedAt);
      if (remove.run(row.ledgerRowid, row.hash, row.createdAt).changes !== 1) {
        throw new Error(
          `Retired workflow migration ${row.ledgerRowid} changed during archival`,
        );
      }
    }
  })();
}
