import {
  ARTIFACT_REVIEW_MUTATION_ADMISSION_ERROR,
  admitArtifactReviewMutationScenario,
  type ArtifactReviewMutationScenario,
} from "./artifact-review-mutation-contract.js";

export type ArtifactReviewMutationReferenceOutcome =
  | typeof ARTIFACT_REVIEW_MUTATION_ADMISSION_ERROR
  | "reject-authority-input"
  | "new-mutation"
  | "replay-committed"
  | "idempotency-conflict"
  | "pending-not-saved"
  | "saved-after-commit"
  | "retryable-after-response-loss";

function evaluateAdmittedMutation(
  scenario: ArtifactReviewMutationScenario,
): ArtifactReviewMutationReferenceOutcome {
  switch (scenario.mutationKind) {
    case "authority-input":
      if (scenario.invariant !== "local-owner") {
        return ARTIFACT_REVIEW_MUTATION_ADMISSION_ERROR;
      }
      return "reject-authority-input";
    case "idempotency-lookup": {
      const applicableInvariant = scenario.sameScope
        ? "idempotency"
        : "origin-scope";
      if (scenario.invariant !== applicableInvariant) {
        return ARTIFACT_REVIEW_MUTATION_ADMISSION_ERROR;
      }
      if (!scenario.sameScope || !scenario.sameActor || !scenario.sameKey) {
        return "new-mutation";
      }
      return scenario.sameOperation && scenario.sameDigest
        ? "replay-committed"
        : "idempotency-conflict";
    }
    case "durability-response":
      if (scenario.invariant !== "idempotency") {
        return ARTIFACT_REVIEW_MUTATION_ADMISSION_ERROR;
      }
      if (!scenario.state.committed) {
        return "pending-not-saved";
      }
      if (scenario.state.deliveryState === "delivered") {
        return "saved-after-commit";
      }
      return scenario.state.exactRetry
        ? "replay-committed"
        : "retryable-after-response-loss";
  }
}

export function evaluateArtifactReviewMutationReference(
  input: unknown,
): ArtifactReviewMutationReferenceOutcome {
  const admission = admitArtifactReviewMutationScenario(input);
  if (!admission.admitted) {
    return admission.code;
  }
  return evaluateAdmittedMutation(admission.value);
}
