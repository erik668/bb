import type {
  ArtifactReviewMutationInvariant,
  ArtifactReviewMutationKind,
  ArtifactReviewMutationScenario,
} from "./artifact-review-mutation-contract.js";

export const ARTIFACT_REVIEW_MUTATION_OWNERSHIP_MODULE = {
  surfaceId: "mutation-ownership",
  path: "plugins/workflows/src/artifact-review-mutation-ownership.ts",
  description:
    "Typed successor invariant ownership, applicability, and legacy disposition.",
} as const;

export type ArtifactReviewMutationLegacyDisposition =
  | "shared"
  | "successor-only";

export type ArtifactReviewMutationOwnershipApplication =
  | Readonly<{ mutationKind: "authority-input" }>
  | Readonly<{
      mutationKind: "idempotency-lookup";
      sameScope: boolean;
    }>
  | Readonly<{ mutationKind: "durability-response" }>;

type ArtifactReviewMutationOwnershipEntry = Readonly<{
  legacyDisposition: ArtifactReviewMutationLegacyDisposition;
  applications: ReadonlyArray<ArtifactReviewMutationOwnershipApplication>;
}>;

export const ARTIFACT_REVIEW_MUTATION_OWNERSHIP = {
  "local-owner": {
    legacyDisposition: "successor-only",
    applications: [{ mutationKind: "authority-input" }],
  },
  "origin-scope": {
    legacyDisposition: "shared",
    applications: [{ mutationKind: "idempotency-lookup", sameScope: false }],
  },
  idempotency: {
    legacyDisposition: "successor-only",
    applications: [
      { mutationKind: "idempotency-lookup", sameScope: true },
      { mutationKind: "durability-response" },
    ],
  },
} as const satisfies Record<
  ArtifactReviewMutationInvariant,
  ArtifactReviewMutationOwnershipEntry
>;

type IsExactly<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <
        Value,
      >() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;

type Assert<Condition extends true> = Condition;

type OwnershipInvariantForKind<Kind extends ArtifactReviewMutationKind> = {
  [Invariant in keyof typeof ARTIFACT_REVIEW_MUTATION_OWNERSHIP]: Extract<
    (typeof ARTIFACT_REVIEW_MUTATION_OWNERSHIP)[Invariant]["applications"][number],
    { mutationKind: Kind }
  > extends never
    ? never
    : Invariant;
}[keyof typeof ARTIFACT_REVIEW_MUTATION_OWNERSHIP];

type OwnershipInvariantsByKind = {
  [Kind in ArtifactReviewMutationKind]: OwnershipInvariantForKind<Kind>;
};

type ContractInvariantsByKind = {
  [Kind in ArtifactReviewMutationKind]: Extract<
    ArtifactReviewMutationScenario,
    { mutationKind: Kind }
  >["invariant"];
};

type MappingKeysEqualContractInvariants = Assert<
  IsExactly<
    keyof typeof ARTIFACT_REVIEW_MUTATION_OWNERSHIP,
    ArtifactReviewMutationInvariant
  >
>;

type MappingKindUnionsEqualContractKindUnions = Assert<
  IsExactly<OwnershipInvariantsByKind, ContractInvariantsByKind>
>;

export type ArtifactReviewMutationOwnershipTypeProof = Readonly<{
  mappingKeys: MappingKeysEqualContractInvariants;
  kindUnions: MappingKindUnionsEqualContractKindUnions;
}>;
