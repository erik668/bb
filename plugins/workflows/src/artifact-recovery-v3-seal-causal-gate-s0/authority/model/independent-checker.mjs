// This is the deterministic checker owned by the operative model. It is not
// the independently authored sibling oracle and shares no oracle predicates.
import {
  canonicalJson,
  capabilityDigest,
  capabilityPayload,
  eventDigest,
  eventPayload,
} from "./canonical.mjs";
import { CLOSED_API_SURFACE, reconstructSpentGateDigests } from "./authority-model.mjs";
import {
  transcriptSchema,
  validateCapabilitySchema,
  validateEventSchema,
  validateSchema,
} from "./schemas.mjs";

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function add(errors, code, detail = "") {
  if (!errors.some((error) => error.code === code)) errors.push({ code, detail });
}

function reaches(byDigest, fromDigest, targetDigest) {
  const pending = [fromDigest];
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (current === targetDigest) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const predecessor of byDigest.get(current)?.predecessors ?? []) pending.push(predecessor);
  }
  return false;
}

export function causalRelation(byDigest, ancestorDigest, descendantDigest) {
  if (!ancestorDigest || !descendantDigest) return "incomparable";
  if (ancestorDigest === descendantDigest) return "equal";
  if (reaches(byDigest, descendantDigest, ancestorDigest)) return "after";
  if (reaches(byDigest, ancestorDigest, descendantDigest)) return "before";
  return "incomparable";
}

function addRelationFault(errors, prefix, relation) {
  if (relation === "before") add(errors, `${prefix}_BEFORE`);
  if (relation === "equal") add(errors, `${prefix}_EQUAL`);
  if (relation === "incomparable") add(errors, `${prefix}_INCOMPARABLE`);
}

function findMultiEventCycle(byDigest) {
  const state = new Map();
  function visit(digest) {
    if (state.get(digest) === 1) return true;
    if (state.get(digest) === 2) return false;
    state.set(digest, 1);
    for (const predecessor of byDigest.get(digest)?.predecessors ?? []) {
      if (predecessor !== digest && byDigest.has(predecessor) && visit(predecessor)) return true;
    }
    state.set(digest, 2);
    return false;
  }
  return [...byDigest.keys()].some(visit);
}

const BINDING_FIELDS = [
  ["runId", "RUN"],
  ["rowId", "ROW"],
  ["challenge", "CHALLENGE"],
  ["processId", "PROCESS"],
  ["evidenceRootDigest", "EVIDENCE_ROOT"],
  ["sealedSubjectDigest", "SEALED_SUBJECT"],
  ["verifierId", "VERIFIER"],
  ["recorderId", "RECORDER"],
  ["brokerId", "BROKER"],
  ["scope", "SCOPE"],
];

function bindingFault(errors, actual, expected, prefix) {
  for (const [field, suffix] of BINDING_FIELDS) {
    if (actual?.[field] !== expected?.[field]) add(errors, `${prefix}_${suffix}`);
  }
}

function displayOrderDiagnostics(events) {
  const malformed = [];
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].displaySequence < events[index - 1].displaySequence) {
      malformed.push({ previousDigest: events[index - 1].digest, digest: events[index].digest });
    }
  }
  return { ok: malformed.length === 0, malformed };
}

function exactPredecessors(errors, event, expected, code) {
  if (event && !same(event.predecessors, expected)) add(errors, code);
}

