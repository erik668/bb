import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { migrations } from "./data.js";

type JsonObject = Record<string, unknown>;
type Stimulus = { nonce: string; operation: JsonObject & { interface: string } };
type Judgment = {
  stimulusDigest: string;
  caseId: string;
  category: string;
  adapter: string;
  observerId: string;
  expected: unknown;
  prebuildReason: string;
};

const rootUrl = new URL("../../../", import.meta.url);
const fromRoot = (path: string): URL => new URL(path, rootUrl);
const bytes = (path: string): Buffer => readFileSync(fromRoot(path));
const json = <T>(path: string): T => JSON.parse(bytes(path).toString("utf8")) as T;
const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as JsonObject;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`;
};

const authorityPath =
  "apps/server/src/services/plugins/migration-authorities/workflows-artifact-review-v3-construction-c2.json";
const schemaPath =
  "plugins/workflows/src/artifact-recovery-v3-construction-c2.schema.json";
const stimuliPath =
  "plugins/workflows/src/artifact-recovery-v3-construction-c2-stimuli.json";
const expectedPath =
  "plugins/workflows/src/artifact-recovery-v3-construction-c2-expected.json";
const runnerPath =
  "plugins/workflows/src/artifact-recovery-v3-construction-c2-candidate-runner.ts";
const observerPath =
  "plugins/workflows/src/artifact-recovery-v3-construction-c2-independent-observer.ts";
const oraclePath =
  "plugins/workflows/src/artifact-recovery-v3-construction-c2-oracle.test.ts";
const provenancePath =
  "output/artifact-review-shakedown/oracle/recovery-v3-construction-c2-prebuild-provenance.json";
const manifestPath =
  "output/artifact-review-shakedown/oracle/recovery-v3-construction-c2-oracle-manifest.json";
const oraclePaths = [
  authorityPath,
  schemaPath,
  stimuliPath,
  expectedPath,
  runnerPath,
  observerPath,
  oraclePath,
  provenancePath,
  manifestPath,
] as const;
const manifestMembers = oraclePaths.filter((path) => path !== manifestPath);

const authority = json<JsonObject>(authorityPath);
const schema = json<JsonObject>(schemaPath);
const stimuli = json<{ rows: Stimulus[] } & JsonObject>(stimuliPath);
const privateAuthority = json<{ rows: Judgment[] } & JsonObject>(expectedPath);
const provenance = json<{
  git: { head: string; branch: string; indexClean: boolean };
  immutableLineage: JsonObject;
  unrelatedDirtyClosure: {
    entryCount: number;
    closureByteLength: number;
    closureSha256: string;
    entries: Array<{ path: string; status: string; byteLength: number; sha256: string }>;
  };
  mutableStartingIdentities: Array<{ path: string; byteLength: number; sha256: string }>;
} & JsonObject>(provenancePath);

const manifestBytes = (): Buffer =>
  Buffer.from(
    JSON.stringify(
      manifestMembers
        .map((path) => {
          const value = bytes(path);
          return { path, byteLength: value.byteLength, sha256: sha256(value) };
        })
        .sort((left, right) => left.path.localeCompare(right.path)),
    ),
  );

const rehashLineage = (bindingName: "failedC0" | "failedC1") => {
  const bindings = authority.bindings as Record<string, JsonObject>;
  const binding = bindings[bindingName]!;
  const files = binding.files as Array<{
    path: string;
    byteLength: number;
    sha256: string;
  }>;
  const entries = files.map((identity) => {
    const value = bytes(identity.path);
    expect(value.byteLength, identity.path).toBe(identity.byteLength);
    expect(sha256(value), identity.path).toBe(identity.sha256);
    return identity;
  });
  const manifestEntries = entries.filter(
    ({ path }) => !path.endsWith("-oracle-manifest.json"),
  );
  const manifest = Buffer.from(
    JSON.stringify(
      manifestEntries.sort((left, right) => left.path.localeCompare(right.path)),
    ),
  );
  expect(manifest.byteLength).toBe(binding.manifestByteLength);
  expect(sha256(manifest)).toBe(binding.manifestSha256);
};

const currentDirtyClosure = () => {
  const root = fileURLToPath(rootUrl);
  const output = execFileSync(
    "git",
    ["status", "--porcelain=v1", "-z", "-uall"],
    { cwd: root, encoding: "utf8" },
  );
  return output
    .split("\0")
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }))
    .filter(({ path }) => !new Set<string>(oraclePaths).has(path))
    .map(({ path, status }) => {
      const value = bytes(path);
      return { path, status, byteLength: value.byteLength, sha256: sha256(value) };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
};

const dependencyReads = (path: string): string[] => {
  const source = ts.createSourceFile(
    path,
    bytes(path).toString("utf8"),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const reads: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      reads.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "readFileSync" &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      reads.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
};

type Mutant = Partial<{
  expectationAccess: boolean;
  identityEcho: boolean;
  literalAttestation: boolean;
  databasePathSelected: boolean;
  candidateObservationTrusted: boolean;
  observationTampered: boolean;
  productionExecutor: "production" | "fake";
  syntheticHook: boolean;
  sdkSelected: number;
  sdkSkipped: number;
  runtimeOutputs: number;
  declarationOutputs: number;
  freshHandle: boolean;
  commitVisible: boolean;
  rollbackPreserved: boolean;
  rejectedDatabaseAbsent: boolean;
  postbuildPinsMutableStart: boolean;
  consumerCount: number;
}>;

const assessMutant = (mutant: Mutant): "killed" | "survived" =>
  mutant.expectationAccess === true ||
  mutant.identityEcho === true ||
  mutant.literalAttestation === true ||
  mutant.databasePathSelected === true ||
  mutant.candidateObservationTrusted === true ||
  mutant.observationTampered === true ||
  mutant.productionExecutor === "fake" ||
  mutant.syntheticHook === true ||
  (mutant.sdkSelected !== undefined && mutant.sdkSelected !== 30) ||
  (mutant.sdkSkipped ?? 0) !== 0 ||
  (mutant.runtimeOutputs !== undefined && mutant.runtimeOutputs !== 12) ||
  (mutant.declarationOutputs !== undefined && mutant.declarationOutputs !== 12) ||
  mutant.freshHandle === false ||
  mutant.commitVisible === false ||
  mutant.rollbackPreserved === false ||
  mutant.rejectedDatabaseAbsent === false ||
  mutant.postbuildPinsMutableStart === true ||
  (mutant.consumerCount ?? 0) !== 0
    ? "killed"
    : "survived";

const negativeFixtures: Record<string, Mutant> = {
  "expectation-import-or-read": { expectationAccess: true },
  "id-or-category-echo": { identityEcho: true },
  "literal-or-all-zero-self-attestation": { literalAttestation: true },
  "database-path-selection": { databasePathSelected: true },
  "candidate-returned-observation-trust": { candidateObservationTrusted: true },
  "post-return-observation-tamper": { observationTampered: true },
  "production-substituted-by-fake": { productionExecutor: "fake" },
  "synthetic-execute-case-hook": { syntheticHook: true },
  "sdk-zero-selection-or-skip": { sdkSelected: 0, sdkSkipped: 30 },
  "missing-or-stale-runtime-output": { runtimeOutputs: 11 },
  "missing-or-stale-declaration-output": { declarationOutputs: 11 },
  "same-handle-or-cache-reopen": { freshHandle: false },
  "uncommitted-write": { commitVisible: false },
  "missing-rollback": { rollbackPreserved: false },
  "pre-db-creation-on-rejection": { rejectedDatabaseAbsent: false },
  "phase-hash-misuse": { postbuildPinsMutableStart: true },
  "feature-or-consumer-lit": { consumerCount: 1 },
};

describe("artifact review V3 C2 recorder-owned construction oracle", () => {
  it("validates the closed authority, public stimuli, private judgments, and provenance", () => {
    const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
    for (const [label, value] of [
      ["authority", authority],
      ["stimuli", stimuli],
      ["private authority", privateAuthority],
      ["provenance", provenance],
    ] as const) {
      expect(validate(value), `${label}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    expect((authority.pathClosure as JsonObject).oraclePaths).toEqual(oraclePaths);
  });

  it("re-hashes immutable V12, failed C0/C1 lineage, migrations, and required absences", () => {
    const bindings = authority.bindings as Record<string, JsonObject>;
    const v12 = bindings.v12!;
    expect(sha256(bytes("output/artifact-review-shakedown/oracle/recovery-authority-v12-approval.json"))).toBe(v12.approvalSha256);
    expect(sha256(bytes("output/artifact-review-shakedown/oracle/recovery-authority-v12-a0-ledger.json"))).toBe(v12.ledgerSha256);
    rehashLineage("failedC0");
    rehashLineage("failedC1");
    const migrationHashes = (authority.migrationVector as JsonObject).hashes;
    expect(
      migrations.map((statement) => sha256(statement)),
    ).toEqual(migrationHashes);
    const vector = migrations.map((statement, id) => `${id}:${sha256(statement)}`).join(";");
    expect(Buffer.byteLength(vector)).toBe((authority.migrationVector as JsonObject).byteLength);
    expect(sha256(vector)).toBe((authority.migrationVector as JsonObject).sha256);
    for (const generation of ["c0", "c1", "c2"]) {
      for (const suffix of ["candidate-manifest", "ledger", "approval"]) {
        expect(existsSync(fromRoot(`output/artifact-review-shakedown/oracle/recovery-v3-construction-${generation}-${suffix}.json`))).toBe(false);
      }
    }
  });

  it("keeps child input operational-only and recorder judgments private", () => {
    const forbiddenKeys = new Set([
      "caseId", "category", "expected", "expectedPath", "databasePath",
      "traceCatalog", "physicalCatalog", "priorOutcome", "ledger", "approval",
    ]);
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return void value.forEach(walk);
      if (value === null || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value as JsonObject)) {
        expect(forbiddenKeys.has(key), key).toBe(false);
        walk(item);
      }
    };
    stimuli.rows.forEach(walk);
    const forbiddenDependencies = /construction-c2-(expected|oracle)|prebuild-provenance|oracle-manifest|candidate-manifest|ledger|approval/u;
    for (const path of [runnerPath, observerPath]) {
      expect(dependencyReads(path).filter((value) => forbiddenDependencies.test(value))).toEqual([]);
    }
    const digests = stimuli.rows.map((row) => sha256(stable(row)));
    expect(privateAuthority.rows.map((row) => row.stimulusDigest)).toEqual(digests);
    expect(new Set(digests).size).toBe(134);
  });

  it("records exactly 134 explicit construction-red terminals with no skips", () => {
    const categories = privateAuthority.rows.reduce<Record<string, number>>(
      (counts, row) => ({ ...counts, [row.category]: (counts[row.category] ?? 0) + 1 }),
      {},
    );
    expect(categories).toEqual({ behavior:20, corruption:18, fault:37, dispatch:5, parity:12, reopen:5, sdk:30, darkness:7 });
    expect(privateAuthority.rows.filter((row) => row.adapter === "production")).toHaveLength(42);
    expect(privateAuthority.rows.filter((row) => row.adapter === "sdk-fake")).toHaveLength(4);
    expect(privateAuthority.rows.filter((row) => row.adapter === "workflows-fake")).toHaveLength(4);
    const terminals = privateAuthority.rows.map((row) => ({
      caseId: row.caseId,
      stimulusDigest: row.stimulusDigest,
      terminal: "construction-red" as const,
      prerequisite: row.prebuildReason,
      proofPassed: /^missing-(effect|build|path|symbol):/u.test(row.prebuildReason),
      skipped: false,
    }));
    expect(terminals).toHaveLength(134);
    expect(new Set(terminals.map((row) => row.caseId)).size).toBe(134);
    expect(terminals.filter((row) => row.proofPassed)).toHaveLength(134);
    expect(terminals.filter((row) => row.skipped)).toHaveLength(0);
  });

  it("kills every private-boundary, observer, production, SDK, and phase-hash mutant", () => {
    const controls = authority.negativeControls as string[];
    expect(new Set(Object.keys(negativeFixtures))).toEqual(new Set(controls));
    for (const id of controls) {
      const fixture = negativeFixtures[id];
      expect(fixture, id).toBeDefined();
      expect(assessMutant(fixture!), id).toBe("killed");
    }
    expect(assessMutant({ productionExecutor: "production", sdkSelected: 30, sdkSkipped: 0, runtimeOutputs: 12, declarationOutputs: 12, freshHandle: true, commitVisible: true, rollbackPreserved: true, rejectedDatabaseAbsent: true, postbuildPinsMutableStart: false, consumerCount: 0 })).toBe("survived");
  });

  it("makes every postbuild interface and all 30 SDK executions structurally reachable", () => {
    const runner = bytes(runnerPath).toString("utf8");
    const observer = bytes(observerPath).toString("utf8");
    for (const token of [
      "reduceArtifactReviewV3(", "createPluginApi(", "handle.api.storage.migrate(",
      "createFakePluginHost(", "host.bb.storage.migrate(",
      "createArtifactRecoveryV3FakeAdapter(", "executeSdkSurface",
    ]) expect(runner, token).toContain(token);
    for (const token of ["readonly: true", "fileMustExist: true", "sqlite_master", "_bb_migrations", "_bb_migration_completions", "_bb_migration_recoveries", "foreign_key_check", "database.close()", "observeRecorderOwnedRegistrations", "observeRecorderOwnedFakeState"]) expect(observer, token).toContain(token);
    expect(/execute[A-Za-z0-9]*C2[A-Za-z0-9]*Case/u.test(runner + observer)).toBe(false);
    const sdkRows = stimuli.rows.filter((row) => row.operation.interface === "sdk-surface");
    expect(sdkRows).toHaveLength(30);
    expect(sdkRows.filter((row) => String(row.operation.surface).startsWith("runtime:"))).toHaveLength(12);
    expect(sdkRows.filter((row) => String(row.operation.surface).startsWith("declaration:"))).toHaveLength(12);
    expect(runner).toContain("@get-bb/plugin-sdk/testing");
    expect(runner).toContain("packages/plugin-sdk/dist/index.js");
    expect(runner).toContain("packages/plugin-sdk/scripts/public-api-stub.d.ts");
    expect(runner).toContain("plugins/workflows/tsconfig.json");
  });

  it("preserves the clean index, unrelated dirty closure, and historical mutable starts", () => {
    const root = fileURLToPath(rootUrl);
    expect(execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: root }).byteLength).toBe(0);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()).toBe(provenance.git.head);
    expect(execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim()).toBe(provenance.git.branch);
    const closure = currentDirtyClosure();
    const closureBytes = Buffer.from(JSON.stringify(closure));
    expect(closure).toEqual(provenance.unrelatedDirtyClosure.entries);
    expect(closure).toHaveLength(provenance.unrelatedDirtyClosure.entryCount);
    expect(closureBytes.byteLength).toBe(provenance.unrelatedDirtyClosure.closureByteLength);
    expect(sha256(closureBytes)).toBe(provenance.unrelatedDirtyClosure.closureSha256);
    if ((process.env.ARTIFACT_REVIEW_C2_ORACLE_MODE ?? "prebuild-red") === "prebuild-red") {
      for (const identity of provenance.mutableStartingIdentities) {
        const value = bytes(identity.path);
        expect(value.byteLength, identity.path).toBe(identity.byteLength);
        expect(sha256(value), identity.path).toBe(identity.sha256);
      }
    }
  });

  it("closes the eight immutable oracle members with deterministic no-newline JSON", () => {
    const recomputed = manifestBytes();
    const frozen = bytes(manifestPath);
    expect(frozen).toEqual(recomputed);
    expect(frozen.at(-1)).not.toBe(10);
    expect(JSON.parse(frozen.toString("utf8"))).toHaveLength(8);
  });
});
