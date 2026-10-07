import { createHash } from "node:crypto";
import { canonicalizeArtifactReviewV3 } from "@get-bb/plugin-sdk";

export type ArtifactRecoveryV3FakeState = {
  readonly schema: readonly unknown[];
  readonly migrationLedger: readonly unknown[];
  readonly completionLedger: readonly unknown[];
  readonly recoveryLedger: readonly unknown[];
  readonly rowsByTable: Readonly<Record<string, readonly unknown[]>>;
  readonly edges: readonly unknown[];
  readonly grants: readonly unknown[];
  readonly blobs: readonly {
    readonly sha256: string;
    readonly contentType: string;
    readonly bytesHex: string;
    readonly byteLength: number;
    readonly createdAt: number;
  }[];
  readonly blobReferences: readonly unknown[];
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const root = (domain: string, values: readonly unknown[]): string =>
  sha256(
    `${domain}\0${values
      .map(canonicalizeArtifactReviewV3)
      .sort()
      .join("\0")}`,
  );

/** Independent in-memory projection used by the fake contract corpus. */
export function projectArtifactRecoveryV3Fake(
  state: ArtifactRecoveryV3FakeState,
) {
  const tableNames = Object.keys(state.rowsByTable).sort();
  const perTableCounts = Object.fromEntries(
    tableNames.map((table) => [table, state.rowsByTable[table]!.length]),
  );
  const activeRows = tableNames.flatMap((table) =>
    state.rowsByTable[table]!.map((row) => ({ table, row })),
  );
  return {
    schemaSha256: root("artifact-review-v3:schema", state.schema),
    migrationLedgerSha256: root(
      "artifact-review-v3:migrations",
      state.migrationLedger,
    ),
    completionLedgerSha256: root(
      "artifact-review-v3:completions",
      state.completionLedger,
    ),
    recoveryLedgerSha256: root(
      "artifact-review-v3:recoveries",
      state.recoveryLedger,
    ),
    activeRootSha256: root("artifact-review-v3:active", activeRows),
    quarantineRootSha256: root(
      "artifact-review-v3:quarantine",
      state.recoveryLedger,
    ),
    presentationGrantRootSha256: root(
      "artifact-review-v3:grants",
      state.grants,
    ),
    blobObjectRootSha256: root("artifact-review-v3:blobs", state.blobs),
    blobReferenceRootSha256: root(
      "artifact-review-v3:blob-references",
      state.blobReferences,
    ),
    relationshipRootSha256: root("artifact-review-v3:edges", state.edges),
    perTableCounts,
    relationshipCount: state.edges.length,
    referenceCount: state.blobReferences.length,
    grantCount: state.grants.length,
    blobObjectCount: state.blobs.length,
    blobReferenceCount: state.blobReferences.length,
  } as const;
}
