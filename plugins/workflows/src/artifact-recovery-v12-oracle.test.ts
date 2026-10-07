import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  compareV12LiteralTraces,
  executeV12Corpus,
  type V12ExecutionReport,
  type V12LedgerRow,
  validateV12Authority,
} from "./artifact-recovery-v12-reference-interpreter.js";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

const authorityUrl = new URL(
  "../../../apps/server/src/services/plugins/migration-authorities/workflows-artifact-review-recovery-v12.json",
  import.meta.url,
);
const schemaUrl = new URL(
  "./artifact-recovery-v12-oracle-dsl.schema.json",
  import.meta.url,
);
const interpreterUrl = new URL(
  "./artifact-recovery-v12-reference-interpreter.ts",
  import.meta.url,
);
const conformanceUrl = new URL(
  "./artifact-recovery-v12-runner-conformance.json",
  import.meta.url,
);
const v11ApprovalUrl = new URL(
  "../../../output/artifact-review-shakedown/oracle/recovery-authority-v11-approval.json",
  import.meta.url,
);
const v12ApprovalUrl = new URL(
  "../../../output/artifact-review-shakedown/oracle/recovery-authority-v12-approval.json",
  import.meta.url,
);

const authorityBytes = readFileSync(authorityUrl);
const schemaBytes = readFileSync(schemaUrl);
const interpreterBytes = readFileSync(interpreterUrl);
const conformanceBytes = readFileSync(conformanceUrl);
const authority = JSON.parse(authorityBytes.toString("utf8")) as JsonObject;
const schema = JSON.parse(schemaBytes.toString("utf8")) as JsonObject;
const conformance = JSON.parse(conformanceBytes.toString("utf8")) as JsonObject;

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const asObject = (value: JsonValue | undefined, label: string): JsonObject => {
  expect(value, label).not.toBeNull();
  expect(Array.isArray(value), label).toBe(false);
  expect(typeof value, label).toBe("object");
  return value as JsonObject;
};

const asArray = (value: JsonValue | undefined, label: string): JsonValue[] => {
  expect(Array.isArray(value), label).toBe(true);
  return value as JsonValue[];
};

const asString = (value: JsonValue | undefined, label: string): string => {
  expect(typeof value, label).toBe("string");
  return value as string;
};

const body = asObject(authority.authority, "authority body");
const cases = asObject(body.caseCatalog, "case catalog");
const mutants = asObject(body.mutantCatalog, "mutant catalog");
const proof = asObject(body.proofContract, "proof contract");

const decodePointer = (pointer: string): string[] => {
  expect(pointer.startsWith("/"), pointer).toBe(true);
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
};

const readPointer = (document: JsonValue, pointer: string): JsonValue =>
  decodePointer(pointer).reduce<JsonValue>((current, token) => {
    if (Array.isArray(current)) return current[Number(token)]!;
    return asObject(current, pointer)[token]!;
  }, document);

const applyOneReplace = (
  document: JsonObject,
  rootPointer: string,
  relativePointer: string,
  replacement: JsonValue,
): JsonObject => {
  const copy = structuredClone(document);
  const tokens = decodePointer(`${rootPointer}${relativePointer}`);
  const member = tokens.pop()!;
  let parent: JsonValue = copy;
  for (const token of tokens) {
    parent = Array.isArray(parent)
      ? parent[Number(token)]!
      : asObject(parent, relativePointer)[token]!;
  }
  if (Array.isArray(parent))
    parent[Number(member)] = structuredClone(replacement);
  else asObject(parent, relativePointer)[member] = structuredClone(replacement);
  return copy;
};

const applySetupOperation = (
  fixture: JsonObject,
  operation: JsonObject,
): JsonObject => {
  const copy = structuredClone(fixture);
  const tokens = decodePointer(asString(operation.path, "setup patch path"));
  const member = tokens.pop()!;
  let parent: JsonValue = copy;
  for (const token of tokens) {
    parent = Array.isArray(parent)
      ? parent[Number(token)]!
      : asObject(parent, "setup patch parent")[token]!;
  }
  const op = asString(operation.op, "setup patch op");
  if (Array.isArray(parent)) {
    const index = Number(member);
    if (op === "remove") parent.splice(index, 1);
    else if (op === "add")
      parent.splice(index, 0, structuredClone(operation.value!));
    else parent[index] = structuredClone(operation.value!);
  } else if (op === "remove") {
    delete asObject(parent, "setup patch parent")[member];
  } else {
    asObject(parent, "setup patch parent")[member] = structuredClone(
      operation.value!,
    );
  }
  return copy;
};

