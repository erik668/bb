import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";

const authorityUrl = new URL(
  "../../../apps/server/src/services/plugins/migration-authorities/workflows-artifact-review-recovery-v10.json",
  import.meta.url,
);
const schemaUrl = new URL(
  "./artifact-recovery-v10-oracle-dsl.schema.json",
  import.meta.url,
);
const conformanceUrl = new URL(
  "./artifact-recovery-v10-runner-conformance.json",
  import.meta.url,
);
const interpreterUrl = new URL(
  "./artifact-recovery-v10-reference-interpreter.ts",
  import.meta.url,
);

const authorityText = readFileSync(authorityUrl, "utf8");
const schemaText = readFileSync(schemaUrl, "utf8");
const conformanceText = readFileSync(conformanceUrl, "utf8");
const authority = JSON.parse(authorityText) as Record<string, unknown>;
const schema = JSON.parse(schemaText) as Record<string, unknown>;
const conformance = JSON.parse(conformanceText) as Record<string, unknown>;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

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
  program: ReadonlyArray<Readonly<{ op: string }>>;
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

const decodePointer = (pointer: string): string[] => {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`E_POINTER:${pointer}`);
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
};

const getPointer = (document: JsonValue, pointer: string): JsonValue =>
  decodePointer(pointer).reduce<JsonValue>((value, token) => {
    if (Array.isArray(value)) return value[Number(token)]!;
    if (value !== null && typeof value === "object") return value[token]!;
    throw new Error(`E_UNRESOLVED_POINTER:${pointer}`);
  }, document);

const removePointer = (document: JsonValue, pointer: string): void => {
  const tokens = decodePointer(pointer);
  const finalToken = tokens.pop();
  if (finalToken === undefined) throw new Error("E_CANNOT_REMOVE_ROOT");
  const parent = tokens.reduce<JsonValue>((value, token) => {
    if (Array.isArray(value)) return value[Number(token)]!;
    if (value !== null && typeof value === "object") return value[token]!;
    throw new Error(`E_UNRESOLVED_POINTER:${pointer}`);
  }, document);
  if (Array.isArray(parent)) parent.splice(Number(finalToken), 1);
  else if (parent !== null && typeof parent === "object") delete parent[finalToken];
  else throw new Error(`E_UNRESOLVED_POINTER:${pointer}`);
};

const body = authority.authority as Record<string, unknown>;
const caseCollections = [
  "stateCases",
  "collisionCases",
  "edgeCases",
  "parityCases",
  "restartCases",
  "corruptionCases",
  "faultCases",
  "divergenceCases",
  "darknessCases",
] as const;
const cases = caseCollections.flatMap(
  (key) => body[key] as unknown as CorpusCase[],
);

