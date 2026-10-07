/**
 * Pure contract shared by production and fake V3 migration adapters.
 *
 * Adapters own observations and effects. This module owns only normalized
 * classification, decisions, errors, and literal trace ordering.
 */

export const ARTIFACT_REVIEW_V3_CAPABILITY = {
  id: "bb-plugin-migration-completed-state-v3",
  version: 1,
} as const;

export type ArtifactReviewV3Decision =
  | "reject-before-db"
  | "ordinary-append-all"
  | "ordinary-append-suffix"
  | "recover-one-transaction"
  | "verify-completed"
  | "verify-predecessor-apply-suffix"
  | "block-unknown-completion"
  | "block-human-rollout"
  | "fail-closed";

export type ArtifactReviewV3Error =
  | "E_UNSUPPORTED_PLAN_OR_CAPABILITY"
  | "E_UNKNOWN_AUTHORITY"
  | "E_STATIC_DIGEST_MISMATCH"
  | "E_LEDGER_FAILED"
  | "E_LEDGER_NONCONTIGUOUS"
  | "E_LEDGER_FUTURE"
  | "E_LEDGER_MALFORMED"
  | "E_LEDGER_PARTIAL"
  | "E_UNKNOWN_COMPLETION"
  | "E_COMPLETION_MISMATCH"
  | "E_RECOVERY_MISMATCH"
  | "E_SCHEMA_METADATA_MISMATCH"
  | "E_ROOT_OR_COUNT_MISMATCH"
  | "E_UNADMITTED_LEGACY_STATE";

export type ArtifactReviewV3CompletionObservation =
  | { readonly state: "absent" }
  | {
      readonly state: "present";
      readonly outcome: "ordinary" | "recovered";
      readonly predecessorAuthorityId: string | null;
      readonly matchesAuthority: boolean;
    }
  | { readonly state: "malformed" | "duplicate" | "mismatched" };

export interface ArtifactReviewV3Observation {
  readonly planVersion: number;
  readonly capabilityAdmitted: boolean;
  readonly authorityAdmitted: boolean;
  readonly staticDigestsAdmitted: boolean;
  readonly appliedMigrationIds: readonly number[];
  readonly statementCount: number;
  readonly beforeMigrationId: number;
  readonly completion: ArtifactReviewV3CompletionObservation;
  readonly predecessorCompletionVerified: boolean;
  readonly recoveryEvidence:
    | "absent"
    | "matching"
    | "partial"
    | "mismatched";
  readonly completedState:
    | "unobserved"
    | "matching"
    | "schema-mismatch"
    | "evidence-mismatch";
  readonly legacyEvidence: boolean;
  readonly ordinaryMigration18Blocked: boolean;
}

export interface ArtifactReviewV3Reduction {
  readonly decision: ArtifactReviewV3Decision;
  readonly error: ArtifactReviewV3Error | null;
  readonly trace: readonly string[];
  readonly suffixStart: number | null;
  readonly terminalOutcome: "ordinary" | "recovered" | null;
}

export interface ArtifactReviewV3Contract {
  readonly capability: typeof ARTIFACT_REVIEW_V3_CAPABILITY;
  readonly reduce: typeof reduceArtifactReviewV3;
}

const compareUnicodeScalars = (left: string, right: string): number => {
  const a = Array.from(left, (item) => item.codePointAt(0)!);
  const b = Array.from(right, (item) => item.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
};

/** Stable recursive Unicode-codepoint JSON for cross-adapter evidence. */
export const canonicalizeArtifactReviewV3 = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeArtifactReviewV3).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareUnicodeScalars)
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalizeArtifactReviewV3(record[key])}`,
    )
    .join(",")}}`;
};

const PREFIX = ["T01", "T02", "T03", "T04", "T05"] as const;

const failed = (
  error: ArtifactReviewV3Error,
  decision: ArtifactReviewV3Decision = "fail-closed",
  extraTrace: readonly string[] = [],
): ArtifactReviewV3Reduction => ({
  decision,
  error,
  trace: [...PREFIX, ...extraTrace],
  suffixStart: null,
  terminalOutcome: null,
});

const ledgerError = (
  ids: readonly number[],
  statementCount: number,
): ArtifactReviewV3Error | null => {
  if (!Number.isSafeInteger(statementCount) || statementCount < 1) {
    return "E_LEDGER_MALFORMED";
  }
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 0)) {
    return "E_LEDGER_MALFORMED";
  }
  if (new Set(ids).size !== ids.length) return "E_LEDGER_MALFORMED";
  if (ids.some((id) => id >= statementCount)) return "E_LEDGER_FUTURE";
  if (ids.some((id, index) => id !== index)) {
    return "E_LEDGER_NONCONTIGUOUS";
  }
  return null;
};

