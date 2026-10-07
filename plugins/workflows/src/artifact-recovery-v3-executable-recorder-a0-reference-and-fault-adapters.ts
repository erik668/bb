import { createHash } from "node:crypto";
import {
  canonicalizeArtifactReviewV3,
  reduceArtifactReviewV3,
  type ArtifactReviewV3Observation,
} from "@get-bb/plugin-sdk";
import { createArtifactRecoveryV3FakeAdapter } from "./artifact-recovery-v3-fake-adapter.js";
import type { ArtifactRecoveryV3FakeState } from "./artifact-recovery-v3-fake-projection.js";

export type A0Operation = Readonly<{
  interface:
    | "production"
    | "reducer"
    | "production-admission"
    | "independent-observer"
    | "darkness-consumer"
    | "sdk-fake"
    | "workflows-fake"
    | "production-reopen"
    | "sdk-surface"
    | "target-construction"
    | "manifest-boundary";
  input?: Readonly<Record<string, unknown>>;
  fault?: Readonly<{ phase: string }>;
  mutation?: Readonly<{ target: string; operation: string }>;
  scenario?: string;
  surface?: string;
}>;

export type A0PublicStimulus = Readonly<{
  nonce: string;
  operation: A0Operation;
}>;

export type A0CandidateInput = Readonly<{
  executionIdentity: string;
  nonce: string;
  operation: A0Operation;
  storeRoot: string;
  commandRoot: string;
  cleanConsumerRoot: string;
  sdkBuildRoot?: string;
  sdkBuildRootSecond?: string;
  sdkMatrixPath?: string;
  boundaryMutation?: A0CandidateBoundaryMutation;
}>;

export type A0ControlId =
  | "expectation-access-attempt"
  | "fake-production-executor"
  | "serialized-return-tamper"
  | "candidate-controlled-database-selection"
  | "reused-handle-cache"
  | "uncommitted-visibility"
  | "rollback-failure"
  | "database-creation-on-rejected-admission"
  | "skipped-sdk-command"
  | "stale-runtime-output"
  | "stale-declaration-output"
  | "regeneration-divergence"
  | "registration-substitution"
  | "rpc-lighting"
  | "ui-lighting"
  | "renderer-lighting"
  | "live-change-lighting";

export type A0BoundaryMutationKind =
  | "private-authority-capability"
  | "production-executor-substitution"
  | "serialized-operational-receipt"
  | "candidate-database-root"
  | "candidate-observation-cache"
  | "committed-uncommitted-marker"
  | "committed-rollback-marker"
  | "rejected-admission-database"
  | "sdk-command-omission"
  | "runtime-output-staleness"
  | "declaration-output-staleness"
  | "isolated-builder-divergence"
  | "registration-map-substitution"
  | "rpc-consumer-registration"
  | "ui-consumer-registration"
  | "renderer-consumer-registration"
  | "live-change-consumer-registration";

/** Candidate-visible mutation data deliberately excludes the expected kill. */
export type A0CandidateBoundaryMutation = Readonly<{
  id: A0ControlId;
  kind: A0BoundaryMutationKind;
}>;

export type A0BoundaryMutationDescriptor = Readonly<{
  id: A0ControlId;
  kind: A0BoundaryMutationKind;
  operation: A0Operation;
  receiptType: string;
  killCode: string;
}>;

