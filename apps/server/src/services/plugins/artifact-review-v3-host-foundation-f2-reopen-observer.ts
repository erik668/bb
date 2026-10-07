/* F2 quartz observer: structured rows, no repository imports or expected projection. */

const { DatabaseSync } = require("node:sqlite");
const { existsSync } = require("node:fs");

const WIRE = "quartz-frame/1";

function readPlan() {
  const encoded = process.env.BB_F2_OBSERVER_PLAN;
  if (!encoded) throw new Error("F2_QUARTZ_PLAN_MISSING");
  const plan = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (plan.protocol !== WIRE) throw new Error("F2_QUARTZ_PROTOCOL_INVALID");
  if (plan.confirmedDeath !== true) throw new Error("F2_QUARTZ_DEATH_UNCONFIRMED");
  if (plan.readonly !== true) throw new Error("F2_QUARTZ_READONLY_REQUIRED");
  if (plan.fileMustExist !== true) throw new Error("F2_QUARTZ_FILE_MUST_EXIST_REQUIRED");
  if (!Number.isFinite(plan.deathConfirmedAt) || Date.now() < plan.deathConfirmedAt) {
    throw new Error("F2_QUARTZ_OPENED_BEFORE_DEATH");
  }
  if (!existsSync(plan.dbPath)) throw new Error("F2_QUARTZ_DATABASE_MISSING");
  return plan;
}

function tableExists(db, name) {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name),
  );
}

function observe(plan) {
  const db = new DatabaseSync(plan.dbPath, { readOnly: true });
  try {
    const rows = tableExists(db, "f2_migrations")
      ? db
          .prepare(
            "SELECT migration_id, statement_sha256, statement_bytes FROM f2_migrations ORDER BY migration_id ASC",
          )
          .all()
          .map((row) => ({
            migration: Number(row.migration_id),
            digest: String(row.statement_sha256),
            bytes: Number(row.statement_bytes),
          }))
      : [];
    const rawSentinel = tableExists(db, "f2_sentinel")
      ? db.prepare("SELECT * FROM f2_sentinel WHERE singleton = 1").get()
      : undefined;
    const sentinel = rawSentinel
      ? {
          seam: String(rawSentinel.seam_id),
          owner: String(rawSentinel.owner_authority),
          origin: String(rawSentinel.origin_authority),
          scope: String(rawSentinel.presentation_scope),
          saved: String(rawSentinel.saved_state),
          appendOnly: Number(rawSentinel.append_only_truth) === 1,
          legacy: Number(rawSentinel.legacy_adopted) === 1,
          vectorBytes: Number(rawSentinel.v12_vector_bytes),
          vectorSha256: String(rawSentinel.v12_vector_sha256),
        }
      : null;

    if (plan.mutation === "corrupt-row" && rows.length > 0) rows[0].migration += 1;

    const dependencies = ["node:sqlite", "node:fs"];
    if (plan.mutation === "delegate") dependencies.push("ember-line/1");
    if (plan.mutation === "shared-parser") dependencies.push("shared-f2-parser");
    if (plan.mutation === "shared-canonicalizer") dependencies.push("shared-canonicalizer");
    if (plan.mutation === "shared-expected-projection") dependencies.push("shared-expected-projection");
    if (plan.mutation === "candidate-module") dependencies.push("candidate-module");
    if (plan.mutation === "registry") dependencies.push("candidate-registry");
    if (plan.mutation === "common-mode") dependencies.push("common-mode-projection");

    return {
      wire: WIRE,
      observer: "quartz",
      process: { pid: process.pid, nonce: plan.observerNonce },
      open: {
        readonly: plan.readonly,
        fileMustExist: plan.fileMustExist,
        afterConfirmedDeath: true,
        openedAt: Date.now(),
      },
      dependencies,
      rows,
      sentinel,
    };
  } finally {
    db.close();
  }
}

try {
  process.stdout.write(`${JSON.stringify(observe(readPlan()))}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? `${error.name}:${error.message}` : String(error)}\n`,
  );
  process.exitCode = 74;
}
