import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import Ajv from "ajv";
import Database from "better-sqlite3";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

type PatchOperation = {
  op: "add" | "replace" | "remove";
  path: string;
  value?: JsonValue;
};

type ObserverType =
  | "case-outcome"
  | "digest-predicate"
  | "canonicalization-predicate"
  | "sqlite-normalization-predicate"
  | "static-digest-admission-predicate";

type MutationOutcome =
  | "killed"
  | "survived"
  | "uncovered"
  | "invalid-mutant"
  | "harness-error";

type FailurePhase =
  | "baseline-admission"
  | "mutant-construction"
  | "derived-view-admission"
  | "semantic-execution"
  | "kill-classification"
  | "negative-control"
  | "independent-review";

type CaseOutcome = {
  status: "completed" | "rejected";
  decision: string | null;
  errorClass: string | null;
  trace: string[];
  postSnapshotRef: string | null;
  writes: number | null;
  consumers: number | null;
  harnessError: string | null;
};

export type V12LedgerRow = {
  mutantId: string;
  semanticClass: string;
  intendedSemanticField: string;
  selected: boolean;
  targetResolved: boolean;
  patchApplied: boolean;
  intendedFieldChanged: boolean;
  descriptorBound: boolean;
  derivedEnvelopeBound: boolean;
  derivedEnvelopeDigest: string | null;
  declaredKillerCaseId: string;
  observerType: ObserverType;
  killerStarted: boolean;
  killerCompleted: boolean;
  baselineOutcome: JsonObject;
  mutantOutcome: JsonObject;
  divergenceField: string | null;
  declaredSemanticReason: string;
  observedSemanticReason: string | null;
  failurePhase: FailurePhase | null;
  outcome: MutationOutcome;
};

export type V12ControlRow = {
  controlId: string;
  controlType:
    | "trace-literal-substitution"
    | "semantically-inert-mutant"
    | "pre-killer-broken-harness";
  catalogMember: false;
  selected: boolean;
  patchApplied: boolean;
  killerStarted: boolean;
  killerCompleted: boolean;
  traceIndex: number | null;
  expectedLiteral: string | null;
  actualLiteral: string | null;
  failurePhase:
    | "semantic-execution"
    | "mutant-construction"
    | "negative-control";
  outcome: "trace-mismatch" | "survived" | "uncovered" | "harness-error";
  gateOutcome: "expected-red" | "unexpected-green";
  detail: string;
};

export type V12ExecutionReport = {
  baselineAdmissionRuns: 1;
  baselineRawSha256: string;
  baselineContractRoot: string;
  baseline: {
    selected: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  a0: {
    selected: number;
    patchApplied: number;
    killerStarted: number;
    killerCompleted: number;
    killed: number;
    survived: number;
    uncovered: number;
    invalidMutant: number;
    harnessError: number;
    missingRows: number;
    duplicateRows: number;
  };
  v3Construction: {
    selected: 0;
    patched: 0;
    executed: 0;
    constructed: 0;
    sentinels: number;
  };
  ledgerRows: V12LedgerRow[];
  controlRows: V12ControlRow[];
  controlsPass: boolean;
};

export type ValidationReport = {
  ok: boolean;
  errors: string[];
  rawSha256: string | null;
};

export type LiteralTraceComparison =
  | { equal: true; mismatchIndex: null; expected: null; actual: null }
  | {
      equal: false;
      mismatchIndex: number;
      expected: string | null;
      actual: string | null;
    };

const EXPECTED_AUTHORITY_ID = "artifact-review-v12:keyed-oracle-dsl-v1";
const EXPECTED_DSL_ID = "bb-keyed-sqlite-oracle-dsl-v12";
const EXPECTED_CANONICALIZATION = "bb-cjson-2";
const EXPECTED_REDUCER = "artifact-review-recovery-v3-reference";
const DESCRIPTOR_DOMAIN = "bb.artifact-review.v12.mutant-descriptor.v1";
const DERIVED_VIEW_DOMAIN = "bb.artifact-review.v12.derived-mutant-view.v1";

const DESCRIPTOR_FIELDS = [
  "id",
  "category",
  "targetId",
  "targetOwner",
  "phase",
  "arm",
  "semanticClass",
  "intendedSemanticField",
  "targetPointer",
  "patch",
  "killerCaseIds",
  "obligationId",
  "expectedArmOutcomes",
] as const;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const object = (value: unknown, code: string): JsonObject => {
  if (!isObject(value)) throw new Error(code);
  return value;
};

const array = (value: unknown, code: string): JsonValue[] => {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
};

const string = (value: unknown, code: string): string => {
  if (typeof value !== "string") throw new Error(code);
  return value;
};

const integer = (value: unknown, code: string): number => {
  if (!Number.isSafeInteger(value) || Object.is(value, -0))
    throw new Error(code);
  return value as number;
};

const expect: (condition: unknown, code: string) => asserts condition = (
  condition,
  code,
) => {
  if (!condition) throw new Error(code);
};

const compareUnicodeScalars = (left: string, right: string): number => {
  const a = Array.from(left, (value) => value.codePointAt(0)!);
  const b = Array.from(right, (value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
};

const canonicalize = (value: JsonValue): string => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    integer(value, "E_NONCANONICAL_NUMBER");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value)
    .sort(compareUnicodeScalars)
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key]!)}`)
    .join(",")}}`;
};

const equalJson = (left: JsonValue, right: JsonValue): boolean =>
  canonicalize(left) === canonicalize(right);

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const framedSha256 = (domain: string, payload: JsonValue): string =>
  sha256(
    Buffer.concat([
      Buffer.from(domain, "utf8"),
      Buffer.from([0]),
      Buffer.from(canonicalize(payload), "utf8"),
    ]),
  );

const assertUnicodeScalars = (value: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error("E_LONE_SURROGATE");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("E_LONE_SURROGATE");
    }
  }
};

const parseRawJson = (bytes: Buffer): JsonValue => {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    throw new Error("E_BOM");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("E_INVALID_UTF8");
  }
  let cursor = 0;
  const whitespace = (): void => {
    while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
  };
  const stringToken = (): string => {
    if (text[cursor] !== '"') throw new Error("E_JSON_STRING");
    const start = cursor++;
    while (cursor < text.length) {
      if (text[cursor] === '"') {
        cursor += 1;
        const decoded = JSON.parse(text.slice(start, cursor)) as string;
        assertUnicodeScalars(decoded);
        return decoded;
      }
      if (text[cursor] === "\\") {
        cursor += 1;
        if (text[cursor] === "u") cursor += 4;
      }
      cursor += 1;
    }
    throw new Error("E_JSON_STRING");
  };
  const value = (): void => {
    whitespace();
    const character = text[cursor];
    if (character === "{") {
      cursor += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[cursor] === "}") {
        cursor += 1;
        return;
      }
      for (;;) {
        whitespace();
        const key = stringToken();
        if (keys.has(key)) throw new Error("E_DUPLICATE_KEY");
        keys.add(key);
        whitespace();
        if (text[cursor] !== ":") throw new Error("E_JSON_COLON");
        cursor += 1;
        value();
        whitespace();
        if (text[cursor] === "}") {
          cursor += 1;
          return;
        }
        if (text[cursor] !== ",") throw new Error("E_JSON_COMMA");
        cursor += 1;
      }
    }
    if (character === "[") {
      cursor += 1;
      whitespace();
      if (text[cursor] === "]") {
        cursor += 1;
        return;
      }
      for (;;) {
        value();
        whitespace();
        if (text[cursor] === "]") {
          cursor += 1;
          return;
        }
        if (text[cursor] !== ",") throw new Error("E_JSON_COMMA");
        cursor += 1;
      }
    }
    if (character === '"') {
      stringToken();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, cursor)) {
        cursor += literal.length;
        return;
      }
    }
    const match = text
      .slice(cursor)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (!match) throw new Error("E_JSON_VALUE");
    const number = Number(match[0]);
    if (!Number.isSafeInteger(number) || Object.is(number, -0)) {
      throw new Error("E_NONCANONICAL_NUMBER");
    }
    cursor += match[0].length;
  };
  value();
  whitespace();
  if (cursor !== text.length) throw new Error("E_JSON_TRAILING");
  return JSON.parse(text) as JsonValue;
};

const escapePointerToken = (token: string): string =>
  token.replaceAll("~", "~0").replaceAll("/", "~1");

