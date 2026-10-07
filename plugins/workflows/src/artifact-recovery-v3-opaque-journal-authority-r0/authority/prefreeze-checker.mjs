#!/usr/bin/env node

import { readFileSync } from "node:fs";
import {
  ACCOUNTING_IDENTITY,
  ACCOUNTING_ROWS,
  ACTOR_OUTPUT_SCHEMA,
  AUTHORITY_ID,
  BODY_SCHEMAS,
  BOUNDARY_BYTE_PHASES,
  CANONICAL_BYTE_RULES,
  CAPABILITY_MATRIX,
  CHECKER_IDENTITY,
  CONFORMANCE_RULES,
  CONTROL_CATALOG,
  DATA_PLANE_ARTIFACT_SCHEMA,
  EVENT_SCHEMA,
  FAULT_CLASSES,
  FORBIDDEN_DATA_PLANE_FIELDS,
  FROZEN_INPUTS,
  INTERNAL_CONSTANTS,
  KNOWN_BAD_TRACE_SPECS,
  LEGAL_TRACE_SPECS,
  PHASES,
  RETAINED_MEMBER_AUTHORITY,
  SCHEMA_NEGATIVE_CORPUS,
  SDK_ROW_CATALOG,
  TRANSITIONS,
  canonicalDigest,
  canonicalJson,
  clone,
  expectedSdkBindingDigest,
  materializeKnownBadTrace,
  materializeLegalTrace,
  sha256,
} from "./protocol-authority.mjs";

const DEFAULT_CONTRACT_PATH =
  "/Users/erik/.bb/thread-storage/v3-a0-contract.json";
const contractPath = process.argv[2] ?? DEFAULT_CONTRACT_PATH;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizedField(field) {
  return field.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

const forbiddenNormalized = new Set(
  FORBIDDEN_DATA_PLANE_FIELDS.filter((field) => field !== "unknownField").map(
    normalizedField,
  ),
);

function semanticFieldIn(value) {
  if (Array.isArray(value)) {
    return value.map(semanticFieldIn).find(Boolean) ?? null;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenNormalized.has(normalizedField(key))) return key;
      const nested = semanticFieldIn(child);
      if (nested) return nested;
    }
  }
  return null;
}

function validateClosedObject(value, schema) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (schema.additionalProperties !== false) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !(key in schema.properties))) return false;
  if (schema.required.some((key) => !(key in value))) return false;
  for (const [key, property] of Object.entries(schema.properties)) {
    if (!(key in value)) continue;
    const candidate = value[key];
    if ("const" in property && candidate !== property.const) return false;
    if (property.type === "string") {
      if (typeof candidate !== "string") return false;
      if (
        property.pattern &&
        !new RegExp(property.pattern, "u").test(candidate)
      )
        return false;
      if (property.minLength && candidate.length < property.minLength)
        return false;
    }
    if (property.type === "integer") {
      if (!Number.isSafeInteger(candidate)) return false;
      if (property.minimum !== undefined && candidate < property.minimum)
        return false;
      if (property.maximum !== undefined && candidate > property.maximum)
        return false;
    }
  }
  return true;
}

function opaquePersistedPath(path) {
  return /^[0-9a-f]{64}\/[0-9a-f]{64}\/[0-9]{12}\.bin$/u.test(path);
}

function reject(code, detail = null) {
  return { ok: false, code, detail };
}

