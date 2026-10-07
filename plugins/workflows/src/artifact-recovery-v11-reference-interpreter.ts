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

type ValidationReport = { ok: boolean; errors: string[] };

export type V11ExecutionReport = {
  selected: number;
  passed: number;
  failed: number;
  skipped: number;
  mutantsSelected: number;
  mutantsKilled: number;
  mutantsSurvived: number;
  mutantsSkipped: number;
  uncovered: number;
};

const EXPECTED_AUTHORITY_ID = "artifact-review-v11:keyed-oracle-dsl-v1";
const EXPECTED_DSL_ID = "bb-keyed-sqlite-oracle-dsl-v1";
const EXPECTED_CANONICALIZATION = "bb-cjson-2";
const EXPECTED_REDUCER = "artifact-review-recovery-v3-reference";

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
  if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
    throw new Error(code);
  }
  return value as number;
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
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort(compareUnicodeScalars)
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key]!)}`)
    .join(",")}}`;
};

const equalJson = (left: JsonValue, right: JsonValue): boolean =>
  canonicalize(left) === canonicalize(right);

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const assertUnicodeScalars = (value: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("E_LONE_SURROGATE");
      }
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
  return {
    parent: getPointer(
      document,
      tokens.length === 0 ? "" : `/${tokens.map(escapePointerToken).join("/")}`,
    ),
    token,
  };
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
    if (!(["add", "replace", "remove"] as string[]).includes(operation.op)) {
      throw new Error("E_PATCH_OP");
    }
    const { parent, token } = parentAndToken(result, operation.path);
    if (Array.isArray(parent)) {
      if (token === "-") throw new Error("E_PATCH_APPEND");
      if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) {
        throw new Error("E_PATCH_INDEX");
      }
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

const removePointer = (document: JsonValue, pointer: string): void => {
  const { parent, token } = parentAndToken(document, pointer);
  if (Array.isArray(parent)) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) {
      throw new Error("E_PATCH_INDEX");
    }
    parent.splice(Number(token), 1);
  } else if (isObject(parent)) delete parent[token];
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

const expect: (condition: unknown, code: string) => asserts condition = (
  condition,
  code,
) => {
  if (!condition) throw new Error(code);
};

