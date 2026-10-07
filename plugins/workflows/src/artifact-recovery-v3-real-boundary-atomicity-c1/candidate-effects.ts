import type {
  PluginMigrationCandidateEffectsV3,
  PluginMigrationDomainEffectV3,
} from "@get-bb/plugin-sdk";
import { migrations } from "../data.js";

/** Recorder-selected inputs; none of these fields claims an expected result. */
export interface ArtifactReviewV3CandidateInput {
  readonly recorderNonce: string;
  readonly stimulusId: string;
  readonly operationKind: string;
  readonly operationPayload: Uint8Array;
  readonly launchPayload: Uint8Array;
  readonly queryPayload: Uint8Array;
  readonly domainEffects?: readonly PluginMigrationDomainEffectV3[];
  readonly recoveryEffects?: readonly PluginMigrationDomainEffectV3[];
}

/**
 * Supplies domain effects only. Path selection, transaction ownership, gate
 * consumption, receipt keys, completion, reopen, and observation remain host
 * or recorder responsibilities.
 */
export function createArtifactReviewV3CandidateEffects(
  input: ArtifactReviewV3CandidateInput,
): PluginMigrationCandidateEffectsV3 {
  return {
    version: 3,
    statements: migrations,
    gate: {
      recorderNonce: input.recorderNonce,
      stimulusId: input.stimulusId,
    },
    operation: {
      kind: input.operationKind,
      payload: input.operationPayload,
    },
    launch: { payload: input.launchPayload },
    query: { payload: input.queryPayload },
    domainEffects: input.domainEffects ?? [],
    recoveryEffects: input.recoveryEffects ?? [],
  };
}
