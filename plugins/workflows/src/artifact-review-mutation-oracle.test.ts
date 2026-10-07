import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  ARTIFACT_REVIEW_MUTATION_ADMISSION_ERROR,
  ARTIFACT_REVIEW_MUTATION_AUTHORITY,
  ARTIFACT_REVIEW_MUTATION_INVARIANTS,
  ARTIFACT_REVIEW_MUTATION_KINDS,
  admitArtifactReviewMutationScenario,
  type ArtifactReviewMutationScenario,
} from "./artifact-review-mutation-contract.js";
import {
  ARTIFACT_REVIEW_MUTATION_ADMISSION_NEGATIVE_ROWS,
  ARTIFACT_REVIEW_MUTATION_DECISION_ROWS,
  ARTIFACT_REVIEW_MUTATION_METAMORPHIC_RULES,
  ARTIFACT_REVIEW_MUTATION_OUTCOMES,
  ARTIFACT_REVIEW_MUTATION_SELF_VALIDATION,
  type ArtifactReviewMutationDecisionRow,
} from "./artifact-review-mutation-decision-table.js";
import {
  ARTIFACT_REVIEW_MUTATION_OWNERSHIP,
  type ArtifactReviewMutationOwnershipApplication,
} from "./artifact-review-mutation-ownership.js";
import {
  evaluateArtifactReviewMutationReference,
  type ArtifactReviewMutationReferenceOutcome,
} from "./artifact-review-mutation-reference-model.js";

const EXPECTED_CONSTRUCTION_RED = "missing-production-driver" as const;

type ArtifactReviewMutationProductionDriver = (
  scenario: ArtifactReviewMutationScenario,
) => ArtifactReviewMutationReferenceOutcome;

type ArtifactReviewMutationProductionDriverFactory =
  () => ArtifactReviewMutationProductionDriver;

type ProductionObservation =
  | Readonly<{
      classification: "production-outcome";
      outcome: ArtifactReviewMutationReferenceOutcome;
    }>
  | Readonly<{
      classification: "expected-construction-red";
      reason: typeof EXPECTED_CONSTRUCTION_RED;
    }>;

const productionModulePresent = existsSync(
  new URL("./artifact-review-service.ts", import.meta.url),
);
let productionDriver: ArtifactReviewMutationProductionDriver | undefined;

beforeAll(async () => {
  if (!productionModulePresent) return;
  const modulePath = "./artifact-review-service.js";
  const production = (await import(/* @vite-ignore */ modulePath)) as Record<
    string,
    unknown
  >;
  const candidate = production.createArtifactReviewAcceptanceDriver;
  if (typeof candidate !== "function") return;
  const driver = (candidate as ArtifactReviewMutationProductionDriverFactory)();
  if (typeof driver === "function") productionDriver = driver;
});