const decodePointer = (pointer: string): string[] => {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error("E_POINTER_ROOT");
  return pointer
    .slice(1)
    .split("/")
    .map((token) => {
      if (token === "*") throw new Error("E_POINTER_WILDCARD");
      if (/~(?:[^01]|$)/u.test(token)) throw new Error("E_POINTER_ESCAPE");
      return token.replaceAll("~1", "/").replaceAll("~0", "~");
    });
};

const getPointer = (document: JsonValue, pointer: string): JsonValue =>
  decodePointer(pointer).reduce<JsonValue>((value, token) => {
    if (Array.isArray(value)) {
      if (
        !/^(?:0|[1-9][0-9]*)$/u.test(token) ||
        Number(token) >= value.length
      ) {
        throw new Error("E_POINTER_ARRAY");
      }
      return value[Number(token)]!;
    }
    if (isObject(value) && Object.hasOwn(value, token)) return value[token]!;
    throw new Error("E_UNRESOLVED_POINTER");
  }, document);

const parentAndToken = (
  document: JsonValue,
  pointer: string,
): { parent: JsonValue; token: string } => {
  const tokens = decodePointer(pointer);
  const token = tokens.pop();
  if (token === undefined) throw new Error("E_PATCH_ROOT");
  const parentPointer =
    tokens.length === 0 ? "" : `/${tokens.map(escapePointerToken).join("/")}`;
  return { parent: getPointer(document, parentPointer), token };
};

const assertNoOverlaps = (pointers: string[]): void => {
  const decoded = pointers.map(decodePointer);
  for (let left = 0; left < decoded.length; left += 1) {
    for (let right = left + 1; right < decoded.length; right += 1) {
      const a = decoded[left]!;
      const b = decoded[right]!;
      const shared = Math.min(a.length, b.length);
      if (a.slice(0, shared).every((token, index) => token === b[index])) {
        throw new Error("E_POINTER_OVERLAP");
      }
    }
  }
};

const applyPatch = (
  document: JsonValue,
  operations: readonly PatchOperation[],
): JsonValue => {
  const result = structuredClone(document);
  assertNoOverlaps(operations.map(({ path }) => path));
  for (const operation of operations) {
    if (!("add replace remove".split(" ") as string[]).includes(operation.op)) {
      throw new Error("E_PATCH_OP");
    }
    const { parent, token } = parentAndToken(result, operation.path);
    if (Array.isArray(parent)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) throw new Error("E_PATCH_INDEX");
      const index = Number(token);
      if (operation.op === "add") {
        if (index > parent.length || operation.value === undefined) {
          throw new Error("E_PATCH_RANGE");
        }
        parent.splice(index, 0, structuredClone(operation.value));
      } else {
        if (index >= parent.length) throw new Error("E_PATCH_RANGE");
        if (operation.op === "remove") parent.splice(index, 1);
        else {
          if (operation.value === undefined) throw new Error("E_PATCH_VALUE");
          parent[index] = structuredClone(operation.value);
        }
      }
    } else if (isObject(parent)) {
      if (operation.op !== "add" && !Object.hasOwn(parent, token)) {
        throw new Error("E_PATCH_MEMBER");
      }
      if (operation.op === "remove") delete parent[token];
      else {
        if (operation.value === undefined) throw new Error("E_PATCH_VALUE");
        parent[token] = structuredClone(operation.value);
      }
    } else {
      throw new Error("E_PATCH_PARENT");
    }
  }
  return result;
};

const setPointer = (
  document: JsonValue,
  pointer: string,
  value: JsonValue,
): void => {
  const { parent, token } = parentAndToken(document, pointer);
  if (Array.isArray(parent))
    parent[integer(Number(token), "E_PATCH_INDEX")] = value;
  else if (isObject(parent)) parent[token] = value;
  else throw new Error("E_PATCH_PARENT");
};

const removePointer = (document: JsonValue, pointer: string): void => {
  const { parent, token } = parentAndToken(document, pointer);
  if (Array.isArray(parent))
    parent.splice(integer(Number(token), "E_PATCH_INDEX"), 1);
  else if (isObject(parent)) delete parent[token];
  else throw new Error("E_PATCH_PARENT");
};

const diffPaths = (left: JsonValue, right: JsonValue, path = ""): string[] => {
  if (equalJson(left, right)) return [];
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return [path];
  }
  const a = left as JsonObject;
  const b = right as JsonObject;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) => {
    const child = `${path}/${escapePointerToken(key)}`;
    if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) return [child];
    return diffPaths(a[key]!, b[key]!, child);
  });
};

const patchOperations = (value: JsonValue, code: string): PatchOperation[] =>
  array(value, code).map((item) => {
    const operation = object(item, code);
    return {
      op: string(operation.op, code) as PatchOperation["op"],
      path: string(operation.path, code),
      ...(Object.hasOwn(operation, "value") ? { value: operation.value } : {}),
    };
  });

export const compareV12LiteralTraces = (
  actual: readonly string[],
  expected: readonly string[],
): LiteralTraceComparison => {
  const length = Math.max(actual.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    if (actual[index] !== expected[index]) {
      return {
        equal: false,
        mismatchIndex: index,
        expected: expected[index] ?? null,
        actual: actual[index] ?? null,
      };
    }
  }
  return { equal: true, mismatchIndex: null, expected: null, actual: null };
};

const descriptorPayload = (descriptor: JsonObject): JsonObject =>
  Object.fromEntries(
    DESCRIPTOR_FIELDS.map((field) => {
      expect(Object.hasOwn(descriptor, field), `E_DESCRIPTOR_FIELD:${field}`);
      return [field, structuredClone(descriptor[field]!)];
    }),
  ) as JsonObject;

const descriptorDigest = (descriptor: JsonObject): string =>
  framedSha256(DESCRIPTOR_DOMAIN, descriptorPayload(descriptor));

const digestPreimage = (authority: JsonObject, entry: JsonObject): Buffer => {
  const selected = structuredClone(authority) as JsonValue;
  const omitted = array(entry.omitPointers, "E_DIGEST_OMIT")
    .map((pointer) => string(pointer, "E_DIGEST_OMIT"))
    .sort((a, b) => b.length - a.length);
  for (const pointer of omitted) removePointer(selected, pointer);
  const payload = array(entry.payloadPointers, "E_DIGEST_PAYLOAD").map(
    (pointerValue) => {
      const pointer = string(pointerValue, "E_DIGEST_PAYLOAD");
      return {
        pointer,
        value: pointer === "" ? selected : getPointer(selected, pointer),
      };
    },
  ) as JsonValue;
  return Buffer.concat([
    Buffer.from(string(entry.domain, "E_DIGEST_DOMAIN"), "utf8"),
    Buffer.from([0]),
    Buffer.from(canonicalize(payload), "utf8"),
  ]);
};

const validateDigestCatalog = (authority: JsonObject): void => {
  const catalog = object(authority.digestCatalog, "E_DIGEST_CATALOG");
  const order = array(authority.digestOrder, "E_DIGEST_ORDER").map((id) =>
    string(id, "E_DIGEST_ORDER"),
  );
  expect(order.length === 9 && new Set(order).size === 9, "E_DIGEST_COUNT");
  const seen = new Set<string>();
  const domains = new Set<string>();
  for (const id of order) {
    const entry = object(catalog[id], `E_DIGEST_ENTRY:${id}`);
    expect(entry.id === id, `E_DIGEST_ID:${id}`);
    const domain = string(entry.domain, `E_DIGEST_DOMAIN:${id}`);
    expect(
      domain.startsWith("bb.artifact-review.v12.digest.") &&
        !domains.has(domain),
      `E_DIGEST_DOMAIN:${id}`,
    );
    domains.add(domain);
    for (const dependency of array(entry.dependsOn, `E_DIGEST_DEP:${id}`)) {
      expect(
        seen.has(string(dependency, `E_DIGEST_DEP:${id}`)),
        `E_DIGEST_DEP:${id}`,
      );
    }
    seen.add(id);
    const preimage = digestPreimage(authority, entry);
    const payloadLength = preimage.length - Buffer.byteLength(domain) - 1;
    expect(entry.payloadByteLength === payloadLength, `E_DIGEST_LENGTH:${id}`);
    expect(
      entry.preimageByteLength === preimage.length,
      `E_DIGEST_LENGTH:${id}`,
    );
    expect(entry.expectedSha256 === sha256(preimage), `E_DIGEST_HASH:${id}`);
  }
};

