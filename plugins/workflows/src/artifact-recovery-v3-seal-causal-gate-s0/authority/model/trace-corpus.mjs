import {
  capabilityDigest,
  cloneJson,
  eventDigest,
} from "./canonical.mjs";
import { SealCausalAuthority, buildCompleteLegalTranscript } from "./authority-model.mjs";

function eventByKind(trace, kind) {
  const event = trace.events.find((candidate) => candidate.kind === kind);
  if (!event) throw new Error(`missing fixture event:${kind}`);
  return event;
}

function gateOf(trace) {
  const gate = trace.capabilities.find(({ kind }) => kind === "KEY_GATE");
  if (!gate) throw new Error("missing fixture capability:KEY_GATE");
  return gate;
}

const DIGEST_FIELDS = [
  "sealedSubjectEventDigest",
  "ackEventDigest",
  "gateDigest",
  "mintEventDigest",
  "consumptionDigest",
];

function rewriteDigestFields(value, remap) {
  for (const field of DIGEST_FIELDS) if (value[field]) value[field] = remap.get(value[field]) ?? value[field];
}

function reidentify(trace) {
  const result = cloneJson(trace);
  const remap = new Map();
  const leadingKinds = new Set(["GENESIS", "SEALED_SUBJECT", "SEAL_VERIFIED_ACK"]);

  const reidentifyEvent = (event) => {
    const oldDigest = event.digest;
    event.predecessors = event.predecessors.map((digest) => remap.get(digest) ?? digest);
    rewriteDigestFields(event, remap);
    event.digest = eventDigest(event);
    remap.set(oldDigest, event.digest);
  };

  for (const event of result.events.filter(({ kind }) => leadingKinds.has(kind))) reidentifyEvent(event);
  for (const capability of result.capabilities) {
    const oldDigest = capability.digest;
    rewriteDigestFields(capability, remap);
    capability.digest = capabilityDigest(capability);
    remap.set(oldDigest, capability.digest);
  }
  for (const event of result.events.filter(({ kind }) => !leadingKinds.has(kind))) reidentifyEvent(event);
  for (const operation of result.operations) {
    for (const field of [
      "gateDigest",
      "mintEventDigest",
      "consumptionDigest",
      "launchReceiptDigest",
      "queryReceiptDigest",
    ]) {
      operation[field] = remap.get(operation[field]) ?? operation[field];
    }
  }
  result.claimedSpentGateDigests = result.claimedSpentGateDigests.map((digest) => remap.get(digest) ?? digest);
  return result;
}

function mutateBase(mutator, { reidentifyObjects = false } = {}) {
  const trace = cloneJson(buildCompleteLegalTranscript());
  mutator(trace);
  return reidentifyObjects ? reidentify(trace) : trace;
}

function addWitness(trace, label = "independent-branch") {
  const genesis = eventByKind(trace, "GENESIS");
  const unsigned = {
    kind: "WITNESS",
    predecessors: [genesis.digest],
    displaySequence: trace.events.length + 10,
    actor: "witness-s0",
    label,
  };
  const witness = { digest: eventDigest(unsigned), ...unsigned };
  trace.events.push(witness);
  return witness;
}

const FORGED_BINDINGS = [
  ["F15", "FORGED_RUN", "runId", "run-forged"],
  ["F16", "FORGED_ROW", "rowId", "row-forged"],
  ["F17", "FORGED_CHALLENGE", "challenge", "challenge-forged"],
  ["F18", "FORGED_PROCESS", "processId", "pid-forged"],
  ["F19", "FORGED_EVIDENCE_ROOT", "evidenceRootDigest", "22".repeat(32)],
  ["F20", "FORGED_SEALED_SUBJECT", "sealedSubjectDigest", "23".repeat(32)],
  ["F21", "FORGED_VERIFIER", "verifierId", "verifier-forged"],
  ["F22", "FORGED_RECORDER", "recorderId", "recorder-forged"],
  ["F23", "FORGED_BROKER", "brokerId", "broker-forged"],
  ["F24", "FORGED_SCOPE", "scope", "launch"],
];