const validateConformanceVectors = (conformance: JsonObject): void => {
  const raw = object(conformance.rawAdmissionVectors, "E_RAW_VECTORS");
  for (const item of array(raw.accepted, "E_RAW_VECTORS")) {
    const vector = object(item, "E_RAW_VECTOR");
    parseRawJson(Buffer.from(string(vector.utf8Hex, "E_RAW_VECTOR"), "hex"));
  }
  for (const item of array(raw.rejected, "E_RAW_VECTORS")) {
    const vector = object(item, "E_RAW_VECTOR");
    const wanted = string(vector.error, "E_RAW_VECTOR");
    let observed = "";
    try {
      parseRawJson(Buffer.from(string(vector.utf8Hex, "E_RAW_VECTOR"), "hex"));
    } catch (error) {
      observed = error instanceof Error ? error.message : "E_UNKNOWN";
    }
    expect(observed === wanted, `E_RAW_VECTOR:${String(vector.id)}`);
  }
  const pointers = object(conformance.pointerVectors, "E_POINTER_VECTORS");
  for (const item of array(pointers.accepted, "E_POINTER_VECTORS")) {
    const vector = object(item, "E_POINTER_VECTOR");
    const target = object(
      getPointer(vector.document!, string(vector.pointer, "E_POINTER_VECTOR")),
      "E_POINTER_VECTOR",
    );
    expect(target.id === vector.targetId, "E_TARGET_ID");
  }
  for (const item of array(pointers.rejected, "E_POINTER_VECTORS")) {
    const vector = object(item, "E_POINTER_VECTOR");
    const wanted = string(vector.error, "E_POINTER_VECTOR");
    let observed = "";
    try {
      if (wanted === "E_POINTER_OVERLAP") {
        assertNoOverlaps(array(vector.pointers, wanted).map(String));
      } else if (wanted === "E_TARGET_ID") {
        const target = object(
          getPointer({ a: { id: "actual" } }, string(vector.pointer, wanted)),
          wanted,
        );
        if (target.id !== vector.targetId) throw new Error(wanted);
      } else if (wanted === "E_POINTER_DOMAIN") {
        if (
          !string(vector.pointer, wanted).startsWith("/authority/caseCatalog/")
        ) {
          throw new Error(wanted);
        }
      } else {
        getPointer(
          wanted === "E_POINTER_ARRAY" ? { items: [0] } : {},
          string(vector.pointer, wanted),
        );
      }
    } catch (error) {
      observed = error instanceof Error ? error.message : "E_UNKNOWN";
    }
    expect(observed === wanted, `E_POINTER_VECTOR:${String(vector.id)}`);
  }

  const patches = object(conformance.patchVectors, "E_PATCH_VECTORS");
  for (const item of array(patches.accepted, "E_PATCH_VECTORS")) {
    const vector = object(item, "E_PATCH_VECTOR");
    const result = applyPatch(
      vector.document!,
      patchOperations(vector.patch!, "E_PATCH_VECTOR"),
    );
    expect(
      equalJson(result, vector.result!),
      `E_PATCH_VECTOR:${String(vector.id)}`,
    );
  }
  for (const item of array(patches.rejected, "E_PATCH_VECTORS")) {
    const vector = object(item, "E_PATCH_VECTOR");
    const wanted = string(vector.error, "E_PATCH_VECTOR");
    let observed = "";
    try {
      const before = vector.document!;
      const after = applyPatch(
        before,
        patchOperations(vector.patch!, "E_PATCH_VECTOR"),
      );
      const changed = diffPaths(before, after);
      if (changed.length === 0) throw new Error("E_PATCH_NO_EFFECT");
      const field = `/${escapePointerToken(string(vector.semanticField, "E_PATCH_VECTOR"))}`;
      if (changed.some((path) => path !== field)) {
        throw new Error("E_PATCH_SEMANTIC_FIELD");
      }
    } catch (error) {
      observed = error instanceof Error ? error.message : "E_UNKNOWN";
    }
    expect(observed === wanted, `E_PATCH_VECTOR:${String(vector.id)}`);
  }
};

