import { createHash } from "node:crypto";
import {
  API_ALLOWLIST,
  CONTEXT_BINDINGS,
  EVENT_DEFINITIONS,
  EVENT_SLOTS,
  REQUIRED_RELATIONS,
} from "./oracle-contract.mjs";

export const EVENT_DOMAIN_PREFIX = "bb.artifact-review.s0.event";

function stable(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stable(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function eventDomain(kind) {
  return `${EVENT_DOMAIN_PREFIX}/${kind}/v1`;
}

export function canonicalEventBytes(event) {
  return stable({
    bindings: event.bindings,
    domain: event.domain,
    issuer: event.issuer,
    kind: event.kind,
    predecessors: event.predecessors,
    slot: event.slot,
    transactionId: event.transactionId ?? null,
  });
}

export function canonicalDigest(event) {
  return createHash("sha256")
    .update(canonicalEventBytes(event))
    .digest("hex");
}

function isStrictAncestor(eventsById, ancestorId, descendantId) {
  if (ancestorId === descendantId) return false;
  const pending = [descendantId];
  const visited = new Set();
  while (pending.length > 0) {
    const currentId = pending.pop();
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    const current = eventsById.get(currentId);
    if (!Array.isArray(current?.predecessors)) continue;
    for (const predecessorId of current.predecessors) {
      if (predecessorId === ancestorId) return true;
      pending.push(predecessorId);
    }
  }
  return false;
}

export function classifyRelation(eventsById, anchorId, subjectId) {
  if (anchorId === subjectId) return "same";
  if (isStrictAncestor(eventsById, anchorId, subjectId)) return "valid-after";
  if (isStrictAncestor(eventsById, subjectId, anchorId)) return "before";
  return "incomparable";
}

function graphHasCycle(eventsById) {
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === "visiting") return true;
    if (state.get(id) === "visited") return false;
    state.set(id, "visiting");
    const event = eventsById.get(id);
    for (const predecessorId of event?.predecessors ?? []) {
      if (eventsById.has(predecessorId) && visit(predecessorId)) return true;
    }
    state.set(id, "visited");
    return false;
  };
  return [...eventsById.keys()].some((id) => visit(id));
}

function compareExactPredecessors(errors, bySlot, byId) {
  for (const slot of EVENT_SLOTS) {
    const current = bySlot.get(slot);
    if (!current || !Array.isArray(current.predecessors)) continue;
    const expectedSlots = EVENT_DEFINITIONS[slot].predecessorSlots;
    const expectedIds = expectedSlots
      .map((predecessorSlot) => bySlot.get(predecessorSlot)?.id)
      .filter(Boolean);

    for (const predecessorSlot of expectedSlots) {
      const predecessorId = bySlot.get(predecessorSlot)?.id;
      if (predecessorId && !current.predecessors.includes(predecessorId)) {
        errors.add(`predecessor:missing:${slot}:${predecessorSlot}`);
      }
    }
    for (const predecessorId of current.predecessors) {
      if (!expectedIds.includes(predecessorId)) {
        const predecessorSlot = byId.get(predecessorId)?.slot ?? "rogue";
        errors.add(`predecessor:unexpected:${slot}:${predecessorSlot}`);
      }
    }
    if (new Set(current.predecessors).size !== current.predecessors.length) {
      errors.add(`predecessor:duplicate:${slot}`);
    }
  }
}

