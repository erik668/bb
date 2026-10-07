import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runForbiddenAccessProbe } from "./access-audit.mjs";
import { LabRunError, runCrashScenario } from "./parent-runner.mjs";
import { validateCrashResult } from "./result-validator.mjs";

const expectedEventTypes = [
  "barrier-received",
  "sigkill-sent",
  "child-exit",
  "observer-start:node",
  "observer-exit:node",
  "observer-start:sqlite3",
  "observer-exit:sqlite3",
];

const withRoot = async (name, callback) => {
  const root = await mkdtemp(join(tmpdir(), `artifact-review-v3-lab-${name}-`));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const assertStableClosure = (closure) => {
  assert.equal(closure.stable, true);
  assert.deepEqual(closure.members.map((member) => member.role).sort(), ["child", "node", "sqlite3"]);
  for (const member of closure.members) {
    assert.equal(member.sourceSha256Before, member.sourceSha256After);
    assert.equal(member.sourceSha256Before, member.snapshotSha256Before);
    assert.equal(member.snapshotSha256Before, member.snapshotSha256After);
  }
  for (const member of [...closure.controllers, ...closure.executables]) {
    assert.equal(member.sha256Before, member.sha256After);
  }
};

test("real SIGKILL and independent reopens expose zero effects before commit and one effect after commit", async () => {
  await withRoot("crash", async (root) => {
    const rolledBack = await runCrashScenario({ phase: "pre-commit", root });
    assert.deepEqual(rolledBack.childExit, { code: null, signal: "SIGKILL" });
    assert.deepEqual(rolledBack.observers.node.actual, {
      tablePresent: false,
      rowCount: 0,
      rows: [],
    });
    assert.deepEqual(rolledBack.observers.sqlite3.actual, rolledBack.observers.node.actual);
    assert.deepEqual(rolledBack.events.map((event) => event.type), expectedEventTypes);
    assertStableClosure(rolledBack.runtimeClosure);

    const committed = await runCrashScenario({ phase: "post-commit-pre-close", root });
    const expected = {
      tablePresent: true,
      rowCount: 1,
      rows: [{ id: 1, value: "committed" }],
    };
    assert.deepEqual(committed.childExit, { code: null, signal: "SIGKILL" });
    assert.deepEqual(committed.observers.node.actual, expected);
    assert.deepEqual(committed.observers.sqlite3.actual, expected);
    assert.deepEqual(committed.events.map((event) => event.type), expectedEventTypes);
    assertStableClosure(committed.runtimeClosure);
  });
});

test("executable child failure capsules remain process observations rather than synthetic result objects", async (t) => {
  const cases = [
    { capsule: "clean-exit-before-barrier", code: "CHILD_EXIT_BEFORE_BARRIER", exit: { code: 0, signal: null } },
    { capsule: "sigterm-before-barrier", code: "CHILD_EXIT_BEFORE_BARRIER", exit: { code: null, signal: "SIGTERM" } },
    { capsule: "throw-before-barrier", code: "CHILD_EXIT_BEFORE_BARRIER", exit: { code: 1, signal: null }, stderr: /deliberate child failure capsule/ },
    { capsule: "timeout-before-barrier", code: "CHILD_BARRIER_TIMEOUT", exit: { code: null, signal: "SIGKILL" } },
    { capsule: "wrong-barrier", code: "INVALID_BARRIER_RECEIPT", receiptPhase: "wrong-phase" },
  ];

  for (const fault of cases) {
    await t.test(fault.capsule, async () => {
      await withRoot(fault.capsule, async (root) => {
        await assert.rejects(
          runCrashScenario({
            phase: "pre-commit",
            root,
            capsule: fault.capsule,
            timeoutMs: fault.capsule === "timeout-before-barrier" ? 100 : 2_000,
          }),
          (error) => {
            assert.equal(error instanceof LabRunError, true);
            assert.equal(error.code, fault.code);
            if (fault.exit) assert.deepEqual(error.details.childExit, fault.exit);
            if (fault.stderr) assert.match(error.details.stderr, fault.stderr);
            if (fault.receiptPhase) assert.equal(error.details.receipt.phase, fault.receiptPhase);
            assert.equal(error.details.runtimeClosure.stable, true);
            return true;
          },
        );
      });
    });
  }
});

test("the closed validator rejects field, chronology, observation, and closure drift", async () => {
  await withRoot("validator", async (root) => {
    const result = await runCrashScenario({ phase: "post-commit-pre-close", root });

    const extraField = structuredClone(result);
    extraField.claimedSuccess = true;
    assert.throws(() => validateCrashResult(extraField), /keys must be exactly/);

    const reordered = structuredClone(result);
    reordered.events[1].type = "child-exit";
    assert.throws(() => validateCrashResult(reordered), /sequence or type mismatch/);

    const forgedObservation = structuredClone(result);
    forgedObservation.observers.node.actual = { tablePresent: false, rowCount: 0, rows: [] };
    forgedObservation.observers.sqlite3.actual = { tablePresent: false, rowCount: 0, rows: [] };
    assert.throws(() => validateCrashResult(forgedObservation), /does not match the crash phase/);

    const drifted = structuredClone(result);
    drifted.runtimeClosure.members[0].snapshotSha256After = "0".repeat(64);
    assert.throws(() => validateCrashResult(drifted), /byte identity drift/);
  });
});

test("runtime snapshot mutation after the barrier is detected before a result can return", async () => {
  await withRoot("runtime-drift", async (root) => {
    await assert.rejects(
      runCrashScenario({ phase: "post-commit-pre-close", root, capsule: "tamper-runtime-after-barrier" }),
      (error) => {
        assert.equal(error instanceof LabRunError, true);
        assert.equal(error.code, "RUNTIME_CLOSURE_DRIFT");
        assert.equal(error.details.runtimeClosure.stable, false);
        return true;
      },
    );
  });
});

test("a forbidden read yields a parent-retained OS denial receipt", async () => {
  await withRoot("access", async (root) => {
    const forbiddenPath = join(root, "forbidden.txt");
    await writeFile(forbiddenPath, "not read by the probe\n", { flag: "wx", mode: 0o600 });
    const receipt = await runForbiddenAccessProbe({ forbiddenPath, root });
    const canonicalForbiddenPath = await realpath(forbiddenPath);
    assert.deepEqual(receipt.childExit, { code: 1, signal: null });
    assert.deepEqual(receipt.observedError, { code: "EPERM", syscall: "open", path: canonicalForbiddenPath });
    assert.equal(receipt.stdout, "");
    assert.match(receipt.stderr, /EPERM: operation not permitted/);
    assert.equal(receipt.runtimeClosure.stable, true);
  });
});
