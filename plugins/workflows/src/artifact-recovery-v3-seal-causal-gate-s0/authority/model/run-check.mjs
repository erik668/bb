import assert from "node:assert/strict";
import {
  canonicalJson,
  capabilityDigest,
  cloneJson,
  domainDigest,
  eventDigest,
} from "./canonical.mjs";
import {
  ACCOUNTING_IDENTITY,
  ACCOUNTING_ROWS,
  ADAPTER_ALLOCATION,
  CONTROLS,
  NEGATIVE_LINEAGE_ONLY,
  PROTOCOL_PHASES,
  SDK_ROWS,
} from "./authority-data.mjs";
import {
  SealCausalAuthority,
  buildCompleteLegalTranscript,
  reconstructSpentGateDigests,
} from "./authority-model.mjs";
import { checkTranscript } from "./independent-checker.mjs";
import {
  capabilitySchemas,
  eventSchemas,
  transcriptSchema,
  validateCapabilitySchema,
  validateEventSchema,
  validateSchema,
} from "./schemas.mjs";
import {
  FAULT_CLASSES,
  MUTATION_MATRIX,
  buildKnownBadTraces,
  buildLegalTraces,
  buildSchemaNegatives,
  sequenceRenumberings,
} from "./trace-corpus.mjs";

function countBy(values, key) {
  return Object.fromEntries(
    [...new Set(values.map((value) => value[key]))].map((item) => [item, values.filter((value) => value[key] === item).length]),
  );
}

function assertFrozenDataOnlyAuthority() {
  assert.equal(PROTOCOL_PHASES.length, 12);
  assert.deepEqual(PROTOCOL_PHASES.map(({ ordinal }) => ordinal), Array.from({ length: 12 }, (_, index) => index + 1));
  assert(PROTOCOL_PHASES.every(({ semantics }) => semantics === null));
  assert.equal(ACCOUNTING_ROWS.length, 134);
  assert.equal(CONTROLS.length, 17);
  assert.equal(SDK_ROWS.length, 30);
  assert.deepEqual(Object.values(countBy(ACCOUNTING_ROWS, "category")), [20, 18, 37, 5, 12, 5, 30, 7]);
  assert.deepEqual(ADAPTER_ALLOCATION.map(({ rows }) => rows), [42, 4, 4]);
  assert.deepEqual(ACCOUNTING_IDENTITY, {
    stimuli: 134,
    controls: 17,
    sdkRows: 30,
    categoryAllocation: [20, 18, 37, 5, 12, 5, 30, 7],
    adapterAllocation: [42, 4, 4],
  });
  assert.deepEqual(NEGATIVE_LINEAGE_ONLY, ["V9", "V10", "V11", "C0", "C1", "C2", "A0", "P1", "R0"]);
  assert.equal(transcriptSchema.additionalProperties, false);
  assert(Object.values(eventSchemas).every((schema) => schema.additionalProperties === false));
  assert(Object.values(capabilitySchemas).every((schema) => schema.additionalProperties === false));
}

function assertLegalTraces() {
  const legal = buildLegalTraces();
  assert.equal(legal.length, 8);
  for (const anchor of legal) {
    const outcome = checkTranscript(anchor.trace);
    assert.equal(outcome.authorized, anchor.expectedAuthorized, `${anchor.id}:${canonicalJson(outcome.errors)}`);
    assert.equal(outcome.errors.length, 0, `${anchor.id}:${canonicalJson(outcome.errors)}`);
    if (anchor.expectedDisplayOrder !== undefined) assert.equal(outcome.displayOrder.ok, anchor.expectedDisplayOrder, anchor.id);
  }
  return legal;
}