const rowAggregates = (rows: readonly V12LedgerRow[]) => ({
  selected: rows.filter(({ selected }) => selected).length,
  patchApplied: rows.filter(({ patchApplied }) => patchApplied).length,
  killerStarted: rows.filter(({ killerStarted }) => killerStarted).length,
  killerCompleted: rows.filter(({ killerCompleted }) => killerCompleted).length,
  killed: rows.filter(({ outcome }) => outcome === "killed").length,
  survived: rows.filter(({ outcome }) => outcome === "survived").length,
  uncovered: rows.filter(({ outcome }) => outcome === "uncovered").length,
  invalidMutant: rows.filter(({ outcome }) => outcome === "invalid-mutant")
    .length,
  harnessError: rows.filter(({ outcome }) => outcome === "harness-error")
    .length,
});

const exactInputHashes = {
  authority: "dce9f6220e07452f0ad0aea5efe34dbd518e8bc689d6c5f9a558652fd7d64225",
  schema: "1757d6d75991b4df7e42a1172706d7abc3447d9c769845b86ee80a533177cf0e",
  interpreter:
    "274ec43fb0dcebf719d99e5541c2a56ded9e2ed23233ed00903d3322ea95f9c5",
  conformance:
    "eaeca2940663a8662a82189c95aee5424e4152b9431fa7ec15b6583eab3f1d6a",
};

