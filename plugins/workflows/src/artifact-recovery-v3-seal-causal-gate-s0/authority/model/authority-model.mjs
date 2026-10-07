import {
  canonicalJson,
  capabilityDigest,
  cloneJson,
  deepFreeze,
  eventDigest,
} from "./canonical.mjs";
import { AUTHORITY_ID } from "./authority-data.mjs";
import {
  validateCapabilitySchema,
  validateEventSchema,
  validateSchema,
  operationSchema,
} from "./schemas.mjs";

export const DEFAULT_BINDINGS = deepFreeze({
  runId: "run-s0-001",
  rowId: "row-s0-001",
  challenge: "challenge-s0-001",
  processId: "pid-s0-001",
  evidenceRootDigest: "10".repeat(32),
  sealedSubjectDigest: "11".repeat(32),
  verifierId: "verifier-s0",
  recorderId: "recorder-s0",
  brokerId: "broker-s0",
  scope: "launch+query",
});

export const CLOSED_API_SURFACE = deepFreeze({
  coordinator: ["coordinate"],
  recorder: ["appendSealVerifiedAck", "mintKeyGateFromAck"],
  broker: ["consumeKeyGateForAtomicLaunchQuery"],
  universal: [],
});

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function makeEvent(kind, actor, predecessors, displaySequence, fields = {}) {
  const unsigned = { kind, predecessors: [...predecessors], displaySequence, actor, ...cloneJson(fields) };
  return deepFreeze({ digest: eventDigest(unsigned), ...unsigned });
}

function makeCapability(kind, fields) {
  const unsigned = { kind, ...cloneJson(fields) };
  return deepFreeze({ digest: capabilityDigest(unsigned), ...unsigned });
}

function eventMap(events) {
  return new Map(events.map((event) => [event.digest, event]));
}

export function strictlyDescends(events, ancestorDigest, descendantDigest) {
  if (!ancestorDigest || !descendantDigest || ancestorDigest === descendantDigest) return false;
  const byDigest = eventMap(events);
  const pending = [descendantDigest];
  const visited = new Set();
  while (pending.length) {
    const digest = pending.pop();
    if (visited.has(digest)) continue;
    visited.add(digest);
    for (const predecessor of byDigest.get(digest)?.predecessors ?? []) {
      if (predecessor === ancestorDigest) return true;
      pending.push(predecessor);
    }
  }
  return false;
}

export function reconstructSpentGateDigests(events) {
  return [...new Set(events.filter(({ kind }) => kind === "KEY_GATE_CONSUMED").map(({ gateDigest }) => gateDigest))].sort();
}

function appendEventTo(events, event) {
  const schemaErrors = validateEventSchema(event);
  if (schemaErrors.length) throw new Error(`closed-event-schema:${schemaErrors.join(",")}`);
  if (event.digest !== eventDigest(event)) throw new Error("immutable-event-identity");
  if (events.some(({ digest }) => digest === event.digest)) throw new Error("duplicate-event-identity");
  const known = new Set(events.map(({ digest }) => digest));
  for (const predecessor of event.predecessors) {
    if (!known.has(predecessor)) throw new Error("missing-predecessor");
    if (predecessor === event.digest) throw new Error("self-cycle");
  }
  events.push(event);
  return event;
}

function storeCapabilityIn(capabilities, capability) {
  const schemaErrors = validateCapabilitySchema(capability);
  if (schemaErrors.length) throw new Error(`closed-capability-schema:${schemaErrors.join(",")}`);
  if (capability.digest !== capabilityDigest(capability)) throw new Error("immutable-capability-identity");
  if (capabilities.some(({ digest }) => digest === capability.digest)) throw new Error("duplicate-capability-identity");
  capabilities.push(capability);
  return capability;
}

export class SealCausalAuthority {
  #events = [];
  #capabilities = [];
  #operations = [];
  #bindings;