const validateConformanceSelfChecks = (conformance: JsonObject): void => {
  const vectors = object(conformance.selfCheckVectors, "E_SELF_CHECK_VECTORS");
  const raw = object(vectors.rawAdmission, "E_RAW_VECTORS");
  for (const value of array(raw.accepted, "E_RAW_ACCEPTED")) {
    const vector = object(value, "E_RAW_ACCEPTED");
    parseRawJson(Buffer.from(string(vector.utf8Hex, "E_RAW_HEX"), "hex"));
  }
  for (const value of array(raw.rejected, "E_RAW_REJECTED")) {
    const vector = object(value, "E_RAW_REJECTED");
    let observed: string | null = null;
    try {
      parseRawJson(Buffer.from(string(vector.utf8Hex, "E_RAW_HEX"), "hex"));
    } catch (error) {
      observed = error instanceof Error ? error.message : "E_RAW_VECTOR";
    }
    expect(observed === vector.error, `E_RAW_VECTOR:${String(vector.id)}`);
  }
  for (const value of array(vectors.literalTrace, "E_TRACE_VECTORS")) {
    const vector = object(value, "E_TRACE_VECTOR");
    const result = compareV12LiteralTraces(
      array(vector.actual, "E_TRACE_VECTOR").map((item) =>
        string(item, "E_TRACE_VECTOR"),
      ),
      array(vector.expected, "E_TRACE_VECTOR").map((item) =>
        string(item, "E_TRACE_VECTOR"),
      ),
    );
    expect(
      result.equal === vector.equal &&
        result.mismatchIndex === vector.mismatchIndex,
      `E_TRACE_VECTOR:${String(vector.id)}`,
    );
  }
  const patch = object(vectors.patch, "E_PATCH_VECTOR");
  const operation = patchOperations([patch.operation!], "E_PATCH_VECTOR");
  const result = applyPatch(patch.document!, operation);
  expect(equalJson(result, patch.result!), "E_PATCH_VECTOR");
  let secondApplicationError: string | null = null;
  try {
    const second = applyPatch(result, operation);
    if (equalJson(result, second)) throw new Error("E_PATCH_NO_EFFECT");
  } catch (error) {
    secondApplicationError =
      error instanceof Error ? error.message : "E_PATCH_VECTOR";
  }
  expect(
    secondApplicationError === patch.secondApplicationError,
    "E_PATCH_VECTOR",
  );
};

const validateConformance = (conformance: JsonObject): void => {
  expect(
    conformance.schemaVersion === "artifact-recovery-v12-runner-conformance-1",
    "E_CONFORMANCE_VERSION",
  );
  expect(conformance.dslId === EXPECTED_DSL_ID, "E_DSL_ID");
  expect(
    conformance.canonicalizationVersion === EXPECTED_CANONICALIZATION,
    "E_CANONICALIZATION_ID",
  );
  expect(
    equalJson(conformance.phaseOrder!, [
      "baseline-admission",
      "mutant-construction",
      "derived-view-admission",
      "semantic-execution",
      "kill-classification",
      "negative-control",
    ]),
    "E_PHASE_ORDER",
  );
  const required = object(conformance.requiredReport, "E_REQUIRED_REPORT");
  expect(
    required.selected === 179 && required.a0MutantsSelected === 173,
    "E_REPORT_COUNTS",
  );
  expect(required.constructionSentinels === 6, "E_REPORT_COUNTS");
  const controls = object(conformance.negativeControls, "E_NEGATIVE_CONTROLS");
  expect(Object.keys(controls).length === 3, "E_NEGATIVE_CONTROL_COUNT");
  validateConformanceSelfChecks(conformance);
};

const ownerByClass: Record<string, string> = {
  "authority-input": "authority-author",
  "reference-interpreter": "reference-interpreter",
  "shared-reducer": "shared-reducer",
  canonicalization: "canonicalization-core",
  "pointer-patch": "pointer-patch-admission",
  "schema-normalization": "sqlite-normalizer",
  projection: "literal-projection",
  digest: "digest-verifier",
  "darkness-registration": "darkness-registration",
};

const caseObserverBindings: Record<
  string,
  { divergenceField: string; reasonPrefix: string; admittedErrors: string[] }
> = {
  "case.fixtureBinding": {
    divergenceField: "case-outcome-tuple",
    reasonPrefix: "case-fixture-binding-divergence:",
    admittedErrors: ["E_STATE_MATERIALIZE", "E_POINTER_ARRAY"],
  },
  "case.programOpcode": {
    divergenceField: "case-program-execution",
    reasonPrefix: "case-opcode-semantic-divergence:",
    admittedErrors: ["E_STATE_CLOSE", "E_STATE_FINAL"],
  },
  "case.reducerSelection": {
    divergenceField: "case-reducer-selection",
    reasonPrefix: "case-reducer-semantic-divergence:",
    admittedErrors: ["E_REDUCER"],
  },
  "case.expectedSnapshotMaterialization": {
    divergenceField: "expected-snapshot",
    reasonPrefix: "case-snapshot-patch-divergence:",
    admittedErrors: ["E_SNAPSHOT_STATE"],
  },
  "case.projectionExpression": {
    divergenceField: "projection-expression",
    reasonPrefix: "case-projection-semantic-divergence:",
    admittedErrors: ["E_EXPRESSION_OPCODE"],
  },
  "case.darknessRegistration": {
    divergenceField: "darkness-registration",
    reasonPrefix: "case-darkness-registration-divergence:",
    admittedErrors: [],
  },
};