describe("V12 immutable baseline admission", () => {
  it("binds exact raw inputs, closed schema, accepted lineage, role separation, and dark scope", () => {
    expect({
      authority: sha256(authorityBytes),
      schema: sha256(schemaBytes),
      interpreter: sha256(interpreterBytes),
      conformance: sha256(conformanceBytes),
    }).toEqual(exactInputHashes);
    expect(
      new Ajv({ allErrors: true, strict: true }).compile(schema)(authority),
    ).toBe(true);
    expect(validateV12Authority(authorityBytes, schema, conformance)).toEqual({
      ok: true,
      errors: [],
      rawSha256: exactInputHashes.authority,
    });

    const contract = asObject(authority.contract, "contract");
    expect(contract).toMatchObject({
      architectureRevision: 2,
      contractId: "bb-artifact-review-service:revision-1",
      successorSeamId: "bb-artifact-review-oracle-proof-v12:revision-1",
      authorityScope: "local-owner-origin-derived",
      presentationScope: "grant-only",
      durability: "committed-only",
      retention: "append-only",
      rollout: "dark",
    });
    const evidence = asObject(authority.legacyEvidence, "legacy evidence");
    expect(evidence).toMatchObject({
      acceptedDesign: {
        byteLength: 52165,
        sha256:
          "d97f8c76f09a92ce242977d0b676a19fb3dd48c1a5e6223602378783721f175f",
      },
      contextPacket: {
        byteLength: 13331,
        sha256:
          "40b147a61a59f48c2a52cccdcf2b54e516dae79967bb760c8033d9ba5401cc44",
      },
      v8Approval: {
        sha256:
          "117b322e0b524e1a6a7900389dfc0eaeb1cafe63f7c68427817572f7b10e6a4d",
      },
      historicalV6: { admitted: false },
      failedV11: {
        terminalVerdict: "blocked",
        approvalPresent: false,
        candidateManifestByteLength: 798,
        candidateManifestSha256:
          "fa96f5f142fb5629e5d72a1b800dcdef0b286314feb5bf80ac2eb8ee92072117",
      },
      v12BindingSynthesis: {
        runId: "wfr_b33bb153-1c95-4136-8c1b-027e953710ae",
        decisionClass: "contract-preserving",
      },
    });
    expect(existsSync(v11ApprovalUrl)).toBe(false);
    expect(existsSync(v12ApprovalUrl)).toBe(false);

    expect(asObject(proof.roleContract, "role contract")).toEqual({
      identitiesMustBeDistinct: true,
      roles: [
        "authority-and-corpus-author",
        "harness-implementer",
        "independent-a0-reviewer",
        "approval-recorder",
      ],
      approvalRecorderMayEditCandidateOrLedger: false,
    });
    expect(proof.role).toBe("authority-and-corpus-author");
    expect(asObject(proof.frozenBoundaries, "frozen boundaries")).toMatchObject(
      {
        feature: false,
        rpc: false,
        ui: false,
        renderer: false,
        liveDelivery: false,
        sdk: false,
        host: false,
        plugin: false,
        production: false,
        fake: false,
        v2Adopted: false,
        v6Adopted: false,
      },
    );
  });

  it("derives all six literal trace resolutions from operation bytes and rejects aliases, prefixes, and length drift", () => {
    const traceContract = asObject(proof.traceContract, "trace contract");
    expect(traceContract).toMatchObject({
      comparator: "exact-length-position-and-utf8-string-value",
      normalization: "none",
      aliasesAllowed: false,
      wildcardCategoriesAllowed: false,
    });
    const resolutions = asObject(
      traceContract.literalTraceResolutions,
      "trace resolutions",
    );
    expect(Object.keys(resolutions)).toHaveLength(6);
    for (const [id, value] of Object.entries(resolutions)) {
      const resolution = asObject(value, id);
      const caseValue = asObject(cases[id], id);
      const operationIndex = resolution.operationIndex as number;
      const traceIndex = resolution.traceIndex as number;
      const operation = asObject(
        asArray(caseValue.program, `${id} program`)[operationIndex],
        `${id} operation`,
      );
      const expected = asObject(caseValue.expected, `${id} expected`);
      const expectedTrace = asArray(expected.trace, `${id} trace`);
      const derived = `observed:${asString(operation.observationId, id)}`;
      expect(operation.op, id).toBe("observe");
      expect(traceIndex, id).toBe(operationIndex);
      expect(resolution.resolvedLiteral, id).toBe(derived);
      expect(expectedTrace[traceIndex], id).toBe(derived);
      expect(expectedTrace, id).toHaveLength(
        asArray(caseValue.program, id).length,
      );
    }

    expect(
      compareV12LiteralTraces(["observed:ordinary"], ["observed:ordinary"]),
    ).toEqual({
      equal: true,
      mismatchIndex: null,
      expected: null,
      actual: null,
    });
    expect(
      compareV12LiteralTraces(
        ["observed:ordinary:extra"],
        ["observed:ordinary"],
      ),
    ).toEqual({
      equal: false,
      mismatchIndex: 0,
      expected: "observed:ordinary",
      actual: "observed:ordinary:extra",
    });
    expect(compareV12LiteralTraces(["open"], ["open", "close"])).toEqual({
      equal: false,
      mismatchIndex: 1,
      expected: "close",
      actual: null,
    });
  });

  it("proves fresh one-shot mutant construction without mutating baseline descriptors", () => {
    const baselineDigest = sha256(JSON.stringify(authority));
    const a0Entries = Object.entries(mutants).filter(
      ([, value]) => asObject(value, "mutant").phase === "a0",
    );
    expect(a0Entries).toHaveLength(173);
    for (const [id, value] of a0Entries) {
      const descriptor = asObject(value, id);
      const beforeDescriptor = sha256(JSON.stringify(descriptor));
      const patch = asArray(descriptor.patch, `${id} patch`);
      expect(patch, id).toHaveLength(1);
      const operation = asObject(patch[0], `${id} operation`);
      expect(operation.op, id).toBe("replace");
      const targetPointer = asString(descriptor.targetPointer, id);
      const relativePointer = asString(operation.path, id);
      const before = readPointer(
        authority,
        `${targetPointer}${relativePointer}`,
      );
      expect(before, id).not.toEqual(operation.value);
      const derived = applyOneReplace(
        authority,
        targetPointer,
        relativePointer,
        operation.value!,
      );
      expect(
        readPointer(derived, `${targetPointer}${relativePointer}`),
        id,
      ).toEqual(operation.value);
      expect(
        readPointer(authority, `${targetPointer}${relativePointer}`),
        id,
      ).toEqual(before);
      expect(sha256(JSON.stringify(descriptor)), id).toBe(beforeDescriptor);
    }
    expect(sha256(JSON.stringify(authority))).toBe(baselineDigest);
  });

  it("independently rematerializes corruption snapshots and binds migrations 0 through 22", () => {
    const fixtures = asArray(body.fixtureCatalog, "fixtures").map((value) =>
      asObject(value, "fixture"),
    );
    const snapshots = asArray(body.snapshotCatalog, "snapshots").map((value) =>
      asObject(value, "snapshot"),
    );
    const fixtureById = new Map(
      fixtures.map((fixture) => [asString(fixture.id, "fixture id"), fixture]),
    );
    const snapshotById = new Map(
      snapshots.map((snapshot) => [
        asString(snapshot.id, "snapshot id"),
        snapshot,
      ]),
    );
    const recoveredBaseline = snapshotById.get("snapshot-completed-recovered")!;
    const corruptionCases = Object.entries(cases).filter(
      ([, value]) => asObject(value, "case").category === "corruption",
    );
    expect(corruptionCases).toHaveLength(15);
    for (const [id, value] of corruptionCases) {
      const caseValue = asObject(value, id);
      const fixtureRef = asString(caseValue.fixtureRef, id);
      const fixture = fixtureById.get(fixtureRef)!;
      const patch = asObject(asArray(caseValue.setupPatch, id)[0], id);
      const materialized = applySetupOperation(fixture, patch);
      const expected = asObject(caseValue.expected, id);
      const preRef = asString(expected.preSnapshotRef, id);
      const postRef = asString(expected.postSnapshotRef, id);
      const pre = snapshotById.get(preRef)!;
      const post = snapshotById.get(postRef)!;
      expect(preRef, id).toBe(postRef);
      expect(pre.sourceFixtureRef, id).toBe(fixtureRef);
      expect(pre.state, id).toEqual(materialized);
      expect(post, id).toEqual(pre);
      expect(expected.roots, id).toEqual(recoveredBaseline.roots);
      expect(expected.counts, id).toEqual({ writes: 0, consumers: 0 });
      expect(expected.consumerGate, id).toBe("closed");
      expect(
        asArray(caseValue.program, id).filter(
          (op) => asObject(op, id).op === "assertExpectedSnapshot",
        ),
        id,
      ).toEqual([{ op: "assertExpectedSnapshot" }]);
    }

    const migrations = asArray(body.migrationCatalog, "migrations").map(
      (value) => asObject(value, "migration"),
    );
    expect(migrations.map(({ id }) => id)).toEqual(
      Array.from({ length: 23 }, (_, id) => id),
    );
    for (const migration of migrations) {
      const statement = asString(
        migration.statementUtf8,
        "migration statement",
      );
      expect(Buffer.byteLength(statement)).toBe(migration.byteLength);
      expect(sha256(statement)).toBe(migration.sha256);
    }
    const vector = asObject(body.migrationVectorIdentity, "migration vector");
    const encoded = migrations
      .map(({ id, sha256: statementHash }) => `${id}:${statementHash}`)
      .join(";");
    expect(Buffer.byteLength(encoded)).toBe(vector.byteLength);
    expect(sha256(encoded)).toBe(vector.sha256);
  });
});

