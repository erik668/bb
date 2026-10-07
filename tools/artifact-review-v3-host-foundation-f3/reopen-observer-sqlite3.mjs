import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

if (process.argv.length !== 9 || process.argv[2] !== "--db" || process.argv[4] !== "--sqlite3" || process.argv[6] !== "--readonly" || process.argv[7] !== "--file-must-exist" || process.argv[8] !== "true") {
  throw new Error("SQLITE3_OBSERVER_ARGV_INVALID");
}
const dbPath = resolve(process.argv[3]);
const sqlite3 = resolve(process.argv[5]);
if (dbPath !== process.argv[3] || sqlite3 !== process.argv[5] || sqlite3 !== "/usr/bin/sqlite3") throw new Error("SQLITE3_OBSERVER_IDENTITY_INVALID");
const migrationText = execFileSync(sqlite3, ["-readonly", "-json", dbPath, "SELECT migration_index, authority, origin FROM migration_events ORDER BY migration_index;"], { encoding: "utf8" }).trim();
const sentinelText = execFileSync(sqlite3, ["-readonly", "-json", dbPath, "SELECT owner, origin, artifact_id, content_sha256 FROM artifact_sentinel ORDER BY singleton;"], { encoding: "utf8" }).trim();
const migrations = (migrationText ? JSON.parse(migrationText) : []).map((row) => ({ migrationIndex: row.migration_index, authority: row.authority, origin: row.origin }));
const sentinels = (sentinelText ? JSON.parse(sentinelText) : []).map((row) => ({ owner: row.owner, origin: row.origin, artifactId: row.artifact_id, contentSha256: row.content_sha256 }));
process.stdout.write(JSON.stringify({
  observer: "sqlite3-cli",
  parser: "sqlite3-json-column-map",
  pid: process.pid,
  readonly: true,
  fileMustExist: true,
  migrations,
  sentinels
}));
