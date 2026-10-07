export const AUTHORITY = Object.freeze({
  seamId:
    "bb-artifact-review-v3-seal-causal-gate-s0:prefreeze-causality-model-check-v1",
  architectureRevision: 2,
  serviceContract: "bb-artifact-review-service:revision-1",
  acceptedContractSha256:
    "b4bbedd9460e1dee4389c2d13f7831f341105063924fca81afa787551fd99ebc",
  v12ManifestSha256:
    "c074fc850151672da17f2b6478782a90becacef0a5641154c731033cb90a8a3b",
  v12ApprovalSha256:
    "c28b4884022b615491ba826ca6a6a2604d97c39b914d4ee44fdc406e30ea28e0",
  v12LedgerSha256:
    "ee24d026bffba3b976dfbc0363193459b0c7d98c22f362b2d9a18b01b0c1e1d7",
  synthesisRunId: "wfr_25b94782-1c45-469a-9d51-484dedaad0b5",
  synthesisSha256:
    "d3dee9b918f85890828e6958417679a6d6c8e39585916a7b7dd5b3792619ac0b",
  negativeLineage: Object.freeze([
    "V9",
    "V10",
    "V11",
    "C0",
    "C1",
    "C2",
    "A0",
    "P1",
    "R0",
  ]),
  productFacts: Object.freeze([
    "server-assigned local-owner",
    "origin authority",
    "presentation grant-only",
    "committed-only Saved",
    "content-addressed bytes",
    "append-only truth",
    "immutable migrations 0..22",
    "independent restart verification",
    "legacy non-adoption",
    "dark consumers",
  ]),
});

export const PHASES = Object.freeze([
  [1, "bind-run", "bind a fresh run identity"],
  [2, "bind-row", "bind one frozen-accounting row"],
  [3, "issue-challenge", "bind a fresh challenge and nonce"],
  [4, "commit-subject", "commit the content-addressed subject"],
  [5, "close-ledger", "close append-only truth"],
  [6, "reopen-ledger", "independently reopen retained truth"],
  [7, "record-seal", "record the sealed-ledger digest"],
  [8, "verify-seal", "independently verify the exact seal"],
  [9, "append-ack", "append canonical immutable SEAL_VERIFIED_ACK"],
  [10, "mint-gate", "recorder alone mints the exact bound KEY_GATE"],
  [11, "consume-gate", "atomically append exactly one gate consumption"],
  [12, "launch-query", "append both receipts for one broker transaction"],
].map(([number, id, obligation]) => Object.freeze({ number, id, obligation })));

export const ACCOUNTING_CATEGORIES = Object.freeze([
  ["ordinary-commit", 20],
  ["recovery-continuation", 18],
  ["causal-authority", 37],
  ["restart-durability", 5],
  ["retained-evidence", 12],
  ["legacy-non-adoption", 5],
  ["genuine-sdk-replay", 30],
  ["dark-consumer-boundary", 7],
]);

export const ACCOUNTING_ROWS = Object.freeze(
  ACCOUNTING_CATEGORIES.flatMap(([category, count]) =>
    Array.from({ length: count }, (_, index) =>
      Object.freeze({
        id: `${category}:${String(index + 1).padStart(3, "0")}`,
        category,
      }),
    ),
  ),
);

export const CONTROLS = Object.freeze(
  Array.from(
    { length: 17 },
    (_, index) => `control:${String(index + 1).padStart(2, "0")}`,
  ),
);

export const SDK_ROWS = Object.freeze(
  ACCOUNTING_ROWS.filter(
    ({ category }) => category === "genuine-sdk-replay",
  ).map(({ id }) => id),
);

export const ADAPTER_ALLOCATION = Object.freeze({
  reference: 42,
  fault: 4,
  restart: 4,
});