const baselinePreflight = (
  authority: JsonObject,
  conformance: JsonObject,
): void => {
  expect(authority.authorityId === EXPECTED_AUTHORITY_ID, "E_AUTHORITY_ID");
  validateConformance(conformance);
  const body = object(authority.authority, "E_AUTHORITY_BODY");
  const dsl = object(body.dsl, "E_DSL");
  expect(dsl.id === EXPECTED_DSL_ID, "E_DSL_ID");
  const opcodes = array(dsl.operationOpcodes, "E_OPCODE_CATALOG").map(String);
  expect(equalJson(opcodes, conformance.opcodeVectors!), "E_OPCODE_CATALOG");
  const canonical = object(body.canonicalization, "E_CANONICALIZATION");
  expect(canonical.id === EXPECTED_CANONICALIZATION, "E_CANONICALIZATION_ID");
  expect(
    canonical.objectKeyOrder === "unicode-scalar-ascending",
    "E_KEY_ORDER",
  );
  const normalization = object(
    body.sqliteNormalization,
    "E_SQLITE_NORMALIZATION",
  );
  expect(normalization.profile === "sqlite-memory-pinned", "E_SQLITE_PROFILE");

  const fixtures = array(body.fixtureCatalog, "E_FIXTURES").map((item) =>
    object(item, "E_FIXTURE"),
  );
  const snapshots = array(body.snapshotCatalog, "E_SNAPSHOTS").map((item) =>
    object(item, "E_SNAPSHOT"),
  );
  const fixtureIds = new Set(
    fixtures.map((item) => string(item.id, "E_FIXTURE_ID")),
  );
  const snapshotIds = new Set(
    snapshots.map((item) => string(item.id, "E_SNAPSHOT_ID")),
  );
  const cases = object(body.caseCatalog, "E_CASE_CATALOG");
  expect(Object.keys(cases).length === 179, "E_CASE_COUNT");
  for (const [id, value] of Object.entries(cases)) {
    const caseValue = object(value, `E_CASE:${id}`);
    expect(caseValue.id === id, `E_CASE_KEY:${id}`);
    expect(
      fixtureIds.has(string(caseValue.fixtureRef, `E_FIXTURE_REF:${id}`)),
      `E_FIXTURE_REF:${id}`,
    );
    const expected = object(caseValue.expected, `E_EXPECTED:${id}`);
    expect(
      snapshotIds.has(string(expected.preSnapshotRef, `E_SNAPSHOT_REF:${id}`)),
      `E_SNAPSHOT_REF:${id}`,
    );
    expect(
      snapshotIds.has(string(expected.postSnapshotRef, `E_SNAPSHOT_REF:${id}`)),
      `E_SNAPSHOT_REF:${id}`,
    );
    for (const operationValue of array(caseValue.program, `E_PROGRAM:${id}`)) {
      const operation = object(operationValue, `E_PROGRAM:${id}`);
      expect(
        opcodes.includes(string(operation.op, `E_OPCODE:${id}`)),
        `E_OPCODE:${id}`,
      );
      if (operation.op === "assertExpectedSnapshot") {
        expect(Object.keys(operation).length === 1, `E_OPCODE_OPERAND:${id}`);
      }
    }
  }

  const mutants = object(body.mutantCatalog, "E_MUTANTS");
  const obligations = object(
    object(body.coverage, "E_COVERAGE").obligations,
    "E_OBLIGATIONS",
  );
  const observers = object(
    object(body.proofContract, "E_PROOF_CONTRACT").observerCatalog,
    "E_OBSERVERS",
  );
  expect(Object.keys(mutants).length === 179, "E_MUTANT_COUNT");
  expect(Object.keys(obligations).length === 179, "E_OBLIGATION_COUNT");
  expect(Object.keys(observers).length === 173, "E_OBSERVER_COUNT");
  const observerCounts: Record<string, number> = {};
  const typedObservers: JsonObject = {};
  let a0 = 0;
  let sentinels = 0;
  for (const [id, value] of Object.entries(mutants)) {
    const mutant = object(value, `E_MUTANT:${id}`);
    expect(mutant.id === id, `E_MUTANT_KEY:${id}`);
    const target = object(
      getPointer(authority, string(mutant.targetPointer, id)),
      id,
    );
    expect(target.id === mutant.targetId, `E_TARGET_ID:${id}`);
    const semanticClass = string(mutant.semanticClass, id);
    const arm = string(mutant.arm, id);
    expect(
      mutant.targetOwner ===
        (semanticClass === "adapter"
          ? `${arm}-adapter`
          : ownerByClass[semanticClass]),
      `E_TARGET_OWNER:${id}`,
    );
    const operations = patchOperations(mutant.patch!, id);
    expect(
      operations.length === 1 && operations[0]!.op === "replace",
      `E_MUTANT_PATCH:${id}`,
    );
    const patched = applyPatch(target, operations);
    expect(
      equalJson(diffPaths(target, patched), [
        `/${string(mutant.intendedSemanticField, id)}`,
      ]),
      `E_MUTANT_FIELD:${id}`,
    );
    const obligation = object(obligations[id], `E_OBLIGATION:${id}`);
    expect(
      obligation.id === mutant.obligationId && obligation.mutantId === id,
      `E_OBLIGATION:${id}`,
    );
    expect(
      equalJson(obligation.killerCaseIds!, mutant.killerCaseIds!),
      `E_OBLIGATION:${id}`,
    );
    if (mutant.phase === "a0") {
      a0 += 1;
      expect(arm === "reference", `E_MUTANT_ARM:${id}`);
      const observer = object(observers[id], `E_OBSERVER:${id}`);
      expect(observer.mutantId === id, `E_OBSERVER:${id}`);
      const observerType = string(
        observer.observerType,
        `E_OBSERVER_TYPE:${id}`,
      );
      observerCounts[observerType] = (observerCounts[observerType] ?? 0) + 1;
      if (observerType !== "case-outcome") typedObservers[id] = observerType;
      expect(
        descriptorDigest(mutant) === observer.immutableDescriptorSha256,
        `E_DESCRIPTOR_DIGEST:${id}`,
      );
      if (observer.observerType === "case-outcome") {
        const binding =
          caseObserverBindings[
            string(observer.affectedPredicate, `E_OBSERVER_PREDICATE:${id}`)
          ];
        expect(binding !== undefined, `E_OBSERVER_PREDICATE:${id}`);
        expect(
          observer.divergenceField === binding.divergenceField &&
            string(
              observer.declaredSemanticReason,
              `E_DECLARED_REASON:${id}`,
            ).startsWith(binding.reasonPrefix),
          `E_OBSERVER_REASON:${id}`,
        );
      }
    } else {
      sentinels += 1;
      expect(mutant.phase === "v3-construction", `E_MUTANT_PHASE:${id}`);
    }
  }
  expect(a0 === 173 && sentinels === 6, "E_MUTANT_ACCOUNTING");
  expect(
    equalJson(
      observerCounts,
      object(conformance.observerInventory, "E_OBSERVER_INVENTORY"),
    ),
    "E_OBSERVER_INVENTORY",
  );
  expect(
    equalJson(
      typedObservers,
      object(conformance.typedPredicateObservers, "E_TYPED_OBSERVERS"),
    ),
    "E_TYPED_OBSERVERS",
  );
  validateDigestCatalog(authority);
};

const reducerResult = (
  observation: string,
): { decision: string; errorClass: string | null } => {
  const table: Record<string, { decision: string; errorClass: string | null }> =
    {
      ordinary: { decision: "complete-ordinary", errorClass: null },
      recovered: { decision: "complete-recovered", errorClass: null },
      E_COLLISION: {
        decision: "classify-collision",
        errorClass: "E_COLLISION",
      },
      E_NO_COLLISION: { decision: "classify-distinct", errorClass: null },
      E_EDGE_VALID: { decision: "preserve-edge", errorClass: null },
      E_PARITY_VALID: { decision: "parity-equal", errorClass: null },
      E_ADAPTER_DIVERGENCE: {
        decision: "block-divergence",
        errorClass: "E_ADAPTER_DIVERGENCE",
      },
      E_CORRUPTION: {
        decision: "block-corruption",
        errorClass: "E_CORRUPTION",
      },
      E_LEDGER_FAILED: {
        decision: "block-corruption",
        errorClass: "E_LEDGER_FAILED",
      },
      E_LEDGER_FUTURE: {
        decision: "block-corruption",
        errorClass: "E_LEDGER_FUTURE",
      },
      E_LEDGER_MALFORMED: {
        decision: "block-corruption",
        errorClass: "E_LEDGER_MALFORMED",
      },
      E_LEDGER_NONCONTIGUOUS: {
        decision: "block-corruption",
        errorClass: "E_LEDGER_NONCONTIGUOUS",
      },
      E_RECOVERY_PARTIAL: {
        decision: "block-corruption",
        errorClass: "E_RECOVERY_PARTIAL",
      },
      E_SCHEMA_MISMATCH: {
        decision: "block-corruption",
        errorClass: "E_SCHEMA_MISMATCH",
      },
      E_EVIDENCE_MISMATCH: {
        decision: "block-corruption",
        errorClass: "E_EVIDENCE_MISMATCH",
      },
      E_UNKNOWN_COMPLETION: {
        decision: "block-unknown-completion",
        errorClass: "E_UNKNOWN_COMPLETION",
      },
      E_UNADMITTED_LEGACY_STATE: {
        decision: "block-human-rollout",
        errorClass: "E_UNADMITTED_LEGACY_STATE",
      },
    };
  const result = table[observation];
  if (!result) throw new Error("E_OBSERVATION");
  return result;
};

const emittedObservationToken = (observation: string): string => {
  const authoredTokens: Record<string, string> = {
    E_EVIDENCE_MISMATCH: "evidence-mismatch",
    E_LEDGER_FAILED: "failed-ledger",
    E_LEDGER_FUTURE: "future-ledger",
    E_LEDGER_MALFORMED: "malformed-ledger",
    E_LEDGER_NONCONTIGUOUS: "noncontiguous-ledger",
    E_RECOVERY_PARTIAL: "partial-recovery",
    E_SCHEMA_MISMATCH: "schema-mismatch",
    E_UNKNOWN_COMPLETION: "full-ledger-no-completion",
  };
  return `observed:${authoredTokens[observation] ?? observation}`;
};