function compareBindings(errors, trace, bySlot) {
  for (const slot of EVENT_SLOTS) {
    const current = bySlot.get(slot);
    if (!current?.bindings || typeof current.bindings !== "object") continue;
    for (const field of CONTEXT_BINDINGS) {
      if (current.bindings[field] !== trace.context?.[field]) {
        errors.add(`binding:mismatch:${slot}:${field}`);
      }
    }
  }

  const ack = bySlot.get("ack");
  const mint = bySlot.get("mint");
  const consume = bySlot.get("consume");
  const launch = bySlot.get("launch");
  const query = bySlot.get("query");

  if (ack?.bindings?.sealValidated !== true) errors.add("ack:not-validated");
  if (mint?.bindings?.sealAckDigest !== ack?.id) {
    errors.add("binding:mismatch:mint:sealAckDigest");
  }
  if (consume?.bindings?.sealAckDigest !== ack?.id) {
    errors.add("binding:mismatch:consume:sealAckDigest");
  }
  if (consume?.bindings?.gateDigest !== mint?.id) {
    errors.add("binding:mismatch:consume:gateDigest");
  }
  if (consume?.bindings?.atomic !== true) errors.add("consume:not-atomic");

  for (const receipt of [launch, query]) {
    if (!receipt) continue;
    if (receipt.bindings?.sealAckDigest !== ack?.id) {
      errors.add(`binding:mismatch:${receipt.slot}:sealAckDigest`);
    }
    if (receipt.bindings?.gateDigest !== mint?.id) {
      errors.add(`binding:mismatch:${receipt.slot}:gateDigest`);
    }
    if (receipt.bindings?.gateConsumptionDigest !== consume?.id) {
      errors.add(
        `binding:mismatch:${receipt.slot}:gateConsumptionDigest`,
      );
    }
  }
}

function compareConsumption(errors, trace, bySlot) {
  if (!Array.isArray(trace.consumptionAttempts)) return;
  const mint = bySlot.get("mint");
  const accepted = trace.consumptionAttempts.filter(
    ({ outcome }) => outcome === "accepted",
  );
  if (accepted.length !== 1) {
    errors.add(`consumption:cardinality:${accepted.length}`);
  }
  if (accepted.some(({ gateDigest }) => gateDigest !== mint?.id)) {
    errors.add("consumption:gate-mismatch");
  }
  if (accepted.length > 1) {
    const groups = new Set(accepted.map(({ concurrencyGroup }) => concurrencyGroup));
    if (groups.size === 1) errors.add("consumption:concurrent-duplicate");
    if (groups.size > 1) errors.add("consumption:sequential-duplicate");
  }
}

function compareRestart(errors, trace, bySlot) {
  const restart = trace.restart;
  if (!restart || typeof restart !== "object" || Array.isArray(restart)) return;
  const mint = bySlot.get("mint");
  const consume = bySlot.get("consume");

  if (restart.independent !== true) errors.add("restart:not-independent");
  if (restart.closed !== true) errors.add("restart:not-closed");
  if (restart.reopened !== true) errors.add("restart:not-reopened");
  if (!restart.spentGateDigests?.includes(mint?.id)) {
    errors.add("restart:spent-not-reconstructed");
  }
  if (!Array.isArray(restart.reconstructedFromEventDigests) || restart.reconstructedFromEventDigests.length === 0) {
    errors.add("restart:consumption-evidence-missing");
  } else if (!restart.reconstructedFromEventDigests.includes(consume?.id)) {
    errors.add("restart:consumption-evidence-wrong");
  }
  if (restart.poisonedPriorReceiptAccepted === true) {
    errors.add("restart:poisoned-prior-receipt");
  }
  if (restart.spentGateReplayAccepted === true) {
    errors.add("restart:replay-accepted");
  }
}

