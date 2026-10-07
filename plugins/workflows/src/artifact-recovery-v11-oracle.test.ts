import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { TextDecoder } from "node:util";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";

const authorityUrl = new URL(
  "../../../apps/server/src/services/plugins/migration-authorities/workflows-artifact-review-recovery-v11.json",
  import.meta.url,
);
const schemaUrl = new URL(
  "./artifact-recovery-v11-oracle-dsl.schema.json",
  import.meta.url,
);
const conformanceUrl = new URL(
  "./artifact-recovery-v11-runner-conformance.json",
  import.meta.url,
);
const interpreterUrl = new URL(
  "./artifact-recovery-v11-reference-interpreter.ts",
  import.meta.url,
);

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

type PatchOperation = Readonly<{
  op: "add" | "replace" | "remove";
  path: string;
  value?: JsonValue;
}>;

type DigestEntry = Readonly<{
  id: string;
  domain: string;
  hashAlgorithm: "sha256";
  canonicalizationVersion: "bb-cjson-2";
  payloadPointers: string[];
  omitPointers: string[];
  inclusionRule: string;
  orderingRule: string;
  framingEncoding: string;
  payloadByteLength: number;
  preimageByteLength: number;
  expectedSha256: string;
  dependsOn: string[];
}>;

type CorpusCase = Readonly<{
  id: string;
  category: string;
  fixtureRef: string;
  setupPatch?: PatchOperation[];
  program: ReadonlyArray<JsonObject & Readonly<{ op: string }>>;
  expected: Readonly<{
    decision: string;
    errorClass: string | null;
    trace: string[];
    preSnapshotRef: string;
    postSnapshotRef: string;
    roots: Record<string, string>;
    counts: { writes: number; consumers: number };
    consumerGate: string;
  }>;
}>;

type Mutant = Readonly<{
  id: string;
  category: string;
  targetId: string;
  targetOwner: string;
  phase: "a0" | "v3-construction";
  arm: "reference" | "production" | "fake";
  semanticClass: string;
  intendedSemanticField: string;
  targetPointer: string;
  patch: PatchOperation[];
  killerCaseIds: string[];
  obligationId: string;
}>;