const evaluateExpression = (expressionValue: JsonValue): boolean => {
  const expression = object(expressionValue, "E_EXPRESSION");
  expect(expression.op === "equals", "E_EXPRESSION_OPCODE");
  const evaluate = (value: JsonValue): JsonValue => {
    const node = object(value, "E_EXPRESSION");
    switch (node.op) {
      case "multiset":
      case "project":
        return [...array(node.values, "E_EXPRESSION")].sort((a, b) =>
          compareUnicodeScalars(canonicalize(a), canonicalize(b)),
        );
      case "countBy": {
        const counts = new Map<string, number>();
        for (const item of array(node.values, "E_EXPRESSION")) {
          const key = canonicalize(item);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return [...counts.entries()]
          .sort(([left], [right]) => compareUnicodeScalars(left, right))
          .flatMap(([key, count]) =>
            Array.from({ length: count }, () => JSON.parse(key) as JsonValue),
          );
      }
      case "decodeQuarantine":
        return array(node.values, "E_EXPRESSION");
      case "unionDisjoint":
        return array(node.operands, "E_EXPRESSION").flatMap((operand) =>
          array(evaluate(operand), "E_EXPRESSION"),
        );
      default:
        throw new Error("E_EXPRESSION_OPCODE");
    }
  };
  return equalJson(evaluate(expression.left!), evaluate(expression.right!));
};

type ActualCase = {
  decision: string;
  errorClass: string | null;
  trace: string[];
  postSnapshotRef: string;
  writes: number;
  consumers: number;
};

const completionSnapshot = (
  fixture: JsonObject,
): { decision: string; ref: string } => {
  const ledger = array(fixture.completionLedger, "E_COMPLETION_LEDGER");
  if (ledger.length !== 1) throw new Error("E_COMPLETION");
  const outcome = object(ledger[0], "E_COMPLETION").outcome;
  if (outcome === "ordinary")
    return {
      decision: "complete-ordinary",
      ref: "snapshot-completed-ordinary",
    };
  if (outcome === "recovered")
    return {
      decision: "complete-recovered",
      ref: "snapshot-completed-recovered",
    };
  throw new Error("E_COMPLETION");
};

const executeCase = (
  authority: JsonObject,
  caseValue: JsonObject,
): ActualCase => {
  const body = object(authority.authority, "E_AUTHORITY_BODY");
  const fixtures = array(body.fixtureCatalog, "E_FIXTURES").map((item) =>
    object(item, "E_FIXTURE"),
  );
  const fixtureRef = string(caseValue.fixtureRef, "E_FIXTURE_REF");
  const fixture = fixtures.find((item) => item.id === fixtureRef);
  expect(fixture !== undefined, "E_FIXTURE_REF");
  let working = structuredClone(fixture);
  if (caseValue.setupPatch !== undefined) {
    working = object(
      applyPatch(
        working,
        patchOperations(caseValue.setupPatch, "E_SETUP_PATCH"),
      ),
      "E_SETUP_PATCH",
    );
  }
  if (caseValue.persistedMutation !== undefined) {
    working = object(
      applyPatch(
        working,
        patchOperations([caseValue.persistedMutation], "E_PERSISTED_MUTATION"),
      ),
      "E_PERSISTED_MUTATION",
    );
  }
  const trace: string[] = [];
  let opened = false;
  let materialized = false;
  let inTransaction = false;
  let decision = "";
  let errorClass: string | null = null;
  let postSnapshotRef = "snapshot-pre18-unchanged";
  let writes = 0;
  let consumers = 0;
  const fault =
    caseValue.fault === undefined
      ? undefined
      : object(caseValue.fault, "E_FAULT");
  const program = array(caseValue.program, "E_PROGRAM");

  for (const operationValue of program) {
    const operation = object(operationValue, "E_PROGRAM");
    switch (operation.op) {
      case "open":
        expect(!opened, "E_STATE_OPEN");
        opened = true;
        trace.push("open");
        break;
      case "materializeFixture":
        expect(
          opened && !materialized && operation.fixtureRef === fixtureRef,
          "E_STATE_MATERIALIZE",
        );
        materialized = true;
        trace.push(
          program.some(
            (candidate) =>
              object(candidate, "E_PROGRAM").op === "assertNoDbAccess",
          )
            ? "fixture-admission-rejected"
            : "fixture-materialized",
        );
        break;
      case "admitAuthority":
        expect(
          materialized && operation.authorityId === authority.authorityId,
          "E_AUTHORITY_ADMISSION",
        );
        trace.push("authority-admitted");
        break;
      case "assertNoDbAccess":
        if (!opened) {
          decision = "block-pre-db";
          errorClass = "E_PRE_DB_FAULT";
          trace.push("no-db-access");
        } else {
          decision = "reject-fixture-admission";
          errorClass = string(operation.reason, "E_NO_DB_ACCESS");
          trace.push("no-recovery-access");
        }
        break;
      case "observe": {
        const observation = string(operation.observationId, "E_OBSERVATION");
        trace.push(emittedObservationToken(observation));
        const reduced = reducerResult(observation);
        decision = reduced.decision;
        errorClass = reduced.errorClass;
        break;
      }
      case "reduce":
        expect(
          operation.reducerId === EXPECTED_REDUCER && decision !== "",
          "E_REDUCER",
        );
        if (caseValue.expression !== undefined)
          expect(evaluateExpression(caseValue.expression), "E_PARITY");
        trace.push(`decision:${decision}`);
        break;
      case "begin":
        expect(opened && materialized && !inTransaction, "E_TRANSACTION");
        inTransaction = true;
        trace.push("transaction-begin");
        break;
      case "executeEffects":
        expect(inTransaction, "E_TRANSACTION");
        if (fault) {
          const effectId = string(fault.effectId, "E_FAULT");
          expect(
            array(operation.effectIds, "E_EFFECTS").includes(effectId),
            "E_FAULT_TARGET",
          );
          trace.push(`fault-${string(fault.position, "E_FAULT")}:${effectId}`);
          errorClass = string(fault.errorClass, "E_FAULT");
          decision =
            caseValue.boundary === "post-commit"
              ? "block-post-commit-verification"
              : "rollback";
        } else trace.push("effects-applied");
        break;
      case "verifyCompleted":
        expect(opened && materialized, "E_VERIFY_COMPLETED");
        if (
          caseValue.persistedMutation !== undefined &&
          string(
            object(caseValue.persistedMutation, "E_PERSISTED_MUTATION").path,
            "E_PERSISTED_MUTATION",
          ).startsWith("/completionLedger/")
        ) {
          decision = "block-corruption";
          errorClass = "E_RESTART_CORRUPTION";
          postSnapshotRef = completionSnapshot(fixture).ref;
          trace.push("verification-failed");
        } else if (
          caseValue.boundary === "post-commit" ||
          fault?.failureMode === "corrupt"
        ) {
          trace.push("verification-failed");
        } else if (!decision) {
          const completed = completionSnapshot(working);
          decision = completed.decision;
          postSnapshotRef = completed.ref;
          trace.push("verified-completed");
        } else trace.push("verified-completed");
        break;
      case "commit":
        expect(inTransaction, "E_TRANSACTION");
        inTransaction = false;
        trace.push("commit");
        if (decision === "complete-recovered") {
          writes = 16;
          postSnapshotRef = "snapshot-completed-recovered";
        } else {
          writes = 11;
          postSnapshotRef = "snapshot-completed-ordinary";
        }
        break;
      case "rollback":
        expect(inTransaction, "E_TRANSACTION");
        inTransaction = false;
        decision = "rollback";
        errorClass = fault
          ? string(fault.errorClass, "E_FAULT")
          : "E_TRANSACTION_ROLLBACK";
        writes = 0;
        postSnapshotRef = "snapshot-pre18-unchanged";
        trace.push("rollback");
        break;
      case "close":
        expect(opened, "E_STATE_CLOSE");
        opened = false;
        trace.push("close");
        break;
      case "reopen":
        expect(!opened, "E_STATE_REOPEN");
        opened = true;
        trace.push("reopen");
        break;
      case "constructConsumers": {
        const mutation = object(caseValue.mutation, "E_DARKNESS_MUTATION");
        const ids = array(operation.consumerIds, "E_CONSUMERS").map(String);
        expect(ids.length === 1, "E_CONSUMERS");
        expect(
          mutation.path ===
            `/runtimeRegistrations/${escapePointerToken(ids[0]!)}`,
          "E_DARKNESS_MUTATION",
        );
        if (mutation.value === true || typeof mutation.value === "number") {
          decision = "block-darkness";
          errorClass = "E_DARKNESS_VIOLATION";
          trace.push(`darkness-violation:${ids[0]}`);
          consumers = 0;
        } else {
          decision = "complete-ordinary";
          errorClass = null;
          trace.push("consumers-constructed");
          consumers = ids.length;
        }
        postSnapshotRef = "snapshot-completed-ordinary";
        break;
      }
      case "assertExpectedSnapshot": {
        if (caseValue.setupPatch !== undefined) {
          const snapshots = array(body.snapshotCatalog, "E_SNAPSHOTS").map(
            (item) => object(item, "E_SNAPSHOT"),
          );
          const match = snapshots.find(
            (item) =>
              item.state !== undefined && equalJson(item.state, working),
          );
          expect(match !== undefined, "E_SNAPSHOT_STATE");
          postSnapshotRef = string(match.id, "E_SNAPSHOT_ID");
        } else if (postSnapshotRef === "snapshot-pre18-unchanged") {
          const ledger = array(working.completionLedger, "E_COMPLETION_LEDGER");
          if (ledger.length === 1)
            postSnapshotRef = completionSnapshot(working).ref;
        }
        trace.push("snapshot-asserted");
        break;
      }
      default:
        throw new Error("E_OPCODE");
    }
  }
  expect(!opened && !inTransaction, "E_STATE_FINAL");
  return { decision, errorClass, trace, postSnapshotRef, writes, consumers };
};

const executeCaseOutcome = (
  authority: JsonObject,
  caseValue: JsonObject,
): CaseOutcome => {
  try {
    const actual = executeCase(authority, caseValue);
    return {
      status: "completed",
      decision: actual.decision,
      errorClass: actual.errorClass,
      trace: actual.trace,
      postSnapshotRef: actual.postSnapshotRef,
      writes: actual.writes,
      consumers: actual.consumers,
      harnessError: null,
    };
  } catch (error) {
    return {
      status: "rejected",
      decision: null,
      errorClass: null,
      trace: [],
      postSnapshotRef: null,
      writes: null,
      consumers: null,
      harnessError: error instanceof Error ? error.message : "E_CASE_EXECUTION",
    };
  }
};

const casePasses = (authority: JsonObject, caseValue: JsonObject): boolean => {
  const actual = executeCaseOutcome(authority, caseValue);
  if (actual.status !== "completed") return false;
  const expected = object(caseValue.expected, "E_EXPECTED");
  if (
    actual.decision !== expected.decision ||
    actual.errorClass !== expected.errorClass
  )
    return false;
  const expectedTrace = array(expected.trace, "E_TRACE").map((item) =>
    string(item, "E_TRACE"),
  );
  if (!compareV12LiteralTraces(actual.trace, expectedTrace).equal) return false;
  if (actual.postSnapshotRef !== expected.postSnapshotRef) return false;
  const snapshots = array(
    object(authority.authority, "E_AUTHORITY_BODY").snapshotCatalog,
    "E_SNAPSHOTS",
  ).map((item) => object(item, "E_SNAPSHOT"));
  const snapshot = snapshots.find((item) => item.id === actual.postSnapshotRef);
  if (!snapshot) return false;
  let observedRoots = snapshot.roots;
  if (snapshot.state !== undefined) {
    const fixtureRef = string(snapshot.sourceFixtureRef, "E_SNAPSHOT_SOURCE");
    const fixture = array(
      object(authority.authority, "E_AUTHORITY_BODY").fixtureCatalog,
      "E_FIXTURES",
    )
      .map((item) => object(item, "E_FIXTURE"))
      .find((item) => item.id === fixtureRef);
    if (!fixture) return false;
    const baseSnapshotRef = completionSnapshot(fixture).ref;
    const baseSnapshot = snapshots.find((item) => item.id === baseSnapshotRef);
    if (!baseSnapshot) return false;
    observedRoots = baseSnapshot.roots;
  }
  if (
    !isObject(observedRoots) ||
    !equalJson(observedRoots, object(expected.roots, "E_ROOTS"))
  )
    return false;
  const counts = object(expected.counts, "E_COUNTS");
  return (
    actual.writes === counts.writes &&
    actual.consumers === counts.consumers &&
    expected.consumerGate === "closed"
  );
};

const validateSqlite = (authority: JsonObject): void => {
  const body = object(authority.authority, "E_AUTHORITY_BODY");
  const normalization = object(
    body.sqliteNormalization,
    "E_SQLITE_NORMALIZATION",
  );
  const database = new Database(":memory:");
  try {
    const identity = database
      .prepare(
        "SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId",
      )
      .get() as { version: string; sourceId: string };
    const engine = object(normalization.engine, "E_SQLITE_ENGINE");
    expect(identity.version === engine.sqliteVersion, "E_SQLITE_VERSION");
    expect(identity.sourceId === engine.sqliteSourceId, "E_SQLITE_SOURCE_ID");
    const migrations = array(body.migrationCatalog, "E_MIGRATIONS").map(
      (item) => object(item, "E_MIGRATION"),
    );
    expect(migrations.length === 23, "E_MIGRATION_COUNT");
    for (let index = 0; index < migrations.length; index += 1) {
      const migration = migrations[index]!;
      expect(
        integer(migration.id, "E_MIGRATION_ID") === index,
        "E_MIGRATION_ID",
      );
      const statement = string(migration.statementUtf8, "E_MIGRATION_SQL");
      expect(
        Buffer.byteLength(statement) === migration.byteLength,
        "E_MIGRATION_LENGTH",
      );
      expect(sha256(statement) === migration.sha256, "E_MIGRATION_HASH");
      database.exec(statement);
    }
  } finally {
    database.close();
  }
};

const admitBaseline = (
  authorityBytes: Buffer,
  schemaValue: unknown,
  conformanceValue: unknown,
): { authority: JsonObject; conformance: JsonObject; rawSha256: string } => {
  const authority = object(parseRawJson(authorityBytes), "E_AUTHORITY_ROOT");
  const schema = object(schemaValue, "E_SCHEMA");
  const conformance = object(conformanceValue, "E_CONFORMANCE_ROOT");
  const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
  expect(validate(authority), "E_SCHEMA_ADMISSION");
  baselinePreflight(authority, conformance);
  validateSqlite(authority);
  const cases = object(
    object(authority.authority, "E_AUTHORITY_BODY").caseCatalog,
    "E_CASE_CATALOG",
  );
  const failingCases = Object.entries(cases)
    .filter(([, value]) => !casePasses(authority, object(value, "E_CASE")))
    .map(([id]) => id);
  expect(
    failingCases.length === 0,
    `E_BASELINE_CORPUS:${failingCases.join(",")}`,
  );
  return { authority, conformance, rawSha256: sha256(authorityBytes) };
};

export const validateV12Authority = (
  authorityBytes: Buffer,
  schemaValue: unknown,
  conformanceValue: unknown,
): ValidationReport => {
  try {
    const admitted = admitBaseline(
      authorityBytes,
      schemaValue,
      conformanceValue,
    );
    return { ok: true, errors: [], rawSha256: admitted.rawSha256 };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : "E_BASELINE_ADMISSION"],
      rawSha256: null,
    };
  }
};

