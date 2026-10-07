import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { afterAll, describe, expect, it } from "vitest";
import {
  runPrefreezeReadiness,
  type A0ReadinessRun,
} from "./artifact-recovery-v3-executable-recorder-a0-runner.js";
import {
  stableJson,
  type A0PublicStimulus,
} from "./artifact-recovery-v3-executable-recorder-a0-reference-and-fault-adapters.js";

type JsonObject = Record<string, unknown>;
type Judgment = Readonly<{
  stimulusDigest: string;
  caseId: string;
  category: string;
  adapter: string;
  observerId: string;
  expected: Readonly<Record<string, unknown>>;
}>;

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fromRoot = (path: string): string => join(repositoryRoot, path);
const bytes = (path: string): Buffer => readFileSync(fromRoot(path));
const json = <T>(path: string): T => JSON.parse(bytes(path).toString("utf8")) as T;
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

const authorityPath = "apps/server/src/services/plugins/migration-authorities/workflows-artifact-review-v3-executable-recorder-a0.json";
const publicPath = "plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0-public-stimuli.json";
const privatePath = "plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0-private-authority.json";
const adapterPath = "plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0-reference-and-fault-adapters.ts";
const runnerPath = "plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0-runner.ts";
const observerPath = "plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0-independent-observer.ts";
const schemaPath = "plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0.schema.json";
const oraclePath = "plugins/workflows/src/artifact-recovery-v3-executable-recorder-a0-oracle.test.ts";
const prefreezePath = "output/artifact-review-shakedown/oracle/recovery-v3-executable-recorder-a0-prefreeze-provenance.json";
const repairPath = "output/artifact-review-shakedown/oracle/recovery-v3-executable-recorder-a0-repair-provenance.json";
const laterOutputPaths = [
  "output/artifact-review-shakedown/oracle/recovery-v3-executable-recorder-a0-manifest.json",
  "output/artifact-review-shakedown/oracle/recovery-v3-executable-recorder-a0-run-1.json",
  "output/artifact-review-shakedown/oracle/recovery-v3-executable-recorder-a0-run-2.json",
  "output/artifact-review-shakedown/oracle/recovery-v3-executable-recorder-a0-execution-ledger.json",
  "output/artifact-review-shakedown/oracle/recovery-v3-executable-recorder-a0-approval.json",
] as const;
const allA0Paths = [
  authorityPath,
  publicPath,
  privatePath,
  adapterPath,
  runnerPath,
  observerPath,
  schemaPath,
  oraclePath,
  prefreezePath,
  repairPath,
  ...laterOutputPaths,
];

const authority = json<JsonObject>(authorityPath);
const stimuli = json<{ rows: A0PublicStimulus[] } & JsonObject>(publicPath);
const privateAuthority = json<{ rows: Judgment[] } & JsonObject>(privatePath);
const provenance = json<{
  git: { head: string; branch: string; indexClean: boolean };
  immutableLineage: JsonObject;
  unrelatedDirtyClosure: {
    entryCount: number;
    closureByteLength: number;
    closureSha256: string;
    entries: Array<{ path: string; status: string; byteLength: number; sha256: string }>;
  };
  repair: { status: string; used: null; events: [] };
} & JsonObject>(prefreezePath);
const schema = json<object>(schemaPath);
const controlDefinitions = authority.negativeControls as Array<{
  id: string;
  killReason: { code: string };
  reachability: { receiptType: string };
}>;
const AjvConstructor = Ajv as unknown as new (options: {
  allErrors: boolean;
  strict: boolean;
}) => {
  compile(schemaValue: object): ((value: unknown) => boolean) & { errors?: unknown };
};

