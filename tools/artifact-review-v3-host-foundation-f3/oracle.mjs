import { createHash } from "node:crypto";

const EXPECTED_PHASES = ["BEGIN_IMMEDIATE", "MIGRATIONS_0_22", "SENTINEL", "COMMIT", "PRE_CLOSE"];
const EXPECTED_SURFACES = ["public-v3", "feature", "rpc", "ui", "renderer", "sdk", "live", "deployment", "rollout"];

export const CONTROL_REASONS = Object.freeze({
  "F3-SA-01": "ORACLE_INVALID_SPY_REQUIRED",
  "F3-SA-02": "CALLABLE_IDENTITY_MISMATCH",
  "F3-SA-03": "NON_AUTHORITATIVE_CLAIM",
  "F3-SA-04": "PHASE_CHRONOLOGY_INVALID",
  "F3-SA-05": "DEATH_NOT_CONFIRMED_SIGKILL",
  "F3-SA-06": "BARRIER_ORDER_INVALID",
  "F3-SA-07": "OBSERVER_HANDLE_NOT_FRESH",
  "F3-SA-08": "REOPEN_FLAGS_INVALID",
  "F3-SA-09": "OBSERVER_INDEPENDENCE_INVALID",
  "F3-SA-10": "AUTHORITY_CHAIN_INVALID",
  "F3-SA-11": "PHASE_PRIVACY_VIOLATION",
  "F3-SA-12": "V2_BEHAVIOR_CHANGED",
  "F3-SA-13": "DARKNESS_VIOLATION",
  "F3-SA-14": "PACKAGE_TOPOLOGY_INVALID",
  "F3-SA-15": "SETUP_SELECTION_INVALID",
  "F3-SA-16": "LAUNCH_TOPOLOGY_INVALID"
});

function fail(reason, detail) {
  return { accepted: false, reason, detail };
}