const authorityBytes = readFileSync(authorityUrl);
const authorityText = authorityBytes.toString("utf8");
const schemaText = readFileSync(schemaUrl, "utf8");
const conformanceText = readFileSync(conformanceUrl, "utf8");
const authority = JSON.parse(authorityText) as JsonObject;
const schema = JSON.parse(schemaText) as JsonObject;
const conformance = JSON.parse(conformanceText) as JsonObject;

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

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
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error("E_NONCANONICAL_NUMBER");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const members = Object.keys(value)
    .sort(compareUnicodeScalars)
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key]!)}`);
  return `{${members.join(",")}}`;
};

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
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      const character = text[cursor];
      if (character === '"') {
        cursor += 1;
        const decoded = JSON.parse(text.slice(start, cursor)) as string;
        assertUnicodeScalars(decoded);
        return decoded;
      }
      if (character === "\\") {
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
    const token = match[0];
    const number = Number(token);
    if (!Number.isSafeInteger(number) || Object.is(number, -0)) {
      throw new Error("E_NONCANONICAL_NUMBER");
    }
    cursor += token.length;
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
    if (
      value !== null &&
      typeof value === "object" &&
      Object.hasOwn(value, token)
    ) {
      return value[token]!;
    }
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
  const tokenized = pointers.map((pointer) => decodePointer(pointer));
  for (let left = 0; left < tokenized.length; left += 1) {
    for (let right = left + 1; right < tokenized.length; right += 1) {
      const a = tokenized[left]!;
      const b = tokenized[right]!;
      const shared = Math.min(a.length, b.length);
      if (a.slice(0, shared).every((token, index) => token === b[index])) {
        throw new Error("E_POINTER_OVERLAP");
      }
    }
  }
};

const applyPatch = (
  document: JsonValue,
  operations: ReadonlyArray<PatchOperation>,
): JsonValue => {
  const result = structuredClone(document);
  assertNoOverlaps(operations.map(({ path }) => path));
  for (const operation of operations) {
    if (!["add", "replace", "remove"].includes(operation.op)) {
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
        if (index > parent.length) throw new Error("E_PATCH_RANGE");
        parent.splice(index, 0, structuredClone(operation.value!));
      } else {
        if (index >= parent.length) throw new Error("E_PATCH_RANGE");
        if (operation.op === "remove") parent.splice(index, 1);
        else parent[index] = structuredClone(operation.value!);
      }
    } else if (parent !== null && typeof parent === "object") {
      if (operation.op !== "add" && !Object.hasOwn(parent, token)) {
        throw new Error("E_PATCH_MEMBER");
      }
      if (operation.op === "remove") delete parent[token];
      else parent[token] = structuredClone(operation.value!);
    } else {
      throw new Error("E_PATCH_PARENT");
    }
  }
  return result;
};

const removePointer = (document: JsonValue, pointer: string): void => {
  const { parent, token } = parentAndToken(document, pointer);
  if (Array.isArray(parent)) parent.splice(Number(token), 1);
  else if (parent !== null && typeof parent === "object") delete parent[token];
  else throw new Error("E_PATCH_PARENT");
};

const diffPaths = (left: JsonValue, right: JsonValue, path = ""): string[] => {
  if (canonicalize(left) === canonicalize(right)) return [];
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return [path];
  }
  const leftRecord = left as JsonObject;
  const rightRecord = right as JsonObject;
  const keys = [
    ...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]),
  ];
  return keys.flatMap((key) => {
    const child = `${path}/${escapePointerToken(key)}`;
    if (!Object.hasOwn(leftRecord, key) || !Object.hasOwn(rightRecord, key)) {
      return [child];
    }
    return diffPaths(leftRecord[key]!, rightRecord[key]!, child);
  });
};

const body = authority.authority as JsonObject;
// The raw duplicate-key gate and Ajv schema admission below are the runtime
// boundary for this committed JSON fixture; the cast only exposes that admitted
// shape to TypeScript's test helpers.
const caseCatalog = body.caseCatalog as unknown as Record<string, CorpusCase>;
const cases = Object.values(caseCatalog);
const mutants = body.mutantCatalog as unknown as Mutant[];

describe("V11 four-file owner candidate", () => {
  it("admits strict UTF-8 JSON, rejects duplicate keys before parsing, and validates the closed schema", () => {
    expect(parseRawJson(authorityBytes)).toEqual(authority);
    const rawVectors = conformance.rawAdmissionVectors as JsonObject;
    for (const vector of rawVectors.accepted as JsonObject[]) {
      expect(() =>
        parseRawJson(Buffer.from(vector.utf8Hex as string, "hex")),
      ).not.toThrow();
    }
    for (const vector of rawVectors.rejected as JsonObject[]) {
      expect(() =>
        parseRawJson(Buffer.from(vector.utf8Hex as string, "hex")),
      ).toThrow(vector.error as string);
    }

    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(schema);
    expect(validate(authority), JSON.stringify(validate.errors)).toBe(true);

    const invalidAuthorities: JsonObject[] = [];
    const extraRoot = structuredClone(authority);
    extraRoot.unknown = true;
    invalidAuthorities.push(extraRoot);

    const missingRoot = structuredClone(authority);
    delete missingRoot.authorityId;
    invalidAuthorities.push(missingRoot);

    const firstKey = Object.keys(caseCatalog)[0]!;
    const unknownOpcode = structuredClone(authority);
    ((unknownOpcode.authority as JsonObject).caseCatalog as JsonObject)[
      firstKey
    ] = structuredClone(caseCatalog[firstKey] as unknown as JsonValue);
    (
      (
        ((unknownOpcode.authority as JsonObject).caseCatalog as JsonObject)[
          firstKey
        ] as JsonObject
      ).program as JsonObject[]
    )[0]!.op = "unknownOpcode";
    invalidAuthorities.push(unknownOpcode);

    for (const [field, value] of [
      ["targetOwner", "unknown-owner"],
      ["phase", "unknown-phase"],
      ["arm", "unknown-arm"],
      ["semanticClass", "unknown-class"],
    ] as const) {
      const invalid = structuredClone(authority);
      ((invalid.authority as JsonObject).mutantCatalog as JsonObject[])[0]![
        field
      ] = value;
      invalidAuthorities.push(invalid);
    }

    const snapshotOperand = structuredClone(authority);
    const snapshotCase = Object.values(
      (snapshotOperand.authority as JsonObject).caseCatalog as JsonObject,
    ).find((item) =>
      ((item as JsonObject).program as JsonObject[]).some(
        (operation) => operation.op === "assertExpectedSnapshot",
      ),
    ) as JsonObject;
    const snapshotOperation = (snapshotCase.program as JsonObject[]).find(
      (operation) => operation.op === "assertExpectedSnapshot",
    )!;
    snapshotOperation.snapshotRef = "forbidden";
    invalidAuthorities.push(snapshotOperand);

    const digestDomain = structuredClone(authority);
    (
      (digestDomain.digestCatalog as JsonObject)[
        "migration-vector"
      ] as JsonObject
    ).domain = "unknown-domain";
    invalidAuthorities.push(digestDomain);

    for (const invalid of invalidAuthorities) {
      expect(validate(invalid)).toBe(false);
    }

    const visitSchema = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (record.type === "object") {
        expect(record.additionalProperties).toBe(false);
        expect(record.required).toEqual(
          Object.keys(record.properties as Record<string, unknown>).sort(
            compareUnicodeScalars,
          ),
        );
      }
      for (const value of Object.values(record)) visitSchema(value);
    };
    visitSchema(schema);
  });

  it("resolves all keyed RFC 6901 targets uniquely with exact target identity", () => {
    const pointers = mutants.map(({ targetPointer }) => targetPointer);
    expect(pointers).toHaveLength(179);
    expect(new Set(pointers).size).toBe(179);
    expect(() => assertNoOverlaps(pointers)).not.toThrow();

    for (const mutant of mutants) {
      expect(mutant.targetPointer).not.toContain("*");
      expect(mutant.targetPointer).not.toMatch(/\/(?:0|[1-9][0-9]*)(?:\/|$)/u);
      const target = getPointer(authority, mutant.targetPointer) as JsonObject;
      expect(target.id, mutant.id).toBe(mutant.targetId);
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
      expect(mutant.targetOwner, mutant.id).toBe(
        mutant.semanticClass === "adapter"
          ? `${mutant.arm}-adapter`
          : ownerByClass[mutant.semanticClass],
      );
      expect(mutant.phase === "a0" ? mutant.arm : mutant.semanticClass).toBe(
        mutant.phase === "a0" ? "reference" : "adapter",
      );
    }

    const pointerVectors = conformance.pointerVectors as JsonObject;
    for (const vector of pointerVectors.accepted as JsonObject[]) {
      const target = getPointer(
        vector.document as JsonValue,
        vector.pointer as string,
      ) as JsonObject;
      expect(target.id).toBe(vector.targetId);
    }
    for (const vector of pointerVectors.rejected as JsonObject[]) {
      const error = vector.error as string;
      if (error === "E_POINTER_OVERLAP") {
        expect(() => assertNoOverlaps(vector.pointers as string[])).toThrow(
          error,
        );
      } else if (error === "E_TARGET_ID") {
        const target = getPointer(
          { a: { id: "actual" } },
          vector.pointer as string,
        ) as JsonObject;
        expect(() => {
          if (target.id !== vector.targetId) throw new Error("E_TARGET_ID");
        }).toThrow(error);
      } else if (error === "E_POINTER_DOMAIN") {
        expect(() => {
          if (
            !(vector.pointer as string).startsWith("/authority/caseCatalog/")
          ) {
            throw new Error("E_POINTER_DOMAIN");
          }
        }).toThrow(error);
      } else {
        const document: JsonValue =
          error === "E_POINTER_ARRAY" ? { items: [0] } : {};
        expect(() => getPointer(document, vector.pointer as string)).toThrow(
          error,
        );
      }
    }
  });

  it("admits exact JSON Patch operations and rejects no-op, overlap, wildcard, and multi-field mutations", () => {
    for (const mutant of mutants) {
      expect(mutant.patch).toHaveLength(1);
      expect(mutant.patch[0]!.path).toBe(`/${mutant.intendedSemanticField}`);
      if (mutant.phase === "a0") {
        expect(mutant.targetPointer).not.toContain("/expected");
        expect(mutant.patch[0]!.path).not.toContain("/expected");
      }
      const target = getPointer(authority, mutant.targetPointer);
      const patched = applyPatch(target, mutant.patch);
      expect(diffPaths(target, patched), mutant.id).toEqual([
        `/${mutant.intendedSemanticField}`,
      ]);
    }

    const vectors = conformance.patchVectors as JsonObject;
    for (const vector of vectors.accepted as JsonObject[]) {
      expect(
        applyPatch(
          vector.document as JsonValue,
          vector.patch as unknown as PatchOperation[],
        ),
      ).toEqual(vector.result);
    }
    for (const vector of vectors.rejected as JsonObject[]) {
      expect(() => {
        const before = vector.document as JsonValue;
        const after = applyPatch(
          before,
          vector.patch as unknown as PatchOperation[],
        );
        const changed = diffPaths(before, after);
        if (changed.length === 0) throw new Error("E_PATCH_NO_EFFECT");
        const semanticField = `/${escapePointerToken(vector.semanticField as string)}`;
        if (changed.some((path) => path !== semanticField)) {
          throw new Error("E_PATCH_SEMANTIC_FIELD");
        }
      }).toThrow(vector.error as string);
    }
  });

  it("closes every literal fixture, operandless snapshot assertion, and patched corruption snapshot", () => {
    const fixtures = body.fixtureCatalog as JsonObject[];
    const snapshots = body.snapshotCatalog as JsonObject[];
    const fixtureById = new Map(
      fixtures.map((fixture) => [fixture.id as string, fixture]),
    );
    const snapshotById = new Map(
      snapshots.map((snapshot) => [snapshot.id as string, snapshot]),
    );
    expect(new Set(fixtures.map(({ id }) => id)).size).toBe(fixtures.length);
    expect(new Set(snapshots.map(({ id }) => id)).size).toBe(snapshots.length);

    for (const item of cases) {
      expect(fixtureById.has(item.fixtureRef), item.id).toBe(true);
      expect(snapshotById.has(item.expected.preSnapshotRef), item.id).toBe(
        true,
      );
      expect(snapshotById.has(item.expected.postSnapshotRef), item.id).toBe(
        true,
      );
      expect(item.expected.trace.length, item.id).toBeGreaterThan(0);
      expect(item.expected.consumerGate, item.id).toBe("closed");
      const assertions = item.program.filter(
        ({ op }) => op === "assertExpectedSnapshot",
      );
      for (const assertion of assertions) {
        expect(assertion, item.id).toEqual({ op: "assertExpectedSnapshot" });
      }
      expect(
        item.program.some(({ op }) => op === "assertSnapshot"),
        item.id,
      ).toBe(false);
    }

    const corruptionCases = cases.filter(
      ({ category }) => category === "corruption",
    );
    expect(corruptionCases).toHaveLength(15);
    for (const item of corruptionCases) {
      expect(item.setupPatch, item.id).toHaveLength(1);
      expect(
        item.program.filter(({ op }) => op === "assertExpectedSnapshot"),
        item.id,
      ).toEqual([{ op: "assertExpectedSnapshot" }]);
      const fixture = fixtureById.get(item.fixtureRef)!;
      const independentlyMaterialized = applyPatch(fixture, item.setupPatch!);
      const pre = snapshotById.get(item.expected.preSnapshotRef)!;
      const post = snapshotById.get(item.expected.postSnapshotRef)!;
      expect(pre.sourceFixtureRef, item.id).toBe(item.fixtureRef);
      expect(pre.state, item.id).toEqual(independentlyMaterialized);
      expect(post, item.id).toEqual(pre);
      expect(item.expected.preSnapshotRef, item.id).toBe(
        item.expected.postSnapshotRef,
      );
      expect(item.expected.counts.writes, item.id).toBe(0);
    }
  });

  it("recomputes the fresh self-reference-free V11 digest DAG with exact selectors and framing", () => {
    const digestCatalog = authority.digestCatalog as unknown as Record<
      string,
      DigestEntry
    >;
    const digestOrder = authority.digestOrder as string[];
    const entries = digestOrder.map((id) => digestCatalog[id]!);
    expect(entries).toHaveLength(9);
    expect(Object.keys(digestCatalog).sort(compareUnicodeScalars)).toEqual(
      [...digestOrder].sort(compareUnicodeScalars),
    );
    const seenIds = new Set<string>();
    const seenDomains = new Set<string>();
    for (const entry of entries) {
      expect(entry.domain).toMatch(/^bb\.artifact-review\.v11\.digest\./u);
      expect(entry.domain).not.toContain(".v10.");
      expect(entry.hashAlgorithm).toBe("sha256");
      expect(entry.canonicalizationVersion).toBe("bb-cjson-2");
      expect(entry.framingEncoding).toBe("utf8-domain+nul+bb-cjson-2-payload");
      expect(seenIds.has(entry.id)).toBe(false);
      expect(seenDomains.has(entry.domain)).toBe(false);
      for (const dependency of entry.dependsOn) {
        expect(seenIds.has(dependency), entry.id).toBe(true);
      }
      seenIds.add(entry.id);
      seenDomains.add(entry.domain);

      const selectedDocument = structuredClone(authority) as JsonValue;
      for (const pointer of [...entry.omitPointers].sort(
        (left, right) => right.length - left.length,
      )) {
        removePointer(selectedDocument, pointer);
      }
      const payload = entry.payloadPointers.map((pointer) => ({
        pointer,
        value:
          pointer === ""
            ? selectedDocument
            : getPointer(selectedDocument, pointer),
      })) as JsonValue;
      const payloadBytes = Buffer.from(canonicalize(payload), "utf8");
      const preimage = Buffer.concat([
        Buffer.from(entry.domain, "utf8"),
        Buffer.from([0]),
        payloadBytes,
      ]);
      expect(payloadBytes.byteLength, entry.id).toBe(entry.payloadByteLength);
      expect(preimage.byteLength, entry.id).toBe(entry.preimageByteLength);
      expect(sha256(preimage), entry.id).toBe(entry.expectedSha256);
    }
    expect(entries[4]?.payloadPointers).toEqual(["/authority/caseCatalog"]);
    expect(entries[7]?.payloadPointers).toEqual([""]);
    expect(entries[7]?.omitPointers).toEqual(["/digestCatalog"]);
    expect(entries[8]?.dependsOn).toEqual(
      entries.slice(0, 8).map(({ id }) => id),
    );
  });

  it("preserves migrations 0..22, exact SQLite normalization, counts, and the mutation-obligation bijection", () => {
    const migrations = body.migrationCatalog as JsonObject[];
    expect(migrations.map(({ id }) => id)).toEqual(
      Array.from({ length: 23 }, (_, id) => id),
    );
    for (const migration of migrations) {
      expect(Buffer.byteLength(migration.statementUtf8 as string)).toBe(
        migration.byteLength,
      );
      expect(sha256(migration.statementUtf8 as string)).toBe(migration.sha256);
    }
    const vector = body.migrationVectorIdentity as JsonObject;
    const canonicalVector = migrations
      .map(({ id, sha256: statementSha256 }) => `${id}:${statementSha256}`)
      .join(";");
    expect(vector.value).toBe(canonicalVector);
    expect(vector.byteLength).toBe(1553);
    expect(vector.sha256).toBe(
      "2d4aa4a4dc215e4a3c51e763dfde370cf2a33741130f7ec3d2082c334251ec7c",
    );
    expect(sha256(canonicalVector)).toBe(vector.sha256);

    const normalization = body.sqliteNormalization as JsonObject;
    expect((normalization.package as JsonObject).name).toBe("better-sqlite3");
    expect((normalization.package as JsonObject).version).toBe("12.10.0");
    expect((normalization.engine as JsonObject).sqliteVersion).toBe("3.53.1");
    expect((normalization.engine as JsonObject).sqliteSourceId).toBe(
      "2026-05-05 10:34:17 c88b22011a54b4f6fbd149e9f8e4de77658ce58143a1af0e3785e4e6475127e9",
    );
    expect(normalization.absentEncoding as JsonObject).toEqual({
      present: false,
      records: [],
      recordCount: 0,
    });
    expect(
      (normalization.schemaStates as JsonObject[]).map(({ id }) => id),
    ).toEqual(["pre18", "post18"]);

    const coverage = body.coverage as JsonObject;
    const obligations = coverage.obligations as JsonObject[];
    expect(cases).toHaveLength(179);
    expect(mutants).toHaveLength(179);
    expect(obligations).toHaveLength(179);
    expect(new Set(cases.map(({ id }) => id)).size).toBe(179);
    expect(new Set(mutants.map(({ id }) => id)).size).toBe(179);
    expect(new Set(obligations.map(({ id }) => id)).size).toBe(179);

    const obligationById = new Map(
      obligations.map((obligation) => [obligation.id as string, obligation]),
    );
    const mutantByObligation = new Map<string, Mutant[]>();
    for (const mutant of mutants) {
      mutantByObligation.set(mutant.obligationId, [
        ...(mutantByObligation.get(mutant.obligationId) ?? []),
        mutant,
      ]);
      const obligation = obligationById.get(mutant.obligationId)!;
      expect(obligation.mutantId, mutant.id).toBe(mutant.id);
      expect(obligation.primaryCaseId, mutant.id).toBe(mutant.killerCaseIds[0]);
      expect(obligation.killerCaseIds, mutant.id).toEqual(mutant.killerCaseIds);
      expect(obligation.targetId, mutant.id).toBe(mutant.targetId);
      expect(obligation.targetOwner, mutant.id).toBe(mutant.targetOwner);
      expect(obligation.phase, mutant.id).toBe(mutant.phase);
      expect(obligation.arm, mutant.id).toBe(mutant.arm);
      expect(obligation.semanticClass, mutant.id).toBe(mutant.semanticClass);
      expect(
        caseCatalog[mutant.killerCaseIds[0]!] !== undefined,
        mutant.id,
      ).toBe(true);
    }
    for (const obligation of obligations) {
      expect(mutantByObligation.get(obligation.id as string)).toHaveLength(1);
    }

    const byCategory = Object.fromEntries(
      [...new Set(cases.map(({ category }) => category))]
        .sort(compareUnicodeScalars)
        .map((category) => [
          category,
          cases.filter((item) => item.category === category).length,
        ]),
    );
    expect(byCategory).toEqual({
      collision: 57,
      corruption: 15,
      darkness: 6,
      divergence: 9,
      edge: 24,
      fault: 40,
      parity: 3,
      restart: 9,
      state: 16,
    });
    expect(coverage.expectedExpandedCounts as JsonObject).toEqual({
      byCategory,
      total: 179,
    });

    const a0Mutants = mutants.filter(({ phase }) => phase === "a0");
    const constructionMutants = mutants.filter(
      ({ phase }) => phase === "v3-construction",
    );
    expect(a0Mutants).toHaveLength(173);
    expect(constructionMutants).toHaveLength(6);
    expect(a0Mutants.every(({ arm }) => arm === "reference")).toBe(true);
    expect(
      constructionMutants.filter(({ arm }) => arm === "production"),
    ).toHaveLength(3);
    expect(
      constructionMutants.filter(({ arm }) => arm === "fake"),
    ).toHaveLength(3);

    const inventory = coverage.semanticInventory as JsonObject;
    for (const semanticClass of inventory.requiredA0SemanticClasses as string[]) {
      expect(
        a0Mutants.filter((mutant) => mutant.semanticClass === semanticClass)
          .length,
        semanticClass,
      ).toBeGreaterThan(0);
    }
  });

  it("freezes six concrete adapter-owned construction reds and keeps feature delivery dark", () => {
    const sentinels = conformance.constructionSentinels as JsonObject[];
    expect(sentinels).toHaveLength(6);
    expect(sentinels.filter(({ arm }) => arm === "production")).toHaveLength(3);
    expect(sentinels.filter(({ arm }) => arm === "fake")).toHaveLength(3);
    for (const sentinel of sentinels) {
      expect(sentinel.a0Disposition).toBe("construction-gated-by-phase");
      expect(sentinel.failingArmCount).toBe(1);
      const target = sentinel.adapterTarget as JsonObject;
      expect(target.path).toBeTypeOf("string");
      expect(target.symbol).toBeTypeOf("string");
      expect(
        existsSync(
          new URL(`../../../${target.path as string}`, import.meta.url),
        ),
        target.path as string,
      ).toBe(false);
    }
    const contract = authority.contract as JsonObject;
    expect(contract.architectureRevision).toBe(2);
    expect(contract.contractId).toBe("bb-artifact-review-service:revision-1");
    expect(contract.authorityScope).toBe("local-owner-origin-derived");
    expect(contract.presentationScope).toBe("grant-only");
    expect(contract.durability).toBe("committed-only");
    expect(contract.retention).toBe("append-only");
    expect(contract.rollout).toBe("dark");

    expect(authorityText).not.toMatch(
      /\b(?:TODO|TBD|FIXME|PLACEHOLDER|LOREM)\b/iu,
    );
    expect(authorityText).not.toContain("fromProduction");
    expect(authorityText).not.toContain("deriveExpected");
    expect(authorityText).not.toContain("filesystemScan");
    expect(authorityText).not.toContain("Math.random");
    expect(authorityText).not.toContain("Date.now");
    expect(authorityText).not.toContain("localeCompare");
    expect(authorityText).not.toContain('"op": "assertSnapshot"');
    expect(schemaText.endsWith("\n")).toBe(true);
    expect(conformanceText.endsWith("\n")).toBe(true);
  });
});

describe("V11 five-file A0 execution boundary", () => {
  it("executes all cases and exactly the A0 mutants through the separately owned generic interpreter", async () => {
    expect(existsSync(interpreterUrl), "E_REFERENCE_INTERPRETER_REQUIRED").toBe(
      true,
    );
    const interpreterSource = readFileSync(interpreterUrl, "utf8");
    const boundary = conformance.interpreterBoundary as JsonObject;
    for (const forbiddenImport of boundary.forbiddenImports as string[]) {
      expect(interpreterSource).not.toContain(forbiddenImport);
    }
    const modulePath = "./artifact-recovery-v11-reference-interpreter.js";
    const interpreter = (await import(/* @vite-ignore */ modulePath)) as {
      validateV11Authority: (
        authorityValue: unknown,
        schemaValue: unknown,
        conformanceValue: unknown,
      ) => { ok: boolean; errors: string[] };
      executeV11Corpus: (
        authorityValue: unknown,
        conformanceValue: unknown,
      ) => Promise<{
        selected: number;
        passed: number;
        failed: number;
        skipped: number;
        mutantsSelected: number;
        mutantsKilled: number;
        mutantsSurvived: number;
        mutantsSkipped: number;
        uncovered: number;
      }>;
    };
    expect(
      interpreter.validateV11Authority(authority, schema, conformance),
    ).toEqual({ ok: true, errors: [] });
    const report = await interpreter.executeV11Corpus(authority, conformance);
    const expected = conformance.requiredReport as JsonObject;
    expect(report).toEqual({
      selected: expected.selected,
      passed: expected.passed,
      failed: 0,
      skipped: 0,
      mutantsSelected: expected.a0MutantsSelected,
      mutantsKilled: expected.a0MutantsKilled,
      mutantsSurvived: 0,
      mutantsSkipped: 0,
      uncovered: 0,
    });
  });
});