describe("V10 four-file owner candidate", () => {
  it("validates the canonical authority against the closed DSL schema", () => {
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(schema);
    expect(validate(authority), JSON.stringify(validate.errors)).toBe(true);
    expect(Object.keys(authority).sort()).toEqual(
      [
        "authority",
        "authorityId",
        "contract",
        "digestCatalog",
        "legacyEvidence",
        "predecessorAuthorityId",
        "schemaVersion",
      ].sort(),
    );
    const visit = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (record.type === "object") {
        expect(record.additionalProperties).toBe(false);
        expect(record.required).toEqual(
          Object.keys(record.properties as Record<string, unknown>),
        );
      }
      for (const value of Object.values(record)) visit(value);
    };
    visit(schema);
  });

  it("recomputes every self-reference-free digest with exact framing and topology", () => {
    const entries = authority.digestCatalog as unknown as DigestEntry[];
    const seenIds = new Set<string>();
    const seenDomains = new Set<string>();
    for (const entry of entries) {
      expect(entry.hashAlgorithm).toBe("sha256");
      expect(entry.canonicalizationVersion).toBe("bb-cjson-2");
      expect(entry.framingEncoding).toBe(
        "utf8-domain+nul+bb-cjson-2-payload",
      );
      expect(seenIds.has(entry.id)).toBe(false);
      expect(seenDomains.has(entry.domain)).toBe(false);
      for (const dependency of entry.dependsOn) expect(seenIds.has(dependency)).toBe(true);
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
        value: pointer === "" ? selectedDocument : getPointer(selectedDocument, pointer),
      })) as JsonValue;
      const payloadBytes = Buffer.from(canonicalize(payload), "utf8");
      const preimage = Buffer.concat([
        Buffer.from(entry.domain, "utf8"),
        Buffer.from([0]),
        payloadBytes,
      ]);
      expect(payloadBytes.byteLength).toBe(entry.payloadByteLength);
      expect(preimage.byteLength).toBe(entry.preimageByteLength);
      expect(sha256(preimage)).toBe(entry.expectedSha256);
    }
    const authorityBody = entries.find((entry) => entry.id === "authority-body");
    expect(authorityBody?.payloadPointers).toEqual([""]);
    expect(authorityBody?.omitPointers).toEqual(["/digestCatalog"]);
    expect(entries.at(-1)?.id).toBe("contract-root");
  });

  it("binds exact migration bytes, SQLite records, literal cases, and coverage bijection", () => {
    const migrations = body.migrationCatalog as Array<{
      id: number;
      byteLength: number;
      sha256: string;
      statementUtf8: string;
    }>;
    expect(migrations.map(({ id }) => id)).toEqual(
      Array.from({ length: 23 }, (_, id) => id),
    );
    for (const migration of migrations) {
      expect(Buffer.byteLength(migration.statementUtf8)).toBe(
        migration.byteLength,
      );
      expect(sha256(migration.statementUtf8)).toBe(migration.sha256);
    }
    const migrationVectorIdentity = body.migrationVectorIdentity as {
      encoding: string;
      byteLength: number;
      value: string;
      sha256: string;
    };
    const canonicalVector = migrations
      .map(({ id, sha256: statementSha256 }) => `${id}:${statementSha256}`)
      .join(";");
    expect(migrationVectorIdentity).toEqual({
      encoding: "id-colon-sha256-semicolon-no-terminal",
      byteLength: 1553,
      value: canonicalVector,
      sha256: "2d4aa4a4dc215e4a3c51e763dfde370cf2a33741130f7ec3d2082c334251ec7c",
    });
    expect(Buffer.byteLength(canonicalVector)).toBe(1553);
    expect(sha256(canonicalVector)).toBe(migrationVectorIdentity.sha256);

    const coverage = body.coverage as {
      obligations: Array<{
        id: string;
        category: string;
        primaryCaseId: string;
        mutantIds: string[];
      }>;
      expectedExpandedCounts: {
        byCategory: Record<string, number>;
        total: number;
      };
      expectedMutationCounts: {
        a0: { selected: number; killed: number; survived: number; uncovered: number };
        v3Construction: { selected: number; killed: number; survived: number; uncovered: number };
      };
    };
    const caseIds = cases.map(({ id }) => id);
    const primaryIds = coverage.obligations.map(({ primaryCaseId }) => primaryCaseId);
    expect(new Set(caseIds).size).toBe(caseIds.length);
    expect(new Set(primaryIds).size).toBe(primaryIds.length);
    expect([...primaryIds].sort()).toEqual([...caseIds].sort());
    expect(coverage.expectedExpandedCounts.total).toBe(cases.length);
    const actualByCategory = Object.fromEntries(
      [...new Set(cases.map(({ category }) => category))]
        .sort()
        .map((category) => [
          category,
          cases.filter((item) => item.category === category).length,
        ]),
    );
    expect(coverage.expectedExpandedCounts.byCategory).toEqual(actualByCategory);

    const fixtures = body.fixtureCatalog as Array<{ id: string }>;
    const snapshots = body.snapshotCatalog as Array<{ id: string }>;
    const fixtureIds = new Set(fixtures.map(({ id }) => id));
    const snapshotIds = new Set(snapshots.map(({ id }) => id));
    for (const item of cases) {
      expect(fixtureIds.has(item.fixtureRef), item.id).toBe(true);
      expect(item.program.length, item.id).toBeGreaterThan(0);
      expect(item.expected.trace.length, item.id).toBeGreaterThan(0);
      expect(snapshotIds.has(item.expected.preSnapshotRef), item.id).toBe(true);
      expect(snapshotIds.has(item.expected.postSnapshotRef), item.id).toBe(true);
      expect(item.expected.consumerGate).toBe("closed");
    }

    const mutants = body.mutantCatalog as Array<{
      id: string;
      phase: "a0" | "v3-construction";
      primaryKillerCaseIds: string[];
    }>;
    const mutantIds = new Set(mutants.map(({ id }) => id));
    expect(mutantIds.size).toBe(mutants.length);
    for (const obligation of coverage.obligations) {
      expect(obligation.mutantIds.length).toBeGreaterThan(0);
      for (const mutantId of obligation.mutantIds) expect(mutantIds.has(mutantId)).toBe(true);
    }
    for (const mutant of mutants) {
      expect(mutant.primaryKillerCaseIds.length).toBeGreaterThan(0);
      for (const caseId of mutant.primaryKillerCaseIds) expect(caseIds).toContain(caseId);
    }
    const a0Count = mutants.filter(({ phase }) => phase === "a0").length;
    const v3Count = mutants.filter(({ phase }) => phase === "v3-construction").length;
    expect(coverage.expectedMutationCounts.a0).toEqual({
      selected: a0Count,
      killed: a0Count,
      survived: 0,
      uncovered: 0,
    });
    expect(coverage.expectedMutationCounts.v3Construction).toEqual({
      selected: v3Count,
      killed: v3Count,
      survived: 0,
      uncovered: 0,
    });
  });

  it("contains no placeholder, production-derived expectation, or forbidden operational source", () => {
    expect(authorityText).not.toMatch(/\b(?:TODO|TBD|FIXME|PLACEHOLDER|LOREM)\b/i);
    expect(authorityText).not.toContain("fromProduction");
    expect(authorityText).not.toContain("deriveExpected");
    expect(authorityText).not.toContain("filesystemScan");
    expect(authorityText).not.toContain("Math.random");
    expect(authorityText).not.toContain("Date.now");
    expect(authorityText).not.toContain("localeCompare");
    expect(schemaText.endsWith("\n")).toBe(true);
    expect(conformanceText.endsWith("\n")).toBe(true);
    expect((conformance.interpreterBoundary as { forbiddenImports: string[] }).forbiddenImports).toEqual(
      expect.arrayContaining([
        "./data.js",
        "./artifact-recovery.js",
        "./plugin-api.js",
        "./fake-plugin-host.js",
        "@get-bb/plugin-sdk",
      ]),
    );
  });
});