export const A0_BOUNDARY_MUTATIONS: readonly A0BoundaryMutationDescriptor[] = [
  { id: "expectation-access-attempt", kind: "private-authority-capability", operation: { interface: "reducer", input: { state: "empty" } }, receiptType: "private-authority-access-attempted", killCode: "E_PRIVATE_AUTHORITY_ACCESS_BLOCKED" },
  { id: "fake-production-executor", kind: "production-executor-substitution", operation: { interface: "production", input: { state: "empty" } }, receiptType: "production-factory-and-migrate-invoked", killCode: "E_PRODUCTION_EXECUTOR_SUBSTITUTED" },
  { id: "serialized-return-tamper", kind: "serialized-operational-receipt", operation: { interface: "reducer", input: { state: "empty" } }, receiptType: "serialized-actual-reopened", killCode: "E_SERIALIZED_RETURN_TAMPER" },
  { id: "candidate-controlled-database-selection", kind: "candidate-database-root", operation: { interface: "production", input: { state: "empty" } }, receiptType: "database-root-issued-by-recorder", killCode: "E_CANDIDATE_DATABASE_SELECTION" },
  { id: "reused-handle-cache", kind: "candidate-observation-cache", operation: { interface: "production", input: { state: "empty" } }, receiptType: "candidate-handle-closed-and-new-process-opened", killCode: "E_REUSED_HANDLE_OR_CACHE" },
  { id: "uncommitted-visibility", kind: "committed-uncommitted-marker", operation: { interface: "production", input: { state: "empty" } }, receiptType: "uncommitted-state-probed", killCode: "E_UNCOMMITTED_STATE_VISIBLE" },
  { id: "rollback-failure", kind: "committed-rollback-marker", operation: { interface: "production", input: { state: "empty" } }, receiptType: "rollback-state-probed", killCode: "E_ROLLBACK_NOT_PRESERVED" },
  { id: "database-creation-on-rejected-admission", kind: "rejected-admission-database", operation: { interface: "production-admission", input: { version: 4 } }, receiptType: "rejected-path-root-probed", killCode: "E_REJECTED_ADMISSION_CREATED_DATABASE" },
  { id: "skipped-sdk-command", kind: "sdk-command-omission", operation: { interface: "sdk-surface", surface: "normal-package-import" }, receiptType: "sdk-command-started-and-completed", killCode: "E_SDK_COMMAND_SKIPPED" },
  { id: "stale-runtime-output", kind: "runtime-output-staleness", operation: { interface: "sdk-surface", surface: "runtime:index" }, receiptType: "runtime-output-identity-collected", killCode: "E_STALE_RUNTIME_OUTPUT" },
  { id: "stale-declaration-output", kind: "declaration-output-staleness", operation: { interface: "sdk-surface", surface: "declaration:bb-plugin-sdk" }, receiptType: "declaration-output-identity-collected", killCode: "E_STALE_DECLARATION_OUTPUT" },
  { id: "regeneration-divergence", kind: "isolated-builder-divergence", operation: { interface: "sdk-surface", surface: "runtime:index" }, receiptType: "both-output-identity-sets-collected", killCode: "E_SDK_REGENERATION_DIVERGED" },
  { id: "registration-substitution", kind: "registration-map-substitution", operation: { interface: "darkness-consumer", surface: "feature" }, receiptType: "registration-state-read-from-consumer", killCode: "E_REGISTRATION_SUBSTITUTED" },
  { id: "rpc-lighting", kind: "rpc-consumer-registration", operation: { interface: "darkness-consumer", surface: "artifact-rpc" }, receiptType: "rpc-consumer-probed", killCode: "E_RPC_CONSUMER_LIT" },
  { id: "ui-lighting", kind: "ui-consumer-registration", operation: { interface: "darkness-consumer", surface: "ui" }, receiptType: "ui-consumer-probed", killCode: "E_UI_CONSUMER_LIT" },
  { id: "renderer-lighting", kind: "renderer-consumer-registration", operation: { interface: "darkness-consumer", surface: "renderer" }, receiptType: "renderer-consumer-probed", killCode: "E_RENDERER_CONSUMER_LIT" },
  { id: "live-change-lighting", kind: "live-change-consumer-registration", operation: { interface: "darkness-consumer", surface: "live-changes" }, receiptType: "live-change-consumer-probed", killCode: "E_LIVE_CHANGE_CONSUMER_LIT" },
] as const;

export const boundaryMutationDescriptor = (
  id: string,
): A0BoundaryMutationDescriptor => {
  const descriptor = A0_BOUNDARY_MUTATIONS.find((entry) => entry.id === id);
  if (descriptor === undefined) throw new Error(`E_A0_UNKNOWN_CONTROL:${id}`);
  return descriptor;
};

export type A0ReferenceActual = Readonly<Record<string, unknown>>;

export type A0Reachability = Readonly<{
  helper: string;
  receiptType: string;
  processId: number;
  evidenceSha256: string;
}>;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
};

const forbiddenCandidateKeys = new Set([
  "caseId",
  "category",
  "expected",
  "expectedPath",
  "databasePath",
  "approval",
  "aggregateTarget",
]);

const walkCandidateKeys = (value: unknown): void => {
  if (Array.isArray(value)) return void value.forEach(walkCandidateKeys);
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenCandidateKeys.has(key)) {
      throw new Error(`E_A0_PRIVATE_INPUT:${key}`);
    }
    walkCandidateKeys(child);
  }
};

