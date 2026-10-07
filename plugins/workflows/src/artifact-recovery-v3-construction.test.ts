import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";

type FileIdentity = {
  path: string;
  byteLength: number;
  sha256: string;
};

type ManifestIdentity = {
  byteLength: number;
  sha256: string;
  entries: FileIdentity[];
};

type FailedLineage = {
  manifestByteLength: number;
  manifestSha256: string;
  files: FileIdentity[];
};

type Sentinel = {
  id: string;
  provenance:
    | "v12-construction-sentinel"
    | "current-seam"
    | "current-seam-v12-by-reference";
  arm: "fake" | "production" | "shared" | "plugin" | "independent";
  path: string;
  symbol: string;
  requiredTokens: string[];
  orderedTokens: string[];
  killerId: string;
  expectedPrebuild: "present" | "missing-construction";
  allowedFailure:
    | "none"
    | "missing-path-or-symbol"
    | "missing-symbol"
    | "missing-symbol-or-order";
};

type NegativeControl = {
  id:
    | "fallthrough-to-v2"
    | "plugin-self-attestation"
    | "database-before-authority-admission"
    | "copied-production-fake-decision-logic"
    | "missing-reopened-verification"
    | "consumer-reachability";
  sentinelId: string;
  expectedReason: string;
};

type Authority = {
  schemaVersion: string;
  successorSeamId: string;
  scope: {
    oracleWritePaths: string[];
    constructionPaths: string[];
    ledgerPath: string;
    approvalPath: string;
  };
  identities: {
    acceptedDesign: FileIdentity;
    contextPacket: FileIdentity;
    v8Approval: FileIdentity;
    v12: {
      approval: FileIdentity;
      ledger: FileIdentity;
      candidateManifest: ManifestIdentity;
    };
    failedLineage: {
      v9: FailedLineage;
      v10: FailedLineage;
      v11: FailedLineage;
      v6Receipt: FileIdentity & { admitted: false };
    };
    migrations: {
      source: FileIdentity;
      count: number;
      vectorByteLength: number;
      vectorSha256: string;
      entries: Array<{ id: number; byteLength: number; sha256: string }>;
    };
    worktreeBaseline: {
      root: string;
      head: string;
      branch: string;
      indexClean: boolean;
      unrelatedFileCount: number;
      unrelatedManifestByteLength: number;
      unrelatedManifestSha256: string;
    };
  };
  sentinelCatalog: Sentinel[];
  negativeControls: NegativeControl[];
  prebuildOracle: {
    selected: number;
    passed: number;
    failed: number;
    skipped: number;
  };
};

type SentinelRow = {
  id: string;
  path: string;
  symbol: string;
  selected: true;
  killerReached: boolean;
  outcome: "pass" | "fail";
  reason: string;
};

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const authorityPath = resolve(
  repoRoot,
  "apps/server/src/services/plugins/migration-authorities/workflows-artifact-review-v3-construction-c0.json",
);
const schemaPath = resolve(
  repoRoot,
  "plugins/workflows/src/artifact-recovery-v3-construction.schema.json",
);
const testPath = fileURLToPath(import.meta.url);
const authorityBytes = readFileSync(authorityPath);
const schemaBytes = readFileSync(schemaPath);
const authority = JSON.parse(authorityBytes.toString("utf8")) as Authority;
const schema = JSON.parse(schemaBytes.toString("utf8")) as object;

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const runGit = (...args: string[]): Buffer => {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "buffer",
  });
  expect(result.error, `git ${args.join(" ")}`).toBeUndefined();
  expect(result.status, result.stderr.toString()).toBe(0);
  return result.stdout;
};

const assertFileIdentity = (identity: FileIdentity): void => {
  const bytes = readFileSync(resolve(repoRoot, identity.path));
  expect(bytes.byteLength, identity.path).toBe(identity.byteLength);
  expect(sha256(bytes), identity.path).toBe(identity.sha256);
};