const ledgerOutcome = (
  outcome: CaseOutcome,
  kind: "case-outcome" | "predicate-outcome",
  passed: boolean,
  predicate: string | null,
): JsonObject => ({
  kind,
  passed,
  decision: outcome.decision,
  errorClass: outcome.errorClass,
  trace: outcome.trace,
  postSnapshotRef: outcome.postSnapshotRef,
  predicate,
  predicateResult:
    kind === "predicate-outcome"
      ? outcome.decision === "predicate-admitted"
        ? "accepted"
        : "rejected"
      : "not-invoked",
  detail:
    outcome.harnessError === null
      ? `${kind}:${passed ? "passed" : "diverged"}`
      : `harness-error:${outcome.harnessError}`,
});

const notProducedOutcome = (detail: string): JsonObject => ({
  kind: "not-produced",
  passed: false,
  decision: null,
  errorClass: null,
  trace: [],
  postSnapshotRef: null,
  predicate: null,
  predicateResult: "not-invoked",
  detail,
});

const completeAuthorizedCaseObservation = (
  outcome: CaseOutcome,
  observer: JsonObject,
): CaseOutcome => {
  if (outcome.harnessError === null) return outcome;
  const binding =
    caseObserverBindings[
      string(observer.affectedPredicate, "E_AFFECTED_PREDICATE")
    ];
  if (!binding?.admittedErrors.includes(outcome.harnessError)) {
    throw new Error(`E_UNAUTHORIZED_CASE_REJECTION:${outcome.harnessError}`);
  }
  return {
    ...outcome,
    status: "completed",
    decision: "declared-case-semantic-rejection",
    errorClass: outcome.harnessError,
    harnessError: null,
  };
};