export function assertCandidateInput(
  value: unknown,
): asserts value is A0CandidateInput {
  walkCandidateKeys(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("E_A0_CANDIDATE_INPUT_SHAPE");
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.executionIdentity !== "string" ||
    !/^[0-9a-f]{64}$/u.test(input.executionIdentity) ||
    typeof input.nonce !== "string" ||
    !/^[0-9a-f]{64}$/u.test(input.nonce) ||
    input.operation === null ||
    typeof input.operation !== "object" ||
    Array.isArray(input.operation) ||
    typeof input.storeRoot !== "string" ||
    typeof input.commandRoot !== "string" ||
    typeof input.cleanConsumerRoot !== "string"
  ) {
    throw new Error("E_A0_CANDIDATE_INPUT_SHAPE");
  }
}

export const reach = (
  helper: string,
  receiptType: string,
  evidence: unknown,
): A0Reachability => ({
  helper,
  receiptType,
  processId: process.pid,
  evidenceSha256: sha256(stableJson(evidence)),
});

const observationFromOperation = (
  operation: A0Operation,
): ArtifactReviewV3Observation => {
  const input = operation.input ?? {};
  const migrationIds = Array.isArray(input.migrationIds)
    ? input.migrationIds.filter(
        (value): value is number => typeof value === "number",
      )
    : input.state === "full-ledger-no-completion"
      ? Array.from({ length: 23 }, (_, id) => id)
      : input.state === "prefix-0..16"
        ? Array.from({ length: 17 }, (_, id) => id)
        : input.state === "exact-prefix-0..17" ||
            input.state === "verified-test-predecessor-prefix-0..17"
          ? Array.from({ length: 18 }, (_, id) => id)
          : [];
  return {
    planVersion: typeof input.version === "number" ? input.version : 3,
    capabilityAdmitted: input.capability !== "unknown",
    authorityAdmitted:
      input.authorityId !== "unknown" &&
      input.authorityId !== null &&
      !Array.isArray(input.authorityIds),
    staticDigestsAdmitted: input.digest === undefined,
    appliedMigrationIds: migrationIds,
    statementCount: 23,
    beforeMigrationId: 18,
    completion:
      input.completion === "malformed" || input.completion === "duplicate"
        ? { state: input.completion }
        : input.completion === "conflicting"
          ? { state: "mismatched" }
          : input.state === "completed-ordinary"
            ? {
                state: "present",
                outcome: "ordinary",
                predecessorAuthorityId: null,
                matchesAuthority: true,
              }
            : { state: "absent" },
    predecessorCompletionVerified:
      input.state === "verified-test-predecessor-prefix-0..17",
    recoveryEvidence: "absent",
    completedState:
      input.state === "completed-ordinary" ? "matching" : "unobserved",
    legacyEvidence: input.legacyEvidence === true,
    ordinaryMigration18Blocked:
      input.migration18Error === "E_MIGRATION_18_COMPATIBILITY_BLOCKED",
  };
};

const mutationError = (target: string): string => {
  if (
    target === "allRoots" ||
    target === "activeRoot" ||
    target === "activeRows"
  ) {
    return "E_ROOT_OR_COUNT_MISMATCH";
  }
  if (target === "migrationCatalog" || target === "migration18")
    return "E_STATIC_DIGEST_MISMATCH";
  if (
    target.startsWith("origin.campaign") ||
    target.startsWith("origin.project") ||
    target.startsWith("origin.environment")
  )
    return "E_ORIGIN_SCOPE_MISMATCH";
  if (target.startsWith("origin.localOwner")) return "E_LOCAL_OWNER_MISMATCH";
  if (target === "presentationGrant") return "E_PRESENTATION_GRANT_MISMATCH";
  if (target.startsWith("blobObjects")) return "E_BLOB_OBJECT_MISMATCH";
  if (target.startsWith("relationships")) return "E_RELATIONSHIP_MISMATCH";
  if (target === "completion") return "E_COMPLETION_MISMATCH";
  if (target.startsWith("reopened.")) return "E_POST_REOPEN_MISMATCH";
  return "E_REFERENCE_MUTATION_UNCLASSIFIED";
};

const faultError = (phase: string): string => {
  if (phase === "plan-validation" || phase === "capability-resolution")
    return "E_UNSUPPORTED_PLAN_OR_CAPABILITY";
  if (phase === "authority-resolution") return "E_UNKNOWN_AUTHORITY";
  if (phase === "digest-admission") return "E_STATIC_DIGEST_MISMATCH";
  if (phase === "database-open") return "E_DATABASE_OPEN";
  if (phase === "classification") return "E_CLASSIFICATION";
  if (["commit", "close", "reopen", "post-commit-verify"].includes(phase))
    return "E_POST_COMMIT_VERIFY";
  if (phase === "restart-observation") return "E_POST_REOPEN_MISMATCH";
  if (phase === "consumer-construction") return "E_CONSUMER_BLOCKED";
  return "E_TRANSACTION_ROLLBACK";
};