const currentDirtyClosure = () => {
  const output = execFileSync("git", ["status", "--porcelain=v1", "-z", "-uall"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const excluded = new Set(allA0Paths);
  return output
    .split("\0")
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }))
    .filter(({ path }) => !excluded.has(path))
    .map(({ path, status }) => {
      const value = bytes(path);
      return { path, status, byteLength: value.byteLength, sha256: sha256(value) };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
};

const countBy = <T>(values: readonly T[], key: (value: T) => string): Record<string, number> =>
  values.reduce<Record<string, number>>((counts, value) => {
    const item = key(value);
    counts[item] = (counts[item] ?? 0) + 1;
    return counts;
  }, {});

const actualMatchesPrivateJudgment = (
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
): boolean => Object.entries(expected).every(([key, value]) => stableJson(actual[key]) === stableJson(value));

const assertNoPrivateInput = (value: unknown): void => {
  if (Array.isArray(value)) return void value.forEach(assertNoPrivateInput);
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    expect(["caseId", "category", "expected", "expectedPath", "databasePath", "approval", "aggregateTarget"]).not.toContain(key);
    assertNoPrivateInput(child);
  }
};

let readiness: A0ReadinessRun | undefined;
let rehearsalRoot: string | undefined;

afterAll(() => {
  if (readiness !== undefined) readiness.cleanup();
  else if (rehearsalRoot !== undefined) rmSync(rehearsalRoot, { recursive: true, force: true });
});

