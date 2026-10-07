/* F2 ember observer: delimiter encoding, independently queried and decoded. */

const { DatabaseSync } = require("node:sqlite");
const { statSync } = require("node:fs");

const WIRE = "ember-line/1";

function loadPlan() {
  const encoded = process.env.BB_F2_OBSERVER_PLAN;
  if (!encoded) throw new Error("F2_EMBER_PLAN_MISSING");
  const plan = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (plan.protocol !== WIRE) throw new Error("F2_EMBER_PROTOCOL_INVALID");
  if (plan.confirmedDeath !== true) throw new Error("F2_EMBER_DEATH_UNCONFIRMED");
  if (plan.readonly !== true || plan.fileMustExist !== true) {
    throw new Error("F2_EMBER_REOPEN_FLAGS_REQUIRED");
  }
  if (!Number.isFinite(plan.deathConfirmedAt) || Date.now() < plan.deathConfirmedAt) {
    throw new Error("F2_EMBER_OPENED_BEFORE_DEATH");
  }
  const stat = statSync(plan.dbPath);
  if (!stat.isFile()) throw new Error("F2_EMBER_DATABASE_NOT_FILE");
  return plan;
}

function hasTable(db, name) {
  const names = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name DESC")
    .all()
    .map((row) => String(row.name));
  return names.includes(name);
}

function escapeAtom(value) {
  return encodeURIComponent(String(value));
}

function inspect(plan) {
  const db = new DatabaseSync(plan.dbPath, { readOnly: true });
  try {
    const migrations = hasTable(db, "f2_migrations")
      ? db
          .prepare(
            "SELECT statement_bytes AS b, statement_sha256 AS h, migration_id AS i FROM f2_migrations ORDER BY migration_id DESC",
          )
          .all()
          .map((row) => [Number(row.i), String(row.h), Number(row.b)])
          .reverse()
      : [];
    const sentinelRow = hasTable(db, "f2_sentinel")
      ? db.prepare("SELECT * FROM f2_sentinel WHERE singleton = 1").get()
      : undefined;
    const sentinel = sentinelRow
      ? [
          sentinelRow.seam_id,
          sentinelRow.owner_authority,
          sentinelRow.origin_authority,
          sentinelRow.presentation_scope,
          sentinelRow.saved_state,
          Number(sentinelRow.append_only_truth),
          Number(sentinelRow.legacy_adopted),
          Number(sentinelRow.v12_vector_bytes),
          sentinelRow.v12_vector_sha256,
        ]
      : [];

    if (plan.mutation === "corrupt-row" && migrations.length > 0) migrations[0][1] = "0".repeat(64);

    const lineage = ["node:sqlite", "node:fs-stat"];
    if (plan.mutation === "delegate") lineage.push("quartz-frame/1");
    if (plan.mutation === "shared-parser") lineage.push("shared-f2-parser");
    if (plan.mutation === "shared-canonicalizer") lineage.push("shared-canonicalizer");
    if (plan.mutation === "shared-expected-projection") lineage.push("shared-expected-projection");
    if (plan.mutation === "candidate-module") lineage.push("candidate-module");
    if (plan.mutation === "registry") lineage.push("candidate-registry");
    if (plan.mutation === "common-mode") lineage.push("common-mode-projection");

    const migrationText = migrations
      .map(([id, digest, bytes]) => `${id.toString(16)}.${digest}.${bytes.toString(16)}`)
      .join("~");
    const sentinelText = sentinel.map(escapeAtom).join("^");
    return {
      wire: WIRE,
      observer: "ember",
      identity: `${process.pid}@${escapeAtom(plan.observerNonce)}`,
      flags: "readonly=1,fileMustExist=1,afterDeath=1",
      lineage,
      body: `migrations:${migrationText}|sentinel:${sentinelText}`,
      openedAt: Date.now(),
    };
  } finally {
    db.close();
  }
}

try {
  process.stdout.write(`${JSON.stringify(inspect(loadPlan()))}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? `${error.name}:${error.message}` : String(error)}\n`,
  );
  process.exitCode = 75;
}
