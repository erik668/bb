import assert from "node:assert/strict";
import {
  ACCOUNTING_CATEGORIES,
  ACCOUNTING_ROWS,
  ADAPTER_ALLOCATION,
  AUTHORITY,
  CONTEXT_BINDINGS,
  CONTROLS,
  DERIVED_BINDINGS,
  EVENT_DEFINITIONS,
  EVENT_SLOTS,
  FAULT_SPECS,
  FORBIDDEN_APIS,
  PHASES,
  RELATION_PARTITION,
  REQUIRED_RELATIONS,
  SCHEMA_NEGATIVE_SPECS,
  SDK_ROWS,
} from "./oracle-contract.mjs";
import {
  generateKnownBadTraces,
  generateSchemaNegatives,
  generateSequenceVariants,
  makeLegalTrace,
} from "./mutation-generator.mjs";
import {
  classifyRelation,
  evaluateTrace,
} from "./partial-order-oracle.mjs";

function setOf(values) {
  return new Set(values);
}

function assertExactSet(actual, expected, label) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), label);
}

function relationWitness(relation) {
  if (relation === "same") {
    return [new Map([["event", { predecessors: [] }]]), "event", "event"];
  }
  if (relation === "valid-after") {
    return [
      new Map([
        ["anchor", { predecessors: [] }],
        ["subject", { predecessors: ["anchor"] }],
      ]),
      "anchor",
      "subject",
    ];
  }
  if (relation === "before") {
    return [
      new Map([
        ["anchor", { predecessors: ["subject"] }],
        ["subject", { predecessors: [] }],
      ]),
      "anchor",
      "subject",
    ];
  }
  return [
    new Map([
      ["anchor", { predecessors: [] }],
      ["subject", { predecessors: [] }],
    ]),
    "anchor",
    "subject",
  ];
}

function verifyCompleteRelationPartition() {
  let checks = 0;
  for (const [anchorSlot, subjectSlot] of REQUIRED_RELATIONS) {
    for (const partition of RELATION_PARTITION) {
      const [events, anchorId, subjectId] = relationWitness(partition.id);
      assert.equal(
        classifyRelation(events, anchorId, subjectId),
        partition.id,
        `${anchorSlot}->${subjectSlot}:${partition.id}`,
      );
      assert.equal(
        partition.authorized,
        partition.id === "valid-after",
        `authorization partition for ${partition.id}`,
      );
      checks += 1;
    }
  }
  return checks;
}

function verifyFrozenIdentity() {
  assert.equal(AUTHORITY.architectureRevision, 2);
  assert.equal(AUTHORITY.serviceContract, "bb-artifact-review-service:revision-1");
  assert.equal(
    AUTHORITY.acceptedContractSha256,
    "b4bbedd9460e1dee4389c2d13f7831f341105063924fca81afa787551fd99ebc",
  );
  assert.equal(
    AUTHORITY.v12ManifestSha256,
    "c074fc850151672da17f2b6478782a90becacef0a5641154c731033cb90a8a3b",
  );
  assert.equal(
    AUTHORITY.v12ApprovalSha256,
    "c28b4884022b615491ba826ca6a6a2604d97c39b914d4ee44fdc406e30ea28e0",
  );
  assert.equal(
    AUTHORITY.v12LedgerSha256,
    "ee24d026bffba3b976dfbc0363193459b0c7d98c22f362b2d9a18b01b0c1e1d7",
  );
  assert.deepEqual(AUTHORITY.negativeLineage, [
    "V9",
    "V10",
    "V11",
    "C0",
    "C1",
    "C2",
    "A0",
    "P1",
    "R0",
  ]);
}

function verifyAccountingIdentity() {
  assert.deepEqual(
    ACCOUNTING_CATEGORIES.map(([, count]) => count),
    [20, 18, 37, 5, 12, 5, 30, 7],
  );
  assert.equal(
    ACCOUNTING_CATEGORIES.reduce((total, [, count]) => total + count, 0),
    134,
  );
  assert.equal(ACCOUNTING_ROWS.length, 134);
  assert.equal(setOf(ACCOUNTING_ROWS.map(({ id }) => id)).size, 134);
  assert.equal(CONTROLS.length, 17);
  assert.equal(setOf(CONTROLS).size, 17);
  assert.equal(SDK_ROWS.length, 30);
  assert.equal(setOf(SDK_ROWS).size, 30);
  assert.deepEqual(ADAPTER_ALLOCATION, { reference: 42, fault: 4, restart: 4 });
}

