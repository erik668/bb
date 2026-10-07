import { createHash } from "node:crypto";

export const AUTHORITY_ID =
  "bb-artifact-review-v3-opaque-journal-authority-r0:prefreeze-model-check-v1";

export const CHECKER_IDENTITY = Object.freeze({
  id: "bb-artifact-review-v3-opaque-journal-authority-r0-checker",
  version: "1.0.0",
  configuration: Object.freeze({
    canonicalBytes: "canonical-json-utf8-no-terminal-newline-v1",
    digest: "sha256-lowercase-hex-v1",
    exploration: "all-prefixes-and-every-next-phase-v1",
    maximumEvents: 12,
    schemaDialect: "json-schema-2020-12-closed-objects-v1",
    transitionEngine: "single-engine-no-defect-branch-v1",
  }),
});

export const FROZEN_INPUTS = Object.freeze({
  architectureRevision: 2,
  serviceContract: "bb-artifact-review-service:revision-1",
  baselineHead: "e2b88b053c1e9823e56d71e7f7861fd351d94d5d",
  acceptedContract: Object.freeze({
    byteLength: 20806,
    sha256: "b4bbedd9460e1dee4389c2d13f7831f341105063924fca81afa787551fd99ebc",
  }),
  v12: Object.freeze({
    manifestByteLength: 798,
    manifestSha256:
      "c074fc850151672da17f2b6478782a90becacef0a5641154c731033cb90a8a3b",
    approvalSha256:
      "c28b4884022b615491ba826ca6a6a2604d97c39b914d4ee44fdc406e30ea28e0",
    ledgerSha256:
      "ee24d026bffba3b976dfbc0363193459b0c7d98c22f362b2d9a18b01b0c1e1d7",
  }),
  negativeLineageOnly: Object.freeze([
    "V9",
    "V10",
    "V11",
    "C0",
    "C1",
    "C2",
    "A0-attempt-1",
    "A0-attempt-2",
    "P1",
  ]),
  exclusions: Object.freeze([
    "malicious-writer-authenticity",
    "shared-host-mutation",
    "cross-environment-continuation",
    "deployment",
    "adoption",
    "rollout",
    "product-consumer-lighting",
  ]),
});

export const PHASES = Object.freeze([
  "ALLOCATED",
  "DISPATCHED",
  "BOUNDARY_CAPTURED",
  "RAW_PERSISTED",
  "CANDIDATE_CLOSED",
  "REOPENED",
  "REOPEN_PERSISTED",
  "ACTUAL_SEALED",
  "NORMALIZED",
  "KEY_RELEASED",
  "ADJUDICATED",
  "REVIEW_EXPORTED",
]);

export const TRANSITIONS = Object.freeze([
  Object.freeze({ from: -1, to: 0 }),
  Object.freeze({ from: 0, to: 1 }),
  Object.freeze({ from: 1, to: 2 }),
  Object.freeze({ from: 2, to: 3 }),
  Object.freeze({ from: 3, to: 4 }),
  Object.freeze({ from: 4, to: 5 }),
  Object.freeze({ from: 5, to: 6 }),
  Object.freeze({ from: 6, to: 7 }),
  Object.freeze({ from: 7, to: 8 }),
  Object.freeze({ from: 8, to: 9 }),
  Object.freeze({ from: 9, to: 10 }),
  Object.freeze({ from: 10, to: 11 }),
]);

export const CAPABILITY_MATRIX = Object.freeze([
  Object.freeze({
    phase: 0,
    predecessorPhase: -1,
    actorSlot: "allocator",
    issuer: "external-recorder",
    singleUse: true,
  }),
  Object.freeze({
    phase: 1,
    predecessorPhase: 0,
    actorSlot: "dispatcher",
    issuer: "external-recorder",
    singleUse: true,
  }),
  Object.freeze({
    phase: 2,
    predecessorPhase: 1,
    actorSlot: "boundary-capture",
    issuer: "external-recorder",
    singleUse: true,
  }),
  Object.freeze({
    phase: 3,
    predecessorPhase: 2,
    actorSlot: "raw-persistence",
    issuer: "external-recorder",
    singleUse: true,
  }),
  Object.freeze({
    phase: 4,
    predecessorPhase: 3,
    actorSlot: "close-supervisor",
    issuer: "external-recorder",
    singleUse: true,
  }),
  Object.freeze({
    phase: 5,
    predecessorPhase: 4,
    actorSlot: "independent-reopener",
    issuer: "external-recorder",
    singleUse: true,
  }),
  Object.freeze({
    phase: 6,
    predecessorPhase: 5,
    actorSlot: "reopen-persistence",
    issuer: "external-recorder",
    singleUse: true,
  }),
  Object.freeze({
    phase: 7,
    predecessorPhase: 6,
    actorSlot: "seal-verifier",
    issuer: "external-recorder",
    singleUse: true,
  }),
  Object.freeze({
    phase: 8,
    predecessorPhase: 7,
    actorSlot: "normalizer",
    issuer: "external-recorder",
    singleUse: true,
  }),
  Object.freeze({
    phase: 9,
    predecessorPhase: 8,
    actorSlot: "key-broker",
    issuer: "external-recorder",
    singleUse: true,
  }),
  Object.freeze({
    phase: 10,
    predecessorPhase: 9,
    actorSlot: "adjudicator",
    issuer: "external-recorder",
    singleUse: true,
  }),
  Object.freeze({
    phase: 11,
    predecessorPhase: 10,
    actorSlot: "reviewer",
    issuer: "external-recorder",
    singleUse: true,
  }),
]);