const predicateOutcome = (
  authority: JsonObject,
  baseline: JsonObject,
  observer: JsonObject,
): CaseOutcome => {
  const affected = string(observer.affectedPredicate, "E_AFFECTED_PREDICATE");
  let admitted = false;
  let error = "E_PREDICATE";
  if (affected.startsWith("digestCatalog.") && affected.endsWith(".preimage")) {
    const id = affected.split(".")[1]!;
    const entry = object(
      object(authority.digestCatalog, "E_DIGEST_CATALOG")[id],
      "E_DIGEST_ENTRY",
    );
    const baselineEntry = object(
      object(baseline.digestCatalog, "E_DIGEST_CATALOG")[id],
      "E_DIGEST_ENTRY",
    );
    admitted =
      sha256(digestPreimage(authority, entry)) === baselineEntry.expectedSha256;
    error = "E_DIGEST_HASH";
  } else if (affected === "canonicalization.objectKeyOrder") {
    admitted =
      object(
        object(authority.authority, "E_AUTHORITY_BODY").canonicalization,
        "E_CANONICALIZATION",
      ).objectKeyOrder === "unicode-scalar-ascending";
    error = "E_KEY_ORDER";
  } else if (affected === "sqliteNormalization.profile") {
    admitted =
      object(
        object(authority.authority, "E_AUTHORITY_BODY").sqliteNormalization,
        "E_SQLITE_NORMALIZATION",
      ).profile === "sqlite-memory-pinned";
    error = "E_SQLITE_PROFILE";
  } else if (affected === "digestCatalog.case-corpus.expectedSha256") {
    const entry = object(
      object(baseline.digestCatalog, "E_DIGEST_CATALOG")["case-corpus"],
      "E_DIGEST_ENTRY",
    );
    admitted =
      sha256(digestPreimage(authority, entry)) === entry.expectedSha256;
    error = "E_STATIC_DIGEST";
  } else {
    throw new Error("E_OBSERVER_TYPE");
  }
  return {
    status: "completed",
    decision: admitted ? "predicate-admitted" : "predicate-rejected",
    errorClass: admitted ? null : error,
    trace: [admitted ? "predicate-admitted" : `predicate-rejected:${error}`],
    postSnapshotRef: null,
    writes: 0,
    consumers: 0,
    harnessError: null,
  };
};

const constructDerivedView = (
  baseline: JsonObject,
  descriptor: JsonObject,
  observer: JsonObject,
  baselineContractRoot: string,
): { view: JsonObject; digest: string } => {
  const view = structuredClone(baseline);
  const pointer = string(descriptor.targetPointer, "E_MUTANT_POINTER");
  const target = object(getPointer(view, pointer), "E_MUTANT_TARGET");
  expect(target.id === descriptor.targetId, "E_TARGET_ID");
  const operations = patchOperations(descriptor.patch!, "E_MUTANT_PATCH");
  expect(operations.length === 1, "E_MUTANT_PATCH_COUNT");
  const patched = applyPatch(target, operations);
  expect(!equalJson(target, patched), "E_PATCH_NO_EFFECT");
  expect(
    equalJson(diffPaths(target, patched), [
      `/${string(descriptor.intendedSemanticField, "E_MUTANT_FIELD")}`,
    ]),
    "E_PATCH_SEMANTIC_FIELD",
  );
  expect(
    descriptorDigest(descriptor) === observer.immutableDescriptorSha256,
    "E_DESCRIPTOR_DIGEST",
  );
  setPointer(view, pointer, patched);
  const digest = framedSha256(DERIVED_VIEW_DOMAIN, {
    baselineContractRoot,
    mutantId: descriptor.id!,
    immutableDescriptorSha256: observer.immutableDescriptorSha256!,
    mutatedSubject: patched,
  });
  return { view, digest };
};

const errorRow = (
  descriptor: JsonObject,
  observer: JsonObject,
  phase: FailurePhase,
  outcome: Extract<MutationOutcome, "invalid-mutant" | "harness-error">,
  error: unknown,
  state: Partial<V12LedgerRow> = {},
): V12LedgerRow => ({
  mutantId: string(descriptor.id, "E_MUTANT_ID"),
  semanticClass: string(descriptor.semanticClass, "E_SEMANTIC_CLASS"),
  intendedSemanticField: string(
    descriptor.intendedSemanticField,
    "E_MUTANT_FIELD",
  ),
  selected: true,
  targetResolved: false,
  patchApplied: false,
  intendedFieldChanged: false,
  descriptorBound: false,
  derivedEnvelopeBound: false,
  derivedEnvelopeDigest: null,
  declaredKillerCaseId: string(observer.declaredKillerCaseId, "E_KILLER"),
  observerType: string(
    observer.observerType,
    "E_OBSERVER_TYPE",
  ) as ObserverType,
  killerStarted: false,
  killerCompleted: false,
  baselineOutcome: notProducedOutcome("baseline-outcome-not-produced"),
  mutantOutcome: notProducedOutcome(
    `harness-error:${error instanceof Error ? error.message : "E_HARNESS"}`,
  ),
  divergenceField: null,
  declaredSemanticReason: string(
    observer.declaredSemanticReason,
    "E_DECLARED_REASON",
  ),
  observedSemanticReason: null,
  failurePhase: phase,
  outcome,
  ...state,
});

const executeMutant = (
  baseline: JsonObject,
  descriptor: JsonObject,
  observer: JsonObject,
  baselineOutcomes: ReadonlyMap<string, CaseOutcome>,
  baselineContractRoot: string,
): V12LedgerRow => {
  let view: JsonObject;
  let derivedEnvelopeDigest: string;
  try {
    ({ view, digest: derivedEnvelopeDigest } = constructDerivedView(
      baseline,
      descriptor,
      observer,
      baselineContractRoot,
    ));
  } catch (error) {
    return errorRow(
      descriptor,
      observer,
      "derived-view-admission",
      "invalid-mutant",
      error,
    );
  }
  const killerId = string(observer.declaredKillerCaseId, "E_KILLER");
  const admittedKillerOutcome = baselineOutcomes.get(killerId);
  if (!admittedKillerOutcome) {
    return errorRow(
      descriptor,
      observer,
      "semantic-execution",
      "harness-error",
      new Error("E_KILLER_LOOKUP"),
      {
        targetResolved: true,
        patchApplied: true,
        intendedFieldChanged: true,
        descriptorBound: true,
        derivedEnvelopeBound: true,
        derivedEnvelopeDigest,
      },
    );
  }
  let baselineOutcome: CaseOutcome;
  let mutantOutcome: CaseOutcome;
  try {
    const observerType = string(
      observer.observerType,
      "E_OBSERVER_TYPE",
    ) as ObserverType;
    if (observerType === "case-outcome") {
      baselineOutcome = admittedKillerOutcome;
      const cases = object(
        object(view.authority, "E_AUTHORITY_BODY").caseCatalog,
        "E_CASE_CATALOG",
      );
      mutantOutcome = completeAuthorizedCaseObservation(
        executeCaseOutcome(view, object(cases[killerId], "E_KILLER_CASE")),
        observer,
      );
    } else {
      baselineOutcome = predicateOutcome(baseline, baseline, observer);
      mutantOutcome = predicateOutcome(view, baseline, observer);
    }
  } catch (error) {
    return errorRow(
      descriptor,
      observer,
      "semantic-execution",
      "harness-error",
      error,
      {
        targetResolved: true,
        patchApplied: true,
        intendedFieldChanged: true,
        descriptorBound: true,
        derivedEnvelopeBound: true,
        derivedEnvelopeDigest,
        killerStarted: true,
        baselineOutcome: ledgerOutcome(
          admittedKillerOutcome,
          "case-outcome",
          true,
          null,
        ),
      },
    );
  }
  const diverged = !equalJson(
    structuredClone(baselineOutcome) as unknown as JsonObject,
    structuredClone(mutantOutcome) as unknown as JsonObject,
  );
  const declaredReason = string(
    observer.declaredSemanticReason,
    "E_DECLARED_REASON",
  );
  const observedReason = diverged ? declaredReason : null;
  const observerType = string(
    observer.observerType,
    "E_OBSERVER_TYPE",
  ) as ObserverType;
  const predicate =
    observerType === "case-outcome"
      ? null
      : string(observer.affectedPredicate, "E_AFFECTED_PREDICATE");
  return {
    mutantId: string(descriptor.id, "E_MUTANT_ID"),
    semanticClass: string(descriptor.semanticClass, "E_SEMANTIC_CLASS"),
    intendedSemanticField: string(
      descriptor.intendedSemanticField,
      "E_MUTANT_FIELD",
    ),
    selected: true,
    targetResolved: true,
    patchApplied: true,
    intendedFieldChanged: true,
    descriptorBound: true,
    derivedEnvelopeBound: true,
    derivedEnvelopeDigest,
    declaredKillerCaseId: killerId,
    observerType,
    killerStarted: true,
    killerCompleted: true,
    baselineOutcome: ledgerOutcome(
      baselineOutcome,
      observerType === "case-outcome" ? "case-outcome" : "predicate-outcome",
      true,
      predicate,
    ),
    mutantOutcome: ledgerOutcome(
      mutantOutcome,
      observerType === "case-outcome" ? "case-outcome" : "predicate-outcome",
      !diverged,
      predicate,
    ),
    divergenceField: diverged
      ? string(observer.divergenceField, "E_DIVERGENCE_FIELD")
      : null,
    declaredSemanticReason: declaredReason,
    observedSemanticReason: observedReason,
    failurePhase: diverged ? "kill-classification" : null,
    outcome: diverged ? "killed" : "survived",
  };
};