function verifyMutationCoverage(sequenceVariants) {
  const mutations = FAULT_SPECS.map(({ mutation }) => mutation);
  const bindingTargets = setOf(
    mutations
      .filter(({ type }) => type === "binding")
      .map(({ slot, field }) => `${slot}:${field}`),
  );
  const expectedBindingTargets = setOf(
    EVENT_SLOTS.flatMap((slot) =>
      [...CONTEXT_BINDINGS, ...DERIVED_BINDINGS[slot]].map(
        (field) => `${slot}:${field}`,
      ),
    ),
  );
  assertExactSet(bindingTargets, expectedBindingTargets, "every binding is perturbed");

  const missingEdges = setOf(
    mutations
      .filter(
        ({ type, mode }) => type === "predecessor" && mode === "missing",
      )
      .map(({ slot, predecessorSlot }) => `${predecessorSlot}->${slot}`),
  );
  const expectedEdges = setOf(
    EVENT_SLOTS.flatMap((slot) =>
      EVENT_DEFINITIONS[slot].predecessorSlots.map(
        (predecessorSlot) => `${predecessorSlot}->${slot}`,
      ),
    ),
  );
  assertExactSet(missingEdges, expectedEdges, "every predecessor edge is perturbed");

  assertExactSet(
    setOf(
      mutations
        .filter(({ type }) => type === "issuer")
        .map(({ slot }) => slot),
    ),
    setOf(EVENT_SLOTS),
    "every issuer is perturbed",
  );
  assertExactSet(
    setOf(
      mutations
        .filter(({ type, mode }) => type === "identity" && mode === "tamper")
        .map(({ slot }) => slot),
    ),
    setOf(EVENT_SLOTS),
    "every event identity is perturbed",
  );
  assertExactSet(
    setOf(sequenceVariants.flatMap(({ mutatedSlots }) => mutatedSlots)),
    setOf(EVENT_SLOTS),
    "every sequence number is perturbed",
  );
  assertExactSet(
    setOf(
      mutations
        .filter(({ type }) => type === "consumption")
        .map(({ mode }) => mode),
    ),
    setOf([
      "zero",
      "sequential-duplicate",
      "concurrent-duplicate",
      "wrong-gate",
    ]),
    "consumption cardinality matrix",
  );
  assertExactSet(
    setOf(
      mutations
        .filter(({ type }) => type === "restart")
        .map(({ mode }) => mode),
    ),
    setOf([
      "not-independent",
      "not-closed",
      "not-reopened",
      "missing-spent",
      "missing-consumption-evidence",
      "wrong-consumption-evidence",
      "poisoned-prior",
      "accepted-replay",
    ]),
    "restart state matrix",
  );
  assertExactSet(
    setOf(
      mutations.filter(({ type }) => type === "api").map(({ api }) => api),
    ),
    setOf(FORBIDDEN_APIS),
    "universal and coordinator API matrix",
  );
}

function main() {
  verifyFrozenIdentity();
  assert.deepEqual(
    PHASES.map(({ number }) => number),
    Array.from({ length: 12 }, (_, index) => index + 1),
  );
  assert.equal(setOf(PHASES.map(({ id }) => id)).size, 12);
  verifyAccountingIdentity();

  assert.equal(setOf(FAULT_SPECS.map(({ id }) => id)).size, FAULT_SPECS.length);
  assert.equal(
    setOf(FAULT_SPECS.map(({ obligation }) => obligation)).size,
    FAULT_SPECS.length,
    "every fault class needs a unique oracle obligation",
  );
  assert.equal(
    setOf(FAULT_SPECS.map(({ killer }) => killer)).size,
    FAULT_SPECS.length,
    "every fault class needs a unique killer",
  );

  const relationPartitionChecks = verifyCompleteRelationPartition();
  const baseTrace = makeLegalTrace();
  const base = evaluateTrace(baseTrace);
  assert.equal(base.authorized, true, base.errors.join("\n"));
  assert.deepEqual(base.metadataErrors, []);

  const knownBad = generateKnownBadTraces();
  assert.ok(knownBad.length >= 20);
  const survivors = knownBad.flatMap(({ spec, trace }) => {
    const result = evaluateTrace(trace);
    return result.authorized || !result.errors.includes(spec.killer)
      ? [{ id: spec.id, killer: spec.killer, result }]
      : [];
  });
  assert.deepEqual(survivors, []);

  const schemaNegatives = generateSchemaNegatives();
  const schemaSurvivors = schemaNegatives.flatMap(({ spec, trace }) => {
    const result = evaluateTrace(trace);
    return result.authorized || !result.errors.includes(spec.killer)
      ? [{ id: spec.id, killer: spec.killer, result }]
      : [];
  });
  assert.deepEqual(schemaSurvivors, []);

  const sequenceVariants = generateSequenceVariants();
  verifyMutationCoverage(sequenceVariants);
  const baseIdentities = baseTrace.events.map(({ id }) => id);
  let malformedMetadataVariants = 0;
  for (const { id, trace } of sequenceVariants) {
    const result = evaluateTrace(trace);
    assert.equal(result.authorized, true, `${id}: ${result.errors.join(",")}`);
    assert.deepEqual(
      trace.events.map((current) => current.id),
      baseIdentities,
      `${id}: sequence metadata must not alter canonical event identity`,
    );
    if (result.metadataErrors.length > 0) malformedMetadataVariants += 1;
  }
  assert.ok(malformedMetadataVariants > 0);

  const report = {
    verdict: "ready",
    seamId: AUTHORITY.seamId,
    synthesis: {
      runId: AUTHORITY.synthesisRunId,
      sha256: AUTHORITY.synthesisSha256,
    },
    counts: {
      phases: PHASES.length,
      legalTraces: 1 + sequenceVariants.length,
      knownBadTraces: knownBad.length,
      schemaNegatives: schemaNegatives.length,
      faultClasses: FAULT_SPECS.length,
      accountingRows: ACCOUNTING_ROWS.length,
      controls: CONTROLS.length,
      sdkRows: SDK_ROWS.length,
      relationPartitionChecks,
    },
    allocations: {
      categories: Object.fromEntries(ACCOUNTING_CATEGORIES),
      adapters: ADAPTER_ALLOCATION,
    },
    invariants: {
      legalReachability: true,
      strictDescendantOnly: true,
      incomparabilityRejected: true,
      cyclesRejected: true,
      canonicalDigestUnique: true,
      recorderOnlyMint: true,
      exactGateBindings: true,
      singleAtomicConsumption: true,
      restartDurableSpentReconstruction: true,
      sequenceAuthorizationInvariant: true,
      universalApiUnreachable: true,
      r0PositiveInputs: 0,
    },
    findings: [],
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
