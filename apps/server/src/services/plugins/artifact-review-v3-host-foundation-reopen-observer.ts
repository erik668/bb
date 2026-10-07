import Database from "better-sqlite3";

export interface HostFoundationReopenObservation {
  readonly journalMode: string;
  readonly migrationIds: readonly number[];
  readonly sentinel:
    | null
    | {
        readonly foreignKeys: number;
        readonly journalMode: string;
        readonly marker: string;
        readonly synchronousLevel: number;
      };
  readonly tables: readonly string[];
}

/**
 * First F1 observer. It performs a new readonly/fileMustExist open and walks
 * sqlite_schema before reading either host-owned relation. It deliberately
 * does not import the registry, transaction owner, child, or other observer.
 */
export function observeHostFoundationDatabase(
  databasePath: string,
): HostFoundationReopenObservation {
  const reader = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const journalMode = String(reader.pragma("journal_mode", { simple: true }));
    const tables = reader
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name ASC`,
      )
      .pluck()
      .all() as string[];
    const migrationIds = tables.includes("_bb_migrations")
      ? (reader
          .prepare("SELECT id FROM _bb_migrations ORDER BY id ASC")
          .pluck()
          .all() as number[])
      : [];
    const sentinel = tables.includes("_bb_f1_host_transaction_sentinel")
      ? (reader
          .prepare(
            `SELECT marker,
                    journal_mode AS journalMode,
                    synchronous_level AS synchronousLevel,
                    foreign_keys AS foreignKeys
               FROM _bb_f1_host_transaction_sentinel
              WHERE marker = 'complete'`,
          )
          .get() as HostFoundationReopenObservation["sentinel"])
      : null;
    return { journalMode, migrationIds, sentinel, tables };
  } finally {
    reader.close();
  }
}
