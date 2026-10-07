import { z } from "zod";

export const ARTIFACT_REVIEW_MUTATION_AUTHORITY = Object.freeze({
  successorSeamId:
    "artifact-review-v7:discriminated-mutation-proof-boundary-v1",
  architectureRevision: 2,
  contractId: "bb-artifact-review-service:revision-1",
  acceptedDesignSha256:
    "d97f8c76f09a92ce242977d0b676a19fb3dd48c1a5e6223602378783721f175f",
  contextPacketSha256:
    "40b147a61a59f48c2a52cccdcf2b54e516dae79967bb760c8033d9ba5401cc44",
  architectureSynthesisRunId: "wfr_473e2b42-b3bd-45f2-88bc-ac9be2a3a6e4",
} as const);

export const ARTIFACT_REVIEW_MUTATION_KINDS = [
  "authority-input",
  "idempotency-lookup",
  "durability-response",
] as const;

export const ARTIFACT_REVIEW_MUTATION_INVARIANTS = [
  "local-owner",
  "origin-scope",
  "idempotency",
] as const;

export const ARTIFACT_REVIEW_MUTATION_ADMISSION_ERROR =
  "invalid-input" as const;

const presentationMetadataSchema = z
  .object({
    panelLabel: z.string(),
  })
  .strict();

const optionalPresentationMetadata = {
  presentationMetadata: presentationMetadataSchema.optional(),
};

export const artifactReviewAuthorityInputSchema = z
  .object({
    mutationKind: z.literal("authority-input"),
    invariant: z.literal("local-owner"),
    clientActorSupplied: z.literal(true),
    ...optionalPresentationMetadata,
  })
  .strict();

export const artifactReviewIdempotencyLookupSchema = z
  .object({
    mutationKind: z.literal("idempotency-lookup"),
    invariant: z.enum(["origin-scope", "idempotency"]),
    sameScope: z.boolean(),
    sameActor: z.boolean(),
    sameKey: z.boolean(),
    sameOperation: z.boolean(),
    sameDigest: z.boolean(),
    ...optionalPresentationMetadata,
  })
  .strict();

export const artifactReviewDurabilityStateSchema = z.union([
  z
    .object({
      committed: z.literal(false),
      uiState: z.literal("saving"),
      deliveryState: z.literal("pending"),
      exactRetry: z.literal(false),
    })
    .strict(),
  z
    .object({
      committed: z.literal(true),
      uiState: z.literal("saved"),
      deliveryState: z.literal("delivered"),
      exactRetry: z.literal(false),
    })
    .strict(),
  z
    .object({
      committed: z.literal(true),
      uiState: z.literal("saving"),
      deliveryState: z.literal("response-lost"),
      exactRetry: z.literal(false),
    })
    .strict(),
  z
    .object({
      committed: z.literal(true),
      uiState: z.literal("saving"),
      deliveryState: z.literal("response-lost"),
      exactRetry: z.literal(true),
    })
    .strict(),
]);

export const artifactReviewDurabilityResponseSchema = z
  .object({
    mutationKind: z.literal("durability-response"),
    invariant: z.literal("idempotency"),
    state: artifactReviewDurabilityStateSchema,
    ...optionalPresentationMetadata,
  })
  .strict();

export const artifactReviewMutationScenarioSchema = z.discriminatedUnion(
  "mutationKind",
  [
    artifactReviewAuthorityInputSchema,
    artifactReviewIdempotencyLookupSchema,
    artifactReviewDurabilityResponseSchema,
  ],
);

export type ArtifactReviewMutationKind =
  (typeof ARTIFACT_REVIEW_MUTATION_KINDS)[number];
export type ArtifactReviewMutationInvariant =
  (typeof ARTIFACT_REVIEW_MUTATION_INVARIANTS)[number];
export type ArtifactReviewMutationScenario = z.infer<
  typeof artifactReviewMutationScenarioSchema
>;
export type ArtifactReviewAuthorityInput = z.infer<
  typeof artifactReviewAuthorityInputSchema
>;
export type ArtifactReviewIdempotencyLookup = z.infer<
  typeof artifactReviewIdempotencyLookupSchema
>;
export type ArtifactReviewDurabilityResponse = z.infer<
  typeof artifactReviewDurabilityResponseSchema
>;

export type ArtifactReviewMutationAdmission =
  | Readonly<{
      admitted: true;
      value: ArtifactReviewMutationScenario;
    }>
  | Readonly<{
      admitted: false;
      code: typeof ARTIFACT_REVIEW_MUTATION_ADMISSION_ERROR;
      issues: ReadonlyArray<
        Readonly<{
          code: string;
          path: ReadonlyArray<string>;
        }>
      >;
    }>;

export function admitArtifactReviewMutationScenario(
  input: unknown,
): ArtifactReviewMutationAdmission {
  const parsed = artifactReviewMutationScenarioSchema.safeParse(input);
  if (parsed.success) {
    return {
      admitted: true,
      value: parsed.data,
    };
  }

  return {
    admitted: false,
    code: ARTIFACT_REVIEW_MUTATION_ADMISSION_ERROR,
    issues: parsed.error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map(String),
    })),
  };
}
