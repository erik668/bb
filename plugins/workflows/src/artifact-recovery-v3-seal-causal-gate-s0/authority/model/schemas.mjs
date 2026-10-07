import { DIGEST_PATTERN, deepFreeze } from "./canonical.mjs";
import { AUTHORITY_ID } from "./authority-data.mjs";

const digest = { type: "string", pattern: DIGEST_PATTERN.source };
const string = { type: "string", minLength: 1 };
const sequence = { type: "integer", minimum: 0 };
const predecessors = { type: "array", items: digest, uniqueItems: true };

export const bindingSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: [
    "runId",
    "rowId",
    "challenge",
    "processId",
    "evidenceRootDigest",
    "sealedSubjectDigest",
    "verifierId",
    "recorderId",
    "brokerId",
    "scope",
  ],
  properties: {
    runId: string,
    rowId: string,
    challenge: string,
    processId: string,
    evidenceRootDigest: digest,
    sealedSubjectDigest: digest,
    verifierId: string,
    recorderId: string,
    brokerId: string,
    scope: { const: "launch+query" },
  },
});

const eventBase = { digest, predecessors, displaySequence: sequence, actor: string };

function eventSchema(kind, required = [], properties = {}) {
  return deepFreeze({
    type: "object",
    additionalProperties: false,
    required: ["digest", "kind", "predecessors", "displaySequence", "actor", ...required],
    properties: { ...eventBase, kind: { const: kind }, ...properties },
  });
}

export const eventSchemas = deepFreeze({
  GENESIS: eventSchema("GENESIS"),
  SEALED_SUBJECT: eventSchema("SEALED_SUBJECT", ["bindings", "subjectDigest"], {
    bindings: bindingSchema,
    subjectDigest: digest,
  }),
  SEAL_VERIFIED_ACK: eventSchema(
    "SEAL_VERIFIED_ACK",
    ["bindings", "sealedSubjectEventDigest", "sealedSubjectDigest", "validated"],
    {
      bindings: bindingSchema,
      sealedSubjectEventDigest: digest,
      sealedSubjectDigest: digest,
      validated: { const: true },
    },
  ),
  KEY_GATE_MINTED: eventSchema("KEY_GATE_MINTED", ["bindings", "ackEventDigest", "gateDigest"], {
    bindings: bindingSchema,
    ackEventDigest: digest,
    gateDigest: digest,
  }),
  KEY_GATE_CONSUMED: eventSchema(
    "KEY_GATE_CONSUMED",
    ["bindings", "ackEventDigest", "mintEventDigest", "gateDigest", "operationScope", "atomic", "transactionId"],
    {
      bindings: bindingSchema,
      ackEventDigest: digest,
      mintEventDigest: digest,
      gateDigest: digest,
      operationScope: { const: "launch+query" },
      atomic: { const: true },
      transactionId: string,
    },
  ),
  LAUNCH_RECEIPT: eventSchema(
    "LAUNCH_RECEIPT",
    ["bindings", "consumptionDigest", "operationScope", "transactionId"],
    {
      bindings: bindingSchema,
      consumptionDigest: digest,
      operationScope: { const: "launch+query" },
      transactionId: string,
    },
  ),
  QUERY_RECEIPT: eventSchema(
    "QUERY_RECEIPT",
    ["bindings", "consumptionDigest", "operationScope", "transactionId"],
    {
      bindings: bindingSchema,
      consumptionDigest: digest,
      operationScope: { const: "launch+query" },
      transactionId: string,
    },
  ),
  WITNESS: eventSchema("WITNESS", ["label"], { label: string }),
});

// Backward-compatible export name for consumers that treat every append-only
// authority object as a node. KEY_GATE deliberately does not appear here.
export const nodeSchemas = eventSchemas;

export const capabilitySchemas = deepFreeze({
  KEY_GATE: {
    type: "object",
    additionalProperties: false,
    required: ["digest", "kind", "bindings", "issuer", "ackEventDigest", "operationScope"],
    properties: {
      digest,
      kind: { const: "KEY_GATE" },
      bindings: bindingSchema,
      issuer: string,
      ackEventDigest: digest,
      operationScope: { const: "launch+query" },
    },
  },
});

export const operationSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: [
    "transactionId",
    "mode",
    "gateDigest",
    "mintEventDigest",
    "consumptionDigest",
    "launchReceiptDigest",
    "queryReceiptDigest",
    "atomic",
    "accepted",
    "attemptBindings",
  ],
  properties: {
    transactionId: string,
    mode: { enum: ["initial", "sequential-retry", "concurrent-race", "restart-retry"] },
    gateDigest: digest,
    mintEventDigest: digest,
    consumptionDigest: digest,
    launchReceiptDigest: digest,
    queryReceiptDigest: digest,
    atomic: { type: "boolean" },
    accepted: { type: "boolean" },
    attemptBindings: bindingSchema,
  },
});

export const apiSurfaceSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["coordinator", "recorder", "broker", "universal"],
  properties: {
    coordinator: { type: "array", items: string, uniqueItems: true },
    recorder: { type: "array", items: string, uniqueItems: true },
    broker: { type: "array", items: string, uniqueItems: true },
    universal: { type: "array", items: string, uniqueItems: true },
  },
});

export const transcriptSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "seamId",
    "authorityBasis",
    "bindings",
    "events",
    "capabilities",
    "operations",
    "claimedSpentGateDigests",
    "apiSurface",
  ],
  properties: {
    version: { const: 1 },
    seamId: { const: AUTHORITY_ID },
    authorityBasis: { const: "event-identity-reachability" },
    bindings: bindingSchema,
    events: { type: "array", items: { type: "object" } },
    capabilities: { type: "array", items: { type: "object" } },
    operations: { type: "array", items: operationSchema },
    claimedSpentGateDigests: { type: "array", items: digest, uniqueItems: true },
    apiSurface: apiSurfaceSchema,
  },
});

function typeMatches(type, value) {
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

export function validateSchema(schema, value, path = "$") {
  const errors = [];
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}:const`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}:enum`);
  if (schema.type && !typeMatches(schema.type, value)) return [...errors, `${path}:type`];
  if (schema.type === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}:minLength`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}:pattern`);
  }
  if (schema.type === "integer" && schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}:minimum`);
  if (schema.type === "array") {
    value.forEach((item, index) => errors.push(...validateSchema(schema.items, item, `${path}[${index}]`)));
    if (schema.uniqueItems) {
      const keys = value.map((item) => JSON.stringify(item));
      if (new Set(keys).size !== keys.length) errors.push(`${path}:uniqueItems`);
    }
  }
  if (schema.type === "object") {
    const keys = Object.keys(value);
    for (const required of schema.required ?? []) if (!(required in value)) errors.push(`${path}.${required}:required`);
    if (schema.additionalProperties === false) {
      for (const key of keys) if (!(key in (schema.properties ?? {}))) errors.push(`${path}.${key}:additionalProperties`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in value) errors.push(...validateSchema(child, value[key], `${path}.${key}`));
    }
  }
  return errors;
}

export function validateEventSchema(event, path = "$.events[]") {
  const schema = event && typeof event === "object" ? eventSchemas[event.kind] : undefined;
  return schema ? validateSchema(schema, event, path) : [`${path}.kind:unknown`];
}

export function validateCapabilitySchema(capability, path = "$.capabilities[]") {
  const schema = capability && typeof capability === "object" ? capabilitySchemas[capability.kind] : undefined;
  return schema ? validateSchema(schema, capability, path) : [`${path}.kind:unknown`];
}

export const validateNodeSchema = validateEventSchema;