const REPLAY_BINDINGS = [
  ["F34", "REPLAY_RUN", "runId", "run-replayed"],
  ["F35", "REPLAY_ROW", "rowId", "row-replayed"],
  ["F36", "REPLAY_CHALLENGE", "challenge", "challenge-replayed"],
  ["F37", "REPLAY_PROCESS", "processId", "pid-replayed"],
  ["F38", "REPLAY_EVIDENCE_ROOT", "evidenceRootDigest", "32".repeat(32)],
  ["F39", "REPLAY_SEALED_SUBJECT", "sealedSubjectDigest", "33".repeat(32)],
  ["F40", "REPLAY_VERIFIER", "verifierId", "verifier-replayed"],
  ["F41", "REPLAY_RECORDER", "recorderId", "recorder-replayed"],
  ["F42", "REPLAY_BROKER", "brokerId", "broker-replayed"],
  ["F43", "REPLAY_SCOPE", "scope", "query"],
];

const DEFINITIONS = [
  ["F01", "MINT_ACK_BEFORE", "mint causally precedes acknowledgement"],
  ["F02", "MINT_ACK_EQUAL", "mint is identified as the acknowledgement event"],
  ["F03", "MINT_ACK_INCOMPARABLE", "mint and acknowledgement are incomparable"],
  ["F04", "CONSUME_MINT_BEFORE", "consumption causally precedes mint"],
  ["F05", "CONSUME_MINT_EQUAL", "consumption is identified as the mint event"],
  ["F06", "CONSUME_MINT_INCOMPARABLE", "consumption and mint are incomparable"],
  ["F07", "LAUNCH_CONSUME_BEFORE", "launch causally precedes consumption"],
  ["F08", "LAUNCH_CONSUME_EQUAL", "launch is identified as consumption"],
  ["F09", "LAUNCH_CONSUME_INCOMPARABLE", "launch and consumption are incomparable"],
  ["F10", "QUERY_CONSUME_BEFORE", "query causally precedes consumption"],
  ["F11", "QUERY_CONSUME_EQUAL", "query is identified as consumption"],
  ["F12", "QUERY_CONSUME_INCOMPARABLE", "query and consumption are incomparable"],
  ["F13", "PREMINT", "gate exists without its exact appended acknowledgement"],
  ["F14", "FORGED_ISSUER", "gate issuer is not the recorder"],
  ...FORGED_BINDINGS.map(([id, code, field]) => [id, code, `gate ${field} binding is forged`]),
  ["F25", "FORGED_PREDECESSOR", "mint names a forged acknowledgement predecessor"],
  ["F26", "FORGED_ACK_ACTOR", "acknowledgement actor is not the recorder"],
  ["F27", "FORGED_MINT_ACTOR", "mint actor is not the recorder"],
  ["F28", "FORGED_CONSUME_ACTOR", "consumer actor is not the broker"],
  ["F29", "FORGED_RECEIPT_ACTOR", "receipt actor is not the broker"],
  ["F30", "COORDINATOR_MINT", "coordinator exposes mint"],
  ["F31", "COORDINATOR_DIRECT_LAUNCH", "coordinator exposes launch/query"],
  ["F32", "UNIVERSAL_MINT_API", "universal mint API exists"],
  ["F33", "UNIVERSAL_LAUNCH_API", "universal launch API exists"],
  ...REPLAY_BINDINGS.map(([id, code, field]) => [id, code, `gate is replayed across ${field}`]),
  ["F44", "SEQUENTIAL_DUPLICATE_CONSUME", "gate is consumed again sequentially"],
  ["F45", "CONCURRENT_DUPLICATE_CONSUME", "two concurrent consumers win"],
  ["F46", "RESTART_REUSE", "spent gate is accepted after restart"],
  ["F47", "SELF_CYCLE", "event has a self-cycle"],
  ["F48", "MULTI_EVENT_CYCLE", "events form a multi-event cycle"],
  ["F49", "DIGEST_ALIAS", "distinct canonical event objects share one digest"],
  ["F50", "MISSING_PREDECESSOR", "edge names an absent event"],
  ["F51", "SAME_EVENT_PREDECESSOR", "consumption names itself as predecessor"],
  ["F52", "INCOMPARABLE_PREDECESSOR", "consumption names an incomparable acknowledgement"],
  ["F53", "SEQUENCE_AUTHORITY", "sequence metadata is claimed as authority"],
  ["F54", "SPENT_STATE_LOSS", "claimed spent state omits retained consumption"],
  ["F55", "LAUNCH_CONSUMPTION_REFERENCE", "launch references another consumption"],
  ["F56", "QUERY_CONSUMPTION_REFERENCE", "query references another consumption"],
  ["F57", "NON_ATOMIC_LAUNCH_QUERY", "launch and query are not one atomic transaction"],
  ["F58", "CONSUME_NOT_APPEND_ONLY", "accepted consumption is absent from retained truth"],
  ["F59", "CROSS_DOMAIN_SUBSTITUTION", "event digest is substituted for a capability digest"],
  ["F60", "IMMUTABLE_EVENT_IDENTITY", "event bytes mutate beneath their identity"],
  ["F61", "IMMUTABLE_CAPABILITY_IDENTITY", "capability bytes mutate beneath their identity"],
  ["F62", "ACK_NOT_VALIDATED", "recorder acknowledgement is not validated"],
  ["F63", "ACK_WRONG_SEALED_SUBJECT", "acknowledgement names the wrong sealed subject"],
  ["F64", "DUPLICATE_EVENT_IDENTITY", "append-only truth repeats an event identity"],
  ["F65", "DUPLICATE_CAPABILITY_IDENTITY", "capability store repeats a gate identity"],
  ["F66", "MINT_GATE_MISMATCH", "mint event names another gate"],
  ["F67", "CONSUME_MINT_REFERENCE", "consumption names another mint event"],
  ["F68", "POISONED_PRIOR_RECEIPT", "operation adopts a prior transaction receipt"],
  ["F69", "API_SURFACE_DRIFT", "closed API surface gains an unapproved route"],
  ["F70", "CAPABILITY_MISSING", "operation names an absent gate"],
  ["F71", "MINT_PREDECESSOR_MISMATCH", "mint has extra predecessor authority"],
  ["F72", "CONSUME_PREDECESSOR_MISMATCH", "consume has extra predecessor authority"],
  ["F73", "LAUNCH_PREDECESSOR_MISMATCH", "launch has extra predecessor authority"],
  ["F74", "QUERY_PREDECESSOR_MISMATCH", "query has extra predecessor authority"],
  ["F75", "MULTIPLE_ACCEPTED_TRANSACTIONS", "multiple accepted operations claim one transcript"],
  ["F76", "UNREFERENCED_CAPABILITY", "unreferenced gate expands authority"],
  ["F77", "ACK_PREDECESSOR_MISMATCH", "ack has extra predecessor authority"],
  ["F78", "MINT_EVENT_MISSING", "gate has no retained mint event"],
  ["F79", "LAUNCH_RECEIPT_MISSING", "accepted launch receipt is absent"],
  ["F80", "QUERY_RECEIPT_MISSING", "accepted query receipt is absent"],
  ["F81", "GATE_CONSUMPTION_MISMATCH", "consumption names another gate"],
];