function validateStaticAuthority() {
  invariant(AUTHORITY_ID.endsWith(":prefreeze-model-check-v1"), "authority-id");
  invariant(CHECKER_IDENTITY.version === "1.0.0", "checker-version");
  invariant(
    Object.keys(CHECKER_IDENTITY.configuration).length === 6,
    "checker-configuration",
  );
  invariant(PHASES.length === 12, "phase-count");
  invariant(
    sameJson(PHASES, [
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
    ]),
    "phase-order",
  );
  invariant(TRANSITIONS.length === 12, "transition-count");
  TRANSITIONS.forEach((transition, index) => {
    invariant(
      transition.from === index - 1 && transition.to === index,
      `transition-${index}`,
    );
  });
  invariant(CAPABILITY_MATRIX.length === 12, "capability-count");
  invariant(
    new Set(CAPABILITY_MATRIX.map((row) => row.actorSlot)).size === 12,
    "actor-slots-unique",
  );
  CAPABILITY_MATRIX.forEach((row, index) => {
    invariant(row.phase === index, `capability-phase-${index}`);
    invariant(
      row.predecessorPhase === index - 1,
      `capability-predecessor-${index}`,
    );
    invariant(row.issuer === "external-recorder", `capability-issuer-${index}`);
    invariant(row.singleUse === true, `capability-single-use-${index}`);
    invariant(
      !row.actorSlot.includes("coordinator"),
      `coordinator-not-actor-${index}`,
    );
  });
  invariant(
    EVENT_SCHEMA.additionalProperties === false,
    "event-schema-not-closed",
  );
  invariant(
    DATA_PLANE_ARTIFACT_SCHEMA.additionalProperties === false,
    "artifact-schema-not-closed",
  );
  invariant(
    ACTOR_OUTPUT_SCHEMA.additionalProperties === false,
    "actor-output-schema-not-closed",
  );
  invariant(Object.keys(BODY_SCHEMAS).length === 12, "body-schema-count");
  Object.values(BODY_SCHEMAS).forEach((schema, index) => {
    invariant(
      schema.additionalProperties === false,
      `body-schema-not-closed-${index}`,
    );
  });
  invariant(CONFORMANCE_RULES.length === 18, "conformance-rule-count");
  invariant(
    new Set(CONFORMANCE_RULES.map(({ id }) => id)).size === 18,
    "conformance-rule-ids",
  );

  const canonicalProbe = { z: 1, a: { y: 2, b: [3, "four"] } };
  const canonicalBytes = canonicalJson(canonicalProbe);
  invariant(
    canonicalBytes === '{"a":{"b":[3,"four"],"y":2},"z":1}',
    "canonical-key-order",
  );
  invariant(!canonicalBytes.endsWith("\n"), "canonical-terminal-newline");
  invariant(
    CANONICAL_BYTE_RULES.terminalNewline === false,
    "canonical-rule-terminal-newline",
  );
  invariant(
    canonicalDigest(canonicalProbe) === sha256(canonicalBytes),
    "canonical-digest-stability",
  );
}

function validateAccounting() {
  invariant(
    ACCOUNTING_ROWS.length === ACCOUNTING_IDENTITY.total,
    "accounting-total",
  );
  invariant(
    new Set(ACCOUNTING_ROWS.map(({ rowId }) => rowId)).size === 134,
    "accounting-row-ids",
  );
  for (const [category, expected] of Object.entries(
    ACCOUNTING_IDENTITY.categories,
  )) {
    const actual = ACCOUNTING_ROWS.filter(
      (row) => row.category === category,
    ).length;
    invariant(actual === expected, `accounting-category-${category}:${actual}`);
  }
  for (const [adapter, expected] of Object.entries(
    ACCOUNTING_IDENTITY.adapters,
  )) {
    const actual = ACCOUNTING_ROWS.filter(
      (row) => row.adapter === adapter,
    ).length;
    invariant(actual === expected, `accounting-adapter-${adapter}:${actual}`);
  }
  invariant(CONTROL_CATALOG.length === 17, "control-count");
  invariant(
    new Set(CONTROL_CATALOG.map(({ controlId }) => controlId)).size === 17,
    "control-ids",
  );
  invariant(SDK_ROW_CATALOG.length === 30, "sdk-row-count");
  invariant(
    new Set(SDK_ROW_CATALOG.map(({ rowId }) => rowId)).size === 30,
    "sdk-row-ids",
  );
  const sdkAccountingIds = new Set(
    ACCOUNTING_ROWS.filter((row) => row.category === "sdk").map(
      ({ rowId }) => rowId,
    ),
  );
  invariant(
    SDK_ROW_CATALOG.every(({ rowId }) => sdkAccountingIds.has(rowId)),
    "sdk-row-allocation",
  );
}