describe("V10 five-file A0 execution boundary", () => {
  it("executes every frozen case and A0 mutant through the separately owned generic interpreter", async () => {
    expect(existsSync(interpreterUrl), "E_REFERENCE_INTERPRETER_REQUIRED").toBe(true);
    const interpreterSource = readFileSync(interpreterUrl, "utf8");
    const forbiddenImports = (
      conformance.interpreterBoundary as { forbiddenImports: string[] }
    ).forbiddenImports;
    for (const forbiddenImport of forbiddenImports) {
      expect(interpreterSource).not.toContain(forbiddenImport);
    }
    const modulePath = "./artifact-recovery-v10-reference-interpreter.js";
    const interpreter = (await import(/* @vite-ignore */ modulePath)) as {
      validateV10Authority: (
        authorityValue: unknown,
        schemaValue: unknown,
        conformanceValue: unknown,
      ) => { ok: boolean; errors: string[] };
      executeV10Corpus: (
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
        uncovered: number;
      }>;
    };
    expect(interpreter.validateV10Authority(authority, schema, conformance)).toEqual({
      ok: true,
      errors: [],
    });
    const report = await interpreter.executeV10Corpus(authority, conformance);
    const expectedReport = conformance.requiredReport as typeof report & {
      a0MutantsSelected: number;
      a0MutantsKilled: number;
      a0MutantsSurvived: number;
    };
    expect(report).toEqual({
      selected: expectedReport.selected,
      passed: expectedReport.passed,
      failed: 0,
      skipped: 0,
      mutantsSelected: expectedReport.a0MutantsSelected,
      mutantsKilled: expectedReport.a0MutantsKilled,
      mutantsSurvived: 0,
      uncovered: 0,
    });
  });
});
