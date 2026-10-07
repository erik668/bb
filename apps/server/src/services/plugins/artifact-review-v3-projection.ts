import { createHash } from "node:crypto";
import {
  ARTIFACT_REVIEW_V3_CAPABILITY,
  canonicalizeArtifactReviewV3,
  type PluginMigrationCompletedObservationV3,
  type PluginMigrationRecoveryDescriptorV3,
} from "@get-bb/plugin-sdk";

export const ARTIFACT_REVIEW_V3_AUTHORITY_ID =
  "bb-artifact-review-v3-construction-c0:revision-1" as const;

const statementSha256 = [
  "cb3f719d56d0d09658bef9a0f021ed11496d29c58d9d9c078d239f9dbe78afa6",
  "25757204d3d451e18471a5122c763c0713f59ea85372aa0ed49400bf599e5071",
  "caf5bb39ebbd7372639f2421d50ce8427231529489c25c30d1ca71c105ac603d",
  "d2b6765d51e13028cc32da4b8668d00468a97ae02be20bce217099d6362d3ea1",
  "ba7ff8bfedbd1f8dc16210aede0bd5deeeb4b340090022355629730d6dd54c14",
  "8f7b44eb0118c659b96d5f867e01b4fb2a126891c5f3a6dc499641be742337b1",
  "e2cfdd1965dbb3320046ee9ea102f118a1392a570bc5074ca058ae5e507d7465",
  "eac1a950ae997157aaa3c69c13065ee3d8e74e4e733b1e371c290160a71b9337",
  "a8fb5039dfa92cad024ee86cd5982e28ac541c7c4a96b0b0db5544889372c1d2",
  "e9288122a6224c3e6d88f56a45c88900157d7161425fefcf83ead399db6f9b89",
  "bc4f2cb47b1c15a87b574678dadf01ea9dbe424a2e71253cbeb1a9cec9829c4d",
  "89f614b25f424c27f61d6308f1d93373420fff3cea5a4958b471668bf31ccf24",
  "5c980eccd9a3a40da158ef41806df8f212b494cbc60b2768762bf05fe58c09c2",
  "5951a693ab7a49e5f1b4cecb2e4bc6385853584de204f48b974aaa3fb19e2bfa",
  "1767f3322d25f443f073ff49cada30950ace97d2d348d57696d1baeee7d7a3e3",
  "65e86c96105b3f48f8e0faa5f168e7f5e0d66f916cd4c1ea6d6f8a8a89111f83",
  "5b44b70d6b98aa04374afeefff2860733465d4a1156ac33917b15646073014d8",
  "d147cd626d4887587d4efa99fea9a9f801960d6c9c18b0fb8ac6c9a0b636f01e",
  "aa760982bf7d933ab902f867062d4c11482e64a177b49db5ccdf3ec56dc0f91d",
  "03afb93d68a7018bed783ce9bb72665b52a9c6f544564956d35dbda7d65997a3",
  "1d0f7ebcbc92d9bc7e175a4b70ac430ef42498191b4c57ff46620f82af17434e",
  "57defc2f33da6307d6887fcb357dcf030fd614b56a342f310796ae1fe2b81e14",
  "045811cf8748bb6ca9a33242449f58a2c72dc8e42972e4acc63f2807bef0053e",
] as const;

export interface ResolvedArtifactReviewV3Authority {
  readonly authorityId: typeof ARTIFACT_REVIEW_V3_AUTHORITY_ID;
  readonly capability: typeof ARTIFACT_REVIEW_V3_CAPABILITY;
  readonly descriptor: PluginMigrationRecoveryDescriptorV3;
  readonly statementSha256: readonly string[];
  readonly statementVectorSha256: string;
  readonly completionTable: "_bb_plugin_migration_completions";
  readonly recoveryTable: "_bb_plugin_migration_recoveries_v3";
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const authority: ResolvedArtifactReviewV3Authority = Object.freeze({
  authorityId: ARTIFACT_REVIEW_V3_AUTHORITY_ID,
  capability: ARTIFACT_REVIEW_V3_CAPABILITY,
  descriptor: Object.freeze({
    authorityId: ARTIFACT_REVIEW_V3_AUTHORITY_ID,
    predecessorAuthorityId: null,
    beforeMigrationId: 18,
  }),
  statementSha256: Object.freeze([...statementSha256]),
  statementVectorSha256: sha256(
    statementSha256.map((digest, id) => `${id}:${digest}`).join(";"),
  ),
  completionTable: "_bb_plugin_migration_completions",
  recoveryTable: "_bb_plugin_migration_recoveries_v3",
});

/** Host-owned exact lookup. No alias or registry fallback is permitted. */
export function resolveArtifactReviewV3Authority(
  authorityId: string,
): ResolvedArtifactReviewV3Authority {
  if (authorityId !== ARTIFACT_REVIEW_V3_AUTHORITY_ID) {
    throw new Error(`E_UNKNOWN_AUTHORITY:${authorityId}`);
  }
  return authority;
}

const isDigest = (value: string): boolean => /^[a-f0-9]{64}$/u.test(value);

/**
 * Normalizes and hashes actual rematerialized schema/ledger/row/edge/grant/blob
 * evidence. This projection contains no caller-authored expected outcome.
 */
export function projectArtifactReviewV3(
  observation: PluginMigrationCompletedObservationV3,
): { readonly canonical: string; readonly sha256: string } {
  const digests = [
    observation.schemaSha256,
    observation.migrationLedgerSha256,
    observation.activeRootSha256,
    observation.quarantineRootSha256,
    observation.presentationGrantRootSha256,
    observation.blobObjectRootSha256,
    observation.blobReferenceRootSha256,
    observation.relationshipRootSha256,
  ];
  if (!digests.every(isDigest)) throw new Error("E_ROOT_OR_COUNT_MISMATCH");
  const counts = [
    ...Object.values(observation.perTableCounts),
    observation.relationshipCount,
    observation.referenceCount,
    observation.grantCount,
    observation.blobObjectCount,
    observation.blobReferenceCount,
  ];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error("E_ROOT_OR_COUNT_MISMATCH");
  }
  const encoded = canonicalizeArtifactReviewV3(observation);
  return { canonical: encoded, sha256: sha256(encoded) };
}
