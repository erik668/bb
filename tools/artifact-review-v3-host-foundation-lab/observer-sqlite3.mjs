import { spawnSync } from "node:child_process";

const [databasePath] = process.argv.slice(2);
if (!databasePath) process.exit(64);

const query = (sql, mode = "-list") => {
  const result = spawnSync("/usr/bin/sqlite3", ["-readonly", mode, databasePath, sql], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 70);
  }
  return result.stdout.trim();
};

const tablePresent =
  query("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'lab_effects'") === "1";
const rowsText = tablePresent
  ? query("SELECT id, value FROM lab_effects ORDER BY id", "-json")
  : "";
const rows = rowsText ? JSON.parse(rowsText) : [];

process.stdout.write(
  JSON.stringify({
    tablePresent,
    rowCount: rows.length,
    rows,
  }),
);