export const FAULT_CLASSES = Object.freeze(
  DEFINITIONS.map(([id, killCode, description]) => Object.freeze({ id, killCode, description })),
);

function duplicateConsume(mode) {
  return mutateBase((trace) => {
    const original = eventByKind(trace, "KEY_GATE_CONSUMED");
    const duplicate = cloneJson(original);
    duplicate.transactionId = `${original.transactionId}-${mode}`;
    duplicate.displaySequence += 100;
    duplicate.digest = eventDigest(duplicate);
    trace.events.push(duplicate);
    const operation = cloneJson(trace.operations[0]);
    operation.transactionId = duplicate.transactionId;
    operation.mode = mode;
    operation.consumptionDigest = duplicate.digest;
    trace.operations.push(operation);
  });
}

const BUILDERS = {
  F01: () => mutateBase((trace) => {
    const mint = eventByKind(trace, "KEY_GATE_MINTED");
    const ack = eventByKind(trace, "SEAL_VERIFIED_ACK");
    mint.predecessors = [eventByKind(trace, "SEALED_SUBJECT").digest];
    ack.predecessors = [mint.digest];
  }),
  F02: () => mutateBase((trace) => { trace.operations[0].mintEventDigest = eventByKind(trace, "SEAL_VERIFIED_ACK").digest; }),
  F03: () => mutateBase((trace) => { eventByKind(trace, "KEY_GATE_MINTED").predecessors = [eventByKind(trace, "SEALED_SUBJECT").digest]; }),
  F04: () => mutateBase((trace) => {
    const mint = eventByKind(trace, "KEY_GATE_MINTED");
    const consume = eventByKind(trace, "KEY_GATE_CONSUMED");
    consume.predecessors = [eventByKind(trace, "SEAL_VERIFIED_ACK").digest];
    mint.predecessors = [consume.digest];
  }),
  F05: () => mutateBase((trace) => { trace.operations[0].consumptionDigest = eventByKind(trace, "KEY_GATE_MINTED").digest; }),
  F06: () => mutateBase((trace) => { eventByKind(trace, "KEY_GATE_CONSUMED").predecessors = [eventByKind(trace, "SEAL_VERIFIED_ACK").digest]; }),
  F07: () => mutateBase((trace) => {
    const consume = eventByKind(trace, "KEY_GATE_CONSUMED");
    const launch = eventByKind(trace, "LAUNCH_RECEIPT");
    launch.predecessors = [eventByKind(trace, "KEY_GATE_MINTED").digest];
    consume.predecessors.push(launch.digest);
  }),
  F08: () => mutateBase((trace) => { trace.operations[0].launchReceiptDigest = eventByKind(trace, "KEY_GATE_CONSUMED").digest; }),
  F09: () => mutateBase((trace) => { eventByKind(trace, "LAUNCH_RECEIPT").predecessors = [eventByKind(trace, "KEY_GATE_MINTED").digest]; }),
  F10: () => mutateBase((trace) => {
    const consume = eventByKind(trace, "KEY_GATE_CONSUMED");
    const query = eventByKind(trace, "QUERY_RECEIPT");
    query.predecessors = [eventByKind(trace, "KEY_GATE_MINTED").digest];
    consume.predecessors.push(query.digest);
  }),
  F11: () => mutateBase((trace) => { trace.operations[0].queryReceiptDigest = eventByKind(trace, "KEY_GATE_CONSUMED").digest; }),
  F12: () => mutateBase((trace) => { eventByKind(trace, "QUERY_RECEIPT").predecessors = [eventByKind(trace, "KEY_GATE_MINTED").digest]; }),
  F13: () => mutateBase((trace) => { gateOf(trace).ackEventDigest = "40".repeat(32); }, { reidentifyObjects: true }),
  F14: () => mutateBase((trace) => { gateOf(trace).issuer = "forged-issuer"; }, { reidentifyObjects: true }),
  F25: () => mutateBase((trace) => { eventByKind(trace, "KEY_GATE_MINTED").ackEventDigest = eventByKind(trace, "SEALED_SUBJECT").digest; }, { reidentifyObjects: true }),
  F26: () => mutateBase((trace) => { eventByKind(trace, "SEAL_VERIFIED_ACK").actor = "coordinator-s0"; }, { reidentifyObjects: true }),
  F27: () => mutateBase((trace) => { eventByKind(trace, "KEY_GATE_MINTED").actor = "coordinator-s0"; }, { reidentifyObjects: true }),
  F28: () => mutateBase((trace) => { eventByKind(trace, "KEY_GATE_CONSUMED").actor = "coordinator-s0"; }, { reidentifyObjects: true }),
  F29: () => mutateBase((trace) => { eventByKind(trace, "LAUNCH_RECEIPT").actor = "coordinator-s0"; }, { reidentifyObjects: true }),
  F30: () => mutateBase((trace) => { trace.apiSurface.coordinator.push("mintKeyGateFromAck"); }),
  F31: () => mutateBase((trace) => { trace.apiSurface.coordinator.push("consumeKeyGateForAtomicLaunchQuery"); }),
  F32: () => mutateBase((trace) => { trace.apiSurface.universal.push("universalMint"); }),
  F33: () => mutateBase((trace) => { trace.apiSurface.universal.push("universalLaunch"); }),
  F44: () => duplicateConsume("sequential-retry"),
  F45: () => duplicateConsume("concurrent-race"),
  F46: () => duplicateConsume("restart-retry"),
  F47: () => mutateBase((trace) => { const witness = addWitness(trace, "self-cycle"); witness.predecessors = [witness.digest]; }),
  F48: () => mutateBase((trace) => {
    const left = addWitness(trace, "cycle-left");
    const right = addWitness(trace, "cycle-right");
    left.predecessors = [right.digest];
    right.predecessors = [left.digest];
  }),
  F49: () => mutateBase((trace) => { const witness = addWitness(trace, "alias-source"); trace.events.push({ ...witness, label: "alias-target" }); }),
  F50: () => mutateBase((trace) => { eventByKind(trace, "KEY_GATE_CONSUMED").predecessors.push("50".repeat(32)); }),
  F51: () => mutateBase((trace) => { const consume = eventByKind(trace, "KEY_GATE_CONSUMED"); consume.predecessors.push(consume.digest); }),
  F52: () => mutateBase((trace) => {
    const witness = addWitness(trace, "incomparable-ack");
    const consume = eventByKind(trace, "KEY_GATE_CONSUMED");
    consume.ackEventDigest = witness.digest;
    consume.predecessors = [witness.digest, eventByKind(trace, "KEY_GATE_MINTED").digest];
  }),
  F53: () => mutateBase((trace) => { trace.authorityBasis = "sequence-comparison"; trace.events.forEach((event) => { event.displaySequence = 0; }); }),
  F54: () => mutateBase((trace) => { trace.claimedSpentGateDigests = []; }),
  F55: () => mutateBase((trace) => { eventByKind(trace, "LAUNCH_RECEIPT").consumptionDigest = "55".repeat(32); }, { reidentifyObjects: true }),
  F56: () => mutateBase((trace) => { eventByKind(trace, "QUERY_RECEIPT").consumptionDigest = "56".repeat(32); }, { reidentifyObjects: true }),
  F57: () => mutateBase((trace) => { trace.operations[0].atomic = false; eventByKind(trace, "KEY_GATE_CONSUMED").atomic = false; }),
  F58: () => mutateBase((trace) => {
    const digest = eventByKind(trace, "KEY_GATE_CONSUMED").digest;
    trace.events = trace.events.filter((event) => event.digest !== digest);
    trace.claimedSpentGateDigests = [];
  }),
  F59: () => mutateBase((trace) => { gateOf(trace).digest = eventByKind(trace, "SEAL_VERIFIED_ACK").digest; }),
  F60: () => mutateBase((trace) => { eventByKind(trace, "QUERY_RECEIPT").actor = "mutated-broker"; }),
  F61: () => mutateBase((trace) => { gateOf(trace).issuer = "mutated-recorder"; }),
  F62: () => mutateBase((trace) => { eventByKind(trace, "SEAL_VERIFIED_ACK").validated = false; }, { reidentifyObjects: true }),
  F63: () => mutateBase((trace) => { eventByKind(trace, "SEAL_VERIFIED_ACK").sealedSubjectDigest = "63".repeat(32); }, { reidentifyObjects: true }),
  F64: () => mutateBase((trace) => { trace.events.push(cloneJson(eventByKind(trace, "LAUNCH_RECEIPT"))); }),
  F65: () => mutateBase((trace) => { trace.capabilities.push(cloneJson(gateOf(trace))); }),
  F66: () => mutateBase((trace) => { eventByKind(trace, "KEY_GATE_MINTED").gateDigest = "66".repeat(32); }, { reidentifyObjects: true }),
  F67: () => mutateBase((trace) => { eventByKind(trace, "KEY_GATE_CONSUMED").mintEventDigest = "67".repeat(32); }, { reidentifyObjects: true }),
  F68: () => mutateBase((trace) => { eventByKind(trace, "LAUNCH_RECEIPT").transactionId = "prior-transaction"; }, { reidentifyObjects: true }),
  F69: () => mutateBase((trace) => { trace.apiSurface.recorder.push("inspectAllAuthority"); }),
  F70: () => mutateBase((trace) => { trace.capabilities = []; }),
  F71: () => mutateBase((trace) => { eventByKind(trace, "KEY_GATE_MINTED").predecessors.push(eventByKind(trace, "GENESIS").digest); }),
  F72: () => mutateBase((trace) => { eventByKind(trace, "KEY_GATE_CONSUMED").predecessors.push(eventByKind(trace, "GENESIS").digest); }),
  F73: () => mutateBase((trace) => { eventByKind(trace, "LAUNCH_RECEIPT").predecessors.push(eventByKind(trace, "KEY_GATE_MINTED").digest); }),
  F74: () => mutateBase((trace) => { eventByKind(trace, "QUERY_RECEIPT").predecessors.push(eventByKind(trace, "KEY_GATE_MINTED").digest); }),
  F75: () => mutateBase((trace) => { const duplicate = cloneJson(trace.operations[0]); duplicate.transactionId = "another-accepted"; trace.operations.push(duplicate); }),
  F76: () => mutateBase((trace) => {
    const extra = cloneJson(gateOf(trace));
    extra.bindings.runId = "unreferenced-run";
    extra.digest = capabilityDigest(extra);
    trace.capabilities.push(extra);
  }),
  F77: () => mutateBase((trace) => { eventByKind(trace, "SEAL_VERIFIED_ACK").predecessors.push(eventByKind(trace, "GENESIS").digest); }),
  F78: () => mutateBase((trace) => { const digest = eventByKind(trace, "KEY_GATE_MINTED").digest; trace.events = trace.events.filter((event) => event.digest !== digest); }),
  F79: () => mutateBase((trace) => { const digest = eventByKind(trace, "LAUNCH_RECEIPT").digest; trace.events = trace.events.filter((event) => event.digest !== digest); }),
  F80: () => mutateBase((trace) => { const digest = eventByKind(trace, "QUERY_RECEIPT").digest; trace.events = trace.events.filter((event) => event.digest !== digest); }),
  F81: () => mutateBase((trace) => { eventByKind(trace, "KEY_GATE_CONSUMED").gateDigest = "81".repeat(32); }, { reidentifyObjects: true }),
};

