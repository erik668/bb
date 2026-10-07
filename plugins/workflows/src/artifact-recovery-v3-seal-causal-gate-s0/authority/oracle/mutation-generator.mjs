import {
  API_ALLOWLIST,
  EVENT_DEFINITIONS,
  EVENT_SLOTS,
  FAULT_SPECS,
  SCHEMA_NEGATIVE_SPECS,
} from "./oracle-contract.mjs";
import {
  canonicalDigest,
  eventDomain,
} from "./partial-order-oracle.mjs";

const clone = (value) => structuredClone(value);

function event(trace, slot) {
  return trace.events.find((candidate) => candidate.slot === slot);
}

function makeEvent(slot, predecessors, bindings, sequence, transactionId) {
  const definition = EVENT_DEFINITIONS[slot];
  const value = {
    slot,
    kind: definition.kind,
    domain: eventDomain(definition.kind),
    issuer: definition.issuer,
    predecessors,
    bindings,
    sequence,
  };
  if (transactionId) value.transactionId = transactionId;
  value.id = canonicalDigest(value);
  return value;
}

export function makeLegalTrace() {
  const context = {
    runId: "run:s0:oracle:001",
    rowId: "causal-authority:001",
    challenge: "challenge:s0:fresh:001",
    nonce: "nonce:s0:fresh:001",
    sealedLedgerDigest: "1".repeat(64),
    verifierId: "verifier:independent",
    recorderId: "recorder:external",
    brokerId: "broker:key-holder",
    operationScope: "launch-and-query:atomic",
  };
  const common = () => ({ ...context });
  const transactionId = "broker-transaction:s0:001";

  const ack = makeEvent(
    "ack",
    [],
    { ...common(), sealValidated: true },
    9,
  );
  const mint = makeEvent(
    "mint",
    [ack.id],
    { ...common(), sealAckDigest: ack.id },
    10,
  );
  const consume = makeEvent(
    "consume",
    [ack.id, mint.id],
    {
      ...common(),
      sealAckDigest: ack.id,
      gateDigest: mint.id,
      atomic: true,
    },
    11,
    transactionId,
  );
  const receiptBindings = () => ({
    ...common(),
    sealAckDigest: ack.id,
    gateDigest: mint.id,
    gateConsumptionDigest: consume.id,
  });
  const launch = makeEvent(
    "launch",
    [consume.id],
    receiptBindings(),
    12,
    transactionId,
  );
  const query = makeEvent(
    "query",
    [consume.id],
    receiptBindings(),
    12,
    transactionId,
  );

  return {
    context,
    events: [ack, mint, consume, launch, query],
    apiSurface: [...API_ALLOWLIST],
    consumptionAttempts: [
      {
        gateDigest: mint.id,
        outcome: "accepted",
        concurrencyGroup: "atomic:s0:001",
      },
    ],
    restart: {
      independent: true,
      closed: true,
      reopened: true,
      spentGateDigests: [mint.id],
      reconstructedFromEventDigests: [consume.id],
      poisonedPriorReceiptAccepted: false,
      spentGateReplayAccepted: false,
    },
  };
}

function rehashCanonicalChain(trace) {
  const remappedIds = new Map();
  for (const slot of EVENT_SLOTS) {
    const current = event(trace, slot);
    if (!current) continue;
    const previousId = current.id;
    current.predecessors = current.predecessors.map(
      (id) => remappedIds.get(id) ?? id,
    );
    for (const field of [
      "sealAckDigest",
      "gateDigest",
      "gateConsumptionDigest",
    ]) {
      if (current.bindings?.[field]) {
        current.bindings[field] =
          remappedIds.get(current.bindings[field]) ?? current.bindings[field];
      }
    }
    current.id = canonicalDigest(current);
    remappedIds.set(previousId, current.id);
  }

  for (const attempt of trace.consumptionAttempts ?? []) {
    attempt.gateDigest =
      remappedIds.get(attempt.gateDigest) ?? attempt.gateDigest;
  }
  if (trace.restart) {
    trace.restart.spentGateDigests = trace.restart.spentGateDigests?.map(
      (id) => remappedIds.get(id) ?? id,
    );
    trace.restart.reconstructedFromEventDigests =
      trace.restart.reconstructedFromEventDigests?.map(
        (id) => remappedIds.get(id) ?? id,
      );
  }
  return trace;
}