describe("artifact review V3 executable-recorder A0 prefreeze admission", () => {
  it("admits the exact frozen corpus while definitive repair and freeze outputs remain absent", () => {
    const validate = new AjvConstructor({ allErrors: true, strict: true }).compile(schema);
    for (const [label, value] of [
      ["authority", authority],
      ["public", stimuli],
      ["private", privateAuthority],
      ["prefreeze", provenance],
    ] as const) {
      expect(validate(value), `${label}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    expect(provenance.repair).toEqual({ status: "available-not-yet-applicable", used: null, events: [] });
    for (const path of [repairPath, ...laterOutputPaths]) expect(existsSync(fromRoot(path)), path).toBe(false);
    expect(stimuli.rows).toHaveLength(134);
    expect(privateAuthority.rows).toHaveLength(134);
    const digests = stimuli.rows.map((row) => sha256(stableJson(row)));
    expect(new Set(digests).size).toBe(134);
    expect(digests).toEqual(privateAuthority.rows.map(({ stimulusDigest }) => stimulusDigest));
    expect(countBy(privateAuthority.rows, ({ category }) => category)).toEqual({
      behavior: 20,
      corruption: 18,
      fault: 37,
      dispatch: 5,
      parity: 12,
      reopen: 5,
      sdk: 30,
      darkness: 7,
    });
    expect(privateAuthority.rows.filter(({ adapter }) => adapter === "production")).toHaveLength(42);
    expect(privateAuthority.rows.filter(({ adapter }) => adapter === "sdk-fake")).toHaveLength(4);
    expect(privateAuthority.rows.filter(({ adapter }) => adapter === "workflows-fake")).toHaveLength(4);
    expect(controlDefinitions).toHaveLength(17);
  });

  it("records 134 operational positives and 17 controls through one fresh-process ledger pipeline", async () => {
    rehearsalRoot = mkdtempSync("/tmp/bb-a0-integrated-");
    readiness = await runPrefreezeReadiness({
      repositoryRoot,
      publicStimuli: stimuli.rows,
      controlIds: controlDefinitions.map(({ id }) => id),
      root: rehearsalRoot,
    });
    expect(readiness.executions).toHaveLength(134);
    expect(readiness.observations).toHaveLength(134);
    expect(readiness.controls).toHaveLength(17);
    expect(readiness.ledgerRows).toHaveLength(153);
    expect(new Set(readiness.ledgerRows.map(({ execution }) => execution.executionIdentity)).size).toBe(153);
    for (const [ordinal, execution] of readiness.executions.entries()) {
      const observation = readiness.observations[ordinal]!;
      const judgment = privateAuthority.rows[ordinal]!;
      expect(execution.executionIdentity, judgment.caseId).toBe(observation.executionIdentity);
      expect(execution.stimulusDigest, judgment.caseId).toBe(judgment.stimulusDigest);
      expect(execution.candidateProcessId, judgment.caseId).not.toBe(observation.observerProcessId);
      expect(execution.candidateCommand.status, judgment.caseId).toBe(0);
      expect(observation.observerCommand.status, judgment.caseId).toBe(0);
      expect(execution.durableRecord.byteLength, judgment.caseId).toBeGreaterThan(0);
      expect(observation.durableObservation.byteLength, judgment.caseId).toBeGreaterThan(0);
      expect(execution.durableRecord.path.endsWith("execution-record.json"), judgment.caseId).toBe(true);
      expect(observation.durableObservation.path.endsWith("observation-record.json"), judgment.caseId).toBe(true);
      expect(Object.hasOwn(execution, "actual"), judgment.caseId).toBe(false);
      const persisted = JSON.parse(readFileSync(execution.durableRecord.path, "utf8")) as Record<string, unknown>;
      expect(Object.hasOwn(persisted, "actual"), judgment.caseId).toBe(false);
      expect(Object.hasOwn(persisted.operational as object, "diagnosticReferenceActualSha256"), judgment.caseId).toBe(true);
      expect(actualMatchesPrivateJudgment(observation.actual, judgment.expected), `${judgment.caseId}: ${JSON.stringify(observation.actual)} vs ${JSON.stringify(judgment.expected)}`).toBe(true);
      expect(observation.pipelineStages).toEqual(["dispatch", "candidate-boundary", "durable-record", "fresh-observe", "ledger-join"]);
      expect(observation.pipelineIdentitySha256).toMatch(/^[a-f0-9]{64}$/u);
      assertNoPrivateInput(JSON.parse(readFileSync(join(execution.issuedRoots.commandRoot, "candidate-input.json"), "utf8")));
    }
    expect(readiness.controls.map(({ id }) => id)).toEqual(controlDefinitions.map(({ id }) => id));
    for (const [index, receipt] of readiness.controls.entries()) {
      const definition = controlDefinitions[index]!;
      const row = readiness.ledgerRows.find(({ execution }) => execution.controlId === receipt.id);
      expect(row, receipt.id).toBeDefined();
      expect(receipt.killerStarted, receipt.id).toBe(true);
      expect(receipt.killerCompleted, receipt.id).toBe(true);
      expect(receipt.reached, receipt.id).toBe(true);
      expect(receipt.killed, receipt.id).toBe(true);
      expect(receipt.reason, receipt.id).toBe(definition.killReason.code);
      expect(receipt.receiptType, receipt.id).toBe(definition.reachability.receiptType);
      expect(row!.execution.candidateProcessId, receipt.id).not.toBe(row!.observation.observerProcessId);
      expect(row!.observation.pipelineIdentitySha256, receipt.id).toMatch(/^[a-f0-9]{64}$/u);
    }
  }, 900_000);

  it("executes every SDK surface, both encoders, the newline mutant, and the construction red", () => {
    expect(readiness).toBeDefined();
    expect(readiness!.sdkBuilds.identical).toBe(true);
    expect(readiness!.sdkBuilds.first.runtime).toHaveLength(12);
    expect(readiness!.sdkBuilds.first.declarations).toHaveLength(12);
    expect(readiness!.sdkBuilds.second.runtime).toEqual(readiness!.sdkBuilds.first.runtime);
    expect(readiness!.sdkBuilds.second.declarations).toEqual(readiness!.sdkBuilds.first.declarations);
    for (const build of [readiness!.sdkBuilds.first, readiness!.sdkBuilds.second]) {
      expect(build.commands).toHaveLength(2);
      for (const receipt of build.commands) {
        expect(receipt.started).toBe(true);
        expect(receipt.completed).toBe(true);
        expect(receipt.status).toBe(0);
      }
    }
    expect(readiness!.sdkMatrix.commands).toHaveLength(4);
    for (const receipt of readiness!.sdkMatrix.commands.slice(0, 3)) {
      expect(receipt.started).toBe(true);
      expect(receipt.completed).toBe(true);
      expect(receipt.status).toBe(0);
    }
    expect(readiness!.sdkMatrix.commands[3]).toEqual(
      expect.objectContaining({ started: true, completed: true }),
    );
    expect(readiness!.sdkMatrix.commands[3]!.status).not.toBe(0);
    const sdkOrdinals = stimuli.rows
      .map((stimulus, ordinal) => ({ stimulus, ordinal }))
      .filter(({ stimulus }) => stimulus.operation.interface === "sdk-surface");
    expect(sdkOrdinals).toHaveLength(30);
    expect(sdkOrdinals.map(({ stimulus }) => stimulus.operation.surface)).toEqual(
      readiness!.observations
        .filter((_, ordinal) => stimuli.rows[ordinal]!.operation.interface === "sdk-surface")
        .map(({ actual }) => actual.surface),
    );
    for (const { ordinal } of sdkOrdinals) {
      expect(readiness!.observations[ordinal]!.actual).toEqual(expect.objectContaining({ status: "executed", positive: true, negative: true }));
    }
    expect(readiness!.manifestEncoding.identical).toBe(true);
    expect(readiness!.manifestEncoding.recorder).toEqual(readiness!.manifestEncoding.independent);
    expect(readiness!.manifestEncoding.recorder.terminalNewline).toBe(false);
    expect(readiness!.manifestNewlineControl.observation.actual).toEqual(expect.objectContaining({ reached: true, killed: true, reason: "E_MANIFEST_TERMINAL_NEWLINE", terminalByte: 10 }));
    expect(readiness!.targetConstructionRed.observation.actual).toEqual(expect.objectContaining({
      classification: "typed-expected-construction-red",
      code: "E_A0_TARGET_CONSTRUCTION_ABSENT",
      attemptedBoundary: "artifact-review-service/createArtifactReviewAcceptanceDriver",
      modulePresent: false,
      sideEffects: [],
    }));
    const helpers = new Set(readiness!.helperReachability.map(({ helper }) => helper));
    for (const helper of [
      "recorder-owned-dispatcher",
      "recorder-owned-candidate-runner",
      "known-good-reference-adapter",
      "production-reference-adapter",
      "production-admission-adapter",
      "independent-observer-reference-adapter",
      "sdk-fake-executor",
      "workflows-fake-adapter",
      "shared-sdk-reducer",
      "sdk-surface-executor",
      "darkness-observer-dispatch",
      "fresh-independent-observer",
      "target-construction-boundary",
      "manifest-byte-boundary-mutator",
      "canonical-manifest-encoder-recorder",
      "canonical-manifest-encoder-observer",
    ]) expect(helpers.has(helper), helper).toBe(true);
  });

  it("preserves frozen lineage, unrelated dirty bytes, and the clean index", () => {
    expect(execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: repositoryRoot }).byteLength).toBe(0);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim()).toBe(provenance.git.head);
    expect(execFileSync("git", ["branch", "--show-current"], { cwd: repositoryRoot, encoding: "utf8" }).trim()).toBe(provenance.git.branch);
    const closure = currentDirtyClosure();
    const closureBytes = Buffer.from(JSON.stringify(closure));
    expect(closure).toEqual(provenance.unrelatedDirtyClosure.entries);
    expect(closure).toHaveLength(101);
    expect(closureBytes.byteLength).toBe(provenance.unrelatedDirtyClosure.closureByteLength);
    expect(sha256(closureBytes)).toBe(provenance.unrelatedDirtyClosure.closureSha256);
    expect(provenance.immutableLineage).toEqual((authority.bindings as { immutableLineage: JsonObject }).immutableLineage);
  });
});