function validateContractIdentity(path) {
  const bytes = readFileSync(path);
  invariant(
    bytes.length === FROZEN_INPUTS.acceptedContract.byteLength,
    "accepted-contract-byte-length",
  );
  invariant(
    sha256(bytes) === FROZEN_INPUTS.acceptedContract.sha256,
    "accepted-contract-sha256",
  );
  const parsed = JSON.parse(bytes.toString("utf8"));
  invariant(
    parsed.decisionClass === "contract-preserving",
    "accepted-contract-decision-class",
  );
  invariant(
    parsed.verdict === "contract-preserving-successor",
    "accepted-contract-verdict",
  );
}

function expectedActorDigest(trace, phase) {
  return sha256(
    `${trace.events[phase].envelope.runId}:${trace.events[phase].envelope.rowId}:${trace.identities.challenge}:${CAPABILITY_MATRIX[phase].actorSlot}`,
  );
}

function validateTrace(trace) {
  if (trace.authorityId !== AUTHORITY_ID) return reject("wrong-authority");
  if (trace.engineDigest !== sha256("r0-single-transition-engine")) {
    return reject("alternate-defective-path");
  }
  if (trace.substitution !== null) {
    if (
      !trace.substitution ||
      !["executable", "os", "filesystem", "transport"].includes(
        trace.substitution.slot,
      )
    ) {
      return reject("invalid-substitution-slot");
    }
    if (Object.keys(trace.substitution).length !== 2)
      return reject("multiple-substitution-deltas");
  }
  if (trace.route.dispatcherDigest !== INTERNAL_CONSTANTS.dispatcherDigest) {
    return reject("alternate-defective-path");
  }
  if (trace.route.journalDigest !== INTERNAL_CONSTANTS.journalDigest) {
    return reject("alternate-defective-path");
  }
  if (trace.route.launchPath !== "dispatcher")
    return reject("coordinator-direct-launch");
  if (trace.route.recorderOwnerDigest !== INTERNAL_CONSTANTS.recorderDigest) {
    return reject("candidate-recorder-ownership");
  }
  if (trace.route.coordinatorDigest === trace.route.recorderOwnerDigest) {
    return reject("candidate-recorder-ownership");
  }

  for (const identity of ["challenge", "pid", "root", "target"]) {
    if (trace.identities[identity] === trace.priorIdentities[identity]) {
      return reject(`reused-${identity}`);
    }
  }
  const currentRoots = [
    trace.identities.root,
    trace.identities.packageRoot,
    trace.identities.commandRoot,
    trace.identities.buildRoot,
    trace.identities.cacheRoot,
  ];
  if (new Set(currentRoots).size !== currentRoots.length)
    return reject("reused-root");
  for (const identity of [
    "packageRoot",
    "commandRoot",
    "buildRoot",
    "cacheRoot",
  ]) {
    if (trace.identities[identity] === trace.priorIdentities[identity])
      return reject("reused-root");
  }

  if (
    trace.chronology.independentReopenAtSequence <=
    trace.chronology.candidateClosedAtSequence
  ) {
    return reject("pre-close-reopen");
  }
  if (
    trace.chronology.normalizationStartedAtSequence <=
    trace.chronology.sealVerifiedAtSequence
  ) {
    return reject("pre-seal-normalize");
  }
  if (
    trace.chronology.keyReleasedAtSequence <=
    trace.chronology.sealVerifiedAtSequence
  ) {
    return reject("pre-seal-key-release");
  }
  if (
    trace.keyCustody.keyHolderLaunchAtSequence <
      trace.chronology.sealVerifiedAtSequence ||
    trace.keyCustody.keyHolderQueryAtSequence <
      trace.chronology.sealVerifiedAtSequence
  ) {
    return reject("pre-seal-key-release");
  }
  if (
    trace.keyCustody.privatePlaintextVisibleAtSequence <
    trace.chronology.keyReleasedAtSequence
  ) {
    return reject("private-plaintext-before-release");
  }
  if (
    trace.keyCustody.candidatePlaintextReads !== 0 ||
    trace.keyCustody.coordinatorPlaintextReads !== 0
  ) {
    return reject("private-plaintext-before-release");
  }

  if (
    trace.events.length !== trace.capabilities.length ||
    trace.events.length !== trace.acknowledgements.length
  ) {
    return reject("capability-cardinality");
  }
  if (trace.events.length > PHASES.length) return reject("phase-overflow");

  const consumedCapabilities = new Set();
  const actorInstances = new Set();
  let previousEventDigest = INTERNAL_CONSTANTS.genesisDigest;
  let predecessorAcknowledgementDigest =
    INTERNAL_CONSTANTS.genesisAcknowledgementDigest;

  for (let index = 0; index < trace.events.length; index += 1) {
    const record = trace.events[index];
    const { envelope, body, eventDigest } = record;
    if (envelope.phase > index) return reject("phase-skip");
    if (envelope.phase < index) return reject("phase-reorder");
    if (envelope.sequence !== index) return reject("illegal-chronology");

    const semanticEventField = semanticFieldIn(envelope);
    if (semanticEventField)
      return reject("semantic-field-smuggling", semanticEventField);
    const semanticBodyField = semanticFieldIn(body);
    if (semanticBodyField)
      return reject("semantic-field-smuggling", semanticBodyField);
    if (!validateClosedObject(envelope, EVENT_SCHEMA))
      return reject("invalid-event-schema");
    if (!validateClosedObject(body, BODY_SCHEMAS[String(index)])) {
      return reject("invalid-body-schema");
    }
    if (BOUNDARY_BYTE_PHASES.includes(index)) {
      if (envelope.boundaryBytes !== body.boundaryBytes)
        return reject("boundary-byte-mismatch");
    } else if ("boundaryBytes" in envelope || "boundaryBytes" in body) {
      return reject("boundary-byte-not-authorized");
    }

    const bodyBytes = Buffer.from(canonicalJson(body), "utf8");
    if (bodyBytes.length !== envelope.bodyByteLength)
      return reject("body-byte-length");
    if (sha256(bodyBytes) !== envelope.bodyDigest) return reject("body-digest");
    if (envelope.previousEventDigest !== previousEventDigest)
      return reject("hash-chain");
    if (envelope.actorInstanceDigest !== expectedActorDigest(trace, index)) {
      return reject("wrong-phase-actor");
    }
    if (actorInstances.has(envelope.actorInstanceDigest))
      return reject("universal-actor");
    actorInstances.add(envelope.actorInstanceDigest);

    if (consumedCapabilities.has(envelope.capabilityGrantDigest)) {
      return reject("duplicate-capability");
    }
    if (trace.priorCapabilityDigests.includes(envelope.capabilityGrantDigest)) {
      return reject("replayed-capability");
    }
    if (canonicalDigest(envelope) !== eventDigest)
      return reject("event-digest");
    const capability = trace.capabilities[index];
    if (
      capability.grant.issuerInstanceDigest !==
      INTERNAL_CONSTANTS.recorderDigest
    ) {
      return reject("coordinator-self-mint");
    }
    if (
      capability.grant.predecessorAcknowledgementDigest !==
      predecessorAcknowledgementDigest
    ) {
      return reject("mint-before-recorder-ack");
    }
    if (
      capability.grant.phase !== index ||
      capability.grant.sequence !== index ||
      capability.grant.actorInstanceDigest !== envelope.actorInstanceDigest ||
      capability.grant.challengeDigest !== trace.identities.challenge
    ) {
      return reject("invalid-capability");
    }
    if (
      canonicalDigest(capability.grant) !== capability.grantDigest ||
      capability.grantDigest !== envelope.capabilityGrantDigest
    ) {
      return reject("invalid-capability");
    }
    consumedCapabilities.add(envelope.capabilityGrantDigest);

    const acknowledgement = trace.acknowledgements[index];
    if (
      acknowledgement.sequence !== index ||
      acknowledgement.eventDigest !== eventDigest ||
      acknowledgement.capabilityGrantDigest !==
        envelope.capabilityGrantDigest ||
      acknowledgement.recorderInstanceDigest !==
        INTERNAL_CONSTANTS.recorderDigest
    ) {
      return reject("invalid-recorder-ack");
    }
    predecessorAcknowledgementDigest = canonicalDigest(acknowledgement);
    previousEventDigest = eventDigest;
  }

  if (trace.events.length === PHASES.length) {
    const expectedMemberIds = new Set(
      RETAINED_MEMBER_AUTHORITY.map(({ memberId }) => memberId),
    );
    const actualMemberIds = new Set(
      trace.retention.members.map(({ memberId }) => memberId),
    );
    if (
      expectedMemberIds.size !== actualMemberIds.size ||
      [...expectedMemberIds].some((memberId) => !actualMemberIds.has(memberId))
    ) {
      return reject("evidence-deletion");
    }
    if (
      trace.retention.members.some(({ path }) => !opaquePersistedPath(path))
    ) {
      return reject("semantic-field-smuggling", "retained-path");
    }
    const sealedActualDigest = trace.events[7].envelope.bodyDigest;
    if (
      trace.retention.sealSnapshots.length !== 5 ||
      trace.retention.sealSnapshots.some(
        ({ actualLedgerDigest }) => actualLedgerDigest !== sealedActualDigest,
      )
    ) {
      return reject("post-seal-mutation");
    }
  }

  if (trace.sdk !== null) {
    if (
      trace.sdk.attack.accepted ||
      trace.sdk.receiptBindingDigest === trace.sdk.attack.priorReceiptDigest
    ) {
      return reject("prior-receipt-substitution");
    }
    if (
      !trace.sdk.executed ||
      trace.sdk.commandKind !== "frozen-row-local-command"
    ) {
      return reject("sdk-no-op");
    }
    if (trace.sdk.markerCreated) return reject("sdk-synthetic-marker");
    if (trace.sdk.targetOwnerDigest !== sha256(trace.sdk.rowId)) {
      return reject("reused-target");
    }
    const expectedBinding = expectedSdkBindingDigest(
      trace.identities,
      trace.sdk.rowId,
    );
    if (
      trace.sdk.bindingDigest !== expectedBinding ||
      trace.sdk.receiptBindingDigest !== expectedBinding
    ) {
      return reject("invalid-sdk-binding");
    }
    if (!trace.sdk.attack.attempted)
      return reject("missing-prior-receipt-attack");
  }

  return {
    ok: true,
    complete: trace.events.length === PHASES.length,
    phaseCount: trace.events.length,
    finalEventDigest: previousEventDigest,
  };
}

