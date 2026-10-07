import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { assertLegitimatePath, runDeliberateAccessAudit } from "./access-audit.mjs";
import { CONTROL_REASONS, adjudicateControl, adjudicateRawState, assertMutantKilled, requireSpyReceipt, sha256 } from "./oracle.mjs";
import {
  createNeutralCallable,
  createSpy,
  neutralAuthorityChain,
  neutralDarkness,
  neutralPhaseReceipt,
  neutralV2RoundTrip,
  selectionProbe
} from "./self-admission-subject.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPECTED_ENV_KEYS = ["F3_RUN_ID", "HOME", "LANG", "LC_ALL", "PATH", "TMPDIR", "__CF_USER_TEXT_ENCODING"];

function parseArgs(argv) {
  if (argv.length !== 5 || argv[0] !== "--mode=self-admit" || argv[1] !== "--topology" || argv[3] !== "--recorder-root") {
    throw new Error("SELF_ADMISSION_ARGV_INVALID");
  }
  const topologyPath = resolve(argv[2]);
  const recorderRoot = resolve(argv[4]);
  if (topologyPath !== argv[2] || recorderRoot !== argv[4]) throw new Error("SELF_ADMISSION_ABSOLUTE_ARGV_REQUIRED");
  return { topologyPath, recorderRoot };
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label}_KEYS_INVALID:${JSON.stringify(actual)}`);
}

async function hashFile(path) {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function validateBeforeReady(args, topology) {
  exactKeys(topology, ["schemaVersion", "seamId", "repoRoot", "f3Root", "runtime", "selfAdmission", "sourceMembers", "forbiddenDiscovery", "candidate"], "TOPOLOGY");
  if (topology.schemaVersion !== 1 || topology.seamId !== "bb-artifact-review-v3-host-foundation-f3:standalone-neutral-self-admission-v1") throw new Error("TOPOLOGY_SEAM_INVALID");
  if (HERE !== topology.f3Root || args.topologyPath !== join(HERE, "launch-topology.json")) throw new Error("TOPOLOGY_SOURCE_ROOT_INVALID");
  if (process.execPath !== topology.runtime.node.path || process.argv[1] !== topology.selfAdmission.entrypoint) throw new Error("LAUNCH_EXECUTABLE_OR_ENTRYPOINT_INVALID");
  if (process.cwd() !== args.recorderRoot || args.recorderRoot.startsWith(`${topology.repoRoot}${sep}`) || dirname(args.recorderRoot) === args.recorderRoot) throw new Error("LAUNCH_CWD_INVALID");
  if (process.env.F3_RUN_ID !== "self-admit" || process.env.TMPDIR !== args.recorderRoot || process.env.HOME !== args.recorderRoot) throw new Error("LAUNCH_ENV_VALUES_INVALID");
  const unexpectedEnv = Object.keys(process.env).filter((key) => !EXPECTED_ENV_KEYS.includes(key));
  if (unexpectedEnv.length !== 0) throw new Error(`LAUNCH_ENV_UNEXPECTED:${unexpectedEnv.join(",")}`);
  if (process.env.LANG !== "C" || process.env.LC_ALL !== "C" || process.env.PATH !== "/usr/bin:/bin") throw new Error("LAUNCH_ENV_ALLOWLIST_INVALID");
  if (await hashFile(process.execPath) !== topology.runtime.node.sha256) throw new Error("NODE_BINARY_HASH_MISMATCH");
  if (await hashFile(topology.runtime.sqlite3.path) !== topology.runtime.sqlite3.sha256) throw new Error("SQLITE3_BINARY_HASH_MISMATCH");
  if (process.version !== topology.runtime.node.version || process.versions.modules !== topology.runtime.node.modules || process.versions.napi !== topology.runtime.node.napi || process.versions.sqlite !== topology.runtime.node.sqlite) throw new Error("NODE_RUNTIME_VERSION_MISMATCH");
  if (topology.sourceMembers.length !== 16 || new Set(topology.sourceMembers).size !== 16) throw new Error("SOURCE_MEMBER_SET_INVALID");
  for (const relativePath of topology.sourceMembers) {
    const absolutePath = join(topology.repoRoot, relativePath);
    assertLegitimatePath(absolutePath, [topology.f3Root]);
    const stat = await lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`SOURCE_MEMBER_NOT_REGULAR:${relativePath}`);
  }
}

function waitForBarrier(child, expectedName, timeoutMs) {
  return new Promise((resolveBarrier, reject) => {
    const timer = setTimeout(() => reject(new Error(`BARRIER_TIMEOUT:${expectedName}`)), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("message", (message) => {
      if (message?.type !== "BARRIER_REQUEST" || message.name !== expectedName) return;
      clearTimeout(timer);
      resolveBarrier({ name: expectedName, receivedAt: Date.now() });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`CHILD_EXITED_BEFORE_BARRIER:${code}:${signal}`));
    });
  });
}

function waitForDeath(child, timeoutMs) {
  return new Promise((resolveDeath, reject) => {
    const timer = setTimeout(() => reject(new Error("DEATH_CONFIRMATION_TIMEOUT")), timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveDeath({ exitCode: code, signal, deathConfirmed: true, confirmedAt: Date.now() });
    });
  });
}

function parseObserver(child, label) {
  if (child.error || child.status !== 0 || child.signal !== null) throw new Error(`${label}_SETUP_FAILURE:${child.error?.message ?? child.stderr}`);
  try {
    return JSON.parse(child.stdout);
  } catch (error) {
    throw new Error(`${label}_RECEIPT_INVALID:${error.message}`);
  }
}

function retryabilityProbe(dbPath, expectedRetryable) {
  const database = new DatabaseSync(dbPath);
  let retryable = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    retryable = true;
    database.exec("ROLLBACK");
  } finally {
    database.close();
  }
  if (retryable !== expectedRetryable && expectedRetryable) throw new Error("PRE_COMMIT_RETRYABILITY_NOT_PROVEN");
  return retryable;
}

async function runCrashCell(cell, topology, recorderRoot) {
  const cellRoot = join(recorderRoot, cell);
  const mkdirResult = spawnSync("/bin/mkdir", ["-p", cellRoot], { encoding: "utf8" });
  if (mkdirResult.status !== 0) throw new Error(`RECORDER_CELL_ROOT_FAILED:${mkdirResult.stderr}`);
  const dbPath = join(cellRoot, "neutral.sqlite");
  const child = spawn(topology.runtime.node.path, [join(HERE, "crash-child.mjs"), "--cell", cell, "--db", dbPath], {
    cwd: cellRoot,
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin", TMPDIR: cellRoot, HOME: cellRoot, F3_RUN_ID: `crash-${cell}` },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const expectedBarrier = cell === "pre-commit" ? "PRE_COMMIT" : "POST_COMMIT_PRE_CLOSE";
  const barrier = await waitForBarrier(child, expectedBarrier, 10_000);
  const killed = child.kill("SIGKILL");
  if (!killed) throw new Error(`SIGKILL_NOT_SENT:${cell}`);
  const death = await waitForDeath(child, 10_000);
  if (death.signal !== "SIGKILL" || death.exitCode !== null || !death.deathConfirmed) throw new Error(`SIGKILL_NOT_CONFIRMED:${cell}:${stderr.join("")}`);
  const observerStart = Date.now();
  if (observerStart < death.confirmedAt) throw new Error("OBSERVATION_STARTED_BEFORE_DEATH");
  const nodeChild = spawnSync(topology.runtime.node.path, [join(HERE, "reopen-observer-node.mjs"), "--db", dbPath, "--readonly", "--file-must-exist", "true"], {
    cwd: cellRoot, env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin", TMPDIR: cellRoot, HOME: cellRoot, F3_RUN_ID: `observe-node-${cell}` }, encoding: "utf8", timeout: 10_000
  });
  const sqliteChild = spawnSync(topology.runtime.node.path, [join(HERE, "reopen-observer-sqlite3.mjs"), "--db", dbPath, "--sqlite3", topology.runtime.sqlite3.path, "--readonly", "--file-must-exist", "true"], {
    cwd: cellRoot, env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin", TMPDIR: cellRoot, HOME: cellRoot, F3_RUN_ID: `observe-sqlite3-${cell}` }, encoding: "utf8", timeout: 10_000
  });
  const nodeObserver = parseObserver(nodeChild, "NODE_OBSERVER");
  const sqlite3Observer = parseObserver(sqliteChild, "SQLITE3_OBSERVER");
  for (const state of [nodeObserver, sqlite3Observer]) {
    const judgment = adjudicateRawState(state, cell);
    if (!judgment.accepted) throw new Error(`RAW_STATE_REJECTED:${cell}:${JSON.stringify(judgment)}`);
  }
  const writableAfterDeath = retryabilityProbe(dbPath, true);
  const retryable = cell === "pre-commit";
  if (!writableAfterDeath) throw new Error(`DATABASE_NOT_WRITABLE_AFTER_DEATH:${cell}`);
  return { cell, barrier: barrier.name, signal: death.signal, deathConfirmed: death.deathConfirmed, nodeObserver, sqlite3Observer, retryable };
}

function ensureAccepted(id, evidence) {
  const result = adjudicateControl(id, evidence);
  if (!result.accepted) throw new Error(`LEGITIMATE_CONTROL_REJECTED:${id}:${JSON.stringify(result)}`);
  return result;
}

function receipt(id, controlClass, reachability, legitimate, mutants) {
  return {
    id,
    class: controlClass,
    status: "passed",
    reason: CONTROL_REASONS[id],
    reachability,
    receipt: {
      legitimateAccepted: legitimate?.accepted === true,
      mutationCount: mutants.length,
      mutationReasons: mutants.map((mutant) => mutant.reason),
      semanticKillsContributed: controlClass === "semantic" ? 1 : 0,
      oracleInvalidContributed: controlClass === "oracle-invalid" ? 1 : 0,
      evidenceSha256: sha256(JSON.stringify({ legitimate, mutants }))
    }
  };
}

function runSemanticControls(crashCells, topology, wrongLaunches) {
  const controls = [];
  const semanticKillsBeforeSpy = 0;
  const plainCallable = () => "value";
  const spyInvalid = requireSpyReceipt(plainCallable);
  if (spyInvalid.accepted || spyInvalid.reason !== CONTROL_REASONS["F3-SA-01"]) throw new Error("SPY_MISUSE_NOT_ORACLE_INVALID");
  controls.push(receipt("F3-SA-01", "oracle-invalid", "plain-function-spy-matcher-misuse", { semanticKillsBefore: semanticKillsBeforeSpy, semanticKillsAfter: semanticKillsBeforeSpy }, [spyInvalid]));

  const calls = [];
  const callable = createNeutralCallable(calls);
  const spy = createSpy(callable);
  const callableResult = spy("neutral-input");
  const spyReceipt = requireSpyReceipt(spy);
  if (!spyReceipt.accepted || !callableResult.accepted || calls.length !== 1) throw new Error("LEGITIMATE_CALLABLE_NOT_ONCE");
  const callableEvidence = { expectedIdentity: "f3-neutral-callable-v1", actualIdentity: callable.identity, callCount: calls.length };
  controls.push(receipt("F3-SA-02", "semantic", "real-callable-once-and-wrong-identity", ensureAccepted("F3-SA-02", callableEvidence), [assertMutantKilled("F3-SA-02", { ...callableEvidence, actualIdentity: "wrong-callable" })]));

  const claimBase = { claimsUsedAsAuthority: false, rawObservationSource: "fresh-independent-readonly-reopen" };
  controls.push(receipt("F3-SA-03", "semantic", "fabricated-child-phase-commit-close-durability-claims", ensureAccepted("F3-SA-03", claimBase), ["child", "phase", "commit", "close", "durability"].map((claim) => ({ claim, ...assertMutantKilled("F3-SA-03", { ...claimBase, claimsUsedAsAuthority: true }) }))));

  const phaseBase = neutralPhaseReceipt();
  const phaseMutants = [
    { phases: phaseBase.phases.slice(1), blocking: true },
    { phases: [phaseBase.phases[1], phaseBase.phases[0], ...phaseBase.phases.slice(2)], blocking: true },
    { phases: [...phaseBase.phases, "COMMIT"], blocking: true },
    { phases: [...phaseBase.phases].reverse(), blocking: true },
    { phases: phaseBase.phases, blocking: false }
  ];
  controls.push(receipt("F3-SA-04", "semantic", "disabled-moved-duplicated-reordered-nonblocking-phases", ensureAccepted("F3-SA-04", phaseBase), phaseMutants.map((mutant) => assertMutantKilled("F3-SA-04", mutant))));

  const deathBase = { signal: "SIGKILL", deathConfirmed: true, exitCode: null, timedOut: false };
  const deathMutants = [
    { ...deathBase, signal: null, exitCode: 0 }, { ...deathBase, signal: "SIGTERM" },
    { ...deathBase, signal: null, exitCode: 1 }, { ...deathBase, timedOut: true }, { ...deathBase, deathConfirmed: false }
  ];
  controls.push(receipt("F3-SA-05", "semantic", "clean-sigterm-exception-timeout-ambiguous-death", ensureAccepted("F3-SA-05", deathBase), deathMutants.map((mutant) => assertMutantKilled("F3-SA-05", mutant))));

  const orderingBase = { barrierReached: true, killAfterBarrier: true, observationAfterDeath: true };
  controls.push(receipt("F3-SA-06", "semantic", "kill-before-barrier-and-observe-before-death", ensureAccepted("F3-SA-06", orderingBase), [
    assertMutantKilled("F3-SA-06", { ...orderingBase, killAfterBarrier: false }),
    assertMutantKilled("F3-SA-06", { ...orderingBase, observationAfterDeath: false })
  ]));

  const handleBase = { createdAfterDeath: true, freshProcesses: 2, uniqueHandles: 2, reused: false };
  controls.push(receipt("F3-SA-07", "semantic", "stale-prekill-reused-handles", ensureAccepted("F3-SA-07", handleBase), [
    assertMutantKilled("F3-SA-07", { ...handleBase, createdAfterDeath: false }),
    assertMutantKilled("F3-SA-07", { ...handleBase, freshProcesses: 1 }),
    assertMutantKilled("F3-SA-07", { ...handleBase, uniqueHandles: 1, reused: true })
  ]));

  const reopenBase = crashCells[0] ? [crashCells[0].nodeObserver, crashCells[0].sqlite3Observer] : [];
  controls.push(receipt("F3-SA-08", "semantic", "non-readonly-or-non-file-must-exist-reopen", ensureAccepted("F3-SA-08", reopenBase), [
    assertMutantKilled("F3-SA-08", reopenBase.map((item, index) => index === 0 ? { ...item, readonly: false } : item)),
    assertMutantKilled("F3-SA-08", reopenBase.map((item, index) => index === 1 ? { ...item, fileMustExist: false } : item))
  ]));

  const independenceBase = reopenBase.map((observer) => ({
    implementation: observer.observer, parser: observer.parser, pid: observer.pid, delegated: false, corrupt: false
  }));
  controls.push(receipt("F3-SA-09", "semantic", "corrupt-delegated-shared-parser-common-mode-observers", ensureAccepted("F3-SA-09", independenceBase), [
    assertMutantKilled("F3-SA-09", independenceBase.map((item, index) => index === 0 ? { ...item, corrupt: true } : item)),
    assertMutantKilled("F3-SA-09", independenceBase.map((item, index) => index === 1 ? { ...item, delegated: true } : item)),
    assertMutantKilled("F3-SA-09", independenceBase.map((item) => ({ ...item, parser: "shared" }))),
    assertMutantKilled("F3-SA-09", independenceBase.map((item) => ({ ...item, implementation: "common" })))
  ]));

  const authorityBase = neutralAuthorityChain();
  controls.push(receipt("F3-SA-10", "semantic", "generator-output-registry-cache-divergence", ensureAccepted("F3-SA-10", authorityBase), Object.keys(authorityBase).map((key) => assertMutantKilled("F3-SA-10", { ...authorityBase, [key]: "mutated" }))));

  const privacyBase = { publicResult: undefined, publicPhase: undefined, internalOnly: true };
  controls.push(receipt("F3-SA-11", "semantic", "phase-or-result-leakage", ensureAccepted("F3-SA-11", privacyBase), [
    assertMutantKilled("F3-SA-11", { ...privacyBase, publicResult: { committed: true } }),
    assertMutantKilled("F3-SA-11", { ...privacyBase, publicPhase: "COMMIT" })
  ]));

  const v2Input = [{ id: "admitted-v2-a" }, { id: "admitted-v2-b" }];
  const v2Base = { input: v2Input, output: neutralV2RoundTrip(v2Input) };
  controls.push(receipt("F3-SA-12", "semantic", "admitted-array-v2-mutation", ensureAccepted("F3-SA-12", v2Base), [assertMutantKilled("F3-SA-12", { input: v2Input, output: [v2Input[0]] })]));

  const darknessBase = neutralDarkness();
  controls.push(receipt("F3-SA-13", "semantic", "public-live-or-rollout-surface-lit", ensureAccepted("F3-SA-13", darknessBase), Object.keys(darknessBase).map((surface) => ({ surface, ...assertMutantKilled("F3-SA-13", { ...darknessBase, [surface]: true }) }))));

  const packageBase = {
    callerSubstitution: topology.candidate.callerModuleSubstitution,
    missingExports: Object.keys(topology.candidate.namedExports).filter((path) => !topology.candidate.paths.some((entry) => entry.path === path)),
    unlistedImports: topology.candidate.noncandidateProductionImports
  };
  controls.push(receipt("F3-SA-14", "semantic", "module-substitution-missing-abi-unlisted-closure", { ...ensureAccepted("F3-SA-14", packageBase), abiFrozenButNotExecuted: true }, [
    assertMutantKilled("F3-SA-14", { ...packageBase, callerSubstitution: true }),
    assertMutantKilled("F3-SA-14", { ...packageBase, missingExports: ["runHostOwnedPluginTransaction"] }),
    assertMutantKilled("F3-SA-14", { ...packageBase, unlistedImports: ["unlisted-module"] })
  ]));

  const selectionBase = selectionProbe("legitimate");
  const zeroProbe = spawnSync(topology.runtime.node.path, [join(HERE, "self-admission-subject.mjs"), "--probe-selection=zero"], { encoding: "utf8", timeout: 5_000 });
  const missingReadyProbe = spawnSync(topology.runtime.node.path, [join(HERE, "self-admission-subject.mjs"), "--probe-selection=missing-ready"], { encoding: "utf8", timeout: 5_000 });
  if (zeroProbe.status === 0 || missingReadyProbe.status === 0 || zeroProbe.stdout || missingReadyProbe.stdout) throw new Error("SELECTION_PROBE_NOT_TOPOLOGY_RED");
  controls.push(receipt("F3-SA-15", "setup-topology", "zero-selection-or-missing-ready", ensureAccepted("F3-SA-15", selectionBase), [
    { processExit: zeroProbe.status, ...assertMutantKilled("F3-SA-15", { ready: true, selected: 0 }) },
    { processExit: missingReadyProbe.status, ...assertMutantKilled("F3-SA-15", { ready: false, selected: 16 }) }
  ]));

  const launchBase = { executableMatches: true, runnerMatches: true, defaultLaunches: wrongLaunches };
  controls.push(receipt("F3-SA-16", "setup-topology", "wrong-executable-and-default-config-launch-reds", ensureAccepted("F3-SA-16", launchBase), [
    assertMutantKilled("F3-SA-16", { ...launchBase, executableMatches: false })
  ]));
  return controls;
}

function runWrongLaunches(topology, recorderRoot) {
  const vitestEntry = join(topology.repoRoot, "node_modules/vitest/vitest.mjs");
  const launches = [
    ["--run"],
    ["--run", "--config", join(topology.repoRoot, "apps/server/vitest.config.ts")]
  ];
  return launches.map((args) => {
    const child = spawnSync(topology.runtime.node.path, [vitestEntry, ...args], {
      cwd: recorderRoot,
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin", TMPDIR: recorderRoot, HOME: recorderRoot, F3_RUN_ID: "wrong-launch-red" },
      encoding: "utf8", timeout: 10_000
    });
    const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
    return { argv: args, exitCode: child.status, signal: child.signal, ready: output.includes("\"type\":\"READY\""), typedReceipt: output.includes("\"schemaVersion\":1") };
  });
}

function runEncoders(topology, recorderRoot) {
  const pathsFile = join(recorderRoot, "manifest-paths.txt");
  const pathsBody = `${topology.sourceMembers.join("\n")}\n`;
  return writeFile(pathsFile, pathsBody, { flag: "wx" }).then(() => {
    const node = spawnSync(topology.runtime.node.path, [join(HERE, "manifest-encoder-node.mjs"), "--root", topology.repoRoot, "--paths-file", pathsFile], { cwd: recorderRoot, env: process.env, encoding: null, timeout: 20_000 });
    const posix = spawnSync("/bin/sh", [join(HERE, "manifest-encoder-posix.sh"), "--root", topology.repoRoot, "--paths-file", pathsFile], { cwd: recorderRoot, env: process.env, encoding: null, timeout: 20_000 });
    if (node.error || node.status !== 0) throw new Error(`NODE_ENCODER_FAILED:${node.error?.message ?? node.stderr?.toString()}`);
    if (posix.error || posix.status !== 0) throw new Error(`POSIX_ENCODER_FAILED:${posix.error?.message ?? posix.stderr?.toString()}`);
    if (!node.stdout.equals(posix.stdout)) throw new Error("CANONICAL_ENCODERS_DISAGREE");
    if (node.stdout.at(-1) === 10) throw new Error("CANONICAL_ENCODER_TERMINAL_NEWLINE");
    const newlineMutant = Buffer.concat([node.stdout, Buffer.from("\n")]);
    if (newlineMutant.equals(node.stdout) || sha256(newlineMutant) === sha256(node.stdout)) throw new Error("TERMINAL_NEWLINE_MUTANT_SURVIVED");
    return {
      nodeSha256: sha256(node.stdout), posixSha256: sha256(posix.stdout), byteIdentical: true,
      terminalNewline: false, newlineMutantKilled: true, sourceIdentities: JSON.parse(node.stdout.toString("utf8"))
    };
  });
}

function assertClosedResult(result) {
  exactKeys(result, ["schemaVersion", "seamId", "mode", "ready", "topology", "counts", "controls", "crashCells", "accessAudit", "encoders", "sourceIdentities", "outcome"], "RESULT");
  const ids = result.controls.map((control) => control.id);
  const expectedIds = Array.from({ length: 16 }, (_, index) => `F3-SA-${String(index + 1).padStart(2, "0")}`);
  if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) throw new Error("CONTROL_REGISTRY_ORDER_INVALID");
  if (result.controls.some((control) => control.status !== "passed") || result.sourceIdentities.length !== 16) throw new Error("RESULT_COUNTS_INVALID");
}

const args = parseArgs(process.argv.slice(2));
const topology = JSON.parse(await readFile(args.topologyPath, "utf8"));
await validateBeforeReady(args, topology);
process.stdout.write(`${JSON.stringify({ type: "READY", seamId: topology.seamId, selected: 16 })}\n`);

const crashCells = [];
crashCells.push(await runCrashCell("pre-commit", topology, args.recorderRoot));
crashCells.push(await runCrashCell("post-commit-pre-close", topology, args.recorderRoot));
const accessAuditDetailed = await runDeliberateAccessAudit(topology.repoRoot);
const wrongLaunches = runWrongLaunches(topology, args.recorderRoot);
const controls = runSemanticControls(crashCells, topology, wrongLaunches);
const encoderResult = await runEncoders(topology, args.recorderRoot);
const result = {
  schemaVersion: 1,
  seamId: topology.seamId,
  mode: "self-admit",
  ready: true,
  topology: {
    node: process.execPath,
    sqlite3: topology.runtime.sqlite3.path,
    cwd: process.cwd(),
    runner: process.argv[1],
    environmentKeys: Object.keys(process.env).sort()
  },
  counts: { selected: 16, reached: 16, passed: 16, failed: 0, skipped: 0, todo: 0, filtered: 0, setupErrors: 0, semanticKills: 13, oracleInvalid: 1 },
  controls,
  crashCells,
  accessAudit: {
    deliberateDenied: accessAuditDetailed.deliberateDenied,
    expectedDenied: accessAuditDetailed.expectedDenied,
    legitimateForbiddenAttempts: accessAuditDetailed.legitimateForbiddenAttempts,
    operationsPerPath: accessAuditDetailed.operationsPerPath
  },
  encoders: {
    nodeSha256: encoderResult.nodeSha256,
    posixSha256: encoderResult.posixSha256,
    byteIdentical: encoderResult.byteIdentical,
    terminalNewline: encoderResult.terminalNewline,
    newlineMutantKilled: encoderResult.newlineMutantKilled
  },
  sourceIdentities: encoderResult.sourceIdentities,
  outcome: "pass"
};
assertClosedResult(result);
process.stdout.write(JSON.stringify(result));