const scenarioActual = (scenario: string): A0ReferenceActual => {
  if (scenario === "recovered")
    return {
      decision: "complete-recovered",
      error: null,
      snapshotRef: "recovered",
    };
  if (scenario === "strict-prefix")
    return {
      decision: "complete-ordinary",
      error: null,
      snapshotRef: "strictPrefix",
    };
  if (scenario === "rollback" || scenario === "injected-fault")
    return {
      decision: "failed-closed",
      error: "E_TRANSACTION_ROLLBACK",
      snapshotRef: "pre18",
    };
  if (scenario === "corruption")
    return {
      decision: "failed-closed",
      error: "E_POST_REOPEN_MISMATCH",
      snapshotRef: "ordinary",
    };
  return {
    decision: "complete-ordinary",
    error: null,
    snapshotRef: "ordinary",
  };
};

const failedBehaviorActual = (
  error: string,
  phaseTraceRef: "failedClosed" | "preflightRejected" = "failedClosed",
): A0ReferenceActual => ({
  decision: "fail-closed",
  error,
  phaseTraceRef,
  v12TraceRef: null,
  snapshotRef: "pre18",
  saved: "never",
});

export const runKnownGoodReferenceAdapter = (
  operation: A0Operation,
): {
  actual: A0ReferenceActual;
  reachability: A0Reachability[];
} => {
  const reached = [
    reach(
      "known-good-reference-adapter",
      "reference-adapter-invoked",
      operation,
    ),
  ];
  if (operation.interface === "sdk-surface") {
    return {
      actual: {
        status: "executed",
        surface: operation.surface,
        positive: true,
        negative: true,
      },
      reachability: reached,
    };
  }
  if (
    operation.interface === "darkness-consumer" &&
    operation.surface !== undefined
  ) {
    return {
      actual: { status: "dark", surface: operation.surface, consumerCount: 0 },
      reachability: reached,
    };
  }
  if (operation.scenario !== undefined) {
    const actual = scenarioActual(operation.scenario);
    return {
      actual:
        operation.interface === "production-reopen"
          ? { ...actual, independentHostObservation: true }
          : actual,
      reachability: reached,
    };
  }
  if (operation.mutation !== undefined) {
    return {
      actual: {
        decision: "failed-closed",
        error:
          operation.mutation.target === "completion" &&
          operation.mutation.operation === "remove"
            ? "E_UNKNOWN_COMPLETION"
            : mutationError(operation.mutation.target),
        snapshotRef: "ordinary",
        rollback: true,
      },
      reachability: reached,
    };
  }
  if (operation.fault !== undefined) {
    const preflight = [
      "plan-validation",
      "capability-resolution",
      "authority-resolution",
      "digest-admission",
    ].includes(operation.fault.phase);
    const ordinarySnapshot = [
      "commit",
      "close",
      "reopen",
      "post-commit-verify",
      "restart-observation",
      "consumer-construction",
    ].includes(operation.fault.phase);
    return {
      actual: {
        decision: preflight ? "preflight-rejected" : "failed-closed",
        error: faultError(operation.fault.phase),
        snapshotRef:
          preflight || operation.fault.phase === "database-open"
            ? "absent-database"
            : ordinarySnapshot
              ? "ordinary"
              : "pre18",
        rollback: !preflight && operation.fault.phase !== "database-open",
      },
      reachability: reached,
    };
  }
  const input = operation.input ?? {};
  if (input.version === 2)
    return {
      actual: {
        decision: "legacy-v2-only",
        error: null,
        phaseTraceRef: "preflightRejected",
        v12TraceRef: null,
        snapshotRef: "pre18",
        saved: "never-v3",
      },
      reachability: reached,
    };
  if (input.version === 6)
    return {
      actual: failedBehaviorActual(
        "E_UNSUPPORTED_PLAN_OR_CAPABILITY",
        "preflightRejected",
      ),
      reachability: reached,
    };
  if (
    operation.interface === "production-admission" &&
    input.version === undefined &&
    operation.fault === undefined
  )
    return {
      actual: {
        decision: "preflight-rejected",
        error: "E_UNSUPPORTED_PLAN_OR_CAPABILITY",
        database: "absent",
      },
      reachability: reached,
    };
  if (input.version !== undefined && input.version !== 3)
    return {
      actual: {
        decision: "preflight-rejected",
        error: "E_UNSUPPORTED_PLAN_OR_CAPABILITY",
        database: "absent",
      },
      reachability: reached,
    };
  if (input.capability === "unknown")
    return {
      actual: {
        decision: "preflight-rejected",
        error: "E_UNSUPPORTED_PLAN_OR_CAPABILITY",
        database: "absent",
      },
      reachability: reached,
    };
  if (input.authorityId === "unknown")
    return {
      actual:
        input.version === 3
          ? {
              decision: "preflight-rejected",
              error: "E_UNKNOWN_AUTHORITY",
              database: "absent",
            }
          : failedBehaviorActual("E_UNKNOWN_AUTHORITY", "preflightRejected"),
      reachability: reached,
    };
  if (
    typeof input.authorityId === "string" &&
    input.authorityId.startsWith("failed-v")
  )
    return {
      actual: failedBehaviorActual("E_UNKNOWN_AUTHORITY", "preflightRejected"),
      reachability: reached,
    };
  if (input.authorityId === null || Array.isArray(input.authorityIds))
    return {
      actual: failedBehaviorActual("E_UNKNOWN_AUTHORITY", "preflightRejected"),
      reachability: reached,
    };
  if (input.digest !== undefined)
    return {
      actual: {
        decision: "preflight-rejected",
        error: "E_STATIC_DIGEST_MISMATCH",
        database: "absent",
      },
      reachability: reached,
    };
  if (Array.isArray(input.migrationIds)) {
    if (
      input.migrationIds.some((value) => typeof value !== "number") ||
      new Set(input.migrationIds).size !== input.migrationIds.length
    )
      return {
        actual: failedBehaviorActual("E_LEDGER_MALFORMED"),
        reachability: reached,
      };
    if (input.migrationIds.some((value) => Number(value) > 22))
      return {
        actual: failedBehaviorActual("E_LEDGER_FUTURE"),
        reachability: reached,
      };
  }
  if (input.completion !== undefined)
    return {
      actual: failedBehaviorActual("E_COMPLETION_MISMATCH"),
      reachability: reached,
    };
  if (input.state === "full-ledger-no-completion")
    return {
      actual: failedBehaviorActual("E_UNKNOWN_COMPLETION"),
      reachability: reached,
    };
  if (input.state === "prefix-0..16")
    return {
      actual: failedBehaviorActual("E_LEDGER_NONCONTIGUOUS"),
      reachability: reached,
    };
  if (input.migration18Error === "E_UNRELATED_MIGRATION_FAILURE")
    return {
      actual: failedBehaviorActual("E_TRANSACTION_ROLLBACK"),
      reachability: reached,
    };
  const recovered = input.state === "exact-prefix-0..17";
  const strict = input.state === "verified-test-predecessor-prefix-0..17";
  const actual = {
    decision: recovered ? "complete-recovered" : "complete-ordinary",
    error: null,
    phaseTraceRef: recovered
      ? "exactRecovery"
      : strict
        ? "strictPrefix"
        : "ordinary",
    v12TraceRef: recovered
      ? "v12ExactRecovery"
      : strict
        ? "v12StrictPrefix"
        : "v12Ordinary",
    snapshotRef: recovered ? "recovered" : strict ? "strictPrefix" : "ordinary",
    physicalRef: recovered
      ? "exactRecovery"
      : strict
        ? "strictPrefix"
        : "ordinary",
    saved: "after-reopened-host-verification",
  };
  return { actual, reachability: reached };
};