const manifestBytes = (entries: FileIdentity[]): Buffer =>
  Buffer.from(
    JSON.stringify(
      entries
        .map(({ path, sha256: expectedSha256 }) => ({
          path,
          sha256: expectedSha256,
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    ),
  );

const assertManifestIdentity = (identity: ManifestIdentity): void => {
  for (const entry of identity.entries) assertFileIdentity(entry);
  const bytes = manifestBytes(identity.entries);
  expect(bytes.byteLength).toBe(identity.byteLength);
  expect(sha256(bytes)).toBe(identity.sha256);
};

const assertFailedLineage = (lineage: FailedLineage): void => {
  assertManifestIdentity({
    byteLength: lineage.manifestByteLength,
    sha256: lineage.manifestSha256,
    entries: lineage.files,
  });
};

const evaluateSentinel = (sentinel: Sentinel): SentinelRow => {
  const absolutePath = resolve(repoRoot, sentinel.path);
  if (!existsSync(absolutePath)) {
    return {
      id: sentinel.id,
      path: sentinel.path,
      symbol: sentinel.symbol,
      selected: true,
      killerReached: true,
      outcome: "fail",
      reason: `missing-path:${sentinel.path}`,
    };
  }

  const source = readFileSync(absolutePath, "utf8");
  const missingToken = sentinel.requiredTokens.find(
    (token) => !source.includes(token),
  );
  if (missingToken !== undefined) {
    return {
      id: sentinel.id,
      path: sentinel.path,
      symbol: sentinel.symbol,
      selected: true,
      killerReached: true,
      outcome: "fail",
      reason: `missing-symbol:${sentinel.symbol}:${missingToken}`,
    };
  }

  let previousIndex = -1;
  for (const token of sentinel.orderedTokens) {
    const index = source.indexOf(token, previousIndex + 1);
    if (index <= previousIndex) {
      return {
        id: sentinel.id,
        path: sentinel.path,
        symbol: sentinel.symbol,
        selected: true,
        killerReached: true,
        outcome: "fail",
        reason: `wrong-order:${sentinel.symbol}:${token}`,
      };
    }
    previousIndex = index;
  }

  return {
    id: sentinel.id,
    path: sentinel.path,
    symbol: sentinel.symbol,
    selected: true,
    killerReached: true,
    outcome: "pass",
    reason: `constructed:${sentinel.killerId}`,
  };
};

const negativeFixtures: Record<
  NegativeControl["id"],
  { mutant: string; fixed: string }
> = {
  "fallthrough-to-v2": {
    mutant: "if (!Array.isArray(plan)) migrateWithPlanV2(database, plan)",
    fixed:
      "if (plan.version === 3) migrateWithPlanV3(database, plan); else migrateWithPlanV2(database, plan)",
  },
  "plugin-self-attestation": {
    mutant:
      "interface PluginMigrationPlanV3 { authorityId: string; statementSha256: string[] }",
    fixed:
      "interface PluginMigrationPlanV3 { authorityId: string; statements: string[] }",
  },
  "database-before-authority-admission": {
    mutant: "database(); resolveArtifactReviewV3Authority(plan.authorityId)",
    fixed: "resolveArtifactReviewV3Authority(plan.authorityId); database()",
  },
  "copied-production-fake-decision-logic": {
    mutant:
      "function productionDecision() {}; function fakeDecision() {}; productionDecision(); fakeDecision()",
    fixed:
      "function reduceArtifactReviewV3() {}; productionAdapter(reduceArtifactReviewV3); fakeAdapter(reduceArtifactReviewV3)",
  },
  "missing-reopened-verification": {
    mutant: "verifyCompleted(database)",
    fixed: "reopenPluginDatabaseForVerification(); verifyCompleted(database)",
  },
  "consumer-reachability": {
    mutant: "createWorkflowService(); verifyCompleted()",
    fixed: "verifyCompleted(); createWorkflowService()",
  },
};

const evaluateNegativeControl = (
  id: NegativeControl["id"],
  source: string,
): string | null => {
  switch (id) {
    case "fallthrough-to-v2":
      return source.includes("migrateWithPlanV2") &&
        !source.includes("plan.version === 3")
        ? "v3-fallthrough-to-v2"
        : null;
    case "plugin-self-attestation":
      return /PluginMigrationPlanV3[^}]*statementSha256/u.test(source)
        ? "plugin-supplied-expected-identity"
        : null;
    case "database-before-authority-admission":
      return source.indexOf("database()") <
        source.indexOf("resolveArtifactReviewV3Authority")
        ? "database-before-authority"
        : null;
    case "copied-production-fake-decision-logic":
      return source.includes("productionDecision") &&
        source.includes("fakeDecision") &&
        !source.includes("reduceArtifactReviewV3")
        ? "copied-adapter-decision-logic"
        : null;
    case "missing-reopened-verification":
      return source.includes("verifyCompleted") &&
        !source.includes("reopenPluginDatabaseForVerification")
        ? "verification-without-reopen"
        : null;
    case "consumer-reachability":
      return source.indexOf("createWorkflowService") <
        source.indexOf("verifyCompleted")
        ? "consumer-before-verification"
        : null;
  }
};

describe("artifact review V3 C0 closed authority", () => {
  it("admits the closed schema, exact scope, and immutable identities", () => {
    const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
    expect(validate(authority), JSON.stringify(validate.errors)).toBe(true);

    expect(authority.scope.oracleWritePaths).toEqual([
      "apps/server/src/services/plugins/migration-authorities/workflows-artifact-review-v3-construction-c0.json",
      "plugins/workflows/src/artifact-recovery-v3-construction.schema.json",
      "plugins/workflows/src/artifact-recovery-v3-construction.test.ts",
    ]);
    expect(
      new Set([
        ...authority.scope.oracleWritePaths,
        ...authority.scope.constructionPaths,
        authority.scope.ledgerPath,
        authority.scope.approvalPath,
      ]).size,
    ).toBe(16);

    for (const identity of [
      authority.identities.acceptedDesign,
      authority.identities.contextPacket,
      authority.identities.v8Approval,
      authority.identities.v12.approval,
      authority.identities.v12.ledger,
      authority.identities.failedLineage.v6Receipt,
      authority.identities.migrations.source,
    ]) {
      assertFileIdentity(identity);
    }
    assertManifestIdentity(authority.identities.v12.candidateManifest);
    assertFailedLineage(authority.identities.failedLineage.v9);
    assertFailedLineage(authority.identities.failedLineage.v10);
    assertFailedLineage(authority.identities.failedLineage.v11);
    expect(authority.identities.failedLineage.v9.files[0]).toMatchObject({
      byteLength: 155571,
      sha256:
        "4b9c4b91ee8e3a9384c92cb3fb5366be85e6cfc85756f9fe5d6026be42fd2428",
    });

    expect(existsSync(resolve(repoRoot, authority.scope.ledgerPath))).toBe(
      false,
    );
    expect(existsSync(resolve(repoRoot, authority.scope.approvalPath))).toBe(
      false,
    );
    expect(
      existsSync(resolve(repoRoot, authority.identities.v12.approval.path)),
    ).toBe(true);
  });

  it("recomputes migrations 0..22 and the preserved unrelated worktree", () => {
    const v12Authority = JSON.parse(
      readFileSync(
        resolve(
          repoRoot,
          authority.identities.v12.candidateManifest.entries[0]!.path,
        ),
        "utf8",
      ),
    ) as {
      authority: {
        migrationCatalog: Array<{
          id: number;
          byteLength: number;
          sha256: string;
          statementUtf8: string;
        }>;
      };
    };
    const migrations = v12Authority.authority.migrationCatalog;
    expect(migrations.map(({ id }) => id)).toEqual(
      Array.from({ length: 23 }, (_, id) => id),
    );
    expect(
      migrations.map(({ id, byteLength, sha256: statementSha256 }) => ({
        id,
        byteLength,
        sha256: statementSha256,
      })),
    ).toEqual(authority.identities.migrations.entries);
    for (const migration of migrations) {
      expect(
        Buffer.byteLength(migration.statementUtf8),
        String(migration.id),
      ).toBe(migration.byteLength);
      expect(sha256(migration.statementUtf8), String(migration.id)).toBe(
        migration.sha256,
      );
    }
    const vector = migrations
      .map(({ id, sha256: statementSha256 }) => `${id}:${statementSha256}`)
      .join(";");
    expect(Buffer.byteLength(vector)).toBe(
      authority.identities.migrations.vectorByteLength,
    );
    expect(sha256(vector)).toBe(authority.identities.migrations.vectorSha256);

    const baseline = authority.identities.worktreeBaseline;
    expect(runGit("rev-parse", "HEAD").toString().trim()).toBe(baseline.head);
    expect(runGit("branch", "--show-current").toString().trim()).toBe(
      baseline.branch,
    );
    expect(baseline.indexClean).toBe(true);

    const status = runGit(
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    )
      .toString()
      .split("\0")
      .filter(Boolean);
    const successorOwnedPaths = new Set([
      ...authority.scope.oracleWritePaths,
      ...authority.scope.constructionPaths,
      authority.scope.ledgerPath,
      authority.scope.approvalPath,
    ]);
    const unrelatedEntries = status
      .map((record) => ({ status: record.slice(0, 2), path: record.slice(3) }))
      .filter(({ path }) => !successorOwnedPaths.has(path))
      .map(({ path, status: fileStatus }) => {
        const absolutePath = resolve(repoRoot, path);
        const bytes = existsSync(absolutePath)
          ? readFileSync(absolutePath)
          : null;
        return {
          path,
          status: fileStatus,
          byteLength: bytes?.byteLength ?? null,
          sha256: bytes === null ? null : sha256(bytes),
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));
    const unrelatedManifest = Buffer.from(JSON.stringify(unrelatedEntries));
    expect(unrelatedEntries).toHaveLength(baseline.unrelatedFileCount);
    expect(unrelatedManifest.byteLength).toBe(
      baseline.unrelatedManifestByteLength,
    );
    expect(sha256(unrelatedManifest)).toBe(baseline.unrelatedManifestSha256);
  });

  it("kills every declared negative control without production imports or databases", () => {
    const sentinelIds = new Set(
      authority.sentinelCatalog.map((sentinel) => sentinel.id),
    );
    expect(authority.negativeControls).toHaveLength(6);
    for (const control of authority.negativeControls) {
      expect(sentinelIds.has(control.sentinelId), control.id).toBe(true);
      const fixture = negativeFixtures[control.id];
      expect(
        evaluateNegativeControl(control.id, fixture.mutant),
        control.id,
      ).toBe(control.expectedReason);
      expect(
        evaluateNegativeControl(control.id, fixture.fixed),
        control.id,
      ).toBe(null);
    }

    const testSource = readFileSync(testPath, "utf8");
    const importSpecifiers = Array.from(
      testSource.matchAll(/^import .* from "([^"]+)";$/gmu),
      (match) => match[1],
    );
    expect(importSpecifiers).not.toContain("better-sqlite3");
    expect(
      importSpecifiers.every((specifier) => !specifier?.startsWith("./")),
    ).toBe(true);
    const databaseConstructor = ["new", "Database("].join(" ");
    expect(testSource).not.toContain(databaseConstructor);
  });

  it("selects the exact real seams and stays red only for missing V3 construction", () => {
    const rows = authority.sentinelCatalog.map(evaluateSentinel);
    const report = {
      selected: rows.length,
      passed: rows.filter(({ outcome }) => outcome === "pass").length,
      failed: rows.filter(({ outcome }) => outcome === "fail").length,
      skipped: 0,
      rows,
    };

    expect(new Set(rows.map(({ id }) => id)).size).toBe(rows.length);
    expect(rows.every(({ killerReached }) => killerReached)).toBe(true);
    expect(
      rows
        .filter(({ id }) => id.startsWith("v12-"))
        .map(({ outcome }) => outcome),
    ).toEqual(Array.from({ length: 6 }, () => "fail"));
    expect(rows.find(({ id }) => id === "before-consumer-gate")).toMatchObject({
      outcome: "pass",
      reason: expect.stringMatching(/^constructed:/u),
    });
    expect({
      selected: report.selected,
      passed: report.passed,
      failed: report.failed,
      skipped: report.skipped,
    }).toEqual({
      selected: authority.prebuildOracle.selected,
      passed: authority.prebuildOracle.passed,
      failed: authority.prebuildOracle.failed,
      skipped: authority.prebuildOracle.skipped,
    });
    expect(
      rows
        .filter(({ outcome }) => outcome === "fail")
        .every(({ reason }) =>
          /^(missing-path|missing-symbol|wrong-order):/u.test(reason),
        ),
    ).toBe(true);

    if (report.failed !== 0) {
      throw new Error(
        `C0_MISSING_V3_CONSTRUCTION selected=${report.selected} passed=${report.passed} failed=${report.failed} skipped=${report.skipped}; ${rows
          .filter(({ outcome }) => outcome === "fail")
          .map(({ id, reason }) => `${id}=${reason}`)
          .join("; ")}`,
      );
    }
  });
});