export function evaluateTrace(trace) {
  const errors = new Set();
  const metadataErrors = new Set();
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) {
    return { authorized: false, errors: ["schema:trace"], metadataErrors: [] };
  }
  if (!trace.context || typeof trace.context !== "object" || Array.isArray(trace.context)) {
    errors.add("schema:context:missing");
  }
  if (!("events" in trace)) {
    errors.add("schema:events:missing");
    return { authorized: false, errors: [...errors].sort(), metadataErrors: [] };
  }
  if (!Array.isArray(trace.events)) {
    errors.add("schema:events:type");
    return { authorized: false, errors: [...errors].sort(), metadataErrors: [] };
  }
  if (!Array.isArray(trace.consumptionAttempts)) {
    errors.add("schema:consumption-attempts:type");
  }
  if (!trace.restart || typeof trace.restart !== "object" || Array.isArray(trace.restart)) {
    errors.add("schema:restart:missing");
  }
  if (!Array.isArray(trace.apiSurface)) errors.add("schema:api-surface:type");

  const bySlot = new Map();
  const byId = new Map();
  const canonicalBytesById = new Map();
  for (const current of trace.events) {
    const slot = current?.slot;
    if (!EVENT_SLOTS.includes(slot)) {
      errors.add("schema:slot:unknown");
      continue;
    }
    if (bySlot.has(slot)) errors.add("schema:slot:duplicate");
    bySlot.set(slot, current);

    if (!Array.isArray(current.predecessors)) {
      errors.add(`schema:predecessors:type:${slot}`);
    }
    if (!Number.isInteger(current.sequence)) {
      errors.add(`schema:sequence:type:${slot}`);
    }
    if (!current.bindings || typeof current.bindings !== "object" || Array.isArray(current.bindings)) {
      errors.add(`schema:bindings:type:${slot}`);
    }
    if (typeof current.id !== "string") errors.add(`schema:identity:type:${slot}`);

    const definition = EVENT_DEFINITIONS[slot];
    if (current.kind !== definition.kind) errors.add(`identity:kind-mismatch:${slot}`);
    if (current.domain !== eventDomain(definition.kind)) {
      errors.add(`identity:domain-mismatch:${slot}`);
    }
    if (current.issuer !== definition.issuer) errors.add(`issuer:mismatch:${slot}`);

    if (current.id !== canonicalDigest(current)) {
      errors.add(`identity:digest-mismatch:${slot}`);
    }
    const bytes = canonicalEventBytes(current);
    if (canonicalBytesById.has(current.id) && canonicalBytesById.get(current.id) !== bytes) {
      errors.add("identity:alias");
    }
    canonicalBytesById.set(current.id, bytes);
    if (!byId.has(current.id)) byId.set(current.id, current);
  }

  for (const slot of EVENT_SLOTS) {
    if (!bySlot.has(slot)) errors.add(`receipt:missing:${slot}`);
  }
  for (const current of trace.events) {
    if (current?.predecessors?.includes(current.id)) {
      errors.add(`graph:self-cycle:${current.slot}`);
    }
  }
  if (graphHasCycle(byId)) errors.add("graph:cycle");

  compareExactPredecessors(errors, bySlot, byId);
  for (const [anchorSlot, subjectSlot] of REQUIRED_RELATIONS) {
    const anchor = bySlot.get(anchorSlot);
    const subject = bySlot.get(subjectSlot);
    if (!anchor || !subject) continue;
    const actual = classifyRelation(byId, anchor.id, subject.id);
    if (actual !== "valid-after") {
      errors.add(
        `relation:${anchorSlot}->${subjectSlot}:expected-valid-after:actual-${actual}`,
      );
    }
  }

  compareBindings(errors, trace, bySlot);

  const consume = bySlot.get("consume");
  for (const slot of ["launch", "query"]) {
    const receipt = bySlot.get(slot);
    if (consume && receipt && receipt.transactionId !== consume.transactionId) {
      errors.add(`atomic:transaction-mismatch:${slot}`);
    }
  }

  compareConsumption(errors, trace, bySlot);
  compareRestart(errors, trace, bySlot);

  if (Array.isArray(trace.apiSurface)) {
    for (const api of trace.apiSurface) {
      if (!API_ALLOWLIST.includes(api)) errors.add(`api:forbidden:${api}`);
    }
  }

  const [ack, mint, consumeEvent, launch, query] = EVENT_SLOTS.map((slot) =>
    bySlot.get(slot),
  );
  if ([ack, mint, consumeEvent, launch, query].every(Boolean)) {
    if (!(ack.sequence < mint.sequence && mint.sequence < consumeEvent.sequence)) {
      metadataErrors.add("sequence:malformed-prefix");
    }
    if (!(consumeEvent.sequence < launch.sequence && launch.sequence === query.sequence)) {
      metadataErrors.add("sequence:malformed-atomic-tail");
    }
  }

  return {
    authorized: errors.size === 0,
    errors: [...errors].sort(),
    metadataErrors: [...metadataErrors].sort(),
  };
}