const DIGEST_PATTERN = "^[0-9a-f]{64}$";
const OPAQUE_ID_PATTERN = "^[0-9a-f]{32,64}$";
const BASE64_PATTERN =
  "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";

export const EVENT_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: Object.freeze([
    "version",
    "runId",
    "rowId",
    "sequence",
    "phase",
    "previousEventDigest",
    "actorInstanceDigest",
    "capabilityGrantDigest",
    "bodyByteLength",
    "bodyDigest",
  ]),
  properties: Object.freeze({
    version: Object.freeze({ const: "r0-event-v1" }),
    runId: Object.freeze({ type: "string", pattern: OPAQUE_ID_PATTERN }),
    rowId: Object.freeze({ type: "string", pattern: OPAQUE_ID_PATTERN }),
    sequence: Object.freeze({ type: "integer", minimum: 0, maximum: 11 }),
    phase: Object.freeze({ type: "integer", minimum: 0, maximum: 11 }),
    previousEventDigest: Object.freeze({
      type: "string",
      pattern: DIGEST_PATTERN,
    }),
    actorInstanceDigest: Object.freeze({
      type: "string",
      pattern: DIGEST_PATTERN,
    }),
    capabilityGrantDigest: Object.freeze({
      type: "string",
      pattern: DIGEST_PATTERN,
    }),
    bodyByteLength: Object.freeze({ type: "integer", minimum: 0 }),
    bodyDigest: Object.freeze({ type: "string", pattern: DIGEST_PATTERN }),
    boundaryBytes: Object.freeze({ type: "string", pattern: BASE64_PATTERN }),
  }),
});

export const BOUNDARY_BYTE_PHASES = Object.freeze([2, 3, 6, 7, 11]);

export const BODY_SCHEMAS = Object.freeze(
  Object.fromEntries(
    PHASES.map((_, phase) => [
      String(phase),
      Object.freeze({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: Object.freeze(
          BOUNDARY_BYTE_PHASES.includes(phase)
            ? ["version", "boundaryBytes"]
            : ["version"],
        ),
        properties: Object.freeze({
          version: Object.freeze({ const: "r0-body-v1" }),
          ...(BOUNDARY_BYTE_PHASES.includes(phase)
            ? {
                boundaryBytes: Object.freeze({
                  type: "string",
                  pattern: BASE64_PATTERN,
                  minLength: 4,
                }),
              }
            : {}),
        }),
      }),
    ]),
  ),
);

export const DATA_PLANE_ARTIFACT_SCHEMA = EVENT_SCHEMA;
export const ACTOR_OUTPUT_SCHEMA = EVENT_SCHEMA;

export const CANONICAL_BYTE_RULES = Object.freeze({
  encoding: "utf8",
  objectKeys: "unicode-code-point-ascending",
  arrays: "preserve-order",
  numbers: "finite-safe-integers-decimal-only",
  strings: "json-escaped",
  unsupportedValues: "reject",
  terminalNewline: false,
  digest: "sha256-lowercase-hex",
  eventDigest: "sha256(canonical-event-bytes)",
  bodyDigest: "sha256(canonical-body-bytes)",
  genesisPreviousEventDigest: "sha256(canonical-genesis-authority-bytes)",
});

