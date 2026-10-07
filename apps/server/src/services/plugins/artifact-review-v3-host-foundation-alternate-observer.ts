import Database from "better-sqlite3";

export interface AlternateHostFoundationObservation {
  readonly descendingMigrationEncoding: string;
  readonly durableMode: string;
  readonly sentinelHex: readonly string[];
  readonly userTableCount: number;
}

/**
 * Second F1 observer. It uses PRAGMA table_list, descending scalar encoding,
 * and raw hexadecimal sentinel values. It shares no canonicalizer, relation
 * catalog, expected projection, or open connection with the first observer.
 */
export function inspectHostFoundationBytes(
  databasePath: string,
): AlternateHostFoundationObservation {
  const reader = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const tableNames = (
      reader.prepare("PRAGMA table_list").all() as Array<{
        name: string;
        schema: string;
        type: string;
      }>
    )
      .filter(
        (row) =>
          row.schema === "main" &&
          row.type === "table" &&
          !row.name.startsWith("sqlite_"),
      )
      .map((row) => row.name);
    const migrationRows = tableNames.includes("_bb_migrations")
      ? (reader
          .prepare("SELECT printf('%d', id) AS encoded FROM _bb_migrations ORDER BY id DESC")
          .pluck()
          .all() as string[])
      : [];
    const sentinelHex = tableNames.includes(
      "_bb_f1_host_transaction_sentinel",
    )
      ? (reader
          .prepare(
            `SELECT hex(CAST(marker AS BLOB)) || ':' ||
                    hex(CAST(journal_mode AS BLOB)) || ':' ||
                    printf('%02X', synchronous_level) || ':' ||
                    printf('%02X', foreign_keys)
               FROM _bb_f1_host_transaction_sentinel
              ORDER BY rowid DESC`,
          )
          .pluck()
          .all() as string[])
      : [];
    return {
      descendingMigrationEncoding: migrationRows.join("|"),
      durableMode: String(reader.pragma("journal_mode", { simple: true })),
      sentinelHex,
      userTableCount: tableNames.length,
    };
  } finally {
    reader.close();
  }
}
