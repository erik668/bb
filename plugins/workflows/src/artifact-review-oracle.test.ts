import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { migrations } from "./data.js";
import {
  ARTIFACT_REVIEW_ACCEPTANCE_SURFACES,
  ARTIFACT_REVIEW_ARCHITECTURE_REVISION,
  ARTIFACT_REVIEW_CONTRACT_ID,
  ARTIFACT_REVIEW_INVARIANTS,
  ARTIFACT_REVIEW_LEGACY_COMPATIBILITY,
  ARTIFACT_REVIEW_OBJECTIVE_CLOSURE,
  ARTIFACT_REVIEW_ORACLE_CASES,
  MIGRATION_ORACLE,
  RECOVERY_DESCRIPTOR_ORACLE,
  RECOVERY_EDGE_ORACLE,
  RECOVERY_FAULT_POINTS,
  RECOVERY_MIGRATION_22_SQL,
  RECOVERY_MIGRATION_SHA256,
  RECOVERY_PRE18_LEDGER_ORACLE,
  RECOVERY_RECIPE_MANIFEST,
  RECOVERY_STATE_ORACLE,
  REQUIRED_ARTIFACT_KINDS,
  TERMINAL_WRITER_ORACLE,
  ARTIFACT_REVIEW_SUCCESSOR_MANIFEST_PATHS,
  evaluateArtifactReviewContract,
} from "./artifact-review-oracle-fixtures.js";
import type { ArtifactReviewAcceptanceDriver } from "./artifact-review-oracle-fixtures.js";
import type { ArtifactReviewInvariantId } from "./artifact-review-oracle-fixtures.js";
import {
  ARTIFACT_REVIEW_MUTATION_AUTHORITY,
  ARTIFACT_REVIEW_MUTATION_INVARIANTS,
} from "./artifact-review-mutation-contract.js";
import { ARTIFACT_REVIEW_MUTATION_SELF_VALIDATION } from "./artifact-review-mutation-decision-table.js";
import {
  ARTIFACT_REVIEW_MUTATION_OWNERSHIP,
  ARTIFACT_REVIEW_MUTATION_OWNERSHIP_MODULE,
  type ArtifactReviewMutationLegacyDisposition,
  type ArtifactReviewMutationOwnershipApplication,
} from "./artifact-review-mutation-ownership.js";

type ArtifactReviewAcceptanceDriverFactory =
  () => ArtifactReviewAcceptanceDriver;

let productionFactory: ArtifactReviewAcceptanceDriverFactory | undefined;
let productionDriver: ArtifactReviewAcceptanceDriver | undefined;
const EXPECTED_CONSTRUCTION_RED = "missing-production-driver" as const;
const productionModulePresent = existsSync(
  new URL("./artifact-review-service.ts", import.meta.url),
);

const MUTATION_OWNERSHIP_ENTRIES = Object.entries(
  ARTIFACT_REVIEW_MUTATION_OWNERSHIP,
) as ReadonlyArray<
  readonly [
    ArtifactReviewInvariantId,
    Readonly<{
      legacyDisposition: ArtifactReviewMutationLegacyDisposition;
      applications: ReadonlyArray<ArtifactReviewMutationOwnershipApplication>;
    }>,
  ]
>;

const SUCCESSOR_INVARIANT_IDS = MUTATION_OWNERSHIP_ENTRIES.map(
  ([invariant]) => invariant,
);
const SUCCESSOR_ONLY_INVARIANT_IDS = MUTATION_OWNERSHIP_ENTRIES.filter(
  ([, ownership]) => ownership.legacyDisposition === "successor-only",
).map(([invariant]) => invariant);
const SHARED_INVARIANT_IDS = MUTATION_OWNERSHIP_ENTRIES.filter(
  ([, ownership]) => ownership.legacyDisposition === "shared",
).map(([invariant]) => invariant);