function pass(detail) {
  return { accepted: true, reason: "ACCEPTED", detail };
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function requireSpyReceipt(callable) {
  if (typeof callable !== "function" || !callable.mock || !Array.isArray(callable.mock.calls)) {
    return fail(CONTROL_REASONS["F3-SA-01"], "toReturnWith-style evaluation requires a real call ledger");
  }
  return callable.mock.calls.length === 1
    ? pass("spy call ledger proves exactly one invocation")
    : fail("CALL_COUNT_INVALID", `expected one call, received ${callable.mock.calls.length}`);
}

export function adjudicateControl(id, evidence) {
  switch (id) {
    case "F3-SA-02":
      return evidence.callCount === 1 && evidence.expectedIdentity === evidence.actualIdentity
        ? pass("callable identity and invocation count valid")
        : fail(CONTROL_REASONS[id], { expected: evidence.expectedIdentity, actual: evidence.actualIdentity, calls: evidence.callCount });
    case "F3-SA-03":
      return evidence.claimsUsedAsAuthority === false && evidence.rawObservationSource === "fresh-independent-readonly-reopen"
        ? pass("claims excluded from authority")
        : fail(CONTROL_REASONS[id], "child, IPC, phase, commit, close, or durability claim entered authority");
    case "F3-SA-04":
      return JSON.stringify(evidence.phases) === JSON.stringify(EXPECTED_PHASES) && evidence.blocking === true
        ? pass("exact blocking phase chronology")
        : fail(CONTROL_REASONS[id], { expected: EXPECTED_PHASES, actual: evidence.phases, blocking: evidence.blocking });
    case "F3-SA-05":
      return evidence.signal === "SIGKILL" && evidence.deathConfirmed === true && evidence.exitCode === null && evidence.timedOut === false
        ? pass("parent confirmed SIGKILL and death")
        : fail(CONTROL_REASONS[id], evidence);
    case "F3-SA-06":
      return evidence.barrierReached === true && evidence.killAfterBarrier === true && evidence.observationAfterDeath === true
        ? pass("barrier, kill, confirmed death, observation order valid")
        : fail(CONTROL_REASONS[id], evidence);
    case "F3-SA-07":
      return evidence.createdAfterDeath === true && evidence.freshProcesses === 2 && evidence.uniqueHandles === 2 && evidence.reused === false
        ? pass("two fresh post-death observer handles")
        : fail(CONTROL_REASONS[id], evidence);
    case "F3-SA-08":
      return evidence.every((observer) => observer.readonly === true && observer.fileMustExist === true)
        ? pass("both reopen observers are readonly and file-must-exist")
        : fail(CONTROL_REASONS[id], evidence);
    case "F3-SA-09": {
      const implementations = new Set(evidence.map((observer) => observer.implementation));
      const parsers = new Set(evidence.map((observer) => observer.parser));
      const processes = new Set(evidence.map((observer) => observer.pid));
      const independent = evidence.length === 2 && implementations.size === 2 && parsers.size === 2 && processes.size === 2
        && evidence.every((observer) => observer.delegated === false && observer.corrupt === false);
      return independent ? pass("disjoint process, implementation, and parser custody") : fail(CONTROL_REASONS[id], evidence);
    }
    case "F3-SA-10": {
      const expected = "0..22:server-local-owner:server:f3-neutral-sentinel";
      return evidence.generator === expected && evidence.output === expected && evidence.registry === expected && evidence.cache === expected
        ? pass("generator, output, registry, and cache equal fixed neutral authority")
        : fail(CONTROL_REASONS[id], evidence);
    }
    case "F3-SA-11":
      return evidence.publicResult === undefined && evidence.publicPhase === undefined && evidence.internalOnly === true
        ? pass("phase controller exposes no result or phase")
        : fail(CONTROL_REASONS[id], evidence);
    case "F3-SA-12":
      return Array.isArray(evidence.input) && Array.isArray(evidence.output) && JSON.stringify(evidence.input) === JSON.stringify(evidence.output)
        ? pass("admitted array/V2 behavior unchanged")
        : fail(CONTROL_REASONS[id], evidence);
    case "F3-SA-13":
      return EXPECTED_SURFACES.every((surface) => evidence[surface] === false)
        ? pass("all public, live, deployment, and rollout surfaces remain dark")
        : fail(CONTROL_REASONS[id], evidence);
    case "F3-SA-14":
      return evidence.callerSubstitution === false && evidence.missingExports.length === 0 && evidence.unlistedImports.length === 0
        ? pass("frozen candidate ABI and closed runtime topology")
        : fail(CONTROL_REASONS[id], evidence);
    case "F3-SA-15":
      return evidence.ready === true && evidence.selected === 16
        ? pass("READY and exact nonzero selection")
        : fail(CONTROL_REASONS[id], evidence);
    case "F3-SA-16":
      return evidence.executableMatches === true && evidence.runnerMatches === true && evidence.defaultLaunches.every((launch) => launch.exitCode !== 0 && launch.ready === false && launch.typedReceipt === false)
        ? pass("exact executable and runner; wrong launches remain topology-red")
        : fail(CONTROL_REASONS[id], evidence);
    default:
      throw new Error(`UNKNOWN_CONTROL:${id}`);
  }
}

export function assertMutantKilled(id, mutantEvidence) {
  const result = id === "F3-SA-01" ? requireSpyReceipt(mutantEvidence) : adjudicateControl(id, mutantEvidence);
  if (result.accepted || result.reason !== CONTROL_REASONS[id]) {
    throw new Error(`MUTANT_SURVIVED:${id}:${JSON.stringify(result)}`);
  }
  return result;
}

export function adjudicateRawState(state, cell) {
  if (!state || !Array.isArray(state.migrations) || !Array.isArray(state.sentinels)) {
    return fail("RAW_STATE_INVALID", "observer did not return raw migration and sentinel arrays");
  }
  if (cell === "pre-commit") {
    return state.migrations.length === 0 && state.sentinels.length === 0
      ? pass("pre-COMMIT death retained zero migration effects")
      : fail("PRE_COMMIT_EFFECT_VISIBLE", state);
  }
  if (cell !== "post-commit-pre-close") return fail("UNKNOWN_CRASH_CELL", cell);
  const migrationsValid = state.migrations.length === 23 && state.migrations.every((row, index) =>
    row.migrationIndex === index && row.authority === "server-local-owner" && row.origin === "server");
  const sentinel = state.sentinels[0];
  const sentinelValid = state.sentinels.length === 1 && sentinel.owner === "server-local-owner" && sentinel.origin === "server"
    && sentinel.artifactId === "f3-neutral-sentinel" && sentinel.contentSha256 === "fbcfd96b324792c0f66a449492746f7d4c8c47967d689e1302b65e77f98b12c5";
  return migrationsValid && sentinelValid
    ? pass("post-COMMIT death retained exact 0..22 authority and complete sentinel")
    : fail("COMMITTED_STATE_INVALID", state);
}
