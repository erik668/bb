import {
  ARTIFACT_REVIEW_MUTATION_ADMISSION_ERROR,
  admitArtifactReviewMutationScenario,
  type ArtifactReviewAuthorityInput,
  type ArtifactReviewDurabilityResponse,
  type ArtifactReviewIdempotencyLookup,
  type ArtifactReviewMutationScenario,
} from "./artifact-review-mutation-contract.js";

export const ARTIFACT_REVIEW_MUTATION_OUTCOMES = [
  "reject-authority-input",
  "new-mutation",
  "replay-committed",
  "idempotency-conflict",
  "pending-not-saved",
  "saved-after-commit",
  "retryable-after-response-loss",
] as const;

export type ArtifactReviewMutationOutcome =
  (typeof ARTIFACT_REVIEW_MUTATION_OUTCOMES)[number];

export type ArtifactReviewMutationDecisionRow = Readonly<{
  id: string;
  scenario: ArtifactReviewMutationScenario;
  expectedOutcome: ArtifactReviewMutationOutcome;
  faultClass: string;
}>;

export type ArtifactReviewMutationAdmissionNegativeRow = Readonly<{
  id: string;
  input: unknown;
  expectedAdmission: typeof ARTIFACT_REVIEW_MUTATION_ADMISSION_ERROR;
  faultClass: string;
  negativeClass:
    | "lookup-required-field-omission"
    | "impossible-durability-state"
    | "cross-variant-field-contamination";
}>;

export type ArtifactReviewMutationMetamorphicRule = Readonly<{
  id: string;
  name: string;
  assertion: string;
}>;

const BOOLEAN_VALUES = [false, true] as const;

function expectedLookupOutcome(
  scenario: ArtifactReviewIdempotencyLookup,
): ArtifactReviewMutationOutcome {
  if (!scenario.sameScope || !scenario.sameActor || !scenario.sameKey) {
    return "new-mutation";
  }
  if (scenario.sameOperation && scenario.sameDigest) {
    return "replay-committed";
  }
  return "idempotency-conflict";
}