function assertKnownBadTraces() {
  const knownBad = buildKnownBadTraces();
  assert.equal(knownBad.length, 81);
  assert.equal(new Set(knownBad.map(({ id }) => id)).size, knownBad.length);
  assert.equal(new Set(knownBad.map(({ killCode }) => killCode)).size, knownBad.length);
  for (const candidate of knownBad) {
    const outcome = checkTranscript(candidate.trace);
    assert.equal(outcome.authorized, false, `${candidate.id}:unexpected-authority`);
    assert(
      outcome.errors.some(({ code }) => code === candidate.killCode),
      `${candidate.id}:missing-${candidate.killCode}:${canonicalJson(outcome.errors)}`,
    );
    const renumbered = cloneJson(candidate.trace);
    renumbered.events.forEach((event, index) => { event.displaySequence = (index * 97 + 31) % 11; });
    const renumberedOutcome = checkTranscript(renumbered);
    assert.equal(renumberedOutcome.authorized, outcome.authorized, `${candidate.id}:sequence-authority-drift`);
    assert(renumberedOutcome.errors.some(({ code }) => code === candidate.killCode), `${candidate.id}:sequence-kill-drift`);
  }
  assert.equal(MUTATION_MATRIX.length, knownBad.length);
  assert.deepEqual(MUTATION_MATRIX.map(({ faultClass }) => faultClass), FAULT_CLASSES.map(({ id }) => id));
  assert.equal(new Set(MUTATION_MATRIX.map(({ uniqueKill }) => uniqueKill)).size, MUTATION_MATRIX.length);
  return knownBad;
}

function assertSchemaNegatives() {
  const negatives = buildSchemaNegatives();
  assert.equal(negatives.length, 18);
  for (const candidate of negatives) {
    const transcriptErrors = validateSchema(transcriptSchema, candidate.trace);
    const eventErrors = candidate.trace.events.flatMap((event, index) => validateEventSchema(event, `$.events[${index}]`));
    const capabilityErrors = candidate.trace.capabilities.flatMap((capability, index) =>
      validateCapabilitySchema(capability, `$.capabilities[${index}]`));
    assert(transcriptErrors.length + eventErrors.length + capabilityErrors.length > 0, `${candidate.id}:schema-negative-admitted`);
    assert(checkTranscript(candidate.trace).errors.some(({ code }) => code === "SCHEMA"), `${candidate.id}:checker-schema-gap`);
  }
  return negatives;
}

function assertSequenceAuthorizationInvariance() {
  const legal = buildCompleteLegalTranscript();
  const baseline = checkTranscript(legal);
  assert.equal(baseline.authorized, true);
  const baselineEventDigests = legal.events.map(({ digest }) => digest);
  const variants = sequenceRenumberings(legal);
  assert(variants.length >= 20);
  let malformedDisplayOrders = 0;
  for (const variant of variants) {
    const outcome = checkTranscript(variant);
    assert.equal(outcome.authorized, baseline.authorized, canonicalJson(outcome.errors));
    assert.deepEqual(variant.events.map(({ digest }) => digest), baselineEventDigests);
    if (!outcome.displayOrder.ok) malformedDisplayOrders += 1;
  }
  assert(malformedDisplayOrders > 0);
  return { variants: variants.length, malformedDisplayOrders };
}