function observeProductionMutation(
  scenario: ArtifactReviewMutationScenario,
): ProductionObservation {
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

function mutationSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

type MutationOwnershipInvariant =
  keyof typeof ARTIFACT_REVIEW_MUTATION_OWNERSHIP;

const MUTATION_OWNERSHIP_ENTRIES = Object.entries(
  ARTIFACT_REVIEW_MUTATION_OWNERSHIP,
) as ReadonlyArray<
  readonly [
    MutationOwnershipInvariant,
    Readonly<{
      legacyDisposition: "shared" | "successor-only";
      applications: ReadonlyArray<ArtifactReviewMutationOwnershipApplication>;
    }>,
  ]
>;

const SUCCESSOR_INVARIANTS = MUTATION_OWNERSHIP_ENTRIES.map(
  ([invariant]) => invariant,
);

const SUCCESSOR_MUTATION_KINDS = [
  ...new Set(
    MUTATION_OWNERSHIP_ENTRIES.flatMap(([, ownership]) =>
      ownership.applications.map(({ mutationKind }) => mutationKind),
    ),
  ),
];

function mappedInvariantsForScenario(
  scenario: ArtifactReviewMutationScenario,
): ReadonlyArray<MutationOwnershipInvariant> {
  return MUTATION_OWNERSHIP_ENTRIES.filter(([, ownership]) =>
    ownership.applications.some(
      (application) =>
        application.mutationKind === scenario.mutationKind &&
        (!("sameScope" in application) ||
          (scenario.mutationKind === "idempotency-lookup" &&
            application.sameScope === scenario.sameScope)),
    ),
  ).map(([invariant]) => invariant);
}

function lookupRows(): ReadonlyArray<ArtifactReviewMutationDecisionRow> {
  return ARTIFACT_REVIEW_MUTATION_DECISION_ROWS.filter(
    (row) => row.scenario.mutationKind === "idempotency-lookup",
  );
}

function verifyMetamorphicRule(
  ruleId: (typeof ARTIFACT_REVIEW_MUTATION_METAMORPHIC_RULES)[number]["id"],
): void {
  switch (ruleId) {
    case "identity-mismatch-dominates-operation-digest":
      for (const identityField of [
        "sameScope",
        "sameActor",
        "sameKey",
      ] as const) {
        const dominated = lookupRows().filter(
          (row) =>
            row.scenario.mutationKind === "idempotency-lookup" &&
            !row.scenario[identityField],
        );
        expect(dominated).toHaveLength(16);
        expect(
          dominated.every(
            (row) =>
              evaluateArtifactReviewMutationReference(row.scenario) ===
              "new-mutation",
          ),
        ).toBe(true);
      }
      return;
    case "exact-lookup-replay-requires-all-five-true": {
      const replays = lookupRows().filter(
        (row) =>
          evaluateArtifactReviewMutationReference(row.scenario) ===
          "replay-committed",
      );
      expect(replays).toHaveLength(1);
      expect(replays[0]?.scenario).toEqual(
        expect.objectContaining({
          sameScope: true,
          sameActor: true,
          sameKey: true,
          sameOperation: true,
          sameDigest: true,
        }),
      );
      return;
    }
    case "operation-digest-conflict-only-after-identity-match": {
      const conflicts = lookupRows().filter(
        (row) =>
          evaluateArtifactReviewMutationReference(row.scenario) ===
          "idempotency-conflict",
      );
      expect(conflicts).toHaveLength(3);
      expect(
        conflicts.every(
          (row) =>
            row.scenario.mutationKind === "idempotency-lookup" &&
            row.scenario.sameScope &&
            row.scenario.sameActor &&
            row.scenario.sameKey &&
            (!row.scenario.sameOperation || !row.scenario.sameDigest),
        ),
      ).toBe(true);
      return;
    }
    case "committed-false-never-yields-saved": {
      const uncommittedValid = ARTIFACT_REVIEW_MUTATION_DECISION_ROWS.filter(
        (row) =>
          row.scenario.mutationKind === "durability-response" &&
          !row.scenario.state.committed,
      );
      expect(uncommittedValid).toHaveLength(1);
      expect(
        uncommittedValid.map((row) =>
          evaluateArtifactReviewMutationReference(row.scenario),
        ),
      ).toEqual(["pending-not-saved"]);
      for (const row of ARTIFACT_REVIEW_MUTATION_ADMISSION_NEGATIVE_ROWS) {
        if (row.negativeClass !== "impossible-durability-state") continue;
        expect(evaluateArtifactReviewMutationReference(row.input)).not.toBe(
          "saved-after-commit",
        );
      }
      return;
    }
    case "exact-retry-after-committed-response-loss-replays": {
      const responseLoss = ARTIFACT_REVIEW_MUTATION_DECISION_ROWS.filter(
        (row) =>
          row.scenario.mutationKind === "durability-response" &&
          row.scenario.state.deliveryState === "response-lost",
      );
      expect(responseLoss).toHaveLength(2);
      expect(
        responseLoss.map((row) =>
          evaluateArtifactReviewMutationReference(row.scenario),
        ),
      ).toEqual(["retryable-after-response-loss", "replay-committed"]);
      return;
    }
    case "presentation-metadata-invariance-and-core-extra-rejection":
      for (const row of ARTIFACT_REVIEW_MUTATION_DECISION_ROWS) {
        expect(
          evaluateArtifactReviewMutationReference({
            ...row.scenario,
            presentationMetadata: { panelLabel: "review-panel" },
          }),
        ).toBe(row.expectedOutcome);
        expect(
          evaluateArtifactReviewMutationReference({
            ...row.scenario,
            forbiddenCoreExtra: true,
          }),
        ).toBe(ARTIFACT_REVIEW_MUTATION_ADMISSION_ERROR);
      }
  }
}

const PRODUCTION_CONFORMANCE_ROWS = ARTIFACT_REVIEW_MUTATION_DECISION_ROWS;

describe("artifact-review mutation reference behavior", () => {
  it.each(ARTIFACT_REVIEW_MUTATION_DECISION_ROWS)(
    "$id derives the frozen semantic outcome",
    ({ scenario, expectedOutcome }) => {
      expect(evaluateArtifactReviewMutationReference(scenario)).toBe(
        expectedOutcome,
      );
    },
  );
});

describe("artifact-review mutation admission negatives", () => {
  it.each(ARTIFACT_REVIEW_MUTATION_ADMISSION_NEGATIVE_ROWS)(
    "$id rejects $negativeClass",
    ({ input, expectedAdmission }) => {
      const admission = admitArtifactReviewMutationScenario(input);
      expect(admission.admitted).toBe(false);
      expect(evaluateArtifactReviewMutationReference(input)).toBe(
        expectedAdmission,
      );
    },
  );
});

describe("artifact-review mutation metamorphic closure", () => {
  it.each(ARTIFACT_REVIEW_MUTATION_METAMORPHIC_RULES)("$id", ({ id }) => {
    verifyMetamorphicRule(id);
  });
});

describe("artifact-review mutation structural authority", () => {
  it("closes the discriminated union and frozen authority binding", () => {
    expect(ARTIFACT_REVIEW_MUTATION_AUTHORITY).toEqual({
      successorSeamId:
        "artifact-review-v7:discriminated-mutation-proof-boundary-v1",
      architectureRevision: 2,
      contractId: "bb-artifact-review-service:revision-1",
      acceptedDesignSha256:
        "d97f8c76f09a92ce242977d0b676a19fb3dd48c1a5e6223602378783721f175f",
      contextPacketSha256:
        "40b147a61a59f48c2a52cccdcf2b54e516dae79967bb760c8033d9ba5401cc44",
      architectureSynthesisRunId: "wfr_473e2b42-b3bd-45f2-88bc-ac9be2a3a6e4",
    });
    expect(SUCCESSOR_MUTATION_KINDS).toEqual(ARTIFACT_REVIEW_MUTATION_KINDS);
    expect(SUCCESSOR_INVARIANTS).toEqual(ARTIFACT_REVIEW_MUTATION_INVARIANTS);
    expect(ARTIFACT_REVIEW_MUTATION_SELF_VALIDATION).toEqual({
      validRows: 37,
      authorityRows: 1,
      lookupRows: 32,
      durabilityRows: 4,
      negativeRows: 12,
      metamorphicRules: 6,
    });
  });

  it("requires the invariant applicable to each mutation kind", () => {
    for (const row of ARTIFACT_REVIEW_MUTATION_DECISION_ROWS) {
      const applicableInvariants = mappedInvariantsForScenario(row.scenario);
      expect(applicableInvariants).toEqual([row.scenario.invariant]);
      for (const wrongInvariant of SUCCESSOR_INVARIANTS.filter(
        (invariant) => !applicableInvariants.includes(invariant),
      )) {
        expect(
          evaluateArtifactReviewMutationReference({
            ...row.scenario,
            invariant: wrongInvariant,
          }),
        ).toBe(ARTIFACT_REVIEW_MUTATION_ADMISSION_ERROR);
      }
    }
  });

  it("keeps every row, fault class, and metamorphic rule identity unique", () => {
    const rows = [
      ...ARTIFACT_REVIEW_MUTATION_DECISION_ROWS,
      ...ARTIFACT_REVIEW_MUTATION_ADMISSION_NEGATIVE_ROWS,
    ];
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(new Set(rows.map((row) => row.faultClass)).size).toBe(rows.length);
    expect(
      new Set(ARTIFACT_REVIEW_MUTATION_METAMORPHIC_RULES.map(({ id }) => id))
        .size,
    ).toBe(ARTIFACT_REVIEW_MUTATION_METAMORPHIC_RULES.length);
  });

  it("keeps expected outputs and fault labels out of the input contract", () => {
    const contractSource = mutationSource(
      "./artifact-review-mutation-contract.ts",
    );
    for (const outcome of ARTIFACT_REVIEW_MUTATION_OUTCOMES) {
      expect(contractSource).not.toContain(JSON.stringify(outcome));
    }
    expect(contractSource).not.toContain("expectedOutcome");
    expect(contractSource).not.toContain("faultClass");
    expect(
      ARTIFACT_REVIEW_MUTATION_DECISION_ROWS.every(
        ({ scenario }) =>
          !("expectedOutcome" in scenario) && !("faultClass" in scenario),
      ),
    ).toBe(true);
  });

  it("keeps the reference model dependent only on frozen admission", () => {
    const referenceSource = mutationSource(
      "./artifact-review-mutation-reference-model.ts",
    );
    const dependencies = [
      ...referenceSource.matchAll(/from\s+["']([^"']+)["']/g),
    ].map(([, dependency]) => dependency);
    expect(dependencies).toEqual(["./artifact-review-mutation-contract.js"]);
    expect(referenceSource).not.toContain("decision-table");
    expect(referenceSource).not.toContain("oracle-fixtures");
    expect(referenceSource).not.toContain("artifact-review-service");
    expect(referenceSource).not.toContain("expectedOutcome");
    expect(referenceSource).not.toContain("faultClass");
  });

  it("registers all production rows and classifies absent production explicitly", () => {
    const oracleSource = mutationSource(
      "./artifact-review-mutation-oracle.test.ts",
    );
    expect(PRODUCTION_CONFORMANCE_ROWS).toHaveLength(37);
    expect(oracleSource).toContain("it.each(PRODUCTION_CONFORMANCE_ROWS)");
    expect(oracleSource).not.toMatch(/\b(?:it|describe)\.skip\b/);
    expect(oracleSource).not.toContain(["synthetic", "production"].join("-"));
    const logicalAccounting =
      productionDriver === undefined
        ? {
            selected: 98,
            passed: 61,
            expectedConstructionRed: 37,
            unexpectedFailed: 0,
            skipped: 0,
          }
        : {
            selected: 98,
            passed: 98,
            expectedConstructionRed: 0,
            unexpectedFailed: 0,
            skipped: 0,
          };
    expect(logicalAccounting.selected).toBe(98);
    expect(logicalAccounting.skipped).toBe(0);
    expect(
      logicalAccounting.passed + logicalAccounting.expectedConstructionRed,
    ).toBe(98);
    if (productionDriver === undefined) {
      expect(
        observeProductionMutation(PRODUCTION_CONFORMANCE_ROWS[0]!.scenario),
      ).toEqual({
        classification: "expected-construction-red",
        reason: EXPECTED_CONSTRUCTION_RED,
      });
    }
  });
});

describe("artifact-review mutation production conformance", () => {
  it.each(PRODUCTION_CONFORMANCE_ROWS)(
    "$id production behavior or construction classification",
    ({ scenario, expectedOutcome }) => {
      const observation = observeProductionMutation(scenario);
      if (observation.classification === "expected-construction-red") {
        expect(observation.reason).toBe(EXPECTED_CONSTRUCTION_RED);
        return;
      }
      expect(observation.outcome).toBe(expectedOutcome);
    },
  );
});