export const CONFORMANCE_RULES = Object.freeze([
  Object.freeze({
    id: "R01",
    statement:
      "Event and body objects are closed and phase schemas authorize opaque bytes.",
  }),
  Object.freeze({
    id: "R02",
    statement:
      "Canonical UTF-8 bytes have stable sorted keys, integer numbers, no newline, and SHA-256 digests.",
  }),
  Object.freeze({
    id: "R03",
    statement:
      "The only legal chronology is the exact twelve-phase prefix grammar.",
  }),
  Object.freeze({
    id: "R04",
    statement: "Every phase consumes one phase-scoped capability exactly once.",
  }),
  Object.freeze({
    id: "R05",
    statement:
      "Only the external recorder mints after acknowledging the predecessor event.",
  }),
  Object.freeze({
    id: "R06",
    statement:
      "The coordinator owns no actor launch, mint, journal, recorder, or universal capability.",
  }),
  Object.freeze({
    id: "R07",
    statement: "Candidate close is observed before independent reopen.",
  }),
  Object.freeze({
    id: "R08",
    statement:
      "Independent actual seal precedes normalization and key release.",
  }),
  Object.freeze({
    id: "R09",
    statement:
      "The sealed actual digest is immutable through reveal and export.",
  }),
  Object.freeze({
    id: "R10",
    statement:
      "The key broker launches and queries the key holder only after independent seal verification.",
  }),
  Object.freeze({
    id: "R11",
    statement:
      "Candidate and coordinator never read private plaintext expectations.",
  }),
  Object.freeze({
    id: "R12",
    statement:
      "Exact opaque evidence members, identities, chronology, and chain survive final review.",
  }),
  Object.freeze({
    id: "R13",
    statement:
      "Positive and defective traces enter the same dispatcher, journal, and transition engine.",
  }),
  Object.freeze({
    id: "R14",
    statement:
      "A defective trace changes exactly one external executable, OS, filesystem, or transport slot.",
  }),
  Object.freeze({
    id: "R15",
    statement:
      "Data-plane events, bodies, artifacts, outputs, and paths contain no semantic labels or aliases.",
  }),
  Object.freeze({
    id: "R16",
    statement:
      "SDK execution binds a fresh challenge, PID, roots, row-owned target, and genuine command.",
  }),
  Object.freeze({
    id: "R17",
    statement:
      "A poisoned prior receipt cannot substitute for the freshly bound SDK command receipt.",
  }),
  Object.freeze({
    id: "R18",
    statement:
      "Accounting independently reconstructs 134 stimuli, 17 controls, 30 SDK rows, and adapter allocation.",
  }),
]);

const ACCOUNTING_CATEGORY_BLOCKS = Object.freeze([
  Object.freeze({ category: "behavior", count: 20 }),
  Object.freeze({ category: "corruption", count: 18 }),
  Object.freeze({ category: "fault", count: 37 }),
  Object.freeze({ category: "dispatch", count: 5 }),
  Object.freeze({ category: "parity", count: 12 }),
  Object.freeze({ category: "reopen", count: 5 }),
  Object.freeze({ category: "sdk", count: 30 }),
  Object.freeze({ category: "darkness", count: 7 }),
]);

let accountingSerial = 0;
export const ACCOUNTING_ROWS = Object.freeze(
  ACCOUNTING_CATEGORY_BLOCKS.flatMap(({ category, count }) =>
    Array.from({ length: count }, (_, offset) => {
      accountingSerial += 1;
      const adapter =
        category === "behavior" ||
        category === "corruption" ||
        (category === "fault" && offset < 4)
          ? "production"
          : category === "sdk" && offset < 4
            ? "sdk-fake"
            : category === "parity" && offset < 4
              ? "workflows-fake"
              : null;
      return Object.freeze({
        rowId: `r${String(accountingSerial).padStart(4, "0")}`,
        category,
        ordinal: offset + 1,
        adapter,
      });
    }),
  ),
);

export const CONTROL_CATALOG = Object.freeze(
  [
    "expectation-access-attempt",
    "fake-production-executor",
    "serialized-return-tamper",
    "candidate-controlled-database-selection",
    "reused-handle-cache",
    "uncommitted-visibility",
    "rollback-failure",
    "database-creation-on-rejected-admission",
    "skipped-sdk-command",
    "stale-runtime-output",
    "stale-declaration-output",
    "regeneration-divergence",
    "registration-substitution",
    "rpc-lighting",
    "ui-lighting",
    "renderer-lighting",
    "live-change-lighting",
  ].map((externalDescription, index) =>
    Object.freeze({
      controlId: `c${String(index + 1).padStart(2, "0")}`,
      externalDescription,
    }),
  ),
);