function exploreStateSpace() {
  const reachable = new Set([-1]);
  let legalEdges = 0;
  let illegalAttempts = 0;
  for (let current = -1; current <= 11; current += 1) {
    invariant(reachable.has(current), `unreachable-state-${current}`);
    for (let proposed = 0; proposed <= 11; proposed += 1) {
      const legal = TRANSITIONS.some(
        (transition) =>
          transition.from === current && transition.to === proposed,
      );
      if (legal) {
        legalEdges += 1;
        reachable.add(proposed);
      } else {
        illegalAttempts += 1;
      }
    }
  }
  invariant(reachable.size === 13, "exhaustive-state-count");
  invariant(legalEdges === 12, "exhaustive-legal-edges");
  invariant(illegalAttempts === 144, "exhaustive-illegal-attempts");
  return { reachableStates: reachable.size, legalEdges, illegalAttempts };
}

function validateLegalTraces() {
  invariant(
    LEGAL_TRACE_SPECS.some(({ eventIds }) => eventIds.length === 0),
    "missing-zero-path",
  );
  invariant(
    LEGAL_TRACE_SPECS.some(({ eventIds }) => eventIds.length === 1),
    "missing-one-path",
  );
  invariant(
    LEGAL_TRACE_SPECS.some(({ eventIds }) => eventIds.length === 12),
    "missing-n-path",
  );
  for (const spec of LEGAL_TRACE_SPECS) {
    const trace = materializeLegalTrace(spec);
    const result = validateTrace(trace);
    invariant(result.ok, `legal-trace-rejected:${spec.id}:${result.code}`);
    invariant(
      result.phaseCount === spec.eventIds.length,
      `legal-trace-length:${spec.id}`,
    );
    invariant(
      result.complete === (spec.eventIds.length === 12),
      `legal-trace-complete:${spec.id}`,
    );
  }
}