const validateDigestCatalog = (authority: JsonObject): void => {
  const catalog = object(authority.digestCatalog, "E_DIGEST_CATALOG");
  const order = array(authority.digestOrder, "E_DIGEST_ORDER").map((id) =>
    string(id, "E_DIGEST_ORDER"),
  );
  expect(order.length === 9, "E_DIGEST_COUNT");
  expect(new Set(order).size === order.length, "E_DIGEST_ID");
  const seen = new Set<string>();
  const domains = new Set<string>();
  for (const id of order) {
    const entry = object(catalog[id], `E_DIGEST_ENTRY:${id}`);
    expect(entry.id === id, `E_DIGEST_ID:${id}`);
    const domain = string(entry.domain, `E_DIGEST_DOMAIN:${id}`);
    expect(
      domain.startsWith("bb.artifact-review.v11.digest.") &&
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
    const selected = structuredClone(authority) as JsonValue;
    const omitted = array(entry.omitPointers, `E_DIGEST_OMIT:${id}`).map(
      (pointer) => string(pointer, `E_DIGEST_OMIT:${id}`),
    );
    for (const pointer of omitted.sort((a, b) => b.length - a.length)) {
      removePointer(selected, pointer);
    }
    const payload = array(entry.payloadPointers, `E_DIGEST_PAYLOAD:${id}`).map(
      (pointerValue) => {
        const pointer = string(pointerValue, `E_DIGEST_PAYLOAD:${id}`);
        return {
          pointer,
          value: pointer === "" ? selected : getPointer(selected, pointer),
        };
      },
    ) as JsonValue;
    const payloadBytes = Buffer.from(canonicalize(payload), "utf8");
    const preimage = Buffer.concat([
      Buffer.from(domain, "utf8"),
      Buffer.from([0]),
      payloadBytes,
    ]);
    expect(
      entry.payloadByteLength === payloadBytes.length,
      `E_DIGEST_LENGTH:${id}`,
    );
    expect(
      entry.preimageByteLength === preimage.length,
      `E_DIGEST_LENGTH:${id}`,
    );
    expect(entry.expectedSha256 === sha256(preimage), `E_DIGEST_HASH:${id}`);
  }
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

const preflight = (
  authorityValue: unknown,
  conformanceValue: unknown,
): void => {
  const authority = object(authorityValue, "E_AUTHORITY_ROOT");
  const conformance = object(conformanceValue, "E_CONFORMANCE_ROOT");
  expect(authority.authorityId === EXPECTED_AUTHORITY_ID, "E_AUTHORITY_ID");
  expect(conformance.dslId === EXPECTED_DSL_ID, "E_DSL_ID");
  expect(
    conformance.canonicalizationVersion === EXPECTED_CANONICALIZATION,
    "E_CANONICALIZATION_ID",
  );
  const body = object(authority.authority, "E_AUTHORITY_BODY");
  const dsl = object(body.dsl, "E_DSL");
  const opcodes = array(dsl.operationOpcodes, "E_OPCODE_CATALOG").map(String);
  const conformanceOpcodes = array(
    conformance.opcodeVectors,
    "E_OPCODE_VECTORS",
  ).map((item) =>
    string(object(item, "E_OPCODE_VECTOR").op, "E_OPCODE_VECTOR"),
  );
  expect(equalJson(opcodes, conformanceOpcodes), "E_OPCODE_CATALOG");
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
  expect(normalization.id === "sqlite-normalization-v11-exact", "E_SQLITE_ID");
  expect(normalization.profile === "sqlite-memory-pinned", "E_SQLITE_PROFILE");

  validateConformanceVectors(conformance);

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
  expect(fixtureIds.size === fixtures.length, "E_FIXTURE_ID");
  expect(snapshotIds.size === snapshots.length, "E_SNAPSHOT_ID");
  const caseCatalog = object(body.caseCatalog, "E_CASE_CATALOG");
  const cases = Object.values(caseCatalog).map((item) =>
    object(item, "E_CASE"),
  );
  expect(cases.length === 179, "E_CASE_COUNT");
  expect(new Set(cases.map((item) => item.id)).size === 179, "E_CASE_ID");
  const categoryCounts = Object.fromEntries(
    [...new Set(cases.map((item) => string(item.category, "E_CATEGORY")))]
      .sort(compareUnicodeScalars)
      .map((category) => [
        category,
        cases.filter((item) => item.category === category).length,
      ]),
  ) as JsonObject;
  expect(
    equalJson(
      categoryCounts,
      object(
        object(conformance.requiredReport, "E_REQUIRED_REPORT").categoryCounts,
        "E_CATEGORY_COUNTS",
      ),
    ),
    "E_CATEGORY_COUNTS",
  );
  for (const [key, item] of Object.entries(caseCatalog)) {
    const caseValue = object(item, `E_CASE:${key}`);
    expect(caseValue.id === key, `E_CASE_KEY:${key}`);
    expect(
      fixtureIds.has(string(caseValue.fixtureRef, `E_FIXTURE_REF:${key}`)),
      `E_FIXTURE_REF:${key}`,
    );
    const expected = object(caseValue.expected, `E_EXPECTED:${key}`);
    expect(
      snapshotIds.has(string(expected.preSnapshotRef, `E_SNAPSHOT_REF:${key}`)),
      `E_SNAPSHOT_REF:${key}`,
    );
    expect(
      snapshotIds.has(
        string(expected.postSnapshotRef, `E_SNAPSHOT_REF:${key}`),
      ),
      `E_SNAPSHOT_REF:${key}`,
    );
    for (const operationValue of array(caseValue.program, `E_PROGRAM:${key}`)) {
      const operation = object(operationValue, `E_PROGRAM:${key}`);
      const op = string(operation.op, `E_OPCODE:${key}`);
      expect(opcodes.includes(op), `E_OPCODE:${key}`);
      if (op === "assertExpectedSnapshot") {
        expect(Object.keys(operation).length === 1, `E_OPCODE_OPERAND:${key}`);
      }
    }
    if (caseValue.setupPatch !== undefined) {
      const fixture = fixtures.find(
        (candidate) => candidate.id === caseValue.fixtureRef,
      )!;
      const patched = applyPatch(
        fixture,
        patchOperations(caseValue.setupPatch, `E_SETUP_PATCH:${key}`),
      );
      const snapshot = snapshots.find(
        (candidate) => candidate.id === expected.preSnapshotRef,
      )!;
      expect(
        equalJson(object(snapshot.state, `E_SNAPSHOT_STATE:${key}`), patched),
        `E_SNAPSHOT_STATE:${key}`,
      );
      expect(
        expected.preSnapshotRef === expected.postSnapshotRef,
        `E_SNAPSHOT_REF:${key}`,
      );
    }
  }

  const mutants = array(body.mutantCatalog, "E_MUTANTS").map((item) =>
    object(item, "E_MUTANT"),
  );
  expect(mutants.length === 179, "E_MUTANT_COUNT");
  const pointers = mutants.map((item) =>
    string(item.targetPointer, "E_MUTANT_POINTER"),
  );
  expect(new Set(pointers).size === 179, "E_MUTANT_POINTER");
  assertNoOverlaps(pointers);
  const obligations = array(
    object(body.coverage, "E_COVERAGE").obligations,
    "E_OBLIGATIONS",
  ).map((item) => object(item, "E_OBLIGATION"));
  expect(obligations.length === 179, "E_OBLIGATION_COUNT");
  const obligationsById = new Map(
    obligations.map((item) => [String(item.id), item]),
  );
  for (const mutant of mutants) {
    const id = string(mutant.id, "E_MUTANT_ID");
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
    expect(operations.length === 1, `E_MUTANT_PATCH:${id}`);
    const patched = applyPatch(target, operations);
    expect(
      equalJson(diffPaths(target, patched), [
        `/${String(mutant.intendedSemanticField)}`,
      ]),
      `E_MUTANT_FIELD:${id}`,
    );
    if (mutant.phase === "a0") {
      expect(arm === "reference", `E_MUTANT_ARM:${id}`);
      expect(
        !string(mutant.targetPointer, id).includes("/expected"),
        `E_MUTANT_EXPECTED:${id}`,
      );
    }
    const obligation = obligationsById.get(String(mutant.obligationId));
    expect(obligation?.mutantId === id, `E_OBLIGATION:${id}`);
    expect(
      equalJson(obligation!.killerCaseIds!, mutant.killerCaseIds!),
      `E_OBLIGATION:${id}`,
    );
  }
  expect(
    mutants.filter((item) => item.phase === "a0").length === 173,
    "E_A0_COUNT",
  );
  expect(
    mutants.filter((item) => item.phase === "v3-construction").length === 6,
    "E_SENTINEL_COUNT",
  );
  const sentinels = array(
    conformance.constructionSentinels,
    "E_CONSTRUCTION_SENTINELS",
  ).map((item) => object(item, "E_CONSTRUCTION_SENTINEL"));
  expect(sentinels.length === 6, "E_SENTINEL_COUNT");
  expect(
    sentinels.filter((item) => item.arm === "production").length === 3 &&
      sentinels.filter((item) => item.arm === "fake").length === 3,
    "E_SENTINEL_ARMS",
  );
  for (const sentinel of sentinels) {
    const mutant = mutants.find((item) => item.id === sentinel.mutantId);
    expect(mutant !== undefined, "E_SENTINEL_MUTANT");
    expect(
      mutant.phase === "v3-construction" &&
        mutant.arm === sentinel.arm &&
        mutant.targetOwner === sentinel.owner &&
        mutant.targetId === sentinel.targetId &&
        equalJson(mutant.adapterTarget!, sentinel.adapterTarget!),
      "E_SENTINEL_DESCRIPTOR",
    );
    const target = object(sentinel.adapterTarget, "E_SENTINEL_TARGET");
    string(target.path, "E_SENTINEL_TARGET");
    string(target.symbol, "E_SENTINEL_TARGET");
    expect(
      sentinel.a0Disposition === "construction-gated-by-phase" &&
        sentinel.failingArmCount === 1,
      "E_SENTINEL_DISPOSITION",
    );
  }
  validateDigestCatalog(authority);
};

export const validateV11Authority = (
  authorityValue: unknown,
  schemaValue: unknown,
  conformanceValue: unknown,
): ValidationReport => {
  const errors: string[] = [];
  try {
    const validate = new Ajv({ allErrors: true, strict: true }).compile(
      object(schemaValue, "E_SCHEMA"),
    );
    if (!validate(authorityValue)) {
      errors.push("E_SCHEMA_ADMISSION");
    } else {
      const admitted = object(authorityValue, "E_AUTHORITY_ROOT");
      const invalids: JsonObject[] = [];
      const extraRoot = structuredClone(admitted);
      extraRoot.unknown = true;
      invalids.push(extraRoot);
      const missingRoot = structuredClone(admitted);
      delete missingRoot.authorityId;
      invalids.push(missingRoot);
      const unknownOpcode = structuredClone(admitted);
      const unknownCases = object(
        object(unknownOpcode.authority, "E_AUTHORITY_BODY").caseCatalog,
        "E_CASE_CATALOG",
      );
      const firstCase = object(Object.values(unknownCases)[0], "E_CASE");
      object(array(firstCase.program, "E_PROGRAM")[0], "E_PROGRAM").op =
        "unknownOpcode";
      invalids.push(unknownOpcode);
      const unknownOwner = structuredClone(admitted);
      object(
        array(
          object(unknownOwner.authority, "E_AUTHORITY_BODY").mutantCatalog,
          "E_MUTANTS",
        )[0],
        "E_MUTANT",
      ).targetOwner = "unknown-owner";
      invalids.push(unknownOwner);
      const snapshotOperand = structuredClone(admitted);
      const snapshotCases = Object.values(
        object(
          object(snapshotOperand.authority, "E_AUTHORITY_BODY").caseCatalog,
          "E_CASE_CATALOG",
        ),
      ).map((item) => object(item, "E_CASE"));
      const snapshotOperation = snapshotCases
        .flatMap((item) => array(item.program, "E_PROGRAM"))
        .map((item) => object(item, "E_PROGRAM"))
        .find((item) => item.op === "assertExpectedSnapshot");
      expect(snapshotOperation !== undefined, "E_SNAPSHOT_OPCODE");
      snapshotOperation.optional = true;
      invalids.push(snapshotOperand);
      const digestDomain = structuredClone(admitted);
      object(
        object(digestDomain.digestCatalog, "E_DIGEST_CATALOG")[
          "migration-vector"
        ],
        "E_DIGEST_ENTRY",
      ).domain = "unknown-domain";
      invalids.push(digestDomain);
      if (invalids.some((invalid) => validate(invalid))) {
        errors.push("E_SCHEMA_NEGATIVE_VECTOR");
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "E_SCHEMA");
  }
  try {
    preflight(authorityValue, conformanceValue);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "E_PREFLIGHT");
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
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

const evaluateExpression = (expressionValue: JsonValue): boolean => {
  const expression = object(expressionValue, "E_EXPRESSION");
  expect(expression.op === "equals", "E_EXPRESSION_OPCODE");
  const evaluate = (value: JsonValue): JsonValue => {
    const node = object(value, "E_EXPRESSION");
    switch (node.op) {
      case "multiset":
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
      case "project":
        return [...array(node.values, "E_EXPRESSION")].sort((a, b) =>
          compareUnicodeScalars(canonicalize(a), canonicalize(b)),
        );
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

const observationTrace = (observation: string): string => {
  if (
    observation.startsWith("E_") &&
    observation !== "E_UNADMITTED_LEGACY_STATE"
  ) {
    const aliases: Record<string, string> = {
      E_EVIDENCE_MISMATCH: "evidence-mismatch",
      E_LEDGER_FAILED: "failed-ledger",
      E_LEDGER_FUTURE: "future-ledger",
      E_LEDGER_MALFORMED: "malformed-ledger",
      E_LEDGER_NONCONTIGUOUS: "noncontiguous-ledger",
      E_RECOVERY_PARTIAL: "partial-recovery",
      E_SCHEMA_MISMATCH: "schema-mismatch",
      E_UNKNOWN_COMPLETION: "full-ledger-no-completion",
    };
    return `observed:${aliases[observation] ?? observation}`;
  }
  return `observed:${observation}`;
};

const traceMatches = (actual: JsonValue, expected: JsonValue): boolean => {
  const left = array(actual, "E_TRACE").map((item) => string(item, "E_TRACE"));
  const right = array(expected, "E_TRACE").map((item) =>
    string(item, "E_TRACE"),
  );
  return (
    left.length === right.length &&
    left.every((item, index) =>
      item.startsWith("observed:")
        ? right[index]?.startsWith("observed:") === true
        : item === right[index],
    )
  );
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

  for (const operationValue of array(caseValue.program, "E_PROGRAM")) {
    const operation = object(operationValue, "E_PROGRAM");
    switch (operation.op) {
      case "open":
        expect(!opened, "E_STATE_OPEN");
        opened = true;
        trace.push("open");
        break;
      case "materializeFixture":
        expect(opened && !materialized, "E_STATE_MATERIALIZE");
        expect(operation.fixtureRef === fixtureRef, "E_FIXTURE_REF");
        materialized = true;
        trace.push(
          array(caseValue.program, "E_PROGRAM").some(
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
        trace.push(observationTrace(observation));
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
        if (caseValue.expression !== undefined) {
          expect(evaluateExpression(caseValue.expression), "E_PARITY");
        }
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
          if (caseValue.boundary === "post-commit")
            decision = "block-post-commit-verification";
          else decision = "rollback";
        } else {
          trace.push("effects-applied");
        }
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
        } else {
          trace.push("verified-completed");
        }
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
        const registration = mutation.value;
        if (registration === true || typeof registration === "number") {
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

const casePasses = (authority: JsonObject, caseValue: JsonObject): boolean => {
  try {
    const actual = executeCase(authority, caseValue);
    const expected = object(caseValue.expected, "E_EXPECTED");
    const snapshots = array(
      object(authority.authority, "E_AUTHORITY_BODY").snapshotCatalog,
      "E_SNAPSHOTS",
    ).map((item) => object(item, "E_SNAPSHOT"));
    const snapshot = snapshots.find(
      (item) => item.id === actual.postSnapshotRef,
    );
    expect(snapshot !== undefined, "E_SNAPSHOT_REF");
    expect(actual.decision === expected.decision, "E_DECISION");
    expect(actual.errorClass === expected.errorClass, "E_ERROR_CLASS");
    expect(traceMatches(actual.trace, expected.trace!), "E_TRACE");
    expect(
      actual.postSnapshotRef === expected.postSnapshotRef,
      "E_POST_SNAPSHOT",
    );
    let observedRoots = snapshot.roots;
    if (snapshot.state !== undefined) {
      const sourceFixtureRef = string(
        snapshot.sourceFixtureRef,
        "E_SNAPSHOT_SOURCE",
      );
      const sourceFixture = array(
        object(authority.authority, "E_AUTHORITY_BODY").fixtureCatalog,
        "E_FIXTURES",
      )
        .map((item) => object(item, "E_FIXTURE"))
        .find((item) => item.id === sourceFixtureRef);
      expect(sourceFixture !== undefined, "E_SNAPSHOT_SOURCE");
      const baseRef = completionSnapshot(sourceFixture).ref;
      const baseSnapshot = snapshots.find((item) => item.id === baseRef);
      expect(baseSnapshot !== undefined, "E_SNAPSHOT_SOURCE");
      observedRoots = baseSnapshot.roots;
    }
    expect(
      equalJson(
        object(observedRoots, "E_ROOTS"),
        object(expected.roots, "E_ROOTS"),
      ),
      "E_ROOTS",
    );
    const counts = object(expected.counts, "E_COUNTS");
    expect(actual.writes === counts.writes, "E_WRITES");
    expect(actual.consumers === counts.consumers, "E_CONSUMERS");
    expect(expected.consumerGate === "closed", "E_CONSUMER_GATE");
    return true;
  } catch {
    return false;
  }
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

export const executeV11Corpus = async (
  authorityValue: unknown,
  conformanceValue: unknown,
): Promise<V11ExecutionReport> => {
  const authority = object(authorityValue, "E_AUTHORITY_ROOT");
  const conformance = object(conformanceValue, "E_CONFORMANCE_ROOT");
  preflight(authority, conformance);
  validateSqlite(authority);
  const body = object(authority.authority, "E_AUTHORITY_BODY");
  const caseCatalog = object(body.caseCatalog, "E_CASE_CATALOG");
  const cases = Object.values(caseCatalog).map((item) =>
    object(item, "E_CASE"),
  );
  let passed = 0;
  for (const caseValue of cases) {
    if (casePasses(authority, caseValue)) passed += 1;
  }

  const mutants = array(body.mutantCatalog, "E_MUTANTS")
    .map((item) => object(item, "E_MUTANT"))
    .filter((item) => item.phase === "a0");
  let killed = 0;
  let uncovered = 0;
  for (const mutant of mutants) {
    const killers = array(mutant.killerCaseIds, "E_KILLERS").map(String);
    if (killers.length === 0) {
      uncovered += 1;
      continue;
    }
    let mutantKilled = false;
    try {
      const clone = structuredClone(authority);
      const target = getPointer(
        clone,
        string(mutant.targetPointer, "E_MUTANT_POINTER"),
      );
      const patched = applyPatch(
        target,
        patchOperations(mutant.patch!, "E_MUTANT_PATCH"),
      );
      const { parent, token } = parentAndToken(
        clone,
        string(mutant.targetPointer, "E_MUTANT_POINTER"),
      );
      if (Array.isArray(parent)) parent[Number(token)] = patched;
      else object(parent, "E_MUTANT_POINTER")[token] = patched;
      preflight(clone, conformance);
      const mutantCases = object(
        object(clone.authority, "E_AUTHORITY_BODY").caseCatalog,
        "E_CASE_CATALOG",
      );
      mutantKilled = killers.some((id) => {
        const mutantCase = object(mutantCases[id], `E_KILLER:${id}`);
        const originalCase = object(caseCatalog[id], `E_KILLER:${id}`);
        try {
          const actual = executeCase(clone, mutantCase);
          const expected = object(originalCase.expected, "E_EXPECTED");
          return (
            actual.decision !== expected.decision ||
            actual.errorClass !== expected.errorClass ||
            !traceMatches(actual.trace, expected.trace!) ||
            actual.postSnapshotRef !== expected.postSnapshotRef
          );
        } catch {
          return true;
        }
      });
    } catch {
      mutantKilled = true;
    }
    if (mutantKilled) killed += 1;
  }

  return {
    selected: cases.length,
    passed,
    failed: cases.length - passed,
    skipped: 0,
    mutantsSelected: mutants.length,
    mutantsKilled: killed,
    mutantsSurvived: mutants.length - killed,
    mutantsSkipped: 0,
    uncovered,
  };
};