export const EVENT_DEFINITIONS = Object.freeze({
  ack: Object.freeze({
    kind: "SEAL_VERIFIED_ACK",
    issuer: "recorder",
    predecessorSlots: Object.freeze([]),
  }),
  mint: Object.freeze({
    kind: "KEY_GATE_MINT",
    issuer: "recorder",
    predecessorSlots: Object.freeze(["ack"]),
  }),
  consume: Object.freeze({
    kind: "KEY_GATE_CONSUMED",
    issuer: "broker",
    predecessorSlots: Object.freeze(["ack", "mint"]),
  }),
  launch: Object.freeze({
    kind: "BROKER_LAUNCH_RECEIPT",
    issuer: "broker",
    predecessorSlots: Object.freeze(["consume"]),
  }),
  query: Object.freeze({
    kind: "BROKER_QUERY_RECEIPT",
    issuer: "broker",
    predecessorSlots: Object.freeze(["consume"]),
  }),
});

export const EVENT_SLOTS = Object.freeze(Object.keys(EVENT_DEFINITIONS));

export const DIRECT_RELATIONS = Object.freeze([
  ["ack", "mint"],
  ["mint", "consume"],
  ["consume", "launch"],
  ["consume", "query"],
]);

export const REQUIRED_RELATIONS = Object.freeze([
  ["ack", "mint"],
  ["ack", "consume"],
  ["ack", "launch"],
  ["ack", "query"],
  ["mint", "consume"],
  ["mint", "launch"],
  ["mint", "query"],
  ["consume", "launch"],
  ["consume", "query"],
]);

export const RELATION_PARTITION = Object.freeze([
  Object.freeze({ id: "before", authorized: false }),
  Object.freeze({ id: "same", authorized: false }),
  Object.freeze({ id: "valid-after", authorized: true }),
  Object.freeze({ id: "incomparable", authorized: false }),
]);

export const CONTEXT_BINDINGS = Object.freeze([
  "runId",
  "rowId",
  "challenge",
  "nonce",
  "sealedLedgerDigest",
  "verifierId",
  "recorderId",
  "brokerId",
  "operationScope",
]);

export const DERIVED_BINDINGS = Object.freeze({
  ack: Object.freeze(["sealValidated"]),
  mint: Object.freeze(["sealAckDigest"]),
  consume: Object.freeze(["sealAckDigest", "gateDigest", "atomic"]),
  launch: Object.freeze([
    "sealAckDigest",
    "gateDigest",
    "gateConsumptionDigest",
  ]),
  query: Object.freeze([
    "sealAckDigest",
    "gateDigest",
    "gateConsumptionDigest",
  ]),
});

export const API_ALLOWLIST = Object.freeze([
  "recorder.appendSealVerifiedAck",
  "recorder.mintBoundKeyGate",
  "broker.consumeGateAndLaunchQuery",
]);

export const FORBIDDEN_APIS = Object.freeze([
  "coordinator.mint",
  "coordinator.launch",
  "coordinator.consume",
  "coordinator.recorder",
  "coordinator.journal",
  "universal.mint",
  "universal.launch",
]);

function fault(id, family, mutation, obligation, killer) {
  return Object.freeze({
    id,
    family,
    mutation: Object.freeze(mutation),
    obligation,
    killer,
  });
}

const relationFaults = DIRECT_RELATIONS.flatMap(([anchor, subject]) =>
  ["before", "same", "incomparable"].map((relation) =>
    fault(
      `relation-${anchor}-${subject}-${relation}`,
      "partial-order",
      { type: "relation", anchor, subject, relation },
      `${anchor}->${subject} must classify valid-after, not ${relation}`,
      `relation:${anchor}->${subject}:expected-valid-after:actual-${relation}`,
    ),
  ),
);

