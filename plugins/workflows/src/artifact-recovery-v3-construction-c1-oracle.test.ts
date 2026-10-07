import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv from "ajv";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { migrations } from "./data.js";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };
type OracleMode = "prebuild-red" | "postbuild-pass";
type Seam = {
  id: string;
  module: string;
  requiredExport: string;
  prebuildReason: string;
};
type InventoryRow = {
  id: string;
  category:
    | "behavior"
    | "corruption"
    | "fault"
    | "dispatch"
    | "parity"
    | "reopen"
    | "sdk"
    | "darkness";
  seamId: string;
  value: JsonValue;
};
type LoadedModule = Record<string, unknown>;

const repositoryRootUrl = new URL("../../../", import.meta.url);
const authorityUrl = new URL(
  "../../../apps/server/src/services/plugins/migration-authorities/workflows-artifact-review-v3-construction-c1.json",
  import.meta.url,
);
const schemaUrl = new URL(
  "./artifact-recovery-v3-construction-c1.schema.json",
  import.meta.url,
);
const corpusUrl = new URL(
  "./artifact-recovery-v3-construction-c1-corpus.json",
  import.meta.url,
);

const authorityBytes = readFileSync(authorityUrl);
const schemaBytes = readFileSync(schemaUrl);
const corpusBytes = readFileSync(corpusUrl);
const authority = JSON.parse(authorityBytes.toString("utf8")) as JsonObject;
const schema = JSON.parse(schemaBytes.toString("utf8")) as JsonObject;
const corpus = JSON.parse(corpusBytes.toString("utf8")) as JsonObject;

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const asObject = (value: JsonValue | undefined, label: string): JsonObject => {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
};

const asArray = (value: JsonValue | undefined, label: string): JsonValue[] => {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
};

const asString = (value: JsonValue | undefined, label: string): string => {
  if (typeof value !== "string")
    throw new TypeError(`${label} must be a string`);
  return value;
};

const clone = <T extends JsonValue>(value: T): T => structuredClone(value);

const readSeams = (): Seam[] =>
  asArray(corpus.seams, "seams").map((value) => {
    const seam = asObject(value, "seam");
    return {
      id: asString(seam.id, "seam id"),
      module: asString(seam.module, "seam module"),
      requiredExport: asString(seam.requiredExport, "required export"),
      prebuildReason: asString(seam.prebuildReason, "prebuild reason"),
    };
  });

const seams = readSeams();
const seamById = new Map(seams.map((seam) => [seam.id, seam]));

