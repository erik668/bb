const PHASES = ["BEGIN_IMMEDIATE", "MIGRATIONS_0_22", "SENTINEL", "COMMIT", "PRE_CLOSE"];

export function createNeutralCallable(callLedger) {
  const callable = (value) => {
    callLedger.push(value);
    return { accepted: value === "neutral-input", identity: "f3-neutral-callable-v1" };
  };
  Object.defineProperty(callable, "identity", { value: "f3-neutral-callable-v1" });
  return callable;
}

export function createSpy(callable) {
  const spy = (...args) => {
    spy.mock.calls.push(args);
    return callable(...args);
  };
  spy.mock = { calls: [] };
  return spy;
}

export function neutralAuthorityChain() {
  const value = "0..22:server-local-owner:server:f3-neutral-sentinel";
  return { generator: value, output: value, registry: value, cache: value };
}

export function neutralPhaseReceipt() {
  return { phases: [...PHASES], blocking: true };
}

export function neutralDarkness() {
  return Object.fromEntries(["public-v3", "feature", "rpc", "ui", "renderer", "sdk", "live", "deployment", "rollout"].map((key) => [key, false]));
}

export function neutralV2RoundTrip(input) {
  if (!Array.isArray(input)) throw new TypeError("V2_ARRAY_REQUIRED");
  return [...input];
}

export function selectionProbe(mode) {
  if (mode === "zero") throw new Error("SETUP_SELECTION_INVALID");
  if (mode === "missing-ready") throw new Error("SETUP_READY_MISSING");
  return { ready: true, selected: 16 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const probe = process.argv[2];
  if (probe === "--probe-selection=zero") selectionProbe("zero");
  if (probe === "--probe-selection=missing-ready") selectionProbe("missing-ready");
  throw new Error("SUBJECT_DIRECT_LAUNCH_NOT_AUTHORIZED");
}