/** Side-effect-free V3 state reducer. */
export function reduceArtifactReviewV3(
  observation: ArtifactReviewV3Observation,
): ArtifactReviewV3Reduction {
  if (observation.planVersion !== 3 || !observation.capabilityAdmitted) {
    return {
      decision: "reject-before-db",
      error: "E_UNSUPPORTED_PLAN_OR_CAPABILITY",
      trace: ["T00"],
      suffixStart: null,
      terminalOutcome: null,
    };
  }
  if (!observation.authorityAdmitted) {
    return {
      decision: "reject-before-db",
      error: "E_UNKNOWN_AUTHORITY",
      trace: ["T01"],
      suffixStart: null,
      terminalOutcome: null,
    };
  }
  if (!observation.staticDigestsAdmitted) {
    return failed("E_STATIC_DIGEST_MISMATCH");
  }

  const invalidLedger = ledgerError(
    observation.appliedMigrationIds,
    observation.statementCount,
  );
  if (invalidLedger !== null) return failed(invalidLedger);
  if (observation.recoveryEvidence === "partial") {
    return failed("E_LEDGER_PARTIAL");
  }
  if (observation.recoveryEvidence === "mismatched") {
    return failed("E_RECOVERY_MISMATCH");
  }
  if (
    observation.completion.state === "malformed" ||
    observation.completion.state === "duplicate" ||
    observation.completion.state === "mismatched" ||
    (observation.completion.state === "present" &&
      !observation.completion.matchesAuthority)
  ) {
    return failed("E_COMPLETION_MISMATCH");
  }
  if (observation.completedState === "schema-mismatch") {
    return failed("E_SCHEMA_METADATA_MISMATCH");
  }
  if (observation.completedState === "evidence-mismatch") {
    return failed("E_ROOT_OR_COUNT_MISMATCH");
  }

  if (observation.completion.state === "present") {
    if (observation.completedState !== "matching") {
      return failed("E_ROOT_OR_COUNT_MISMATCH");
    }
    const recovered = observation.completion.outcome === "recovered";
    if (recovered && observation.recoveryEvidence !== "matching") {
      return failed("E_RECOVERY_MISMATCH");
    }
    if (!recovered && observation.recoveryEvidence !== "absent") {
      return failed("E_RECOVERY_MISMATCH");
    }
    return {
      decision: "verify-completed",
      error: null,
      trace: [...PREFIX, ...(recovered ? ["T17"] : []), "T18", "T25"],
      suffixStart: null,
      terminalOutcome: observation.completion.outcome,
    };
  }

  const applied = observation.appliedMigrationIds.length;
  if (applied === observation.statementCount) {
    return failed("E_UNKNOWN_COMPLETION", "block-unknown-completion");
  }
  if (observation.legacyEvidence) {
    return failed("E_UNADMITTED_LEGACY_STATE", "block-human-rollout", [
      "T26",
    ]);
  }

  if (observation.predecessorCompletionVerified) {
    return {
      decision: "verify-predecessor-apply-suffix",
      error: null,
      trace: [
        ...PREFIX,
        "T06",
        "T19",
        "T20",
        "T11",
        "T18",
        "T22",
        "T24",
        "T25",
      ],
      suffixStart: applied,
      terminalOutcome: null,
    };
  }

  if (
    observation.ordinaryMigration18Blocked &&
    applied === observation.beforeMigrationId
  ) {
    return {
      decision: "recover-one-transaction",
      error: null,
      trace: [
        ...PREFIX,
        "T06",
        "T07",
        "T08",
        "T09",
        "T10",
        "T11",
        "T12",
        "T13",
        "T14",
        "T15",
        "T16",
        "T17",
        "T18",
        "T21",
        "T22",
        "T24",
        "T25",
      ],
      suffixStart: applied,
      terminalOutcome: "recovered",
    };
  }

  return {
    decision: applied === 0 ? "ordinary-append-all" : "ordinary-append-suffix",
    error: null,
    trace: [
      ...PREFIX,
      "T06",
      "T10",
      "T11",
      "T18",
      "T22",
      "T24",
      "T25",
    ],
    suffixStart: applied,
    terminalOutcome: "ordinary",
  };
}

export const artifactReviewV3Contract: ArtifactReviewV3Contract = {
  capability: ARTIFACT_REVIEW_V3_CAPABILITY,
  reduce: reduceArtifactReviewV3,
};