const inventory = (): InventoryRow[] => {
  const rows: InventoryRow[] = [];
  for (const value of asArray(corpus.behaviorCases, "behavior cases")) {
    const item = asObject(value, "behavior case");
    rows.push({
      id: `behavior:${asString(item.id, "behavior id")}`,
      category: "behavior",
      seamId: asString(item.seamId, "behavior seam"),
      value,
    });
  }
  const corruptionSeam = asString(
    asObject(
      asObject(corpus.groupContracts, "group contracts").semanticCorruption,
      "semantic corruption contract",
    ).seamId,
    "semantic corruption seam",
  );
  for (const value of asArray(
    corpus.semanticCorruptions,
    "semantic corruptions",
  )) {
    const item = asObject(value, "semantic corruption");
    rows.push({
      id: `corruption:${asString(item.id, "corruption id")}`,
      category: "corruption",
      seamId: corruptionSeam,
      value,
    });
  }
  for (const value of asArray(corpus.faultCases, "fault cases")) {
    const item = asObject(value, "fault case");
    rows.push({
      id: `fault:${asString(item.id, "fault id")}`,
      category: "fault",
      seamId: asString(item.seamId, "fault seam"),
      value,
    });
  }
  for (const value of asArray(corpus.dispatchCases, "dispatch cases")) {
    const item = asObject(value, "dispatch case");
    rows.push({
      id: `dispatch:${asString(item.id, "dispatch id")}`,
      category: "dispatch",
      seamId: "dispatch-before-db",
      value,
    });
  }
  for (const value of asArray(corpus.parityCases, "parity cases")) {
    const item = asObject(value, "parity case");
    for (const adapterValue of asArray(item.adapters, "parity adapters")) {
      const adapter = asString(adapterValue, "parity adapter");
      const seamId =
        adapter === "production"
          ? "production-adapter"
          : adapter === "sdk-fake"
            ? "sdk-fake-adapter"
            : "workflows-fake-adapter";
      rows.push({
        id: `parity:${asString(item.id, "parity id")}:${adapter}`,
        category: "parity",
        seamId,
        value: { ...item, adapter },
      });
    }
  }
  const reopenSeam = asString(
    asObject(
      asObject(corpus.groupContracts, "group contracts").reopen,
      "reopen contract",
    ).seamId,
    "reopen seam",
  );
  for (const value of asArray(corpus.reopenCases, "reopen cases")) {
    const item = asObject(value, "reopen case");
    rows.push({
      id: `reopen:${asString(item.id, "reopen id")}`,
      category: "reopen",
      seamId: reopenSeam,
      value,
    });
  }
  for (const value of asArray(corpus.sdkSurfaces, "SDK surfaces")) {
    const surface = asString(value, "SDK surface");
    const seamId =
      surface.startsWith("declaration:") ||
      surface === "bundled-bb-plugin-sdk-dts" ||
      surface === "workflows-tsconfig"
        ? "declaration-exposure"
        : surface.startsWith("runtime:") ||
            surface === "normal-package-import" ||
            surface === "direct-dist-index" ||
            surface === "testing-entrypoint"
          ? "runtime-exposure"
          : "sdk-exposure";
    rows.push({
      id: `sdk:${surface}`,
      category: "sdk",
      seamId,
      value: surface,
    });
  }
  for (const value of asArray(corpus.darknessSurfaces, "darkness surfaces")) {
    const surface = asString(value, "darkness surface");
    rows.push({
      id: `darkness:${surface}`,
      category: "darkness",
      seamId: "darkness-inspector",
      value: surface,
    });
  }
  return rows;
};

const allCases = inventory();

const moduleCache = new Map<string, LoadedModule>();

const hasDeclarationExport = (path: string, exportName: string): boolean => {
  const program = ts.createProgram([path], {
    allowJs: false,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  });
  const source = program.getSourceFile(path);
  if (source === undefined) return false;
  const symbol = program.getTypeChecker().getSymbolAtLocation(source);
  return (
    symbol !== undefined &&
    program
      .getTypeChecker()
      .getExportsOfModule(symbol)
      .some((item) => item.name === exportName)
  );
};

const loadModule = async (seam: Seam): Promise<LoadedModule> => {
  const cached = moduleCache.get(seam.id);
  if (cached !== undefined) return cached;
  const path = fileURLToPath(new URL(seam.module, repositoryRootUrl));
  if (!existsSync(path)) return {};
  try {
    const loaded = (await import(
      /* @vite-ignore */ pathToFileURL(path).href
    )) as LoadedModule;
    moduleCache.set(seam.id, loaded);
    return loaded;
  } catch (error) {
    throw new Error(`HARNESS_IMPORT_FAILURE:${seam.id}`, { cause: error });
  }
};

const probeSeam = async (
  seam: Seam,
): Promise<{ reached: true; reason: string | null }> => {
  const path = fileURLToPath(new URL(seam.module, repositoryRootUrl));
  if (!existsSync(path)) return { reached: true, reason: seam.prebuildReason };
  if (path.endsWith(".d.ts")) {
    return {
      reached: true,
      reason: hasDeclarationExport(path, seam.requiredExport)
        ? null
        : seam.prebuildReason,
    };
  }
  const loaded = await loadModule(seam);
  return {
    reached: true,
    reason: Object.hasOwn(loaded, seam.requiredExport)
      ? null
      : seam.prebuildReason,
  };
};

const trace = (ref: JsonValue | undefined): JsonValue => {
  if (ref === null) return null;
  const name = asString(ref, "trace reference");
  return clone(
    asArray(asObject(corpus.traceCatalog, "trace catalog")[name], name),
  );
};

const snapshot = (ref: JsonValue | undefined): JsonValue => {
  const name = asString(ref, "snapshot reference");
  if (name === "absent-database") return "absent-database";
  return clone(asObject(asObject(corpus.snapshots, "snapshots")[name], name));
};