function validateKnownBadTraces() {
  invariant(
    KNOWN_BAD_TRACE_SPECS.length === FAULT_CLASSES.length,
    "known-bad-count",
  );
  invariant(
    new Set(KNOWN_BAD_TRACE_SPECS.map(({ faultClass }) => faultClass)).size ===
      FAULT_CLASSES.length,
    "known-bad-unique-kills",
  );
  invariant(
    FAULT_CLASSES.every((faultClass) =>
      KNOWN_BAD_TRACE_SPECS.some((trace) => trace.faultClass === faultClass),
    ),
    "known-bad-fault-coverage",
  );
  invariant(
    KNOWN_BAD_TRACE_SPECS.some(
      ({ lineage }) => lineage === "authoritative-P1-negative",
    ),
    "missing-p1-negative-trace",
  );
  invariant(
    KNOWN_BAD_TRACE_SPECS.some(
      ({ lineage }) => lineage === "authoritative-A0-negative",
    ),
    "missing-a0-negative-trace",
  );
  invariant(
    KNOWN_BAD_TRACE_SPECS.some(({ lineage }) => lineage === "generic"),
    "missing-generic-negative-trace",
  );
  for (const spec of KNOWN_BAD_TRACE_SPECS) {
    const trace = materializeKnownBadTrace(spec);
    const result = validateTrace(trace);
    invariant(!result.ok, `known-bad-accepted:${spec.id}`);
    invariant(
      result.code === spec.faultClass,
      `known-bad-wrong-kill:${spec.id}:expected=${spec.faultClass}:actual=${result.code}`,
    );
  }
}