  constructor(bindings = DEFAULT_BINDINGS, retained = null) {
    this.#bindings = deepFreeze(cloneJson(bindings));
    if (retained) {
      for (const event of retained.events ?? []) appendEventTo(this.#events, deepFreeze(cloneJson(event)));
      for (const capability of retained.capabilities ?? []) {
        storeCapabilityIn(this.#capabilities, deepFreeze(cloneJson(capability)));
      }
      for (const operation of retained.operations ?? []) {
        const errors = validateSchema(operationSchema, operation);
        if (errors.length) throw new Error(`closed-operation-schema:${errors.join(",")}`);
        this.#operations.push(deepFreeze(cloneJson(operation)));
      }
    } else {
      appendEventTo(this.#events, makeEvent("GENESIS", this.#bindings.recorderId, [], 0));
    }
  }

  static restart(retainedTranscript) {
    // claimedSpentGateDigests is deliberately ignored. Spent authority is
    // reconstructed from retained append-only consumption events.
    return new SealCausalAuthority(retainedTranscript.bindings, retainedTranscript);
  }

  appendSealedSubject({ actor = this.#bindings.verifierId, displaySequence = 1 } = {}) {
    if (actor !== this.#bindings.verifierId) throw new Error("verifier-custody");
    const genesis = this.#events.find(({ kind }) => kind === "GENESIS");
    if (!genesis) throw new Error("genesis-missing");
    return appendEventTo(
      this.#events,
      makeEvent("SEALED_SUBJECT", actor, [genesis.digest], displaySequence, {
        bindings: this.#bindings,
        subjectDigest: this.#bindings.sealedSubjectDigest,
      }),
    );
  }

  appendSealVerifiedAck({ actor = this.#bindings.recorderId, displaySequence = 2, sealedSubjectEventDigest } = {}) {
    if (actor !== this.#bindings.recorderId) throw new Error("recorder-ack-custody");
    const sealed = this.#events.find(
      (event) => event.digest === sealedSubjectEventDigest && event.kind === "SEALED_SUBJECT",
    );
    if (
      !sealed ||
      sealed.actor !== this.#bindings.verifierId ||
      sealed.subjectDigest !== this.#bindings.sealedSubjectDigest ||
      !same(sealed.bindings, this.#bindings)
    ) {
      throw new Error("sealed-subject-not-independently-verified");
    }
    return appendEventTo(
      this.#events,
      makeEvent("SEAL_VERIFIED_ACK", actor, [sealed.digest], displaySequence, {
        bindings: this.#bindings,
        sealedSubjectEventDigest: sealed.digest,
        sealedSubjectDigest: sealed.subjectDigest,
        validated: true,
      }),
    );
  }

  mintKeyGate({ actor = this.#bindings.recorderId, displaySequence = 3, acknowledgementDigest } = {}) {
    if (actor !== this.#bindings.recorderId) throw new Error("recorder-mint-custody");
    const acknowledgement = this.#events.find(
      (event) => event.digest === acknowledgementDigest && event.kind === "SEAL_VERIFIED_ACK",
    );
    if (
      !acknowledgement ||
      acknowledgement.actor !== this.#bindings.recorderId ||
      acknowledgement.validated !== true ||
      !same(acknowledgement.bindings, this.#bindings)
    ) {
      throw new Error("acknowledgement-not-appended-and-validated");
    }

    const stagedCapabilities = [...this.#capabilities];
    const gate = storeCapabilityIn(
      stagedCapabilities,
      makeCapability("KEY_GATE", {
        bindings: this.#bindings,
        issuer: this.#bindings.recorderId,
        ackEventDigest: acknowledgement.digest,
        operationScope: "launch+query",
      }),
    );
    const stagedEvents = [...this.#events];
    const mintEvent = appendEventTo(
      stagedEvents,
      makeEvent("KEY_GATE_MINTED", actor, [acknowledgement.digest], displaySequence, {
        bindings: this.#bindings,
        ackEventDigest: acknowledgement.digest,
        gateDigest: gate.digest,
      }),
    );
    this.#capabilities = stagedCapabilities;
    this.#events = stagedEvents;
    return deepFreeze({ gate, mintEvent });
  }

  atomicLaunchQuery({ actor = this.#bindings.brokerId, displaySequence = 4, gateDigest, transactionId = "transaction-s0-001" } = {}) {
    if (actor !== this.#bindings.brokerId) throw new Error("broker-custody");
    const gate = this.#capabilities.find((capability) => capability.digest === gateDigest && capability.kind === "KEY_GATE");
    if (!gate || !same(gate.bindings, this.#bindings)) throw new Error("gate-binding");
    if (gate.issuer !== this.#bindings.recorderId || gate.operationScope !== "launch+query") throw new Error("gate-authority");
    const acknowledgement = this.#events.find(
      (event) => event.digest === gate.ackEventDigest && event.kind === "SEAL_VERIFIED_ACK" && event.validated,
    );
    const mintEvent = this.#events.find(
      (event) => event.kind === "KEY_GATE_MINTED" && event.gateDigest === gate.digest && event.ackEventDigest === gate.ackEventDigest,
    );
    if (
      !acknowledgement ||
      !mintEvent ||
      !same(mintEvent.predecessors, [acknowledgement.digest]) ||
      !strictlyDescends(this.#events, acknowledgement.digest, mintEvent.digest)
    ) {
      throw new Error("gate-not-recorder-minted-after-ack");
    }
    if (reconstructSpentGateDigests(this.#events).includes(gate.digest)) throw new Error("gate-spent");

    const staged = [...this.#events];
    const consumption = appendEventTo(
      staged,
      makeEvent("KEY_GATE_CONSUMED", actor, [acknowledgement.digest, mintEvent.digest], displaySequence, {
        bindings: this.#bindings,
        ackEventDigest: acknowledgement.digest,
        mintEventDigest: mintEvent.digest,
        gateDigest: gate.digest,
        operationScope: "launch+query",
        atomic: true,
        transactionId,
      }),
    );
    const launch = appendEventTo(
      staged,
      makeEvent("LAUNCH_RECEIPT", actor, [consumption.digest], displaySequence + 1, {
        bindings: this.#bindings,
        consumptionDigest: consumption.digest,
        operationScope: "launch+query",
        transactionId,
      }),
    );
    const query = appendEventTo(
      staged,
      makeEvent("QUERY_RECEIPT", actor, [consumption.digest], displaySequence + 2, {
        bindings: this.#bindings,
        consumptionDigest: consumption.digest,
        operationScope: "launch+query",
        transactionId,
      }),
    );
    const operation = deepFreeze({
      transactionId,
      mode: "initial",
      gateDigest: gate.digest,
      mintEventDigest: mintEvent.digest,
      consumptionDigest: consumption.digest,
      launchReceiptDigest: launch.digest,
      queryReceiptDigest: query.digest,
      atomic: true,
      accepted: true,
      attemptBindings: this.#bindings,
    });
    this.#events = staged;
    this.#operations.push(operation);
    return deepFreeze({ consumption, launch, query });
  }

  isTransactionAuthorized(transactionId) {
    const operation = this.#operations.find((candidate) => candidate.transactionId === transactionId && candidate.accepted);
    if (!operation) return false;
    const byDigest = eventMap(this.#events);
    const gate = this.#capabilities.find(({ digest }) => digest === operation.gateDigest);
    const ack = gate && byDigest.get(gate.ackEventDigest);
    const mint = byDigest.get(operation.mintEventDigest);
    const consume = byDigest.get(operation.consumptionDigest);
    const launch = byDigest.get(operation.launchReceiptDigest);
    const query = byDigest.get(operation.queryReceiptDigest);
    return Boolean(
      gate && ack && mint && consume && launch && query &&
      ack.kind === "SEAL_VERIFIED_ACK" && ack.validated === true &&
      same(mint.predecessors, [ack.digest]) && mint.gateDigest === gate.digest &&
      same(consume.predecessors, [ack.digest, mint.digest]) && consume.gateDigest === gate.digest &&
      same(launch.predecessors, [consume.digest]) && launch.consumptionDigest === consume.digest &&
      same(query.predecessors, [consume.digest]) && query.consumptionDigest === consume.digest &&
      [ack, mint, consume, launch, query, gate].every((item) => same(item.bindings, this.#bindings)) &&
      strictlyDescends(this.#events, ack.digest, mint.digest) &&
      strictlyDescends(this.#events, mint.digest, consume.digest) &&
      strictlyDescends(this.#events, consume.digest, launch.digest) &&
      strictlyDescends(this.#events, consume.digest, query.digest)
    );
  }

  snapshot() {
    return deepFreeze({
      version: 1,
      seamId: AUTHORITY_ID,
      authorityBasis: "event-identity-reachability",
      bindings: cloneJson(this.#bindings),
      events: cloneJson(this.#events),
      capabilities: cloneJson(this.#capabilities),
      operations: cloneJson(this.#operations),
      claimedSpentGateDigests: reconstructSpentGateDigests(this.#events),
      apiSurface: cloneJson(CLOSED_API_SURFACE),
    });
  }
}

export function buildCompleteLegalTranscript() {
  const authority = new SealCausalAuthority();
  const sealed = authority.appendSealedSubject();
  const acknowledgement = authority.appendSealVerifiedAck({ sealedSubjectEventDigest: sealed.digest });
  const { gate } = authority.mintKeyGate({ acknowledgementDigest: acknowledgement.digest });
  authority.atomicLaunchQuery({ gateDigest: gate.digest });
  if (!authority.isTransactionAuthorized("transaction-s0-001")) throw new Error("operative-model-self-check");
  return authority.snapshot();
}