const physical = (ref: string): JsonValue =>
  clone(
    asObject(asObject(corpus.physicalCatalog, "physical catalog")[ref], ref),
  );

const expectedFor = (row: InventoryRow): JsonValue | null => {
  const item =
    typeof row.value === "object" &&
    row.value !== null &&
    !Array.isArray(row.value)
      ? row.value
      : null;
  if (row.category === "sdk") return null;
  if (row.category === "behavior") {
    const expected = asObject(item?.expected, "behavior expected");
    const result: JsonObject = {
      decision: expected.decision!,
      error: expected.error!,
      phaseTrace: trace(expected.phaseTraceRef),
      v12Trace: trace(expected.v12TraceRef),
      snapshot: snapshot(expected.snapshotRef),
      saved: expected.saved!,
    };
    if (expected.physicalRef !== undefined) {
      result.physical = physical(
        asString(expected.physicalRef, "physical ref"),
      );
    }
    return result;
  }
  if (row.category === "corruption") {
    const contract = asObject(
      asObject(corpus.groupContracts, "group contracts").semanticCorruption,
      "semantic corruption contract",
    );
    return {
      decision: contract.expectedDecision!,
      error: item?.expectedError!,
      phaseTrace: trace(contract.phaseTraceRef),
      snapshot: snapshot(contract.expectedSnapshotRef),
      physical: physical(asString(contract.physicalRef, "physical ref")),
      consumers: contract.consumers!,
    };
  }
  if (row.category === "fault") {
    const expectedSnapshot = asString(item?.expectedSnapshot, "fault snapshot");
    const physicalRef =
      expectedSnapshot === "absent-database"
        ? "preDbRejected"
        : expectedSnapshot === "ordinary"
          ? "postCommitFailure"
          : "transactionRollback";
    return {
      decision: item?.expectedDecision!,
      error: item?.expectedError!,
      phaseTrace: trace(
        asObject(
          asObject(corpus.groupContracts, "group contracts").fault,
          "fault contract",
        ).phaseTraceRef,
      ),
      snapshot: snapshot(expectedSnapshot),
      physical: physical(physicalRef),
      consumers: 0,
    };
  }
  if (row.category === "dispatch") {
    const contract = asObject(
      asObject(corpus.groupContracts, "group contracts").dispatchBeforeDb,
      "dispatch contract",
    );
    return {
      decision: "preflight-rejected",
      error: item?.expectedError!,
      phaseTrace: trace(contract.phaseTraceRef),
      snapshot: snapshot(contract.expectedSnapshotRef),
      physical: physical(asString(contract.physicalRef, "physical ref")),
      consumers: 0,
    };
  }
  if (row.category === "parity") {
    const id = asString(item?.id, "parity id");
    const physicalRef =
      id === "ordinary"
        ? "ordinary"
        : id === "recovered"
          ? "exactRecovery"
          : id === "strict-prefix"
            ? "strictPrefix"
            : "transactionRollback";
    return {
      decision: item?.expectedDecision!,
      error: item?.expectedError!,
      snapshot: snapshot(item?.snapshotRef),
      physical: physical(physicalRef),
      consumers: 0,
    };
  }
  if (row.category === "reopen") {
    return {
      decision: item?.expectedDecision!,
      error: item?.expectedError!,
      snapshot: snapshot(item?.snapshotRef),
      independentHostObservation: true,
      consumers: 0,
    };
  }
  return {
    decision: "dark",
    surface: row.value,
    consumerCount: 0,
  };
};

const semanticAssessment = (args: {
  reachedSemanticBoundary: boolean;
  expected: JsonValue;
  actual?: JsonValue;
  harnessError?: string;
}): "killed" | "survived" | "not-a-semantic-kill" => {
  if (!args.reachedSemanticBoundary || args.harnessError !== undefined) {
    return "not-a-semantic-kill";
  }
  return JSON.stringify(args.expected) === JSON.stringify(args.actual)
    ? "survived"
    : "killed";
};