export const SDK_ROW_CATALOG = Object.freeze(
  [
    "source-entry",
    "clean-consumer-resolution",
    "clean-consumer-import",
    "direct-dist-import",
    "direct-dist-testing-import",
    ...Array.from(
      { length: 12 },
      (_, index) => `runtime-entry-${String(index + 1).padStart(2, "0")}`,
    ),
    ...Array.from(
      { length: 12 },
      (_, index) => `declaration-entry-${String(index + 1).padStart(2, "0")}`,
    ),
    "workflows-typecheck",
  ].map((externalDescription, index) =>
    Object.freeze({
      rowId: ACCOUNTING_ROWS.filter((row) => row.category === "sdk")[index]
        .rowId,
      externalDescription,
    }),
  ),
);

export const ACCOUNTING_IDENTITY = Object.freeze({
  total: 134,
  categories: Object.freeze({
    behavior: 20,
    corruption: 18,
    fault: 37,
    dispatch: 5,
    parity: 12,
    reopen: 5,
    sdk: 30,
    darkness: 7,
  }),
  adapters: Object.freeze({
    production: 42,
    "sdk-fake": 4,
    "workflows-fake": 4,
  }),
  controls: 17,
  sdkRows: 30,
});

export const FAULT_CLASSES = Object.freeze([
  "phase-skip",
  "phase-reorder",
  "duplicate-capability",
  "replayed-capability",
  "coordinator-direct-launch",
  "coordinator-self-mint",
  "candidate-recorder-ownership",
  "pre-close-reopen",
  "pre-seal-normalize",
  "pre-seal-key-release",
  "post-seal-mutation",
  "evidence-deletion",
  "prior-receipt-substitution",
  "reused-pid",
  "reused-root",
  "reused-target",
  "reused-challenge",
  "alternate-defective-path",
  "semantic-field-smuggling",
  "sdk-no-op",
  "sdk-synthetic-marker",
  "private-plaintext-before-release",
]);

export const LEGAL_TRACE_SPECS = Object.freeze([
  Object.freeze({
    id: "legal-prefix-00",
    mode: "production",
    eventIds: Object.freeze([]),
  }),
  Object.freeze({
    id: "legal-prefix-01",
    mode: "production",
    eventIds: Object.freeze([0]),
  }),
  Object.freeze({
    id: "legal-prefix-02",
    mode: "production",
    eventIds: Object.freeze([0, 1]),
  }),
  Object.freeze({
    id: "legal-prefix-03",
    mode: "production",
    eventIds: Object.freeze([0, 1, 2]),
  }),
  Object.freeze({
    id: "legal-prefix-04",
    mode: "production",
    eventIds: Object.freeze([0, 1, 2, 3]),
  }),
  Object.freeze({
    id: "legal-prefix-05",
    mode: "production",
    eventIds: Object.freeze([0, 1, 2, 3, 4]),
  }),
  Object.freeze({
    id: "legal-prefix-06",
    mode: "production",
    eventIds: Object.freeze([0, 1, 2, 3, 4, 5]),
  }),
  Object.freeze({
    id: "legal-prefix-07",
    mode: "production",
    eventIds: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
  }),
  Object.freeze({
    id: "legal-prefix-08",
    mode: "production",
    eventIds: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7]),
  }),
  Object.freeze({
    id: "legal-prefix-09",
    mode: "production",
    eventIds: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8]),
  }),
  Object.freeze({
    id: "legal-prefix-10",
    mode: "production",
    eventIds: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
  }),
  Object.freeze({
    id: "legal-prefix-11",
    mode: "production",
    eventIds: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
  }),
  Object.freeze({
    id: "legal-prefix-12",
    mode: "production",
    eventIds: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
  }),
  Object.freeze({
    id: "legal-sdk-fresh-12",
    mode: "sdk",
    eventIds: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
  }),
]);