function mutateRelation(trace, mutation) {
  const anchor = event(trace, mutation.anchor);
  const subject = event(trace, mutation.subject);
  if (mutation.relation === "same") subject.id = anchor.id;
  if (mutation.relation === "incomparable") {
    subject.predecessors = subject.predecessors.filter(
      (id) => id !== anchor.id,
    );
  }
  if (mutation.relation === "before") {
    subject.predecessors = subject.predecessors.filter(
      (id) => id !== anchor.id,
    );
    anchor.predecessors = [...anchor.predecessors, subject.id];
  }
  return trace;
}

export function mutateTrace(trace, spec) {
  const mutation = spec.mutation;
  if (mutation.type === "relation") return mutateRelation(trace, mutation);

  if (mutation.type === "binding") {
    event(trace, mutation.slot).bindings[mutation.field] = mutation.value;
    return rehashCanonicalChain(trace);
  }
  if (mutation.type === "issuer") {
    event(trace, mutation.slot).issuer = mutation.issuer;
    return rehashCanonicalChain(trace);
  }
  if (mutation.type === "predecessor") {
    const current = event(trace, mutation.slot);
    if (mutation.mode === "missing") {
      const predecessorId = event(trace, mutation.predecessorSlot).id;
      current.predecessors = current.predecessors.filter(
        (id) => id !== predecessorId,
      );
    }
    if (mutation.mode === "unexpected") {
      current.predecessors.push("f".repeat(64));
    }
    return trace;
  }
  if (mutation.type === "consumption") {
    const gateDigest = event(trace, "mint").id;
    if (mutation.mode === "zero") trace.consumptionAttempts = [];
    if (mutation.mode === "sequential-duplicate") {
      trace.consumptionAttempts.push({
        gateDigest,
        outcome: "accepted",
        concurrencyGroup: "later:s0:002",
      });
    }
    if (mutation.mode === "concurrent-duplicate") {
      trace.consumptionAttempts.push({
        gateDigest,
        outcome: "accepted",
        concurrencyGroup: "atomic:s0:001",
      });
    }
    if (mutation.mode === "wrong-gate") {
      trace.consumptionAttempts[0].gateDigest = "e".repeat(64);
    }
    return trace;
  }
  if (mutation.type === "restart") {
    if (mutation.mode === "not-independent") trace.restart.independent = false;
    if (mutation.mode === "not-closed") trace.restart.closed = false;
    if (mutation.mode === "not-reopened") trace.restart.reopened = false;
    if (mutation.mode === "missing-spent") trace.restart.spentGateDigests = [];
    if (mutation.mode === "missing-consumption-evidence") {
      trace.restart.reconstructedFromEventDigests = [];
    }
    if (mutation.mode === "wrong-consumption-evidence") {
      trace.restart.reconstructedFromEventDigests = [event(trace, "ack").id];
    }
    if (mutation.mode === "poisoned-prior") {
      trace.restart.poisonedPriorReceiptAccepted = true;
    }
    if (mutation.mode === "accepted-replay") {
      trace.restart.spentGateReplayAccepted = true;
    }
    return trace;
  }
  if (mutation.type === "identity") {
    const current = mutation.slot ? event(trace, mutation.slot) : undefined;
    if (mutation.mode === "tamper") current.id = "d".repeat(64);
    if (mutation.mode === "alias") {
      event(trace, "query").id = event(trace, "launch").id;
    }
    if (mutation.mode === "domain") {
      current.domain = "bb.artifact-review.forged/v0";
      rehashCanonicalChain(trace);
    }
    if (mutation.mode === "kind") {
      current.kind = "FORGED_EVENT_KIND";
      rehashCanonicalChain(trace);
    }
    return trace;
  }
  if (mutation.type === "cycle") {
    if (mutation.mode === "self") {
      const current = event(trace, mutation.slot);
      current.predecessors.push(current.id);
    }
    if (mutation.mode === "multi") {
      event(trace, "ack").predecessors.push(event(trace, "query").id);
    }
    return trace;
  }
  if (mutation.type === "atomic") {
    if (mutation.mode === "consume-launch-split") {
      event(trace, "launch").transactionId = "broker-transaction:forged-launch";
      rehashCanonicalChain(trace);
    }
    if (mutation.mode === "consume-query-split") {
      event(trace, "query").transactionId = "broker-transaction:forged-query";
      rehashCanonicalChain(trace);
    }
    if (mutation.mode === "missing-launch") {
      trace.events = trace.events.filter(({ slot }) => slot !== "launch");
    }
    if (mutation.mode === "missing-query") {
      trace.events = trace.events.filter(({ slot }) => slot !== "query");
    }
    return trace;
  }
  if (mutation.type === "api") {
    trace.apiSurface.push(mutation.api);
    return trace;
  }
  throw new Error(`unknown mutation type: ${mutation.type}`);
}