describe("V12 row-bound A0 execution", () => {
  it("derives every aggregate from typed reached-killer rows and detects three same-runner reds", async () => {
    const before = Buffer.from(authorityBytes);
    const report: V12ExecutionReport = await executeV12Corpus(
      authorityBytes,
      schema,
      conformance,
    );
    expect(authorityBytes).toEqual(before);
    expect(report.baselineAdmissionRuns).toBe(1);
    expect(report.baselineRawSha256).toBe(exactInputHashes.authority);
    expect(report.baselineContractRoot).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.baseline).toEqual({
      selected: 179,
      passed: 179,
      failed: 0,
      skipped: 0,
    });

    expect(report.ledgerRows).toHaveLength(173);
    expect(
      new Set(report.ledgerRows.map(({ mutantId }) => mutantId)).size,
    ).toBe(173);
    const observerCounts = report.ledgerRows.reduce<Record<string, number>>(
      (counts, { observerType }) => ({
        ...counts,
        [observerType]: (counts[observerType] ?? 0) + 1,
      }),
      {},
    );
    expect(observerCounts).toEqual({
      "case-outcome": 161,
      "digest-predicate": 9,
      "canonicalization-predicate": 1,
      "sqlite-normalization-predicate": 1,
      "static-digest-admission-predicate": 1,
    });
    const observerCatalog = asObject(proof.observerCatalog, "observer catalog");
    for (const row of report.ledgerRows) {
      const descriptor = asObject(mutants[row.mutantId], row.mutantId);
      const observer = asObject(observerCatalog[row.mutantId], row.mutantId);
      expect(row.selected, row.mutantId).toBe(true);
      expect(row.targetResolved, row.mutantId).toBe(true);
      expect(row.patchApplied, row.mutantId).toBe(true);
      expect(row.intendedFieldChanged, row.mutantId).toBe(true);
      expect(row.descriptorBound, row.mutantId).toBe(true);
      expect(row.derivedEnvelopeBound, row.mutantId).toBe(true);
      expect(row.derivedEnvelopeDigest, row.mutantId).toMatch(
        /^[0-9a-f]{64}$/u,
      );
      expect(row.declaredKillerCaseId, row.mutantId).toBe(
        asArray(descriptor.killerCaseIds, row.mutantId)[0],
      );
      expect(row.declaredKillerCaseId, row.mutantId).toBe(
        observer.declaredKillerCaseId,
      );
      expect(row.observerType, row.mutantId).toBe(observer.observerType);
      expect(row.killerStarted, row.mutantId).toBe(true);
      expect(row.killerCompleted, row.mutantId).toBe(true);
      expect(row.declaredSemanticReason, row.mutantId).toBe(
        observer.declaredSemanticReason,
      );
      expect(row.observedSemanticReason, row.mutantId).toBe(
        row.declaredSemanticReason,
      );
      expect(row.divergenceField, row.mutantId).toBe(observer.divergenceField);
      expect(row.failurePhase, row.mutantId).toBe("kill-classification");
      expect(row.outcome, row.mutantId).toBe("killed");
      expect(row.mutantOutcome.kind, row.mutantId).not.toBe("not-produced");
    }

    const aggregates = rowAggregates(report.ledgerRows);
    expect(aggregates).toEqual({
      selected: 173,
      patchApplied: 173,
      killerStarted: 173,
      killerCompleted: 173,
      killed: 173,
      survived: 0,
      uncovered: 0,
      invalidMutant: 0,
      harnessError: 0,
    });
    expect(report.a0).toEqual({
      ...aggregates,
      missingRows: 0,
      duplicateRows: 0,
    });

    expect(report.controlRows).toHaveLength(3);
    expect(report.controlsPass).toBe(true);
    expect(report.controlRows.map(({ controlId }) => controlId).sort()).toEqual(
      [
        "pre-killer-broken-harness",
        "semantically-inert-mutant",
        "trace-literal-substitution",
      ],
    );
    const trace = report.controlRows.find(
      ({ controlType }) => controlType === "trace-literal-substitution",
    )!;
    expect(trace).toMatchObject({
      catalogMember: false,
      outcome: "trace-mismatch",
      gateOutcome: "expected-red",
      traceIndex: 3,
    });
    expect(trace.expectedLiteral).not.toBe(trace.actualLiteral);
    const inert = report.controlRows.find(
      ({ controlType }) => controlType === "semantically-inert-mutant",
    )!;
    expect(inert.catalogMember).toBe(false);
    expect(inert.patchApplied).toBe(true);
    expect(inert.killerStarted).toBe(true);
    expect(inert.killerCompleted).toBe(true);
    expect(["survived", "uncovered"]).toContain(inert.outcome);
    expect(inert.gateOutcome).toBe("expected-red");
    const broken = report.controlRows.find(
      ({ controlType }) => controlType === "pre-killer-broken-harness",
    )!;
    expect(broken).toMatchObject({
      catalogMember: false,
      killerStarted: false,
      killerCompleted: false,
      outcome: "harness-error",
      gateOutcome: "expected-red",
    });

    expect(report.v3Construction).toEqual({
      selected: 0,
      patched: 0,
      executed: 0,
      constructed: 0,
      sentinels: 6,
    });
    const sentinels = asObject(
      proof.constructionSentinelCatalog,
      "sentinel catalog",
    );
    expect(Object.keys(sentinels)).toHaveLength(6);
    for (const [id, value] of Object.entries(sentinels)) {
      expect(value, id).toMatchObject({
        mutantId: id,
        phase: "v3-construction",
        selectedInA0: false,
        patchAllowedInA0: false,
        executeAllowedInA0: false,
        constructAllowed: false,
        classification: "construction-sentinel-only",
      });
      expect(
        report.ledgerRows.some(({ mutantId }) => mutantId === id),
        id,
      ).toBe(false);
    }
  });

  it("keeps the interpreter isolated from production, plugin, SDK, host, UI, RPC, and fake seams", () => {
    const source = interpreterBytes.toString("utf8");
    const boundary = asObject(
      conformance.interpreterBoundary,
      "interpreter boundary",
    );
    for (const forbidden of asArray(
      boundary.forbiddenImports,
      "forbidden imports",
    )) {
      expect(source).not.toContain(asString(forbidden, "forbidden import"));
    }
    expect(source).not.toContain('startsWith("observed:")');
    expect(source).not.toMatch(
      /Math\.random|Date\.now|fromProduction|fake-plugin-host/u,
    );
    expect(authorityBytes.toString("utf8")).not.toMatch(
      /\b(?:TODO|TBD|FIXME|PLACEHOLDER|LOREM)\b/iu,
    );
  });
});
