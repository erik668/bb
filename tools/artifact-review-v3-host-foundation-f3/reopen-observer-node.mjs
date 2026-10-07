import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

if (process.argv.length !== 7 || process.argv[2] !== "--db" || process.argv[4] !== "--readonly" || process.argv[5] !== "--file-must-exist" || process.argv[6] !== "true") {
  throw new Error("NODE_OBSERVER_ARGV_INVALID");
}
const dbPath = resolve(process.argv[3]);
if (dbPath !== process.argv[3]) throw new Error("NODE_OBSERVER_DB_MUST_BE_ABSOLUTE");
const database = new DatabaseSync(dbPath, { readOnly: true });
const migrations = database.prepare("SELECT migration_index AS migrationIndex, authority, origin FROM migration_events ORDER BY migration_index").all();
const sentinels = database.prepare("SELECT owner, origin, artifact_id AS artifactId, content_sha256 AS contentSha256 FROM artifact_sentinel ORDER BY singleton").all();
database.close();
process.stdout.write(JSON.stringify({
  observer: "node:sqlite",
  parser: "node-row-object",
  pid: process.pid,
  readonly: true,
  fileMustExist: true,
  migrations,
  sentinels
}));