beforeAll(async () => {
  if (!productionModulePresent) return;
  const modulePath = "./artifact-review-service.js";
  const production = (await import(/* @vite-ignore */ modulePath)) as Record<
    string,
    unknown
  >;
  const candidate = production.createArtifactReviewAcceptanceDriver;
  if (typeof candidate === "function") {
    productionFactory = candidate as ArtifactReviewAcceptanceDriverFactory;
    const driver = productionFactory();
    if (typeof driver === "function") productionDriver = driver;
  }
});

function observeProductionContract(
  scenario: Parameters<ArtifactReviewAcceptanceDriver>[0],
):
  | Readonly<{ classification: "production-outcome"; outcome: string }>
  | Readonly<{
      classification: "expected-construction-red";
      reason: typeof EXPECTED_CONSTRUCTION_RED;
    }> {
  if (productionDriver === undefined) {
    return {
      classification: "expected-construction-red",
      reason: EXPECTED_CONSTRUCTION_RED,
    };
  }
  return {
    classification: "production-outcome",
    outcome: productionDriver(scenario),
  };
}

describe("frozen artifact-review acceptance oracle", () => {
  it("is bound to the approved architecture and contract revisions", () => {
    expect(ARTIFACT_REVIEW_ARCHITECTURE_REVISION).toBe(2);
    expect(ARTIFACT_REVIEW_CONTRACT_ID).toBe(
      "bb-artifact-review-service:revision-1",
    );
    expect(ARTIFACT_REVIEW_MUTATION_AUTHORITY.architectureRevision).toBe(
      ARTIFACT_REVIEW_ARCHITECTURE_REVISION,
    );
    expect(ARTIFACT_REVIEW_MUTATION_AUTHORITY.contractId).toBe(
      ARTIFACT_REVIEW_CONTRACT_ID,
    );
    expect(ARTIFACT_REVIEW_MUTATION_SELF_VALIDATION).toEqual(
      expect.objectContaining({
        validRows: 37,
        negativeRows: 12,
        metamorphicRules: 6,
      }),
    );
  });

  it("has unique invariant, case, and fault-class identities", () => {
    const invariantIds = ARTIFACT_REVIEW_INVARIANTS.map(([id]) => id);
    const caseIds = ARTIFACT_REVIEW_ORACLE_CASES.map(({ id }) => id);
    const faults = ARTIFACT_REVIEW_ORACLE_CASES.map(
      ({ uniqueFault }) => uniqueFault,
    );
    expect(new Set(invariantIds).size).toBe(invariantIds.length);
    expect(new Set(caseIds).size).toBe(caseIds.length);
    expect(new Set(faults).size).toBe(faults.length);
    expect(
      ARTIFACT_REVIEW_ORACLE_CASES.every(
        ({ id, expected, uniqueFault }) =>
          id.length > 0 && expected.length > 0 && uniqueFault.length > 0,
      ),
    ).toBe(true);
  });

  it("delegates mutation behavior exclusively to the discriminated successor proof", () => {
    expect(
      ARTIFACT_REVIEW_ORACLE_CASES.some(
        ({ id, domain }) =>
          id.startsWith("mutation-") || String(domain) === "mutation",
      ),
    ).toBe(false);
    expect(SUCCESSOR_INVARIANT_IDS).toEqual(
      ARTIFACT_REVIEW_MUTATION_INVARIANTS,
    );
  });

  it("keeps expected outcomes and fault labels outside the production driver input", () => {
    const scenarios = ARTIFACT_REVIEW_ORACLE_CASES.map(
      ({ invariant, domain, input }) => ({ invariant, domain, input }),
    );
    expect(
      scenarios.every(
        (scenario) => !("expected" in scenario) && !("uniqueFault" in scenario),
      ),
    ).toBe(true);
  });

  it("freezes every acceptance surface before production construction", () => {
    expect(ARTIFACT_REVIEW_ACCEPTANCE_SURFACES).toEqual([
      [
        "mutation-contract",
        "plugins/workflows/src/artifact-review-mutation-contract.ts",
        expect.any(String),
      ],
      [
        ARTIFACT_REVIEW_MUTATION_OWNERSHIP_MODULE.surfaceId,
        ARTIFACT_REVIEW_MUTATION_OWNERSHIP_MODULE.path,
        expect.any(String),
      ],
      [
        "mutation-decision-table",
        "plugins/workflows/src/artifact-review-mutation-decision-table.ts",
        expect.any(String),
      ],
      [
        "mutation-reference-model",
        "plugins/workflows/src/artifact-review-mutation-reference-model.ts",
        expect.any(String),
      ],
      [
        "mutation-oracle-suite",
        "plugins/workflows/src/artifact-review-mutation-oracle.test.ts",
        expect.any(String),
      ],
      [
        "oracle-fixtures",
        "plugins/workflows/src/artifact-review-oracle-fixtures.ts",
        expect.any(String),
      ],
      [
        "oracle-suite",
        "plugins/workflows/src/artifact-review-oracle.test.ts",
        expect.any(String),
      ],
      [
        "artifact-storage-anchor",
        "plugins/workflows/src/artifact-storage.test.ts",
        expect.any(String),
      ],
      [
        "sdk-review-contract",
        "packages/plugin-sdk/src/__tests__/artifact-review-contract.test.tsx",
        expect.any(String),
      ],
      [
        "host-renderer-contract",
        "apps/app/src/components/plugin/PluginArtifactReview.acceptance.test.tsx",
        expect.any(String),
      ],
      [
        "production-driver",
        "plugins/workflows/src/artifact-review-service.ts#createArtifactReviewAcceptanceDriver",
        expect.any(String),
      ],
    ]);
    expect(ARTIFACT_REVIEW_SUCCESSOR_MANIFEST_PATHS).toHaveLength(9);
    expect(
      [...ARTIFACT_REVIEW_SUCCESSOR_MANIFEST_PATHS].sort((left, right) =>
        left.localeCompare(right),
      ),
    ).toEqual(
      [
        "plugins/workflows/src/artifact-review-mutation-contract.ts",
        ARTIFACT_REVIEW_MUTATION_OWNERSHIP_MODULE.path,
        "plugins/workflows/src/artifact-review-mutation-decision-table.ts",
        "plugins/workflows/src/artifact-review-mutation-reference-model.ts",
        "plugins/workflows/src/artifact-review-mutation-oracle.test.ts",
        "plugins/workflows/src/artifact-review-oracle-fixtures.ts",
        "plugins/workflows/src/artifact-review-oracle.test.ts",
        "packages/plugin-sdk/src/__tests__/artifact-review-contract.test.tsx",
        "apps/app/src/components/plugin/PluginArtifactReview.acceptance.test.tsx",
      ].sort((left, right) => left.localeCompare(right)),
    );
  });

  it("freezes architecture-revision-2 compatibility under contract revision 1", () => {
    expect(ARTIFACT_REVIEW_LEGACY_COMPATIBILITY.map(([id]) => id)).toEqual([
      "feature-off-replay-identity",
      "legacy-integrity-isolation",
      "may-have-run-migrations-immutable",
      "presentation-is-not-artifact-identity",
      "service-derived-actors",
      "operation-excluded-from-mutation-identity",
    ]);
  });

  it("covers every required contract boundary and every case names an invariant", () => {
    const ids = new Set<ArtifactReviewInvariantId>(
      ARTIFACT_REVIEW_INVARIANTS.map(([id]) => id),
    );
    expect([...ids]).toEqual([
      "restart-migration",
      "migration-ledger",
      "pre18-quarantine-recovery",
      "origin-scope",
      "controller-authority",
      "local-owner",
      "immutable-bytes",
      "revision-anchor",
      "idempotency",
      "source-apply",
      "renderer",
      "single-steward",
      "architect-admission",
      "snapshot-races",
      "ordered-delivery",
      "acknowledgement",
      "stale-evidence",
      "promotion",
      "off-by-default",
      "terminal-writers",
      "one-repair-policy",
      "retention",
      "cross-environment",
    ]);
    expect(
      ARTIFACT_REVIEW_ORACLE_CASES.every(({ invariant }) => ids.has(invariant)),
    ).toBe(true);
    const caseInvariantIds = new Set<ArtifactReviewInvariantId>(
      ARTIFACT_REVIEW_ORACLE_CASES.map(({ invariant }) => invariant),
    );
    const uncoveredInvariantIds = [...ids].filter(
      (id) => !caseInvariantIds.has(id),
    );
    const legacyCaseCount = (invariant: ArtifactReviewInvariantId): number =>
      ARTIFACT_REVIEW_ORACLE_CASES.filter(
        (oracleCase) => oracleCase.invariant === invariant,
      ).length;
    expect(uncoveredInvariantIds).toEqual(SUCCESSOR_ONLY_INVARIANT_IDS);
    expect(
      SUCCESSOR_ONLY_INVARIANT_IDS.map((invariant) => [
        invariant,
        legacyCaseCount(invariant),
      ]),
    ).toEqual([
      ["local-owner", 0],
      ["idempotency", 0],
    ]);
    expect(
      SHARED_INVARIANT_IDS.map((invariant) => [
        invariant,
        legacyCaseCount(invariant),
      ]),
    ).toEqual([["origin-scope", 3]]);
    const objectiveInvariantIds = ARTIFACT_REVIEW_OBJECTIVE_CLOSURE.flatMap(
      ([, invariantIds]) => invariantIds,
    );
    expect(new Set(objectiveInvariantIds)).toEqual(ids);
    expect(objectiveInvariantIds).toHaveLength(ids.size);
  });

  it("freezes the required workflow inspector artifact set", () => {
    expect(REQUIRED_ARTIFACT_KINDS).toEqual([
      "requirements",
      "architecture",
      "decisions",
    ]);
  });

  it("freezes the complete terminal-writer predicate surface", () => {
    expect(TERMINAL_WRITER_ORACLE).toEqual([
      "claimQueuedRun",
      "settleRun",
      "recoverInterruptedRuns",
      "startCall-replay-upsert",
      "attachCallThread",
      "queueCallProviderRetry",
      "storeStructuredResult",
      "settleCall",
      "idle-fallback",
      "checkpoint-terminal",
      "cancelRun",
      "promotion",
    ]);
    expect(
      ARTIFACT_REVIEW_ORACLE_CASES.filter(
        ({ invariant }) => invariant === "terminal-writers",
      ).map(({ input }) => ("writer" in input ? input.writer : undefined)),
    ).toEqual(TERMINAL_WRITER_ORACLE);
  });

  it("freezes the admitted append-only migration corrections", () => {
    expect(MIGRATION_ORACLE).toEqual(
      expect.objectContaining({
        mode: "append-only-non-destructive",
        artifactScopedIntegrity: true,
        artifactRpcRegistrationAfterMigration: true,
        artifactRpcRemainsDarkAfterRecovery: true,
        artifactUiRendererRemainsDarkAfterRecovery: true,
        preserveLegacyOrphans: true,
        pinEveryMayHaveRunStatement: true,
        rebuildIdentityWithoutPresentationThread: true,
        rebuildPreservesExistingRows: true,
        mutationPrimaryKeyExcludesOperationKind: true,
        normalizeLegacyNullScopeBeforeArtifactJoin: true,
      }),
    );
  });

  it("freezes immutable migration hashes 0 through 22", () => {
    expect(RECOVERY_MIGRATION_SHA256.map(([id]) => id)).toEqual(
      Array.from({ length: 23 }, (_, id) => id),
    );
    expect(
      RECOVERY_MIGRATION_SHA256.every(([, sha256]) =>
        /^[a-f0-9]{64}$/.test(sha256),
      ),
    ).toBe(true);
    expect(
      createHash("sha256").update(RECOVERY_MIGRATION_22_SQL).digest("hex"),
    ).toBe(RECOVERY_MIGRATION_SHA256[22]?.[1]);
    expect(RECOVERY_DESCRIPTOR_ORACLE.migration18Sha256).toBe(
      RECOVERY_MIGRATION_SHA256[18]?.[1],
    );
    expect([22, 23]).toContain(migrations.length);
    expect(
      migrations.map((statement, id) => [
        id,
        createHash("sha256").update(statement).digest("hex"),
      ]),
    ).toEqual(RECOVERY_MIGRATION_SHA256.slice(0, migrations.length));
  });

  it("freezes the hash-bound pre-18 recovery descriptor and recipe", () => {
    expect(RECOVERY_DESCRIPTOR_ORACLE).toEqual({
      recoveryId: "artifact-review-v6:hash-bound-pre18-quarantine-recovery-v1",
      beforeMigrationId: 18,
      migration18Sha256:
        "aa760982bf7d933ab902f867062d4c11482e64a177b49db5ccdf3ec56dc0f91d",
      preSchemaFingerprintAlgorithm:
        "SHA-256(JSON.stringify sqlite_master rows ordered by type,name,tbl_name; keys type,name,tableName,sql)",
      preSchemaFingerprintSha256:
        "51a8174aa115545aebc378063c3d1a612ab5561ea22932bd744dea0506fa5afa",
      recoveryRecipeSha256:
        "a13f7073da036d0f163b640779710327cd88dca9b2cd75259aef39a0afe5c6b5",
    });
    expect(
      createHash("sha256")
        .update(JSON.stringify(RECOVERY_RECIPE_MANIFEST))
        .digest("hex"),
    ).toBe(RECOVERY_DESCRIPTOR_ORACLE.recoveryRecipeSha256);
  });

  it("reconstructs the exact pre-18 ledger and canonical schema fingerprint from migrations 0 through 17", () => {
    const database = new Database(":memory:");
    try {
      database.exec(
        "CREATE TABLE _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
      );
      const recordMigration = database.prepare(
        "INSERT INTO _bb_migrations (id, applied_at) VALUES (?, ?)",
      );
      for (
        let id = 0;
        id < RECOVERY_DESCRIPTOR_ORACLE.beforeMigrationId;
        id++
      ) {
        const statement = migrations[id];
        expect(statement).toBeTypeOf("string");
        database.exec(statement as string);
        recordMigration.run(id, id);
      }

      const ledger = database
        .prepare(
          "SELECT id, applied_at AS appliedAt FROM _bb_migrations ORDER BY id",
        )
        .all();
      expect(ledger).toEqual(RECOVERY_PRE18_LEDGER_ORACLE);
      expect(ledger.map((row) => (row as { id: number }).id)).toEqual(
        Array.from({ length: 18 }, (_, id) => id),
      );

      const sqliteMaster = database
        .prepare(
          "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name, tbl_name",
        )
        .all();
      expect(
        createHash("sha256").update(JSON.stringify(sqliteMaster)).digest("hex"),
      ).toBe(RECOVERY_DESCRIPTOR_ORACLE.preSchemaFingerprintSha256);
    } finally {
      database.close();
    }
  });

  it("fails closed outside the exact blocked pre-18 state", () => {
    expect(RECOVERY_STATE_ORACLE).toEqual([
      ["fresh", "ordinary-append-only"],
      ["migration-18-applied", "ordinary-append-only"],
      ["exact-blocked-pre18", "recover-in-one-transaction"],
      ["failed-ledger", "fail-closed"],
      ["noncontiguous-ledger", "fail-closed"],
      ["future-ledger", "fail-closed"],
      ["malformed-ledger", "fail-closed"],
      ["partial-recovery", "fail-closed"],
      ["migration-hash-mismatch", "fail-closed"],
      ["schema-fingerprint-mismatch", "fail-closed"],
      ["recovery-recipe-hash-mismatch", "fail-closed"],
      ["old-host-without-v2", "fail-closed"],
    ]);
  });

  it("freezes collision, parity, restart, corruption, startup, and dark-feature outcomes", () => {
    const outcomes = new Map<string, string>(RECOVERY_EDGE_ORACLE);
    expect(outcomes.get("collision-free-origin")).toBe(
      "canonical-active-artifact",
    );
    for (const collision of RECOVERY_RECIPE_MANIFEST.collisionClasses) {
      expect(outcomes.get(collision)).toBe(
        "reversible-quarantine-no-active-artifact",
      );
    }
    expect(outcomes.get("every-v1-table-row-parity")).toBe(
      "identical-canonical-row-multiset",
    );
    expect(outcomes.get("referenced-blob-byte-parity")).toBe(
      "identical-byte-multiset",
    );
    expect(outcomes.get("restart-after-success")).toBe(
      "idempotent-recovery-receipt",
    );
    expect(outcomes.get("restart-after-fault")).toBe("original-pre18-state");
    expect(outcomes.get("active-corruption")).toBe("rollback-and-fail-closed");
    expect(outcomes.get("quarantine-corruption")).toBe(
      "rollback-and-fail-closed",
    );
    expect(outcomes.get("service-before-migration-21")).toBe(
      "startup-rejected",
    );
    expect(outcomes.get("artifact-rpc-before-recovery")).toBe(
      "startup-rejected",
    );
    expect(outcomes.get("artifact-rpc-after-recovery")).toBe("disabled");
    expect(outcomes.get("artifact-ui-renderer-after-recovery")).toBe(
      "disabled",
    );
    expect(outcomes.get("live-change-request-after-recovery")).toBe("disabled");
  });

  it("freezes every rollback point through the separate recovery ledger", () => {
    expect(RECOVERY_FAULT_POINTS).toEqual([
      "post-admission-pre-first-write",
      ...RECOVERY_RECIPE_MANIFEST.stageTables.map((table) => `stage:${table}`),
      "remove-staged-components",
      "migration:18",
      "migration-ledger:18",
      "migration:19",
      "migration-ledger:19",
      "migration:20",
      "migration-ledger:20",
      "migration:21",
      "migration-ledger:21",
      "migration:22",
      "migration-ledger:22",
      "restore-presentation-grants",
      "adopt-quarantine",
      "write-recovery-receipt",
      "verify-active-integrity",
      "verify-quarantine-integrity",
      "write-host-recovery-ledger",
    ]);
    expect(new Set(RECOVERY_FAULT_POINTS).size).toBe(
      RECOVERY_FAULT_POINTS.length,
    );
  });

  describe("oracle-independent artifact-review behavior matrix", () => {
    it.each(ARTIFACT_REVIEW_ORACLE_CASES)(
      "$id kills: $uniqueFault",
      ({ invariant, domain, input, expected }) => {
        expect(
          evaluateArtifactReviewContract({ invariant, domain, input }),
        ).toBe(expected);
      },
    );
  });
});

describe("artifact-review production conformance sentinel", () => {
  it("classifies an absent production acceptance driver as construction red", () => {
    const first = ARTIFACT_REVIEW_ORACLE_CASES[0];
    expect(first).toBeDefined();
    const observation = observeProductionContract({
      invariant: first!.invariant,
      domain: first!.domain,
      input: first!.input,
    });
    if (observation.classification === "expected-construction-red") {
      expect(observation.reason).toBe(EXPECTED_CONSTRUCTION_RED);
      return;
    }
    expect(productionModulePresent).toBe(true);
    expect(productionFactory).toBeTypeOf("function");
    expect(productionDriver).toBeTypeOf("function");
  });

  it.each(ARTIFACT_REVIEW_ORACLE_CASES)(
    "$id production behavior or construction classification",
    ({ invariant, domain, input, expected }) => {
      const observation = observeProductionContract({
        invariant,
        domain,
        input,
      });
      if (observation.classification === "expected-construction-red") {
        expect(observation.reason).toBe(EXPECTED_CONSTRUCTION_RED);
        return;
      }
      expect(observation.outcome).toBe(expected);
    },
  );
});