const bindingFaults = EVENT_SLOTS.flatMap((slot) =>
  [...CONTEXT_BINDINGS, ...DERIVED_BINDINGS[slot]].map((field) => {
    const isReplay =
      slot === "query" &&
      [
        "runId",
        "rowId",
        "challenge",
        "nonce",
        "sealedLedgerDigest",
        "brokerId",
        "operationScope",
      ].includes(field);
    const family = isReplay ? "replay" : "binding-forgery";
    const value =
      field === "sealValidated" || field === "atomic"
        ? false
        : `${family}:${field}`;
    const killer =
      field === "sealValidated"
        ? "ack:not-validated"
        : field === "atomic"
          ? "consume:not-atomic"
          : `binding:mismatch:${slot}:${field}`;
    return fault(
      `${family}-${slot}-${field}`,
      family,
      { type: "binding", slot, field, value },
      `${slot} must bind its exact immutable ${field}`,
      killer,
    );
  }),
);

const issuerFaults = EVENT_SLOTS.map((slot) =>
  fault(
    `forged-issuer-${slot}`,
    "issuer-forgery",
    {
      type: "issuer",
      slot,
      issuer: slot === "mint" ? "coordinator" : "forger",
    },
    `${slot} must be issued only by ${EVENT_DEFINITIONS[slot].issuer}`,
    `issuer:mismatch:${slot}`,
  ),
);

const missingPredecessorFaults = EVENT_SLOTS.flatMap((slot) =>
  EVENT_DEFINITIONS[slot].predecessorSlots.map((predecessorSlot) =>
    fault(
      `missing-edge-${predecessorSlot}-${slot}`,
      "predecessor-forgery",
      { type: "predecessor", mode: "missing", slot, predecessorSlot },
      `${slot} must name the exact ${predecessorSlot} identity as a predecessor`,
      `predecessor:missing:${slot}:${predecessorSlot}`,
    ),
  ),
);

const unexpectedPredecessorFaults = EVENT_SLOTS.map((slot) =>
  fault(
    `unexpected-edge-${slot}`,
    "predecessor-forgery",
    { type: "predecessor", mode: "unexpected", slot },
    `${slot} must reject every predecessor outside its exact set`,
    `predecessor:unexpected:${slot}:rogue`,
  ),
);

const consumptionFaults = Object.freeze([
  fault(
    "zero-consumption",
    "consumption-cardinality",
    { type: "consumption", mode: "zero" },
    "the broker transaction must consume KEY_GATE exactly once",
    "consumption:cardinality:0",
  ),
  fault(
    "sequential-duplicate-consumption",
    "consumption-cardinality",
    { type: "consumption", mode: "sequential-duplicate" },
    "a later attempt cannot consume the spent KEY_GATE",
    "consumption:sequential-duplicate",
  ),
  fault(
    "concurrent-duplicate-consumption",
    "consumption-cardinality",
    { type: "consumption", mode: "concurrent-duplicate" },
    "atomic consumption admits only one concurrent winner",
    "consumption:concurrent-duplicate",
  ),
  fault(
    "wrong-gate-consumption",
    "consumption-cardinality",
    { type: "consumption", mode: "wrong-gate" },
    "the accepted attempt must consume the exact KEY_GATE identity",
    "consumption:gate-mismatch",
  ),
]);

const restartFaults = [
  ["not-independent", "independent restart verification is mandatory", "restart:not-independent"],
  ["not-closed", "retained truth is closed before restart", "restart:not-closed"],
  ["not-reopened", "retained truth is reopened after restart", "restart:not-reopened"],
  ["missing-spent", "spent state is reconstructed durably", "restart:spent-not-reconstructed"],
  ["missing-consumption-evidence", "spent state names its consumption event", "restart:consumption-evidence-missing"],
  ["wrong-consumption-evidence", "spent state names the exact consumption event", "restart:consumption-evidence-wrong"],
  ["poisoned-prior", "foreign prior receipts never create authority", "restart:poisoned-prior-receipt"],
  ["accepted-replay", "a spent gate remains rejected after restart", "restart:replay-accepted"],
].map(([mode, obligation, killer]) =>
  fault(
    `restart-${mode}`,
    "restart-state",
    { type: "restart", mode },
    obligation,
    killer,
  ),
);