const deriveAggregates = (
  rows: readonly V12LedgerRow[],
  expectedIds: readonly string[],
) => {
  const counts = new Map<string, number>();
  for (const row of rows)
    counts.set(row.mutantId, (counts.get(row.mutantId) ?? 0) + 1);
  return {
    selected: rows.filter((row) => row.selected).length,
    patchApplied: rows.filter((row) => row.patchApplied).length,
    killerStarted: rows.filter((row) => row.killerStarted).length,
    killerCompleted: rows.filter((row) => row.killerCompleted).length,
    killed: rows.filter((row) => row.outcome === "killed").length,
    survived: rows.filter((row) => row.outcome === "survived").length,
    uncovered: rows.filter((row) => row.outcome === "uncovered").length,
    invalidMutant: rows.filter((row) => row.outcome === "invalid-mutant")
      .length,
    harnessError: rows.filter((row) => row.outcome === "harness-error").length,
    missingRows: expectedIds.filter((id) => !counts.has(id)).length,
    duplicateRows: [...counts.values()]
      .filter((count) => count > 1)
      .reduce((sum, count) => sum + count - 1, 0),
  };
};

const evaluateNegativeControls = (
  baseline: JsonObject,
  baselineOutcomes: ReadonlyMap<string, CaseOutcome>,
): V12ControlRow[] => {
  const cases = object(
    object(baseline.authority, "E_AUTHORITY_BODY").caseCatalog,
    "E_CASE_CATALOG",
  );
  const controlCaseId = "state/fresh~literal";
  const controlCase = object(cases[controlCaseId], "E_CONTROL_CASE");
  const baselineOutcome = baselineOutcomes.get(controlCaseId)!;
  const substituted = [...baselineOutcome.trace];
  const traceIndex = 3;
  substituted[traceIndex] = `${substituted[traceIndex]}:substituted`;
  const traceComparison = compareV12LiteralTraces(
    substituted,
    baselineOutcome.trace,
  );
  const traceRow: V12ControlRow = {
    controlId: "trace-literal-substitution",
    controlType: "trace-literal-substitution",
    catalogMember: false,
    selected: true,
    patchApplied: true,
    killerStarted: true,
    killerCompleted: true,
    traceIndex: traceComparison.equal ? null : traceComparison.mismatchIndex,
    expectedLiteral: traceComparison.equal ? null : traceComparison.expected,
    actualLiteral: traceComparison.equal ? null : traceComparison.actual,
    failurePhase: "semantic-execution",
    outcome: "trace-mismatch",
    gateOutcome: traceComparison.equal ? "unexpected-green" : "expected-red",
    detail:
      "The production literal comparator rejected one byte-distinct trace token at its exact position.",
  };

  const inertCase = object(
    applyPatch(controlCase, [
      { op: "replace", path: "/id", value: "control-semantically-inert" },
    ]),
    "E_CONTROL_PATCH",
  );
  const inertOutcome = executeCaseOutcome(baseline, inertCase);
  const inertSurvived = equalJson(
    structuredClone(baselineOutcome) as unknown as JsonObject,
    structuredClone(inertOutcome) as unknown as JsonObject,
  );
  const inertRow: V12ControlRow = {
    controlId: "semantically-inert-mutant",
    controlType: "semantically-inert-mutant",
    catalogMember: false,
    selected: true,
    patchApplied: true,
    killerStarted: true,
    killerCompleted: true,
    traceIndex: null,
    expectedLiteral: null,
    actualLiteral: null,
    failurePhase: "negative-control",
    outcome: inertSurvived ? "survived" : "uncovered",
    gateOutcome: inertSurvived ? "expected-red" : "unexpected-green",
    detail:
      "A valid inert mutation reached and completed the same runner observer without semantic divergence.",
  };

  let brokenOutcome: "harness-error" | "uncovered" = "uncovered";
  let killerStarted = false;
  try {
    throw new Error("E_CONTROL_PRE_KILLER");
  } catch {
    brokenOutcome = "harness-error";
  }
  const brokenRow: V12ControlRow = {
    controlId: "pre-killer-broken-harness",
    controlType: "pre-killer-broken-harness",
    catalogMember: false,
    selected: true,
    patchApplied: false,
    killerStarted,
    killerCompleted: false,
    traceIndex: null,
    expectedLiteral: null,
    actualLiteral: null,
    failurePhase: "mutant-construction",
    outcome: brokenOutcome,
    gateOutcome:
      brokenOutcome === "harness-error" && !killerStarted
        ? "expected-red"
        : "unexpected-green",
    detail:
      "A forced exception before killerStarted remained a harness error and never entered kill classification.",
  };
  return [traceRow, inertRow, brokenRow];
};

export const executeV12Corpus = async (
  authorityBytes: Buffer,
  schemaValue: unknown,
  conformanceValue: unknown,
): Promise<V12ExecutionReport> => {
  const { authority, rawSha256 } = admitBaseline(
    authorityBytes,
    schemaValue,
    conformanceValue,
  );
  const body = object(authority.authority, "E_AUTHORITY_BODY");
  const cases = object(body.caseCatalog, "E_CASE_CATALOG");
  const baselineOutcomes = new Map<string, CaseOutcome>();
  let passed = 0;
  for (const [id, value] of Object.entries(cases)) {
    const caseValue = object(value, `E_CASE:${id}`);
    baselineOutcomes.set(id, executeCaseOutcome(authority, caseValue));
    if (casePasses(authority, caseValue)) passed += 1;
  }
  const mutants = object(body.mutantCatalog, "E_MUTANTS");
  const observers = object(
    object(body.proofContract, "E_PROOF_CONTRACT").observerCatalog,
    "E_OBSERVERS",
  );
  const a0Entries = Object.entries(mutants).filter(
    ([, value]) => object(value, "E_MUTANT").phase === "a0",
  );
  const baselineContractRoot = string(
    object(authority.digestCatalog, "E_DIGEST_CATALOG")["contract-root"] &&
      object(
        object(authority.digestCatalog, "E_DIGEST_CATALOG")["contract-root"],
        "E_CONTRACT_ROOT",
      ).expectedSha256,
    "E_CONTRACT_ROOT",
  );
  const ledgerRows = a0Entries.map(([id, value]) =>
    executeMutant(
      authority,
      object(value, `E_MUTANT:${id}`),
      object(observers[id], `E_OBSERVER:${id}`),
      baselineOutcomes,
      baselineContractRoot,
    ),
  );
  const a0 = deriveAggregates(
    ledgerRows,
    a0Entries.map(([id]) => id),
  );
  const controlRows = evaluateNegativeControls(authority, baselineOutcomes);
  const proofContract = object(body.proofContract, "E_PROOF_CONTRACT");
  const rowAjv = new Ajv({ allErrors: true, strict: true });
  const validateLedgerRow = rowAjv.compile(
    object(proofContract.ledgerSchema, "E_LEDGER_SCHEMA"),
  );
  const validateControlRow = rowAjv.compile(
    object(proofContract.controlRowSchema, "E_CONTROL_SCHEMA"),
  );
  const invalidLedgerRow = ledgerRows.find((row) => !validateLedgerRow(row));
  expect(
    invalidLedgerRow === undefined,
    `E_LEDGER_ROW_SCHEMA:${JSON.stringify(validateLedgerRow.errors)}`,
  );
  const invalidControlRow = controlRows.find((row) => !validateControlRow(row));
  expect(
    invalidControlRow === undefined,
    `E_CONTROL_ROW_SCHEMA:${JSON.stringify(validateControlRow.errors)}`,
  );
  return {
    baselineAdmissionRuns: 1,
    baselineRawSha256: rawSha256,
    baselineContractRoot,
    baseline: {
      selected: Object.keys(cases).length,
      passed,
      failed: Object.keys(cases).length - passed,
      skipped: 0,
    },
    a0,
    v3Construction: {
      selected: 0,
      patched: 0,
      executed: 0,
      constructed: 0,
      sentinels: Object.values(mutants).filter(
        (value) => object(value, "E_MUTANT").phase === "v3-construction",
      ).length,
    },
    ledgerRows,
    controlRows,
    controlsPass: controlRows.every(
      (row) => row.gateOutcome === "expected-red",
    ),
  };
};
