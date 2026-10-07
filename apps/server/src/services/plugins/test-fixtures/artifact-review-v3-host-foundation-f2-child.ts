/*
 * F2 self-admission crash writer.
 *
 * This file is intentionally valid CommonJS JavaScript despite its .ts suffix.
 * The F2 oracle executes it through an isolated Module._compile bootstrap so the
 * child resolves no repository package or candidate module. IPC coordinates the
 * kill barrier; it is never commit evidence.
 */

const { DatabaseSync } = require("node:sqlite");
const { createHash } = require("node:crypto");

const WIRE = "quorum-edge/1";

function send(kind, detail = {}) {
  if (typeof process.send === "function") {
    process.send({ wire: WIRE, kind, at: Date.now(), ...detail });
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parsePlan() {
  const encoded = process.env.BB_F2_CHILD_PLAN;
  if (!encoded) {
    throw new Error("F2_SETUP_PLAN_MISSING");
  }
  const plan = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (plan.protocol !== WIRE || typeof plan.dbPath !== "string") {
    throw new Error("F2_SETUP_PLAN_INVALID");
  }
  return plan;
}

function waitForever() {
  setInterval(() => {}, 60_000);
}

function emitBarrier(plan, edge, checkpoint, ordinal = 1) {
  send("edge", {
    runNonce: plan.runNonce,
    edge,
    checkpoint,
    ordinal,
  });
}

function emitConfiguredBarrier(plan, edge, correctCheckpoint) {
  const otherEdge = edge === "prepared" ? "durable" : "prepared";
  if (plan.phaseFault === "disabled") {
    return false;
  }
  if (plan.phaseFault === "reordered") {
    emitBarrier(plan, otherEdge, `wrong-order-before-${edge}`, 1);
  }
  const checkpoint =
    plan.phaseFault === "moved"
      ? edge === "prepared"
        ? "after-begin-before-effects"
        : "after-close"
      : correctCheckpoint;
  emitBarrier(plan, edge, checkpoint, 1);
  if (plan.phaseFault === "duplicated") {
    emitBarrier(plan, edge, checkpoint, 2);
  }
  return true;
}

function afterBarrier(plan, db, edge) {
  if (plan.deathBehavior === "clean") {
    if (db.isOpen) db.close();
    process.exit(0);
  }
  if (plan.deathBehavior === "exception") {
    throw new Error(`F2_CHILD_EXCEPTION_AFTER_${edge.toUpperCase()}`);
  }
  if (plan.deathBehavior === "timeout") {
    waitForever();
    return;
  }
  if (plan.phaseFault === "nonblocking") {
    send("advanced", { runNonce: plan.runNonce, edge });
    return;
  }
  waitForever();
}

function createSchemaAndEffects(db, plan) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS f2_migrations (
      migration_id INTEGER PRIMARY KEY,
      statement_sha256 TEXT NOT NULL,
      statement_bytes INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS f2_sentinel (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      seam_id TEXT NOT NULL,
      owner_authority TEXT NOT NULL,
      origin_authority TEXT NOT NULL,
      presentation_scope TEXT NOT NULL,
      saved_state TEXT NOT NULL,
      append_only_truth INTEGER NOT NULL,
      legacy_adopted INTEGER NOT NULL,
      v12_vector_bytes INTEGER NOT NULL,
      v12_vector_sha256 TEXT NOT NULL
    ) STRICT;
  `);

  const insertMigration = db.prepare(
    "INSERT INTO f2_migrations (migration_id, statement_sha256, statement_bytes) VALUES (?, ?, ?)",
  );
  for (const row of plan.rows) {
    insertMigration.run(row.id, sha256(row.statement), Buffer.byteLength(row.statement));
  }

  db.prepare(
    `INSERT INTO f2_sentinel (
      singleton, seam_id, owner_authority, origin_authority,
      presentation_scope, saved_state, append_only_truth, legacy_adopted,
      v12_vector_bytes, v12_vector_sha256
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    plan.sentinel.seamId,
    plan.sentinel.ownerAuthority,
    plan.sentinel.originAuthority,
    plan.sentinel.presentationScope,
    plan.sentinel.savedState,
    plan.sentinel.appendOnlyTruth ? 1 : 0,
    plan.sentinel.legacyAdopted ? 1 : 0,
    plan.sentinel.v12VectorBytes,
    plan.sentinel.v12VectorSha256,
  );
}

async function injectSetupFault(plan) {
  switch (plan.setupFault) {
    case "import":
      await import("data:text/javascript,throw new Error('F2_IMPORT_FAULT')");
      return;
    case "transform":
      await import("data:text/javascript,export%20const%20=%20broken");
      return;
    case "fixture":
      throw new Error("F2_FIXTURE_FAULT");
    case "timeout":
      send("setup-stall", { stage: "fixture", runNonce: plan.runNonce });
      waitForever();
      await new Promise(() => {});
      return;
    case "fabricated":
      for (const claim of ["success", "phase", "commit", "close"]) {
        send("claim", { runNonce: plan.runNonce, claim, authoritative: false });
      }
      process.exit(0);
      return;
    default:
      return;
  }
}

async function main() {
  const plan = parsePlan();
  await injectSetupFault(plan);

  send("target-reached", { runNonce: plan.runNonce });
  const dbPath = plan.setupFault === "database" ? `${plan.dbPath}/missing/ledger.db` : plan.dbPath;
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
  db.exec("BEGIN IMMEDIATE");
  send("transaction-open", { runNonce: plan.runNonce });

  if (plan.phase === "prepared" && plan.phaseFault === "moved") {
    emitConfiguredBarrier(plan, "prepared", "after-effects-before-commit");
    afterBarrier(plan, db, "prepared");
    return;
  }

  createSchemaAndEffects(db, plan);
  send("effects-staged", { runNonce: plan.runNonce, rowCount: plan.rows.length });

  if (plan.phase === "prepared") {
    const emitted = emitConfiguredBarrier(plan, "prepared", "after-effects-before-commit");
    if (!emitted) {
      db.exec("ROLLBACK");
      db.close();
      process.exit(0);
    }
    if (plan.phaseFault === "nonblocking") {
      db.exec("COMMIT");
      send("advanced", { runNonce: plan.runNonce, edge: "prepared" });
      db.close();
      process.exit(0);
    }
    afterBarrier(plan, db, "prepared");
    return;
  }

  db.exec("COMMIT");
  send("commit-returned", { runNonce: plan.runNonce });

  if (plan.phaseFault === "moved") {
    db.close();
    emitConfiguredBarrier(plan, "durable", "after-commit-before-close");
    afterBarrier(plan, db, "durable");
    return;
  }

  const emitted = emitConfiguredBarrier(plan, "durable", "after-commit-before-close");
  if (!emitted) {
    db.close();
    process.exit(0);
  }
  if (plan.phaseFault === "nonblocking") {
    send("advanced", { runNonce: plan.runNonce, edge: "durable" });
    db.close();
    process.exit(0);
  }
  afterBarrier(plan, db, "durable");
}

main().catch((error) => {
  const message = {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  };
  if (typeof process.send === "function") {
    process.send({ wire: WIRE, kind: "setup-fault", at: Date.now(), ...message }, () => process.exit(73));
  } else {
    process.exit(73);
  }
});