export const KNOWN_BAD_TRACE_SPECS = Object.freeze([
  Object.freeze({
    id: "generic-phase-skip",
    lineage: "generic",
    faultClass: "phase-skip",
    slot: "transport",
    delta: Object.freeze({ kind: "phase-skip", eventIndex: 4 }),
  }),
  Object.freeze({
    id: "generic-phase-reorder",
    lineage: "generic",
    faultClass: "phase-reorder",
    slot: "transport",
    delta: Object.freeze({ kind: "phase-reorder", eventIndex: 5 }),
  }),
  Object.freeze({
    id: "generic-duplicate-capability",
    lineage: "generic",
    faultClass: "duplicate-capability",
    slot: "transport",
    delta: Object.freeze({ kind: "duplicate-capability", eventIndex: 3 }),
  }),
  Object.freeze({
    id: "generic-replayed-capability",
    lineage: "generic",
    faultClass: "replayed-capability",
    slot: "transport",
    delta: Object.freeze({ kind: "replayed-capability", eventIndex: 3 }),
  }),
  Object.freeze({
    id: "p1-direct-defective-launch",
    lineage: "authoritative-P1-negative",
    faultClass: "coordinator-direct-launch",
    slot: "executable",
    delta: Object.freeze({ kind: "coordinator-direct-launch" }),
  }),
  Object.freeze({
    id: "generic-coordinator-self-mint",
    lineage: "generic",
    faultClass: "coordinator-self-mint",
    slot: "executable",
    delta: Object.freeze({ kind: "coordinator-self-mint", eventIndex: 4 }),
  }),
  Object.freeze({
    id: "a0-self-derived-recorder",
    lineage: "authoritative-A0-negative",
    faultClass: "candidate-recorder-ownership",
    slot: "filesystem",
    delta: Object.freeze({ kind: "candidate-recorder-ownership" }),
  }),
  Object.freeze({
    id: "generic-pre-close-reopen",
    lineage: "generic",
    faultClass: "pre-close-reopen",
    slot: "os",
    delta: Object.freeze({ kind: "pre-close-reopen" }),
  }),
  Object.freeze({
    id: "generic-pre-seal-normalize",
    lineage: "generic",
    faultClass: "pre-seal-normalize",
    slot: "executable",
    delta: Object.freeze({ kind: "pre-seal-normalize" }),
  }),
  Object.freeze({
    id: "generic-pre-seal-key-release",
    lineage: "generic",
    faultClass: "pre-seal-key-release",
    slot: "executable",
    delta: Object.freeze({ kind: "pre-seal-key-release" }),
  }),
  Object.freeze({
    id: "generic-post-seal-mutation",
    lineage: "generic",
    faultClass: "post-seal-mutation",
    slot: "filesystem",
    delta: Object.freeze({ kind: "post-seal-mutation" }),
  }),
  Object.freeze({
    id: "p1-review-evidence-cleanup",
    lineage: "authoritative-P1-negative",
    faultClass: "evidence-deletion",
    slot: "filesystem",
    delta: Object.freeze({ kind: "evidence-deletion" }),
  }),
  Object.freeze({
    id: "a0-cached-sdk-receipt",
    lineage: "authoritative-A0-negative",
    faultClass: "prior-receipt-substitution",
    slot: "transport",
    mode: "sdk",
    delta: Object.freeze({ kind: "prior-receipt-substitution" }),
  }),
  Object.freeze({
    id: "generic-reused-pid",
    lineage: "generic",
    faultClass: "reused-pid",
    slot: "os",
    mode: "sdk",
    delta: Object.freeze({ kind: "reused-pid" }),
  }),
  Object.freeze({
    id: "generic-reused-root",
    lineage: "generic",
    faultClass: "reused-root",
    slot: "filesystem",
    mode: "sdk",
    delta: Object.freeze({ kind: "reused-root" }),
  }),
  Object.freeze({
    id: "generic-reused-target",
    lineage: "generic",
    faultClass: "reused-target",
    slot: "filesystem",
    mode: "sdk",
    delta: Object.freeze({ kind: "reused-target" }),
  }),
  Object.freeze({
    id: "generic-reused-challenge",
    lineage: "generic",
    faultClass: "reused-challenge",
    slot: "transport",
    mode: "sdk",
    delta: Object.freeze({ kind: "reused-challenge" }),
  }),
  Object.freeze({
    id: "a0-descriptor-derived-terminal",
    lineage: "authoritative-A0-negative",
    faultClass: "alternate-defective-path",
    slot: "executable",
    delta: Object.freeze({ kind: "alternate-defective-path" }),
  }),
  Object.freeze({
    id: "p1-action-terminal-smuggling",
    lineage: "authoritative-P1-negative",
    faultClass: "semantic-field-smuggling",
    slot: "transport",
    delta: Object.freeze({ kind: "semantic-field-smuggling", field: "action" }),
  }),
  Object.freeze({
    id: "p1-sdk-no-op",
    lineage: "authoritative-P1-negative",
    faultClass: "sdk-no-op",
    slot: "executable",
    mode: "sdk",
    delta: Object.freeze({ kind: "sdk-no-op" }),
  }),
  Object.freeze({
    id: "p1-sdk-synthetic-marker",
    lineage: "authoritative-P1-negative",
    faultClass: "sdk-synthetic-marker",
    slot: "filesystem",
    mode: "sdk",
    delta: Object.freeze({ kind: "sdk-synthetic-marker" }),
  }),
  Object.freeze({
    id: "p1-private-map-before-seal",
    lineage: "authoritative-P1-negative",
    faultClass: "private-plaintext-before-release",
    slot: "executable",
    delta: Object.freeze({ kind: "private-plaintext-before-release" }),
  }),
]);

