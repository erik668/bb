import {
  reduceArtifactReviewV3,
  type ArtifactReviewV3Observation,
} from "@get-bb/plugin-sdk";
import {
  projectArtifactRecoveryV3Fake,
  type ArtifactRecoveryV3FakeState,
} from "./artifact-recovery-v3-fake-projection.js";

/**
 * Fake effects stay separate from production SQLite effects. Both adapters
 * share only the SDK reducer and normalized contract.
 */
export function createArtifactRecoveryV3FakeAdapter(
  initialState: ArtifactRecoveryV3FakeState,
) {
  let state = structuredClone(initialState);
  return {
    observe(): ReturnType<typeof projectArtifactRecoveryV3Fake> {
      return projectArtifactRecoveryV3Fake(state);
    },
    decide(observation: ArtifactReviewV3Observation) {
      return reduceArtifactReviewV3(observation);
    },
    transact(effect: (draft: ArtifactRecoveryV3FakeState) => void): void {
      const draft = structuredClone(state);
      effect(draft);
      state = draft;
    },
    snapshot(): ArtifactRecoveryV3FakeState {
      return structuredClone(state);
    },
  };
}