function booleanBit(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function makeLookupRow(
  sameScope: boolean,
  sameActor: boolean,
  sameKey: boolean,
  sameOperation: boolean,
  sameDigest: boolean,
): ArtifactReviewMutationDecisionRow {
  const bitSuffix = [
    `s${booleanBit(sameScope)}`,
    `a${booleanBit(sameActor)}`,
    `k${booleanBit(sameKey)}`,
    `o${booleanBit(sameOperation)}`,
    `d${booleanBit(sameDigest)}`,
  ].join("-");
  const scenario = {
    mutationKind: "idempotency-lookup",
    invariant: sameScope ? "idempotency" : "origin-scope",
    sameScope,
    sameActor,
    sameKey,
    sameOperation,
    sameDigest,
  } satisfies ArtifactReviewIdempotencyLookup;

  return {
    id: `mutation-lookup-${bitSuffix}`,
    scenario,
    expectedOutcome: expectedLookupOutcome(scenario),
    faultClass: `lookup-truth-${bitSuffix}`,
  };
}

const LOOKUP_DECISION_ROWS = BOOLEAN_VALUES.flatMap((sameScope) =>
  BOOLEAN_VALUES.flatMap((sameActor) =>
    BOOLEAN_VALUES.flatMap((sameKey) =>
      BOOLEAN_VALUES.flatMap((sameOperation) =>
        BOOLEAN_VALUES.map((sameDigest) =>
          makeLookupRow(
            sameScope,
            sameActor,
            sameKey,
            sameOperation,
            sameDigest,
          ),
        ),
      ),
    ),
  ),
);

const AUTHORITY_DECISION_ROW = {
  id: "mutation-authority-client-actor-assertion",
  scenario: {
    mutationKind: "authority-input",
    invariant: "local-owner",
    clientActorSupplied: true,
  },
  expectedOutcome: "reject-authority-input",
  faultClass: "authority-client-actor-assertion",
} as const satisfies ArtifactReviewMutationDecisionRow;

const DURABILITY_DECISION_ROWS = [
  {
    id: "mutation-durability-uncommitted-saving",
    scenario: {
      mutationKind: "durability-response",
      invariant: "idempotency",
      state: {
        committed: false,
        uiState: "saving",
        deliveryState: "pending",
        exactRetry: false,
      },
    },
    expectedOutcome: "pending-not-saved",
    faultClass: "durability-uncommitted-remains-pending",
  },
  {
    id: "mutation-durability-committed-delivered",
    scenario: {
      mutationKind: "durability-response",
      invariant: "idempotency",
      state: {
        committed: true,
        uiState: "saved",
        deliveryState: "delivered",
        exactRetry: false,
      },
    },
    expectedOutcome: "saved-after-commit",
    faultClass: "durability-committed-delivery-is-saved",
  },
  {
    id: "mutation-durability-committed-response-lost",
    scenario: {
      mutationKind: "durability-response",
      invariant: "idempotency",
      state: {
        committed: true,
        uiState: "saving",
        deliveryState: "response-lost",
        exactRetry: false,
      },
    },
    expectedOutcome: "retryable-after-response-loss",
    faultClass: "durability-committed-response-loss-is-retryable",
  },
  {
    id: "mutation-durability-committed-response-lost-exact-retry",
    scenario: {
      mutationKind: "durability-response",
      invariant: "idempotency",
      state: {
        committed: true,
        uiState: "saving",
        deliveryState: "response-lost",
        exactRetry: true,
      },
    },
    expectedOutcome: "replay-committed",
    faultClass: "durability-exact-retry-replays-committed-outcome",
  },
] as const satisfies ReadonlyArray<ArtifactReviewMutationDecisionRow>;

export const ARTIFACT_REVIEW_MUTATION_DECISION_ROWS = Object.freeze([
  AUTHORITY_DECISION_ROW,
  ...LOOKUP_DECISION_ROWS,
  ...DURABILITY_DECISION_ROWS,
]) satisfies ReadonlyArray<ArtifactReviewMutationDecisionRow>;

export const ARTIFACT_REVIEW_MUTATION_ADMISSION_NEGATIVE_ROWS = Object.freeze([
  {
    id: "mutation-invalid-lookup-omits-same-scope",
    input: {
      mutationKind: "idempotency-lookup",
      invariant: "idempotency",
      sameActor: true,
      sameKey: true,
      sameOperation: true,
      sameDigest: true,
    },
    expectedAdmission: "invalid-input",
    faultClass: "admission-lookup-missing-same-scope",
    negativeClass: "lookup-required-field-omission",
  },
  {
    id: "mutation-invalid-lookup-omits-same-actor",
    input: {
      mutationKind: "idempotency-lookup",
      invariant: "idempotency",
      sameScope: true,
      sameKey: true,
      sameOperation: true,
      sameDigest: true,
    },
    expectedAdmission: "invalid-input",
    faultClass: "admission-lookup-missing-same-actor",
    negativeClass: "lookup-required-field-omission",
  },
  {
    id: "mutation-invalid-lookup-omits-same-key",
    input: {
      mutationKind: "idempotency-lookup",
      invariant: "idempotency",
      sameScope: true,
      sameActor: true,
      sameOperation: true,
      sameDigest: true,
    },
    expectedAdmission: "invalid-input",
    faultClass: "admission-lookup-missing-same-key",
    negativeClass: "lookup-required-field-omission",
  },
  {
    id: "mutation-invalid-lookup-omits-same-operation",
    input: {
      mutationKind: "idempotency-lookup",
      invariant: "idempotency",
      sameScope: true,
      sameActor: true,
      sameKey: true,
      sameDigest: true,
    },
    expectedAdmission: "invalid-input",
    faultClass: "admission-lookup-missing-same-operation",
    negativeClass: "lookup-required-field-omission",
  },
  {
    id: "mutation-invalid-lookup-omits-same-digest",
    input: {
      mutationKind: "idempotency-lookup",
      invariant: "idempotency",
      sameScope: true,
      sameActor: true,
      sameKey: true,
      sameOperation: true,
    },
    expectedAdmission: "invalid-input",
    faultClass: "admission-lookup-missing-same-digest",
    negativeClass: "lookup-required-field-omission",
  },
  {
    id: "mutation-invalid-durability-uncommitted-saved",
    input: {
      mutationKind: "durability-response",
      invariant: "idempotency",
      state: {
        committed: false,
        uiState: "saved",
        deliveryState: "pending",
        exactRetry: false,
      },
    },
    expectedAdmission: "invalid-input",
    faultClass: "admission-durability-uncommitted-saved",
    negativeClass: "impossible-durability-state",
  },
  {
    id: "mutation-invalid-durability-uncommitted-delivered",
    input: {
      mutationKind: "durability-response",
      invariant: "idempotency",
      state: {
        committed: false,
        uiState: "saving",
        deliveryState: "delivered",
        exactRetry: false,
      },
    },
    expectedAdmission: "invalid-input",
    faultClass: "admission-durability-uncommitted-delivered",
    negativeClass: "impossible-durability-state",
  },
  {
    id: "mutation-invalid-durability-committed-saved-before-delivery",
    input: {
      mutationKind: "durability-response",
      invariant: "idempotency",
      state: {
        committed: true,
        uiState: "saved",
        deliveryState: "pending",
        exactRetry: false,
      },
    },
    expectedAdmission: "invalid-input",
    faultClass: "admission-durability-committed-saved-before-delivery",
    negativeClass: "impossible-durability-state",
  },
  {
    id: "mutation-invalid-durability-response-lost-saved",
    input: {
      mutationKind: "durability-response",
      invariant: "idempotency",
      state: {
        committed: true,
        uiState: "saved",
        deliveryState: "response-lost",
        exactRetry: false,
      },
    },
    expectedAdmission: "invalid-input",
    faultClass: "admission-durability-response-lost-saved",
    negativeClass: "impossible-durability-state",
  },
  {
    id: "mutation-invalid-authority-with-identity-field",
    input: {
      mutationKind: "authority-input",
      invariant: "local-owner",
      clientActorSupplied: true,
      sameScope: true,
    },
    expectedAdmission: "invalid-input",
    faultClass: "admission-authority-contaminated-by-identity",
    negativeClass: "cross-variant-field-contamination",
  },
  {
    id: "mutation-invalid-lookup-with-durability-field",
    input: {
      mutationKind: "idempotency-lookup",
      invariant: "idempotency",
      sameScope: true,
      sameActor: true,
      sameKey: true,
      sameOperation: true,
      sameDigest: true,
      state: {
        committed: false,
        uiState: "saving",
        deliveryState: "pending",
        exactRetry: false,
      },
    },
    expectedAdmission: "invalid-input",
    faultClass: "admission-lookup-contaminated-by-durability",
    negativeClass: "cross-variant-field-contamination",
  },
  {
    id: "mutation-invalid-durability-with-identity-field",
    input: {
      mutationKind: "durability-response",
      invariant: "idempotency",
      sameScope: true,
      state: {
        committed: false,
        uiState: "saving",
        deliveryState: "pending",
        exactRetry: false,
      },
    },
    expectedAdmission: "invalid-input",
    faultClass: "admission-durability-contaminated-by-identity",
    negativeClass: "cross-variant-field-contamination",
  },
] as const satisfies ReadonlyArray<ArtifactReviewMutationAdmissionNegativeRow>);

export const ARTIFACT_REVIEW_MUTATION_METAMORPHIC_RULES = Object.freeze([
  {
    id: "identity-mismatch-dominates-operation-digest",
    name: "Each identity mismatch dominates operation and digest",
    assertion:
      "Any false sameScope, sameActor, or sameKey yields new-mutation for every sameOperation/sameDigest pair.",
  },
  {
    id: "exact-lookup-replay-requires-all-five-true",
    name: "Exact lookup replay requires all five predicates true",
    assertion:
      "replay-committed is the lookup outcome only when scope, actor, key, operation, and digest all match.",
  },
  {
    id: "operation-digest-conflict-only-after-identity-match",
    name: "Operation or digest conflict applies only after identity match",
    assertion:
      "With scope, actor, and key matched, any false operation or digest predicate yields idempotency-conflict.",
  },
  {
    id: "committed-false-never-yields-saved",
    name: "Committed false never yields Saved",
    assertion:
      "Every admitted uncommitted durability state remains pending-not-saved; impossible Saved states fail admission.",
  },
  {
    id: "exact-retry-after-committed-response-loss-replays",
    name: "Exact retry after committed response loss replays the committed outcome",
    assertion:
      "Committed response loss is retryable before a retry and replay-committed for an exact retry.",
  },
  {
    id: "presentation-metadata-invariance-and-core-extra-rejection",
    name: "Presentation metadata is inert while forbidden core extras fail admission",
    assertion:
      "Permitted non-authoritative presentation metadata cannot affect an outcome, and every forbidden core extra is invalid-input.",
  },
] as const satisfies ReadonlyArray<ArtifactReviewMutationMetamorphicRule>);

function assertTable(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Artifact-review mutation table invalid: ${message}`);
  }
}

function outcomeFromSynthesizedDimensions(
  scenario: ArtifactReviewMutationScenario,
): ArtifactReviewMutationOutcome {
  switch (scenario.mutationKind) {
    case "authority-input":
      return "reject-authority-input";
    case "idempotency-lookup":
      return expectedLookupOutcome(scenario);
    case "durability-response": {
      const { state } = scenario;
      if (!state.committed) {
        return "pending-not-saved";
      }
      if (state.deliveryState === "delivered") {
        return "saved-after-commit";
      }
      return state.exactRetry
        ? "replay-committed"
        : "retryable-after-response-loss";
    }
  }
}

function lookupCombinationKey(row: ArtifactReviewIdempotencyLookup): string {
  return [
    row.sameScope,
    row.sameActor,
    row.sameKey,
    row.sameOperation,
    row.sameDigest,
  ]
    .map(booleanBit)
    .join("");
}

function assertRejected(input: unknown, label: string): void {
  const admission = admitArtifactReviewMutationScenario(input);
  assertTable(!admission.admitted, `${label} was admitted`);
  assertTable(
    admission.code === ARTIFACT_REVIEW_MUTATION_ADMISSION_ERROR,
    `${label} did not classify as invalid-input`,
  );
}

function assertInvariantKindMapping(
  row: ArtifactReviewMutationDecisionRow,
): void {
  switch (row.scenario.mutationKind) {
    case "authority-input":
      assertTable(
        row.scenario.invariant === "local-owner",
        `${row.id} has the wrong authority invariant`,
      );
      assertRejected(
        { ...row.scenario, invariant: "idempotency" },
        `${row.id} invariant-kind mismatch`,
      );
      return;
    case "idempotency-lookup":
      assertTable(
        row.scenario.invariant ===
          (row.scenario.sameScope ? "idempotency" : "origin-scope"),
        `${row.id} does not use its frozen lookup invariant`,
      );
      assertRejected(
        { ...row.scenario, invariant: "local-owner" },
        `${row.id} invariant-kind mismatch`,
      );
      return;
    case "durability-response":
      assertTable(
        row.scenario.invariant === "idempotency",
        `${row.id} has the wrong durability invariant`,
      );
      assertRejected(
        { ...row.scenario, invariant: "origin-scope" },
        `${row.id} invariant-kind mismatch`,
      );
  }
}

function assertMetadataMetamorphism(
  row: ArtifactReviewMutationDecisionRow,
): void {
  const withPresentationMetadata = {
    ...row.scenario,
    presentationMetadata: { panelLabel: "non-authoritative-review-panel" },
  };
  const admission = admitArtifactReviewMutationScenario(
    withPresentationMetadata,
  );
  assertTable(
    admission.admitted,
    `${row.id} rejected permitted presentation metadata`,
  );
  assertTable(
    outcomeFromSynthesizedDimensions(admission.value) === row.expectedOutcome,
    `${row.id} changed outcome under presentation metadata`,
  );

  assertRejected(
    { ...row.scenario, forbiddenCoreExtra: true },
    `${row.id} forbidden core extra`,
  );
}

export function validateArtifactReviewMutationDecisionTable(): Readonly<{
  validRows: 37;
  authorityRows: 1;
  lookupRows: 32;
  durabilityRows: 4;
  negativeRows: 12;
  metamorphicRules: 6;
}> {
  const validRows = ARTIFACT_REVIEW_MUTATION_DECISION_ROWS;
  const negativeRows = ARTIFACT_REVIEW_MUTATION_ADMISSION_NEGATIVE_ROWS;
  const lookupRows = validRows.filter(
    (
      row,
    ): row is ArtifactReviewMutationDecisionRow & {
      scenario: ArtifactReviewIdempotencyLookup;
    } => row.scenario.mutationKind === "idempotency-lookup",
  );
  const durabilityRows = validRows.filter(
    (
      row,
    ): row is ArtifactReviewMutationDecisionRow & {
      scenario: ArtifactReviewDurabilityResponse;
    } => row.scenario.mutationKind === "durability-response",
  );
  const authorityRows = validRows.filter(
    (
      row,
    ): row is ArtifactReviewMutationDecisionRow & {
      scenario: ArtifactReviewAuthorityInput;
    } => row.scenario.mutationKind === "authority-input",
  );

  assertTable(
    validRows.length === 37,
    `expected 37 valid rows, got ${validRows.length}`,
  );
  assertTable(authorityRows.length === 1, "authority partition is not 1");
  assertTable(lookupRows.length === 32, "lookup partition is not 32");
  assertTable(durabilityRows.length === 4, "durability partition is not 4");
  assertTable(negativeRows.length === 12, "negative partition is not 12");
  assertTable(
    ARTIFACT_REVIEW_MUTATION_METAMORPHIC_RULES.length === 6,
    "metamorphic rule count is not 6",
  );

  const allRows = [...validRows, ...negativeRows];
  assertTable(
    new Set(allRows.map((row) => row.id)).size === allRows.length,
    "row IDs are not unique",
  );
  assertTable(
    new Set(allRows.map((row) => row.faultClass)).size === allRows.length,
    "row fault classes are not unique",
  );

  for (const row of validRows) {
    const admission = admitArtifactReviewMutationScenario(row.scenario);
    assertTable(admission.admitted, `${row.id} failed admission`);
    assertTable(
      outcomeFromSynthesizedDimensions(admission.value) === row.expectedOutcome,
      `${row.id} violates the synthesized outcome truth table`,
    );
    assertInvariantKindMapping(row);
    assertMetadataMetamorphism(row);
  }

  const lookupKeys = new Set(
    lookupRows.map((row) => lookupCombinationKey(row.scenario)),
  );
  assertTable(lookupKeys.size === 32, "lookup combinations are not complete");
  for (let bits = 0; bits < 32; bits += 1) {
    assertTable(
      lookupKeys.has(bits.toString(2).padStart(5, "0")),
      `lookup combination ${bits.toString(2).padStart(5, "0")} is missing`,
    );
  }

  for (const identityField of ["sameScope", "sameActor", "sameKey"] as const) {
    const dominatedRows = lookupRows.filter(
      (row) => row.scenario[identityField] === false,
    );
    assertTable(
      dominatedRows.length === 16,
      `${identityField} does not cover 16 rows`,
    );
    assertTable(
      dominatedRows.every((row) => row.expectedOutcome === "new-mutation"),
      `${identityField} does not dominate operation/digest`,
    );
  }

  const replayLookupRows = lookupRows.filter(
    (row) => row.expectedOutcome === "replay-committed",
  );
  assertTable(replayLookupRows.length === 1, "lookup replay is not exact");
  assertTable(
    replayLookupRows.every((row) =>
      [
        row.scenario.sameScope,
        row.scenario.sameActor,
        row.scenario.sameKey,
        row.scenario.sameOperation,
        row.scenario.sameDigest,
      ].every(Boolean),
    ),
    "lookup replay does not require all five true",
  );

  const conflictRows = lookupRows.filter(
    (row) => row.expectedOutcome === "idempotency-conflict",
  );
  assertTable(conflictRows.length === 3, "lookup conflict partition is not 3");
  assertTable(
    conflictRows.every(
      (row) =>
        row.scenario.sameScope &&
        row.scenario.sameActor &&
        row.scenario.sameKey &&
        (!row.scenario.sameOperation || !row.scenario.sameDigest),
    ),
    "operation/digest conflict escaped matched identity",
  );

  const uncommittedRows = durabilityRows.filter(
    (row) => !row.scenario.state.committed,
  );
  assertTable(
    uncommittedRows.length === 1,
    "uncommitted valid partition is not 1",
  );
  assertTable(
    uncommittedRows.every((row) => row.expectedOutcome === "pending-not-saved"),
    "committed=false yielded Saved",
  );

  const responseLostRows = durabilityRows.filter(
    (row) => row.scenario.state.deliveryState === "response-lost",
  );
  assertTable(
    responseLostRows.length === 2,
    "response-loss partition is not 2",
  );
  assertTable(
    responseLostRows.some(
      (row) =>
        !row.scenario.state.exactRetry &&
        row.expectedOutcome === "retryable-after-response-loss",
    ),
    "response loss without retry is not retryable",
  );
  assertTable(
    responseLostRows.some(
      (row) =>
        row.scenario.state.exactRetry &&
        row.expectedOutcome === "replay-committed",
    ),
    "exact retry after response loss does not replay",
  );

  const negativeClassCounts = new Map<
    ArtifactReviewMutationAdmissionNegativeRow["negativeClass"],
    number
  >();
  for (const row of negativeRows) {
    negativeClassCounts.set(
      row.negativeClass,
      (negativeClassCounts.get(row.negativeClass) ?? 0) + 1,
    );
    assertRejected(row.input, row.id);
    assertTable(
      row.expectedAdmission === ARTIFACT_REVIEW_MUTATION_ADMISSION_ERROR,
      `${row.id} has the wrong expected admission`,
    );
  }
  assertTable(
    negativeClassCounts.get("lookup-required-field-omission") === 5,
    "lookup omission negatives are not 5",
  );
  assertTable(
    negativeClassCounts.get("impossible-durability-state") === 4,
    "impossible durability negatives are not 4",
  );
  assertTable(
    negativeClassCounts.get("cross-variant-field-contamination") === 3,
    "cross-variant contamination negatives are not 3",
  );

  const exactLookup = replayLookupRows[0]?.scenario;
  assertTable(exactLookup !== undefined, "exact lookup probe is missing");
  assertRejected(
    { ...exactLookup, mutationKind: "unknown-mutation-kind" },
    "unknown mutation discriminant",
  );
  assertRejected({ ...exactLookup, sameScope: "true" }, "wrong primitive type");
  assertRejected(
    {
      ...exactLookup,
      presentationMetadata: {
        panelLabel: "review-panel",
        unexpectedMetadataField: true,
      },
    },
    "unknown presentation metadata field",
  );
  assertRejected(
    {
      ...durabilityRows[0]?.scenario,
      state: {
        ...durabilityRows[0]?.scenario.state,
        unexpectedStateField: true,
      },
    },
    "unknown durability state field",
  );
  assertRejected(
    {
      mutationKind: "authority-input",
      invariant: "local-owner",
      clientActorSupplied: false,
    },
    "authority-input false assertion",
  );
  assertRejected(
    {
      mutationKind: "authority-input",
      invariant: "local-owner",
    },
    "authority-input omitted assertion",
  );

  return Object.freeze({
    validRows: 37,
    authorityRows: 1,
    lookupRows: 32,
    durabilityRows: 4,
    negativeRows: 12,
    metamorphicRules: 6,
  });
}

export const ARTIFACT_REVIEW_MUTATION_SELF_VALIDATION =
  validateArtifactReviewMutationDecisionTable();