function validateSchemaNegativeCorpus() {
  const trace = materializeLegalTrace(
    LEGAL_TRACE_SPECS.find(({ id }) => id === "legal-prefix-12"),
  );
  const validEvent = trace.events[2].envelope;
  const validBody = trace.events[2].body;
  invariant(
    validateClosedObject(validEvent, EVENT_SCHEMA),
    "schema-negative-base-event",
  );
  invariant(
    validateClosedObject(validBody, BODY_SCHEMAS["2"]),
    "schema-negative-base-body",
  );

  for (const negative of SCHEMA_NEGATIVE_CORPUS) {
    let rejected = false;
    if (negative.surface === "event") {
      const candidate = { ...validEvent, [negative.field]: "x" };
      rejected = !validateClosedObject(candidate, EVENT_SCHEMA);
    } else if (negative.surface === "body") {
      const candidate = { ...validBody, [negative.field]: "x" };
      rejected = !validateClosedObject(candidate, BODY_SCHEMAS["2"]);
    } else if (negative.surface === "artifact") {
      const candidate = { ...validEvent, [negative.field]: "x" };
      rejected = !validateClosedObject(candidate, DATA_PLANE_ARTIFACT_SCHEMA);
    } else if (negative.surface === "actor-output") {
      const candidate = { ...validEvent, [negative.field]: "x" };
      rejected = !validateClosedObject(candidate, ACTOR_OUTPUT_SCHEMA);
    } else if (negative.surface === "journal-path") {
      const candidate = `${sha256("run")}/${sha256("row")}/${negative.field}.bin`;
      rejected = !opaquePersistedPath(candidate);
    }
    invariant(rejected, `schema-negative-accepted:${negative.id}`);
  }

  for (const record of trace.events) {
    invariant(
      semanticFieldIn(record.envelope) === null,
      "semantic-field-valid-event",
    );
    invariant(
      semanticFieldIn(record.body) === null,
      "semantic-field-valid-body",
    );
  }
  invariant(
    trace.retention.members.every(({ path }) => opaquePersistedPath(path)),
    "valid-opaque-paths",
  );
}