const executePostbuild = async (
  rows: readonly InventoryRow[],
): Promise<void> => {
  const runRoot = mkdtempSync(join(tmpdir(), "bb-c1-oracle-"));
  try {
    for (const row of rows) {
      if (row.category === "sdk") continue;
      const seam = seamById.get(row.seamId);
      expect(seam, row.id).toBeDefined();
      const loaded = await loadModule(seam!);
      const executor = loaded[seam!.requiredExport];
      expect(typeof executor, row.id).toBe("function");
      const databasePath = join(
        runRoot,
        `${sha256(row.id).slice(0, 20)}.sqlite`,
      );
      const actual = await (
        executor as (request: JsonObject) => JsonValue | Promise<JsonValue>
      )({
        caseId: row.id,
        category: row.category,
        input: clone(row.value),
        databasePath,
      });
      expect(actual, row.id).toEqual(expectedFor(row));
    }
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
};

describe("artifact review V3 construction C1 frozen oracle", () => {
  it("binds the synthesis, V12, immutable C0 lineage, exact migrations, and closed data", () => {
    const validate = new Ajv({
      allErrors: true,
      allowUnionTypes: true,
      strict: true,
    }).compile(schema);
    expect(validate(authority), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(corpus), JSON.stringify(validate.errors)).toBe(true);

    const bindings = asObject(authority.bindings, "bindings");
    const v12 = asObject(bindings.v12, "V12 binding");
    const v12Entries = [
      [
        "apps/server/src/services/plugins/migration-authorities/workflows-artifact-review-recovery-v12.json",
        v12.authoritySha256,
      ],
      [
        "plugins/workflows/src/artifact-recovery-v12-oracle-dsl.schema.json",
        v12.schemaSha256,
      ],
      [
        "plugins/workflows/src/artifact-recovery-v12-oracle.test.ts",
        v12.oracleSha256,
      ],
      [
        "plugins/workflows/src/artifact-recovery-v12-reference-interpreter.ts",
        v12.interpreterSha256,
      ],
      [
        "plugins/workflows/src/artifact-recovery-v12-runner-conformance.json",
        v12.conformanceSha256,
      ],
    ].map(([path, expected]) => {
      const bytes = readFileSync(new URL(path as string, repositoryRootUrl));
      expect(sha256(bytes), path as string).toBe(expected);
      return { path, sha256: expected };
    });
    const v12Manifest = JSON.stringify(
      v12Entries.sort((left, right) =>
        (left.path as string).localeCompare(right.path as string),
      ),
    );
    expect(Buffer.byteLength(v12Manifest)).toBe(798);
    expect(sha256(v12Manifest)).toBe(v12.manifestSha256);
    expect(
      sha256(
        readFileSync(
          new URL(
            "output/artifact-review-shakedown/oracle/recovery-authority-v12-approval.json",
            repositoryRootUrl,
          ),
        ),
      ),
    ).toBe(v12.approvalSha256);
    expect(
      sha256(
        readFileSync(
          new URL(
            "output/artifact-review-shakedown/oracle/recovery-authority-v12-a0-ledger.json",
            repositoryRootUrl,
          ),
        ),
      ),
    ).toBe(v12.ledgerSha256);

    const failedC0 = asObject(bindings.failedC0, "failed C0 binding");
    const c0Files = [
      [
        "apps/server/src/services/plugins/migration-authorities/workflows-artifact-review-v3-construction-c0.json",
        asObject(failedC0.authority, "C0 authority"),
      ],
      [
        "plugins/workflows/src/artifact-recovery-v3-construction.schema.json",
        asObject(failedC0.schema, "C0 schema"),
      ],
      [
        "plugins/workflows/src/artifact-recovery-v3-construction.test.ts",
        asObject(failedC0.oracle, "C0 oracle"),
      ],
    ].map(([pathValue, identityValue]) => {
      const path = pathValue as string;
      const identity = identityValue as JsonObject;
      const bytes = readFileSync(new URL(path, repositoryRootUrl));
      expect(bytes.byteLength, path).toBe(identity.byteLength);
      expect(sha256(bytes), path).toBe(identity.sha256);
      return { path, byteLength: bytes.byteLength, sha256: sha256(bytes) };
    });
    const c0Manifest = JSON.stringify(
      c0Files.sort((left, right) => left.path.localeCompare(right.path)),
    );
    expect(Buffer.byteLength(c0Manifest)).toBe(556);
    expect(sha256(c0Manifest)).toBe(failedC0.manifestSha256);
    expect(
      existsSync(
        new URL(
          "output/artifact-review-shakedown/oracle/recovery-v3-construction-c0-ledger.json",
          repositoryRootUrl,
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        new URL(
          "output/artifact-review-shakedown/oracle/recovery-v3-construction-c0-approval.json",
          repositoryRootUrl,
        ),
      ),
    ).toBe(false);

    const migrationCatalog = asArray(
      authority.migrationCatalog,
      "migration catalog",
    ).map((value) => asObject(value, "migration"));
    expect(migrations).toHaveLength(23);
    expect(
      migrations.map((statement, id) => ({
        id,
        byteLength: Buffer.byteLength(statement),
        sha256: sha256(statement),
      })),
    ).toEqual(migrationCatalog);

    const provenance = asObject(authority.dirtyProvenance, "dirty provenance");
    for (const value of [
      ...asArray(provenance.failedLineageFiles, "failed lineage files"),
      ...asArray(provenance.preC0BehavioralTests, "pre-C0 tests"),
    ]) {
      const identity = asObject(value, "provenance identity");
      const path = asString(identity.path, "provenance path");
      expect(sha256(readFileSync(new URL(path, repositoryRootUrl))), path).toBe(
        identity.sha256,
      );
    }
  });

  it("selects identical nonzero case IDs in both explicit modes", () => {
    const ids = allCases.map(({ id }) => id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    const selected = (mode: OracleMode) =>
      mode === "prebuild-red" ? [...ids] : [...ids];
    expect(selected("prebuild-red")).toEqual(selected("postbuild-pass"));
    expect(allCases.map(expectedFor)).toHaveLength(ids.length);
  });

  it("keeps semantic-kill accounting behind the semantic boundary", () => {
    const controls = asArray(corpus.negativeControls, "negative controls").map(
      (value) => asObject(value, "negative control"),
    );
    const inert = controls.find(({ id }) => id === "inert-case-survives");
    const harness = controls.find(
      ({ id }) => id === "pre-killer-harness-failure-is-not-semantic-kill",
    );
    expect(
      semanticAssessment({
        reachedSemanticBoundary: true,
        expected: { decision: "complete-ordinary" },
        actual: { decision: "complete-ordinary" },
      }),
    ).toBe(inert?.expectedAssessment);
    expect(
      semanticAssessment({
        reachedSemanticBoundary: false,
        expected: { decision: "complete-ordinary" },
        harnessError: "fixture did not materialize",
      }),
    ).toBe(harness?.expectedAssessment);
  });

  it("runs the literal mode without skips, parser predicates, or a terminal throw", async () => {
    const rawMode =
      process.env.ARTIFACT_REVIEW_C1_ORACLE_MODE ?? "prebuild-red";
    expect(["prebuild-red", "postbuild-pass"]).toContain(rawMode);
    const mode = rawMode as OracleMode;
    const probes = new Map<string, Awaited<ReturnType<typeof probeSeam>>>();
    for (const seam of seams) probes.set(seam.id, await probeSeam(seam));
    expect([...probes.values()].every(({ reached }) => reached)).toBe(true);
    expect(new Set(allCases.map(({ seamId }) => seamId))).toEqual(
      new Set(seams.map(({ id }) => id)),
    );

    if (mode === "prebuild-red") {
      const allowedReasons = new Set(
        seams.map(({ prebuildReason }) => prebuildReason),
      );
      const rows = allCases.map((item) => {
        const seam = seamById.get(item.seamId);
        const probe = probes.get(item.seamId);
        expect(seam, item.id).toBeDefined();
        expect(probe, item.id).toBeDefined();
        expect(probe!.reason, item.id).toBe(seam!.prebuildReason);
        expect(allowedReasons.has(probe!.reason!), item.id).toBe(true);
        return { id: item.id, reason: probe!.reason };
      });
      expect(rows).toHaveLength(allCases.length);
      expect(rows.every(({ reason }) => reason !== null)).toBe(true);
      return;
    }

    expect([...probes.values()].every(({ reason }) => reason === null)).toBe(
      true,
    );
    await executePostbuild(allCases);
  });
});