export const FORBIDDEN_DATA_PLANE_FIELDS = Object.freeze([
  "action",
  "fault",
  "reason",
  "category",
  "expected",
  "judgment",
  "terminal",
  "terminalMeaning",
  "kill",
  "control",
  "descriptor",
  "ordinaryPath",
  "typedCode",
  "caseId",
  "verdict",
  "outcome",
  "unknownField",
]);

export const SCHEMA_NEGATIVE_SURFACES = Object.freeze([
  "event",
  "body",
  "artifact",
  "actor-output",
  "journal-path",
]);

export const SCHEMA_NEGATIVE_CORPUS = Object.freeze(
  SCHEMA_NEGATIVE_SURFACES.flatMap((surface) =>
    FORBIDDEN_DATA_PLANE_FIELDS.map((field) =>
      Object.freeze({ id: `${surface}-${field}`, surface, field }),
    ),
  ),
);

const REQUIRED_RETAINED_MEMBER_ROLES = Object.freeze([
  "raw-receipt-bytes",
  "recorder-acknowledgements",
  "persistence-acknowledgement",
  "candidate-close-observation",
  "independent-reopen-observation",
  "sealed-member-bytes",
  "process-identities",
  "root-identities",
  "event-chronology",
  "capability-digests",
  "hash-chain",
]);

export const RETAINED_MEMBER_AUTHORITY = Object.freeze(
  REQUIRED_RETAINED_MEMBER_ROLES.map((externalRole, index) =>
    Object.freeze({
      memberId: sha256(`retained-member-${index}`),
      externalRole,
    }),
  ),
);

