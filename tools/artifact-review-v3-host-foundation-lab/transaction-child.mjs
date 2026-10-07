import { DatabaseSync } from "node:sqlite";

const [phase, databasePath, capsule = "none"] = process.argv.slice(2);
if (!process.send || !["pre-commit", "post-commit-pre-close"].includes(phase) || !databasePath) {
  process.exitCode = 64;
} else {
  if (capsule === "clean-exit-before-barrier") process.exit(0);
  if (capsule === "sigterm-before-barrier") process.kill(process.pid, "SIGTERM");
  if (capsule === "throw-before-barrier") throw new Error("deliberate child failure capsule");
  if (capsule === "timeout-before-barrier") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }

  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA synchronous=FULL");
  database.exec("PRAGMA foreign_keys=ON");
  database.exec("BEGIN IMMEDIATE");
  database.exec(`
    CREATE TABLE lab_effects (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO lab_effects (value) VALUES ('committed');
  `);

  const blockAtBarrier = () => {
    const blocker = new Int32Array(new SharedArrayBuffer(4));
    const reportedPhase = capsule === "wrong-barrier" ? "wrong-phase" : phase;
    process.send({ type: "barrier", phase: reportedPhase, pid: process.pid }, (error) => {
      if (error) process.exit(70);
      Atomics.wait(blocker, 0, 0);
    });
  };

  if (phase === "pre-commit") {
    blockAtBarrier();
  } else {
    database.exec("COMMIT");
    blockAtBarrier();
  }
}