function validateInvalidCapabilityAndChronology() {
  const base = materializeLegalTrace(
    LEGAL_TRACE_SPECS.find(({ id }) => id === "legal-prefix-12"),
  );
  const invalidCapability = clone(base);
  invalidCapability.capabilities[6].grant.challengeDigest =
    sha256("wrong-challenge");
  const capabilityResult = validateTrace(invalidCapability);
  invariant(
    !capabilityResult.ok && capabilityResult.code === "invalid-capability",
    `invalid-capability-not-killed:${capabilityResult.code}`,
  );

  const invalidChronology = clone(base);
  invalidChronology.events[6].envelope.sequence = 7;
  const chronologyResult = validateTrace(invalidChronology);
  invariant(
    !chronologyResult.ok && chronologyResult.code === "illegal-chronology",
    `illegal-chronology-not-killed:${chronologyResult.code}`,
  );
}

function main() {
  validateContractIdentity(contractPath);
  validateStaticAuthority();
  validateAccounting();
  const exploration = exploreStateSpace();
  validateLegalTraces();
  validateKnownBadTraces();
  validateSchemaNegativeCorpus();
  validateInvalidCapabilityAndChronology();

  const summary = {
    authorityId: AUTHORITY_ID,
    checker: CHECKER_IDENTITY,
    status: "prefreeze-green",
    phases: PHASES.length,
    legalTraces: LEGAL_TRACE_SPECS.length,
    knownBadTraces: KNOWN_BAD_TRACE_SPECS.length,
    schemaNegatives: SCHEMA_NEGATIVE_CORPUS.length,
    capabilities: CAPABILITY_MATRIX.length,
    accountingRows: ACCOUNTING_ROWS.length,
    controls: CONTROL_CATALOG.length,
    sdkRows: SDK_ROW_CATALOG.length,
    accountingCatalogSha256: canonicalDigest(ACCOUNTING_ROWS),
    controlCatalogSha256: canonicalDigest(CONTROL_CATALOG),
    sdkCatalogSha256: canonicalDigest(SDK_ROW_CATALOG),
    authorityModelSha256: canonicalDigest({
      checker: CHECKER_IDENTITY,
      phases: PHASES,
      transitions: TRANSITIONS,
      capabilities: CAPABILITY_MATRIX,
      eventSchema: EVENT_SCHEMA,
      bodySchemas: BODY_SCHEMAS,
      canonicalByteRules: CANONICAL_BYTE_RULES,
      legalTraceSpecs: LEGAL_TRACE_SPECS,
      knownBadTraceSpecs: KNOWN_BAD_TRACE_SPECS,
      schemaNegativeCorpus: SCHEMA_NEGATIVE_CORPUS,
      conformanceRules: CONFORMANCE_RULES,
      accountingIdentity: ACCOUNTING_IDENTITY,
      frozenInputs: FROZEN_INPUTS,
    }),
    exploration,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ authorityId: AUTHORITY_ID, status: "prefreeze-red", error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
}
