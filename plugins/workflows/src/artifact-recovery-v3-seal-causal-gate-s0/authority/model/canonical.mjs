import { createHash } from "node:crypto";

export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const DOMAIN_ROOT = "bb-artifact-review-v3-seal-causal-gate-s0\u0000";

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical numbers must be finite");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === undefined || typeof value !== "object") throw new TypeError("canonical values must be JSON values");

  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new TypeError(`undefined canonical field:${key}`);
    result[key] = canonicalize(value[key]);
  }
  return result;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function domainDigest(domain, value) {
  if (typeof domain !== "string" || domain.length === 0 || domain.includes("\u0000")) {
    throw new TypeError("non-empty unframed domain required");
  }
  return createHash("sha256")
    .update(`${DOMAIN_ROOT}${domain}\u0000${canonicalJson(value)}`, "utf8")
    .digest("hex");
}

export function eventPayload(event) {
  // displaySequence is diagnostics-only and cannot affect immutable identity or
  // authorization. All authority-bearing fields remain in the payload.
  const { digest: _digest, displaySequence: _displaySequence, ...payload } = event;
  return payload;
}

export function capabilityPayload(capability) {
  const { digest: _digest, ...payload } = capability;
  return payload;
}

export function eventDigest(event) {
  return domainDigest(`event/${event.kind}/v1`, eventPayload(event));
}

export function capabilityDigest(capability) {
  return domainDigest(`capability/${capability.kind}/v1`, capabilityPayload(capability));
}

// Compatibility alias for model-owned corpus helpers. KEY_GATE is a
// capability, never an append-only event.
export function nodeDigest(value) {
  return value.kind === "KEY_GATE" ? capabilityDigest(value) : eventDigest(value);
}

export const nodePayload = eventPayload;

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function isDigest(value) {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}
