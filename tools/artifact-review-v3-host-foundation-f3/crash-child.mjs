import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--cell" || argv[2] !== "--db") throw new Error("CRASH_CHILD_ARGV_INVALID");
  if (!new Set(["pre-commit", "post-commit-pre-close"]).has(argv[1])) throw new Error("CRASH_CHILD_CELL_INVALID");
  const dbPath = resolve(argv[3]);
  if (dbPath !== argv[3]) throw new Error("CRASH_CHILD_DB_MUST_BE_ABSOLUTE");
  return { cell: argv[1], dbPath };
}

function sendBarrier(name) {
  if (typeof process.send !== "function") throw new Error("CRASH_CHILD_IPC_REQUIRED");
  process.send({ type: "BARRIER_REQUEST", name });
}

const { cell, dbPath } = parseArgs(process.argv.slice(2));
const database = new DatabaseSync(dbPath);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  CREATE TABLE IF NOT EXISTS migration_events (
    migration_index INTEGER PRIMARY KEY,
    authority TEXT NOT NULL,
    origin TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS artifact_sentinel (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    owner TEXT NOT NULL,
    origin TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    content_sha256 TEXT NOT NULL
  ) STRICT;
`);
database.exec("BEGIN IMMEDIATE");
const insertMigration = database.prepare("INSERT INTO migration_events (migration_index, authority, origin) VALUES (?, ?, ?)");
for (let index = 0; index <= 22; index += 1) insertMigration.run(index, "server-local-owner", "server");
database.prepare("INSERT INTO artifact_sentinel (singleton, owner, origin, artifact_id, content_sha256) VALUES (1, ?, ?, ?, ?)")
  .run("server-local-owner", "server", "f3-neutral-sentinel", "fbcfd96b324792c0f66a449492746f7d4c8c47967d689e1302b65e77f98b12c5");

if (cell === "pre-commit") {
  sendBarrier("PRE_COMMIT");
} else {
  database.exec("COMMIT");
  sendBarrier("POST_COMMIT_PRE_CLOSE");
}

setInterval(() => {}, 60_000);