const emptyFakeState = (): ArtifactRecoveryV3FakeState => ({
  schema: [],
  migrationLedger: [],
  completionLedger: [],
  recoveryLedger: [],
  rowsByTable: {},
  edges: [],
  grants: [],
  blobs: [],
  blobReferences: [],
});

export const runReducerAdapter = (operation: A0Operation) => {
  const observation = observationFromOperation(operation);
  return {
    reduction: reduceArtifactReviewV3(observation),
    reachability: reach(
      "shared-sdk-reducer",
      "shared-reducer-invoked",
      observation,
    ),
  };
};

export const runWorkflowsFakeAdapter = (operation: A0Operation) => {
  const adapter = createArtifactRecoveryV3FakeAdapter(emptyFakeState());
  const observation = observationFromOperation(operation);
  const decision = adapter.decide(observation);
  adapter.transact((draft) => {
    (draft as { rowsByTable: Record<string, readonly unknown[]> }).rowsByTable =
      {
        a0_dispatch_receipts: [
          { digest: sha256(canonicalizeArtifactReviewV3(decision)) },
        ],
      };
  });
  return {
    decision,
    state: adapter.snapshot(),
    observation: adapter.observe(),
    reachability: reach(
      "workflows-fake-adapter",
      "workflows-fake-and-shared-reducer-invoked",
      decision,
    ),
  };
};