export function generateKnownBadTraces() {
  return FAULT_SPECS.map((spec) => ({
    spec,
    trace: mutateTrace(clone(makeLegalTrace()), spec),
  }));
}

export function generateSequenceVariants() {
  const variants = EVENT_SLOTS.map((slot, index) => {
    const trace = makeLegalTrace();
    event(trace, slot).sequence += 1000 + index;
    return { id: `sequence-perturb-${slot}`, mutatedSlots: [slot], trace };
  });

  const equal = makeLegalTrace();
  equal.events.forEach((current) => {
    current.sequence = 7;
  });
  variants.push({ id: "sequence-all-equal", mutatedSlots: [...EVENT_SLOTS], trace: equal });

  const reversed = makeLegalTrace();
  [50, 40, 30, 20, 10].forEach((sequence, index) => {
    reversed.events[index].sequence = sequence;
  });
  variants.push({ id: "sequence-reversed", mutatedSlots: [...EVENT_SLOTS], trace: reversed });

  const sparse = makeLegalTrace();
  [-300, -20, 0, 9000, 9000].forEach((sequence, index) => {
    sparse.events[index].sequence = sequence;
  });
  variants.push({ id: "sequence-sparse-renumber", mutatedSlots: [...EVENT_SLOTS], trace: sparse });

  return variants;
}

export function generateSchemaNegatives() {
  return SCHEMA_NEGATIVE_SPECS.map((spec) => {
    if (spec.mode === "trace-missing") return { spec, trace: null };
    const trace = makeLegalTrace();
    if (spec.mode === "events-missing") delete trace.events;
    if (spec.mode === "events-type") trace.events = {};
    if (spec.mode === "context-missing") delete trace.context;
    if (spec.mode === "slot-duplicate") trace.events[1].slot = "ack";
    if (spec.mode === "slot-unknown") trace.events[1].slot = "unknown";
    if (spec.mode === "predecessors-type") trace.events[1].predecessors = "ack";
    if (spec.mode === "sequence-type") trace.events[0].sequence = 1.5;
    if (spec.mode === "bindings-type") trace.events[1].bindings = [];
    if (spec.mode === "identity-type") trace.events[0].id = null;
    if (spec.mode === "attempts-type") trace.consumptionAttempts = {};
    if (spec.mode === "restart-missing") delete trace.restart;
    if (spec.mode === "api-type") trace.apiSurface = {};
    return { spec, trace };
  });
}