export function canonicalJson(value) {
  const encode = (input) => {
    if (input === null) return "null";
    if (typeof input === "boolean") return input ? "true" : "false";
    if (typeof input === "number") {
      if (!Number.isSafeInteger(input)) {
        throw new Error("canonical-number-not-safe-integer");
      }
      return String(input);
    }
    if (typeof input === "string") return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(encode).join(",")}]`;
    if (
      typeof input === "object" &&
      Object.getPrototypeOf(input) === Object.prototype
    ) {
      return `{${Object.keys(input)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(input[key])}`)
        .join(",")}}`;
    }
    throw new Error("canonical-unsupported-value");
  };
  return encode(value);
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(String(value), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalDigest(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

export function clone(value) {
  return structuredClone(value);
}

const RECORDER_DIGEST = sha256("r0-external-recorder-instance");
const COORDINATOR_DIGEST = sha256("r0-coordinator-instance");
const DISPATCHER_DIGEST = sha256("r0-single-dispatcher");
const JOURNAL_DIGEST = sha256("r0-single-journal");
const GENESIS_DIGEST = canonicalDigest({ authority: AUTHORITY_ID, version: 1 });
const GENESIS_ACK_DIGEST = canonicalDigest({
  authority: AUTHORITY_ID,
  acknowledgement: "genesis",
});

function opaqueBoundaryBytes(phase) {
  return Buffer.from(sha256(`r0-opaque-boundary-${phase}`), "hex")
    .subarray(0, 12)
    .toString("base64");
}

function makeIdentities(mode) {
  const prefix = mode === "sdk" ? "sdk" : "production";
  return {
    challenge: sha256(`${prefix}-challenge-current`),
    pid: sha256(`${prefix}-pid-current`),
    root: sha256(`${prefix}-root-current`),
    target: sha256(`${prefix}-target-current`),
    packageRoot: sha256(`${prefix}-package-root-current`),
    commandRoot: sha256(`${prefix}-command-root-current`),
    buildRoot: sha256(`${prefix}-build-root-current`),
    cacheRoot: sha256(`${prefix}-cache-root-current`),
  };
}

function makePriorIdentities(mode) {
  const prefix = mode === "sdk" ? "sdk" : "production";
  return {
    challenge: sha256(`${prefix}-challenge-prior`),
    pid: sha256(`${prefix}-pid-prior`),
    root: sha256(`${prefix}-root-prior`),
    target: sha256(`${prefix}-target-prior`),
    packageRoot: sha256(`${prefix}-package-root-prior`),
    commandRoot: sha256(`${prefix}-command-root-prior`),
    buildRoot: sha256(`${prefix}-build-root-prior`),
    cacheRoot: sha256(`${prefix}-cache-root-prior`),
  };
}

function sdkBindingDigest(identities, rowId) {
  return canonicalDigest({
    challenge: identities.challenge,
    pid: identities.pid,
    root: identities.root,
    target: identities.target,
    packageRoot: identities.packageRoot,
    commandRoot: identities.commandRoot,
    buildRoot: identities.buildRoot,
    cacheRoot: identities.cacheRoot,
    rowId,
  });
}

function makeRetention(events) {
  const finalEventDigest =
    events.length === 0 ? GENESIS_DIGEST : events.at(-1).eventDigest;
  return {
    members: RETAINED_MEMBER_AUTHORITY.map(({ memberId }, index) => ({
      memberId,
      byteLength: index + 1,
      digest: sha256(`${memberId}:${finalEventDigest}`),
      path: `${sha256("retained-root")}/${memberId}/${String(index).padStart(12, "0")}.bin`,
    })),
    sealSnapshots:
      events.length > 7
        ? events.slice(7).map(({ envelope }) => ({
            sequence: envelope.sequence,
            actualLedgerDigest: events[7].envelope.bodyDigest,
          }))
        : [],
  };
}

export function materializeLegalTrace(spec) {
  const mode = spec.mode;
  const runId = sha256(`r0-run-${spec.id}`).slice(0, 48);
  const rowId = sha256(`r0-row-${spec.id}`).slice(0, 48);
  const identities = makeIdentities(mode);
  const priorIdentities = makePriorIdentities(mode);
  const events = [];
  const capabilities = [];
  const acknowledgements = [];
  let previousEventDigest = GENESIS_DIGEST;
  let predecessorAcknowledgementDigest = GENESIS_ACK_DIGEST;

  for (const phase of spec.eventIds) {
    const matrix = CAPABILITY_MATRIX[phase];
    const actorInstanceDigest = sha256(
      `${runId}:${rowId}:${identities.challenge}:${matrix.actorSlot}`,
    );
    const grant = {
      version: "r0-capability-grant-v1",
      runId,
      rowId,
      sequence: phase,
      phase,
      predecessorAcknowledgementDigest,
      actorInstanceDigest,
      issuerInstanceDigest: RECORDER_DIGEST,
      challengeDigest: identities.challenge,
    };
    const capabilityGrantDigest = canonicalDigest(grant);
    const boundaryBytes = BOUNDARY_BYTE_PHASES.includes(phase)
      ? opaqueBoundaryBytes(phase)
      : undefined;
    const body = {
      version: "r0-body-v1",
      ...(boundaryBytes === undefined ? {} : { boundaryBytes }),
    };
    const bodyBytes = Buffer.from(canonicalJson(body), "utf8");
    const envelope = {
      version: "r0-event-v1",
      runId,
      rowId,
      sequence: phase,
      phase,
      previousEventDigest,
      actorInstanceDigest,
      capabilityGrantDigest,
      bodyByteLength: bodyBytes.length,
      bodyDigest: sha256(bodyBytes),
      ...(boundaryBytes === undefined ? {} : { boundaryBytes }),
    };
    const eventDigest = canonicalDigest(envelope);
    const acknowledgement = {
      version: "r0-recorder-ack-v1",
      sequence: phase,
      eventDigest,
      capabilityGrantDigest,
      recorderInstanceDigest: RECORDER_DIGEST,
    };
    events.push({ envelope, body, eventDigest });
    capabilities.push({ grant, grantDigest: capabilityGrantDigest });
    acknowledgements.push(acknowledgement);
    previousEventDigest = eventDigest;
    predecessorAcknowledgementDigest = canonicalDigest(acknowledgement);
  }

  const retention = makeRetention(events);
  const sdk =
    mode === "sdk"
      ? {
          commandKind: "frozen-row-local-command",
          executed: true,
          markerCreated: false,
          rowId,
          targetOwnerDigest: sha256(rowId),
          bindingDigest: sdkBindingDigest(identities, rowId),
          receiptBindingDigest: sdkBindingDigest(identities, rowId),
          attack: {
            attempted: true,
            priorReceiptDigest: sha256("prior-sdk-receipt"),
            accepted: false,
          },
        }
      : null;

  return {
    authorityId: AUTHORITY_ID,
    traceId: spec.id,
    engineDigest: sha256("r0-single-transition-engine"),
    route: {
      dispatcherDigest: DISPATCHER_DIGEST,
      journalDigest: JOURNAL_DIGEST,
      launchPath: "dispatcher",
      recorderOwnerDigest: RECORDER_DIGEST,
      coordinatorDigest: COORDINATOR_DIGEST,
    },
    substitution: null,
    identities,
    priorIdentities,
    priorCapabilityDigests: [],
    chronology: {
      candidateClosedAtSequence: 4,
      independentReopenAtSequence: 5,
      sealVerifiedAtSequence: 7,
      normalizationStartedAtSequence: 8,
      keyReleasedAtSequence: 9,
    },
    keyCustody: {
      keyHolderLaunchAtSequence: 9,
      keyHolderQueryAtSequence: 9,
      privatePlaintextVisibleAtSequence: 9,
      candidatePlaintextReads: 0,
      coordinatorPlaintextReads: 0,
      launchAuthorityDigest: sha256("independent-key-broker-only"),
    },
    events,
    capabilities,
    acknowledgements,
    retention,
    sdk,
  };
}

export function materializeKnownBadTrace(spec) {
  const baseSpec = {
    id: `known-bad-base-${spec.id}`,
    mode: spec.mode ?? "production",
    eventIds: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  };
  const trace = materializeLegalTrace(baseSpec);
  trace.traceId = spec.id;
  trace.substitution = {
    slot: spec.slot,
    deltaDigest: canonicalDigest(spec.delta),
  };

  switch (spec.delta.kind) {
    case "phase-skip":
      trace.events[spec.delta.eventIndex].envelope.phase += 1;
      break;
    case "phase-reorder":
      trace.events[spec.delta.eventIndex].envelope.phase -= 1;
      break;
    case "duplicate-capability":
      trace.events[spec.delta.eventIndex].envelope.capabilityGrantDigest =
        trace.events[spec.delta.eventIndex - 1].envelope.capabilityGrantDigest;
      break;
    case "replayed-capability":
      trace.priorCapabilityDigests.push(
        trace.events[spec.delta.eventIndex].envelope.capabilityGrantDigest,
      );
      break;
    case "coordinator-direct-launch":
      trace.route.launchPath = "coordinator";
      break;
    case "coordinator-self-mint":
      trace.capabilities[spec.delta.eventIndex].grant.issuerInstanceDigest =
        trace.route.coordinatorDigest;
      break;
    case "candidate-recorder-ownership":
      trace.route.recorderOwnerDigest = sha256("candidate-instance");
      break;
    case "pre-close-reopen":
      trace.chronology.independentReopenAtSequence = 3;
      break;
    case "pre-seal-normalize":
      trace.chronology.normalizationStartedAtSequence = 6;
      break;
    case "pre-seal-key-release":
      trace.chronology.keyReleasedAtSequence = 6;
      break;
    case "post-seal-mutation":
      trace.retention.sealSnapshots[2].actualLedgerDigest =
        sha256("mutated-after-seal");
      break;
    case "evidence-deletion":
      trace.retention.members.splice(0, 1);
      break;
    case "prior-receipt-substitution":
      trace.sdk.attack.accepted = true;
      trace.sdk.receiptBindingDigest = trace.sdk.attack.priorReceiptDigest;
      break;
    case "reused-pid":
      trace.identities.pid = trace.priorIdentities.pid;
      break;
    case "reused-root":
      trace.identities.root = trace.priorIdentities.root;
      break;
    case "reused-target":
      trace.identities.target = trace.priorIdentities.target;
      break;
    case "reused-challenge":
      trace.identities.challenge = trace.priorIdentities.challenge;
      break;
    case "alternate-defective-path":
      trace.route.dispatcherDigest = sha256("alternate-defective-dispatcher");
      break;
    case "semantic-field-smuggling":
      trace.events[2].envelope[spec.delta.field] =
        "opaque-looking-but-semantic";
      break;
    case "sdk-no-op":
      trace.sdk.executed = false;
      break;
    case "sdk-synthetic-marker":
      trace.sdk.markerCreated = true;
      break;
    case "private-plaintext-before-release":
      trace.keyCustody.privatePlaintextVisibleAtSequence = 8;
      break;
    default:
      throw new Error(`unknown-known-bad-delta:${spec.delta.kind}`);
  }
  return trace;
}

export const INTERNAL_CONSTANTS = Object.freeze({
  recorderDigest: RECORDER_DIGEST,
  coordinatorDigest: COORDINATOR_DIGEST,
  dispatcherDigest: DISPATCHER_DIGEST,
  journalDigest: JOURNAL_DIGEST,
  genesisDigest: GENESIS_DIGEST,
  genesisAcknowledgementDigest: GENESIS_ACK_DIGEST,
});

export function expectedSdkBindingDigest(identities, rowId) {
  return sdkBindingDigest(identities, rowId);
}