function assertExhaustiveStateExploration() {
  const complete = cloneJson(buildCompleteLegalTranscript());
  const genesis = complete.events.find(({ kind }) => kind === "GENESIS");
  const selectable = [
    ...complete.events.filter(({ kind }) => kind !== "GENESIS").map((event) => ({ type: "event", digest: event.digest })),
    ...complete.capabilities.map((capability) => ({ type: "capability", digest: capability.digest })),
  ];
  const states = 2 ** selectable.length;
  let authorizedStates = 0;
  for (let mask = 0; mask < states; mask += 1) {
    const selectedEvents = new Set([genesis.digest]);
    const selectedCapabilities = new Set();
    selectable.forEach((item, index) => {
      if ((mask & (1 << index)) === 0) return;
      if (item.type === "event") selectedEvents.add(item.digest);
      else selectedCapabilities.add(item.digest);
    });
    const trace = cloneJson(complete);
    trace.events = trace.events.filter(({ digest }) => selectedEvents.has(digest));
    trace.capabilities = trace.capabilities.filter(({ digest }) => selectedCapabilities.has(digest));
    const referenced = [
      trace.operations[0].gateDigest,
      trace.operations[0].mintEventDigest,
      trace.operations[0].consumptionDigest,
      trace.operations[0].launchReceiptDigest,
      trace.operations[0].queryReceiptDigest,
    ];
    const retained = new Set([...trace.events.map(({ digest }) => digest), ...trace.capabilities.map(({ digest }) => digest)]);
    if (!referenced.every((digest) => retained.has(digest))) trace.operations = [];
    trace.claimedSpentGateDigests = reconstructSpentGateDigests(trace.events);
    const outcome = checkTranscript(trace);
    if (outcome.authorized) authorizedStates += 1;
    assert.equal(outcome.authorized, mask === states - 1, `state-mask-${mask}:${canonicalJson(outcome.errors)}`);
  }
  assert.equal(authorizedStates, 1);
  return { states, authorizedStates };
}

function assertDomainSeparation() {
  const payload = { immutable: "same-canonical-bytes" };
  assert.notEqual(domainDigest("event/KEY_GATE_MINTED/v1", payload), domainDigest("event/SEAL_VERIFIED_ACK/v1", payload));
  assert.notEqual(domainDigest("event/LAUNCH_RECEIPT/v1", payload), domainDigest("event/QUERY_RECEIPT/v1", payload));
  assert.notEqual(domainDigest("event/KEY_GATE/v1", payload), domainDigest("capability/KEY_GATE/v1", payload));
  assert.notEqual(eventDigest({ kind: "WITNESS", actor: "x", predecessors: [], displaySequence: 1, label: "x" }),
    capabilityDigest({ kind: "KEY_GATE", bindings: {}, issuer: "x", ackEventDigest: "00".repeat(32), operationScope: "launch+query" }));
}

function assertRestartDurability() {
  const complete = cloneJson(buildCompleteLegalTranscript());
  complete.claimedSpentGateDigests = [];
  const restarted = SealCausalAuthority.restart(complete);
  const snapshot = restarted.snapshot();
  assert.deepEqual(snapshot.claimedSpentGateDigests, [complete.capabilities[0].digest]);
  assert.throws(() => restarted.atomicLaunchQuery({ gateDigest: complete.capabilities[0].digest }), /gate-spent/);
}

assertFrozenDataOnlyAuthority();
assertDomainSeparation();
assertRestartDurability();
const legal = assertLegalTraces();
const knownBad = assertKnownBadTraces();
const schemaNegatives = assertSchemaNegatives();
const sequence = assertSequenceAuthorizationInvariance();
const exploration = assertExhaustiveStateExploration();

const result = {
  ok: true,
  seam: "bb-artifact-review-v3-seal-causal-gate-s0:prefreeze-causality-model-check-v1",
  counts: {
    phases: PROTOCOL_PHASES.length,
    legalTraces: legal.length,
    knownBadTraces: knownBad.length,
    schemaNegatives: schemaNegatives.length,
    faultClasses: FAULT_CLASSES.length,
    accountingRows: ACCOUNTING_ROWS.length,
    exploredStates: exploration.states,
    sequenceRenumberings: sequence.variants,
  },
  invariants: {
    authorizationBasis: "event-identity-reachability",
    authorizedExploredStates: exploration.authorizedStates,
    malformedDisplayOrdersObserved: sequence.malformedDisplayOrders,
    uniqueMutationKills: new Set(MUTATION_MATRIX.map(({ uniqueKill }) => uniqueKill)).size,
    durableSpentState: "reconstructed-from-append-only-consumption-events",
    keyGateCustody: "recorder-minted-after-exact-ack",
    brokerTransaction: "single-atomic-consume-launch-query",
  },
  findings: [],
};
result.checkDigest = domainDigest("deterministic-check-result/v1", result);
process.stdout.write(`${canonicalJson(result)}\n`);