const identityFaults = [
  ...EVENT_SLOTS.map((slot) =>
    fault(
      `identity-tamper-${slot}`,
      "event-identity",
      { type: "identity", mode: "tamper", slot },
      `${slot} identity must equal the digest of its canonical immutable bytes`,
      `identity:digest-mismatch:${slot}`,
    ),
  ),
  fault(
    "canonical-digest-alias",
    "event-identity",
    { type: "identity", mode: "alias" },
    "one digest must identify exactly one canonical object",
    "identity:alias",
  ),
  ...EVENT_SLOTS.map((slot) =>
    fault(
      `domain-forgery-${slot}`,
      "event-identity",
      { type: "identity", mode: "domain", slot },
      `${slot} must use its kind-specific domain separator`,
      `identity:domain-mismatch:${slot}`,
    ),
  ),
  ...EVENT_SLOTS.map((slot) =>
    fault(
      `kind-forgery-${slot}`,
      "event-identity",
      { type: "identity", mode: "kind", slot },
      `${slot} must use its one canonical event kind`,
      `identity:kind-mismatch:${slot}`,
    ),
  ),
];

const cycleFaults = [
  ...EVENT_SLOTS.map((slot) =>
    fault(
      `self-cycle-${slot}`,
      "cycle",
      { type: "cycle", mode: "self", slot },
      `${slot} cannot precede itself`,
      `graph:self-cycle:${slot}`,
    ),
  ),
  fault(
    "multi-event-cycle",
    "cycle",
    { type: "cycle", mode: "multi" },
    "the canonical event relation must be acyclic",
    "graph:cycle",
  ),
];

const atomicFaults = [
  ["consume-launch-split", "consume and launch share one transaction", "atomic:transaction-mismatch:launch"],
  ["consume-query-split", "consume and query share one transaction", "atomic:transaction-mismatch:query"],
  ["missing-launch", "the atomic transaction emits a launch receipt", "receipt:missing:launch"],
  ["missing-query", "the atomic transaction emits a query receipt", "receipt:missing:query"],
].map(([mode, obligation, killer]) =>
  fault(
    `atomic-${mode}`,
    "atomic-transaction",
    { type: "atomic", mode },
    obligation,
    killer,
  ),
);

const apiFaults = FORBIDDEN_APIS.map((api) =>
  fault(
    `forbidden-api-${api}`,
    "universal-api",
    { type: "api", api },
    `${api} must be unreachable from the authority surface`,
    `api:forbidden:${api}`,
  ),
);

export const FAULT_SPECS = Object.freeze([
  ...relationFaults,
  ...bindingFaults,
  ...issuerFaults,
  ...missingPredecessorFaults,
  ...unexpectedPredecessorFaults,
  ...consumptionFaults,
  ...restartFaults,
  ...identityFaults,
  ...cycleFaults,
  ...atomicFaults,
  ...apiFaults,
]);

export const SCHEMA_NEGATIVE_SPECS = Object.freeze([
  ["trace-missing", "trace-missing", "schema:trace"],
  ["events-missing", "events-missing", "schema:events:missing"],
  ["events-type", "events-type", "schema:events:type"],
  ["context-missing", "context-missing", "schema:context:missing"],
  ["slot-duplicate", "slot-duplicate", "schema:slot:duplicate"],
  ["slot-unknown", "slot-unknown", "schema:slot:unknown"],
  ["predecessors-type", "predecessors-type", "schema:predecessors:type:mint"],
  ["sequence-type", "sequence-type", "schema:sequence:type:ack"],
  ["bindings-type", "bindings-type", "schema:bindings:type:mint"],
  ["identity-type", "identity-type", "schema:identity:type:ack"],
  ["attempts-type", "attempts-type", "schema:consumption-attempts:type"],
  ["restart-missing", "restart-missing", "schema:restart:missing"],
  ["api-type", "api-type", "schema:api-surface:type"],
].map(([id, mode, killer]) => Object.freeze({ id, mode, killer })));
