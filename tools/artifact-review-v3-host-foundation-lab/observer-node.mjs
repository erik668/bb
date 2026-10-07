import { DatabaseSync } from "node:sqlite";

const [databasePath] = process.argv.slice(2);
if (!databasePath) process.exit(64);

const database = new DatabaseSync(databasePath, { readOnly: true });
const tablePresent =
  database
    .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'lab_effects'")
    .get().count === 1;
const rows = tablePresent
  ? database.prepare("SELECT id, value FROM lab_effects ORDER BY id").all()
  : [];
database.close();

process.stdout.write(
  JSON.stringify({
    tablePresent,
    rowCount: rows.length,
    rows,
  }),
);