for (const [id, , field, value] of FORGED_BINDINGS) {
  BUILDERS[id] = () => mutateBase((trace) => { gateOf(trace).bindings[field] = value; }, { reidentifyObjects: true });
}
for (const [id, , field, value] of REPLAY_BINDINGS) {
  BUILDERS[id] = () => mutateBase((trace) => { trace.operations[0].attemptBindings[field] = value; });
}

export function buildKnownBadTraces() {
  return FAULT_CLASSES.map((fault) => ({ ...fault, trace: BUILDERS[fault.id]() }));
}

export function buildLegalTraces() {
  const complete = cloneJson(buildCompleteLegalTranscript());
  const empty = cloneJson(complete);
  empty.events = [];
  empty.capabilities = [];
  empty.operations = [];
  empty.claimedSpentGateDigests = [];

  const one = cloneJson(complete);
  one.events = one.events.filter(({ kind }) => kind === "GENESIS");
  one.capabilities = [];
  one.operations = [];
  one.claimedSpentGateDigests = [];

  const acknowledgementPrefix = cloneJson(complete);
  acknowledgementPrefix.events = acknowledgementPrefix.events.filter(({ kind }) =>
    ["GENESIS", "SEALED_SUBJECT", "SEAL_VERIFIED_ACK"].includes(kind));
  acknowledgementPrefix.capabilities = [];
  acknowledgementPrefix.operations = [];
  acknowledgementPrefix.claimedSpentGateDigests = [];

  const reversed = cloneJson(complete);
  reversed.events.forEach((event, index) => { event.displaySequence = reversed.events.length - index; });
  const equalSequence = cloneJson(complete);
  equalSequence.events.forEach((event) => { event.displaySequence = 7; });
  const irrelevantBranch = cloneJson(complete);
  addWitness(irrelevantBranch, "irrelevant-incomparable-branch");
  const staleClaim = cloneJson(complete);
  staleClaim.claimedSpentGateDigests = [];
  const restarted = SealCausalAuthority.restart(staleClaim).snapshot();

  return [
    { id: "A00", description: "zero-event path denies without malformed authority", trace: empty, expectedAuthorized: false },
    { id: "A01", description: "one-event path denies without malformed authority", trace: one, expectedAuthorized: false },
    { id: "A02", description: "acknowledgement prefix denies", trace: acknowledgementPrefix, expectedAuthorized: false },
    { id: "A03", description: "complete N-event strict-descendant path authorizes", trace: complete, expectedAuthorized: true },
    { id: "A04", description: "reverse display sequence preserves authorization", trace: reversed, expectedAuthorized: true, expectedDisplayOrder: false },
    { id: "A05", description: "equal display sequence preserves authorization", trace: equalSequence, expectedAuthorized: true, expectedDisplayOrder: true },
    { id: "A06", description: "irrelevant incomparable branch grants no authority", trace: irrelevantBranch, expectedAuthorized: true },
    { id: "A07", description: "restart reconstructs spent state from retained events", trace: restarted, expectedAuthorized: true },
  ];
}

