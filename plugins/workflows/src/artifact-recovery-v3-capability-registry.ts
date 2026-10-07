import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  ARTIFACT_REVIEW_V3_CAPABILITY,
  canonicalizeArtifactReviewV3,
  type PluginMigrationCompletedObservationV3,
  type PluginMigrationPlanV3,
} from "@get-bb/plugin-sdk";
import { createWorkflowMigrationPlanV2 } from "./artifact-recovery.js";

export const ARTIFACT_RECOVERY_V3_AUTHORITY_ID =
  "bb-artifact-review-v3-construction-c0:revision-1" as const;

export const artifactRecoveryV3Capability = Object.freeze({
  ...ARTIFACT_REVIEW_V3_CAPABILITY,
  authorityId: ARTIFACT_RECOVERY_V3_AUTHORITY_ID,
  consumerReachable: false,
  rollout: "dark",
} as const);

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const normalized = (value: unknown): unknown => {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return ["BLOB", Buffer.from(value).toString("hex")];
  }
  if (value === null) return ["NULL"];
  if (typeof value === "number") return ["INTEGER", String(value)];
  if (typeof value === "string") return ["TEXT", value];
  if (Array.isArray(value)) return value.map(normalized);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        normalized(item),
      ]),
    );
  }
  throw new Error("E_SCHEMA_METADATA_MISMATCH");
};

const multisetRoot = (domain: string, values: readonly unknown[]): string => {
  const leaves = values
    .map((value) =>
      sha256(`${domain}\0${canonicalizeArtifactReviewV3(normalized(value))}`),
    )
    .sort();
  return leaves.length === 0
    ? sha256(`${domain}\0EMPTY\0v1`)
    : sha256(`${domain}\0v1\0${leaves.length}\0${leaves.join("")}`);
};

const tableNames = (database: Database.Database): string[] =>
  (
    database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'workflow_artifact%'
         ORDER BY name`,
      )
      .pluck()
      .all() as string[]
  ).filter((name) => !name.startsWith("sqlite_"));

const orderedRows = (
  database: Database.Database,
  table: string,
): Array<Record<string, unknown>> => {
  const rows = database.prepare(`SELECT * FROM "${table}"`).all() as Array<
    Record<string, unknown>
  >;
  return rows.sort((left, right) =>
    canonicalizeArtifactReviewV3(normalized(left)).localeCompare(
      canonicalizeArtifactReviewV3(normalized(right)),
    ),
  );
};

export function verifyWorkflowArtifactRecoveryV3Completed(
  database: Database.Database,
): PluginMigrationCompletedObservationV3 {
  const schemaRows = database
    .prepare(
      `SELECT type, name, tbl_name AS tableName, sql
       FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name, tbl_name`,
    )
    .all();
  const migrationIds = database
    .prepare("SELECT id FROM _bb_migrations ORDER BY id")
    .pluck()
    .all() as number[];
  const names = tableNames(database);
  const activeNames = names.filter(
    (name) =>
      !name.startsWith("workflow_artifact_recovery_") &&
      name !== "workflow_artifact_presentation_grants" &&
      name !== "workflow_artifact_blobs",
  );
  const quarantineNames = names.filter((name) =>
    name.startsWith("workflow_artifact_recovery_"),
  );
  const rowsByTable = Object.fromEntries(
    names.map((name) => [name, orderedRows(database, name)]),
  );
  const perTableCounts = Object.fromEntries(
    names.map((name) => [name, rowsByTable[name]!.length]),
  );
  const activeRows = activeNames.flatMap((table) =>
    rowsByTable[table]!.map((row) => ({ table, row })),
  );
  const quarantineRows = quarantineNames.flatMap((table) =>
    rowsByTable[table]!.map((row) => ({ table, row })),
  );
  const grants = rowsByTable.workflow_artifact_presentation_grants ?? [];
  const blobs = (
    rowsByTable.workflow_artifact_blobs ?? []
  ).map((row) => ({
    sha256: row.sha256,
    contentType: row.content_type,
    content: normalized(row.content),
    byteLength: row.byte_length,
    createdAt: row.created_at,
  }));
  for (const blob of blobs) {
    if (
      typeof blob.sha256 !== "string" ||
      !Array.isArray(blob.content) ||
      blob.content[0] !== "BLOB" ||
      typeof blob.content[1] !== "string" ||
      blob.content[1].length / 2 !== blob.byteLength ||
      sha256(Buffer.from(blob.content[1], "hex")) !== blob.sha256
    ) {
      throw new Error("E_BLOB_OBJECT_MISMATCH");
    }
  }
  const relationships: unknown[] = [];
  const references: unknown[] = [];
  for (const table of activeNames) {
    for (const row of rowsByTable[table]!) {
      for (const [column, value] of Object.entries(row)) {
        if (value === null) continue;
        if (column === "blob_sha256" || column === "target_blob_sha256") {
          references.push({ table, column, value });
        }
        if (
          column.endsWith("_id") ||
          column.endsWith("_revision") ||
          column === "blob_sha256" ||
          column === "target_blob_sha256"
        ) {
          relationships.push({ table, column, value });
        }
      }
    }
  }
  const foreignKeyViolations = database.pragma("foreign_key_check") as unknown[];
  if (foreignKeyViolations.length > 0) {
    throw new Error("E_RELATIONSHIP_MISMATCH");
  }
  return {
    schemaSha256: sha256(JSON.stringify(schemaRows)),
    migrationLedgerSha256: sha256(JSON.stringify(migrationIds)),
    activeRootSha256: multisetRoot("artifact-review-v3:active", activeRows),
    quarantineRootSha256: multisetRoot(
      "artifact-review-v3:quarantine",
      quarantineRows,
    ),
    presentationGrantRootSha256: multisetRoot(
      "artifact-review-v3:grants",
      grants,
    ),
    blobObjectRootSha256: multisetRoot("artifact-review-v3:blobs", blobs),
    blobReferenceRootSha256: multisetRoot(
      "artifact-review-v3:blob-references",
      references,
    ),
    relationshipRootSha256: multisetRoot(
      "artifact-review-v3:relationships",
      relationships,
    ),
    perTableCounts,
    relationshipCount: relationships.length,
    referenceCount: references.length,
    grantCount: grants.length,
    blobObjectCount: blobs.length,
    blobReferenceCount: references.length,
  };
}

export function createWorkflowMigrationPlanV3(
  statements: readonly string[],
): PluginMigrationPlanV3 {
  const v2 = createWorkflowMigrationPlanV2(statements);
  return {
    version: 3,
    authorityId: ARTIFACT_RECOVERY_V3_AUTHORITY_ID,
    statements,
    recover(context) {
      v2.recovery.recover({
        database: context.database,
        descriptor: v2.recovery.descriptor,
        executeMigration: context.executeMigration,
      });
      const observation = verifyWorkflowArtifactRecoveryV3Completed(
        context.database,
      );
      return {
        semanticReceiptSha256: sha256(
          canonicalizeArtifactReviewV3(observation),
        ),
        observation,
      };
    },
    verifyCompleted(database) {
      return verifyWorkflowArtifactRecoveryV3Completed(database);
    },
  };
}