export function checkTranscript(transcript) {
  const errors = [];
  const transcriptErrors = validateSchema(transcriptSchema, transcript);
  if (transcriptErrors.length) add(errors, "SCHEMA", transcriptErrors.join(","));

  const events = Array.isArray(transcript.events) ? transcript.events : [];
  const capabilities = Array.isArray(transcript.capabilities) ? transcript.capabilities : [];
  for (const [index, event] of events.entries()) {
    const eventErrors = validateEventSchema(event, `$.events[${index}]`);
    if (eventErrors.length) add(errors, "SCHEMA", eventErrors.join(","));
  }
  for (const [index, capability] of capabilities.entries()) {
    const capabilityErrors = validateCapabilitySchema(capability, `$.capabilities[${index}]`);
    if (capabilityErrors.length) add(errors, "SCHEMA", capabilityErrors.join(","));
  }

  const byDigest = new Map();
  for (const event of events) {
    const previous = byDigest.get(event.digest);
    if (previous) {
      if (same(eventPayload(previous), eventPayload(event))) add(errors, "DUPLICATE_EVENT_IDENTITY");
      else add(errors, "DIGEST_ALIAS");
    } else {
      byDigest.set(event.digest, event);
    }
    if (event.digest !== eventDigest(event)) add(errors, "IMMUTABLE_EVENT_IDENTITY");
  }

  const capabilityByDigest = new Map();
  for (const capability of capabilities) {
    const previous = capabilityByDigest.get(capability.digest);
    if (previous) {
      if (same(capabilityPayload(previous), capabilityPayload(capability))) add(errors, "DUPLICATE_CAPABILITY_IDENTITY");
      else add(errors, "DIGEST_ALIAS");
    } else {
      capabilityByDigest.set(capability.digest, capability);
    }
    if (byDigest.has(capability.digest)) add(errors, "CROSS_DOMAIN_SUBSTITUTION");
    if (capability.digest !== capabilityDigest(capability)) add(errors, "IMMUTABLE_CAPABILITY_IDENTITY");
  }

  for (const event of events) {
    for (const predecessor of event.predecessors ?? []) {
      if (!byDigest.has(predecessor)) add(errors, "MISSING_PREDECESSOR");
      if (predecessor === event.digest) {
        add(errors, event.kind === "KEY_GATE_CONSUMED" ? "SAME_EVENT_PREDECESSOR" : "SELF_CYCLE");
      }
    }
  }
  if (findMultiEventCycle(byDigest)) add(errors, "MULTI_EVENT_CYCLE");

  const api = transcript.apiSurface ?? {};
  if ((api.coordinator ?? []).some((name) => name.toLowerCase().includes("mint"))) add(errors, "COORDINATOR_MINT");
  if ((api.coordinator ?? []).some((name) => /launch|query|consume/i.test(name))) add(errors, "COORDINATOR_DIRECT_LAUNCH");
  if ((api.universal ?? []).some((name) => name.toLowerCase().includes("mint"))) add(errors, "UNIVERSAL_MINT_API");
  if ((api.universal ?? []).some((name) => /launch|query|consume/i.test(name))) add(errors, "UNIVERSAL_LAUNCH_API");
  if (!same(api, CLOSED_API_SURFACE)) add(errors, "API_SURFACE_DRIFT");
  if (transcript.authorityBasis !== "event-identity-reachability") add(errors, "SEQUENCE_AUTHORITY");

  const operations = Array.isArray(transcript.operations) ? transcript.operations : [];
  const accepted = operations.filter(({ accepted }) => accepted === true);
  if (accepted.length > 1 && accepted.every(({ mode }) => mode === "initial")) {
    add(errors, "MULTIPLE_ACCEPTED_TRANSACTIONS");
  }
  if (accepted.some(({ mode }) => mode === "sequential-retry")) add(errors, "SEQUENTIAL_DUPLICATE_CONSUME");
  if (accepted.some(({ mode }) => mode === "concurrent-race")) add(errors, "CONCURRENT_DUPLICATE_CONSUME");
  if (accepted.some(({ mode }) => mode === "restart-retry")) add(errors, "RESTART_REUSE");

  for (const operation of accepted) {
    bindingFault(errors, operation.attemptBindings, transcript.bindings, "REPLAY");
    const gate = capabilityByDigest.get(operation.gateDigest);
    if (!gate || gate.kind !== "KEY_GATE") {
      add(errors, "CAPABILITY_MISSING");
      continue;
    }
    bindingFault(errors, gate.bindings, transcript.bindings, "FORGED");
    if (gate.issuer !== transcript.bindings?.recorderId) add(errors, "FORGED_ISSUER");
    if (gate.operationScope !== transcript.bindings?.scope) add(errors, "FORGED_SCOPE");

    const acknowledgement = byDigest.get(gate.ackEventDigest);
    const mintCandidate = byDigest.get(operation.mintEventDigest);
    const consumptionCandidate = byDigest.get(operation.consumptionDigest);
    const launchCandidate = byDigest.get(operation.launchReceiptDigest);
    const queryCandidate = byDigest.get(operation.queryReceiptDigest);

    if (!acknowledgement || acknowledgement.kind !== "SEAL_VERIFIED_ACK") add(errors, "PREMINT");
    if (!mintCandidate) add(errors, "MINT_EVENT_MISSING");
    if (!consumptionCandidate) add(errors, "CONSUME_NOT_APPEND_ONLY");
    if (!launchCandidate) add(errors, "LAUNCH_RECEIPT_MISSING");
    if (!queryCandidate) add(errors, "QUERY_RECEIPT_MISSING");

    if (acknowledgement) {
      bindingFault(errors, acknowledgement.bindings, transcript.bindings, "FORGED");
      if (acknowledgement.actor !== transcript.bindings?.recorderId) add(errors, "FORGED_ACK_ACTOR");
      if (acknowledgement.validated !== true) add(errors, "ACK_NOT_VALIDATED");
      if (acknowledgement.sealedSubjectDigest !== transcript.bindings?.sealedSubjectDigest) {
        add(errors, "ACK_WRONG_SEALED_SUBJECT");
      }
      const sealed = byDigest.get(acknowledgement.sealedSubjectEventDigest);
      if (
        !sealed ||
        sealed.kind !== "SEALED_SUBJECT" ||
        sealed.subjectDigest !== acknowledgement.sealedSubjectDigest ||
        sealed.actor !== transcript.bindings?.verifierId
      ) {
        add(errors, "ACK_WRONG_SEALED_SUBJECT");
      }
      exactPredecessors(errors, acknowledgement, sealed ? [sealed.digest] : [], "ACK_PREDECESSOR_MISMATCH");
    }

    const mintRelation = causalRelation(byDigest, acknowledgement?.digest, operation.mintEventDigest);
    if (mintRelation !== "after") addRelationFault(errors, "MINT_ACK", mintRelation);
    if (mintCandidate) {
      bindingFault(errors, mintCandidate.bindings, transcript.bindings, "FORGED");
      if (mintCandidate.actor !== transcript.bindings?.recorderId) add(errors, "FORGED_MINT_ACTOR");
      if (mintCandidate.ackEventDigest !== acknowledgement?.digest || gate.ackEventDigest !== acknowledgement?.digest) {
        add(errors, "FORGED_PREDECESSOR");
      }
      if (mintCandidate.gateDigest !== gate.digest) add(errors, "MINT_GATE_MISMATCH");
      exactPredecessors(errors, mintCandidate, acknowledgement ? [acknowledgement.digest] : [], "MINT_PREDECESSOR_MISMATCH");
    }

    const consumeRelation = causalRelation(byDigest, mintCandidate?.digest, operation.consumptionDigest);
    if (consumeRelation !== "after") addRelationFault(errors, "CONSUME_MINT", consumeRelation);
    if (consumptionCandidate) {
      bindingFault(errors, consumptionCandidate.bindings, transcript.bindings, "FORGED");
      if (consumptionCandidate.actor !== transcript.bindings?.brokerId) add(errors, "FORGED_CONSUME_ACTOR");
      if (consumptionCandidate.gateDigest !== gate.digest) add(errors, "GATE_CONSUMPTION_MISMATCH");
      if (consumptionCandidate.ackEventDigest !== acknowledgement?.digest) add(errors, "INCOMPARABLE_PREDECESSOR");
      if (consumptionCandidate.mintEventDigest !== mintCandidate?.digest) add(errors, "CONSUME_MINT_REFERENCE");
      if (consumptionCandidate.operationScope !== transcript.bindings?.scope) add(errors, "FORGED_SCOPE");
      exactPredecessors(
        errors,
        consumptionCandidate,
        acknowledgement && mintCandidate ? [acknowledgement.digest, mintCandidate.digest] : [],
        "CONSUME_PREDECESSOR_MISMATCH",
      );
    }

    const launchRelation = causalRelation(byDigest, consumptionCandidate?.digest, operation.launchReceiptDigest);
    if (launchRelation !== "after") addRelationFault(errors, "LAUNCH_CONSUME", launchRelation);
    const queryRelation = causalRelation(byDigest, consumptionCandidate?.digest, operation.queryReceiptDigest);
    if (queryRelation !== "after") addRelationFault(errors, "QUERY_CONSUME", queryRelation);

    for (const [receipt, kind, referenceCode, predecessorCode] of [
      [launchCandidate, "LAUNCH_RECEIPT", "LAUNCH_CONSUMPTION_REFERENCE", "LAUNCH_PREDECESSOR_MISMATCH"],
      [queryCandidate, "QUERY_RECEIPT", "QUERY_CONSUMPTION_REFERENCE", "QUERY_PREDECESSOR_MISMATCH"],
    ]) {
      if (!receipt || receipt.kind !== kind) continue;
      bindingFault(errors, receipt.bindings, transcript.bindings, "FORGED");
      if (receipt.actor !== transcript.bindings?.brokerId) add(errors, "FORGED_RECEIPT_ACTOR");
      if (receipt.consumptionDigest !== consumptionCandidate?.digest) add(errors, referenceCode);
      if (receipt.operationScope !== transcript.bindings?.scope) add(errors, "FORGED_SCOPE");
      if (receipt.transactionId !== operation.transactionId) add(errors, "POISONED_PRIOR_RECEIPT");
      exactPredecessors(errors, receipt, consumptionCandidate ? [consumptionCandidate.digest] : [], predecessorCode);
    }

    if (
      operation.atomic !== true ||
      consumptionCandidate?.atomic !== true
    ) {
      add(errors, "NON_ATOMIC_LAUNCH_QUERY");
    }
  }

  const consumptionEvents = events.filter(({ kind }) => kind === "KEY_GATE_CONSUMED");
  const consumeCounts = new Map();
  for (const consumption of consumptionEvents) {
    consumeCounts.set(consumption.gateDigest, (consumeCounts.get(consumption.gateDigest) ?? 0) + 1);
  }
  if (
    [...consumeCounts.values()].some((count) => count > 1) &&
    !errors.some(({ code }) => ["SEQUENTIAL_DUPLICATE_CONSUME", "CONCURRENT_DUPLICATE_CONSUME", "RESTART_REUSE"].includes(code))
  ) {
    add(errors, "SEQUENTIAL_DUPLICATE_CONSUME");
  }
  const reconstructedSpent = reconstructSpentGateDigests(events);
  const claimedSpent = [...(transcript.claimedSpentGateDigests ?? [])].sort();
  if (!same(reconstructedSpent, claimedSpent)) add(errors, "SPENT_STATE_LOSS");

  const referencedCapabilities = new Set(operations.map(({ gateDigest }) => gateDigest));
  if (capabilities.some(({ digest }) => !referencedCapabilities.has(digest))) add(errors, "UNREFERENCED_CAPABILITY");

  const displayOrder = displayOrderDiagnostics(events);
  return {
    authorized: accepted.length === 1 && errors.length === 0,
    errors,
    displayOrder,
    reconstructedSpentGateDigests: reconstructedSpent,
  };
}