export function buildSchemaNegatives() {
  const cases = [
    ["S01", (trace) => { trace.extra = true; }],
    ["S02", (trace) => { trace.bindings.extra = true; }],
    ["S03", (trace) => { eventByKind(trace, "KEY_GATE_MINTED").extra = true; }],
    ["S04", (trace) => { gateOf(trace).extra = true; }],
    ["S05", (trace) => { delete eventByKind(trace, "KEY_GATE_CONSUMED").digest; }],
    ["S06", (trace) => { eventByKind(trace, "KEY_GATE_MINTED").kind = "OPEN_GATE"; }],
    ["S07", (trace) => { gateOf(trace).kind = "UNIVERSAL_GATE"; }],
    ["S08", (trace) => { gateOf(trace).digest = "not-a-digest"; }],
    ["S09", (trace) => { const mint = eventByKind(trace, "KEY_GATE_MINTED"); mint.predecessors.push(mint.predecessors[0]); }],
    ["S10", (trace) => { eventByKind(trace, "KEY_GATE_MINTED").displaySequence = -1; }],
    ["S11", (trace) => { delete trace.operations[0].atomic; }],
    ["S12", (trace) => { trace.authorityBasis = "wall-clock"; }],
    ["S13", (trace) => { trace.apiSurface.extra = []; }],
    ["S14", (trace) => { trace.operations[0].extra = true; }],
    ["S15", (trace) => { trace.operations[0].mode = "retry-sometime"; }],
    ["S16", (trace) => { eventByKind(trace, "KEY_GATE_CONSUMED").atomic = "yes"; }],
    ["S17", (trace) => { gateOf(trace).operationScope = "launch"; }],
    ["S18", (trace) => { trace.claimedSpentGateDigests.push(trace.claimedSpentGateDigests[0]); }],
  ];
  return cases.map(([id, mutate]) => {
    const trace = cloneJson(buildCompleteLegalTranscript());
    mutate(trace);
    return { id, trace };
  });
}

export const MUTATION_MATRIX = Object.freeze(
  FAULT_CLASSES.map(({ id, killCode, description }) =>
    Object.freeze({ mutationId: `M-${id}`, faultClass: id, uniqueKill: killCode, description })),
);

export function sequenceRenumberings(trace) {
  const length = trace.events.length;
  const assignments = [
    Array(length).fill(0),
    Array(length).fill(7),
    Array.from({ length }, (_, index) => index),
    Array.from({ length }, (_, index) => length - index),
    Array.from({ length }, (_, index) => (index % 2 === 0 ? 999 : 1)),
  ];
  for (let seed = 0; seed < 35; seed += 1) {
    assignments.push(Array.from({ length }, (_, index) => (index * 104729 + seed * 13007) % 1009));
  }
  return assignments.map((values) => {
    const variant = cloneJson(trace);
    variant.events.forEach((event, index) => { event.displaySequence = values[index]; });
    return variant;
  });
}
