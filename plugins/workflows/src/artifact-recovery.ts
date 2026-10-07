import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

interface PluginMigrationRecoveryContextV2 {
  readonly database: Database.Database;
  readonly descriptor: typeof RECOVERY_DESCRIPTOR;
  executeMigration(migrationId: number): void;
}

interface PluginMigrationRecoveryResultV2 {
  readonly activeGraphSha256: string;
  readonly quarantineGraphSha256: string;
  readonly stagedRowCount: number;
  readonly restoredGrantCount: number;
  readonly receiptSha256: string;
}

interface PluginMigrationPlanV2 {
  readonly version: 2;
  readonly statements: readonly string[];
  readonly statementSha256: readonly string[];
  readonly recovery: {
    readonly descriptor: typeof RECOVERY_DESCRIPTOR;
    readonly recoveryRecipeJson: string;
    recover(
      context: PluginMigrationRecoveryContextV2,
    ): PluginMigrationRecoveryResultV2;
  };
}

const RECOVERY_ID =
  "artifact-review-v6:hash-bound-pre18-quarantine-recovery-v1";

export const RECOVERY_MIGRATION_22_SQL = `
  CREATE TABLE workflow_artifact_recovery_components (
    recovery_id TEXT NOT NULL,
    component_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    collision_classes_json TEXT NOT NULL CHECK(json_valid(collision_classes_json)),
    canonical_component_sha256 TEXT NOT NULL CHECK(length(canonical_component_sha256) = 64),
    row_count INTEGER NOT NULL CHECK(row_count >= 1),
    blob_count INTEGER NOT NULL CHECK(blob_count >= 0),
    adopted_at INTEGER NOT NULL,
    PRIMARY KEY (recovery_id, component_id)
  );
  CREATE TABLE workflow_artifact_recovery_rows (
    recovery_id TEXT NOT NULL,
    component_id TEXT NOT NULL,
    row_ordinal INTEGER NOT NULL CHECK(row_ordinal >= 0),
    table_name TEXT NOT NULL CHECK(table_name IN ('workflow_artifacts', 'workflow_artifact_revisions', 'workflow_artifact_annotations', 'workflow_artifact_working_drafts', 'workflow_artifact_decisions', 'workflow_artifact_stewards', 'workflow_artifact_mutations', 'workflow_artifact_apply_intents')),
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    presentation_thread_id TEXT NOT NULL,
    row_id TEXT,
    artifact_id TEXT,
    artifact_revision INTEGER,
    blob_sha256 TEXT,
    canonical_primary_key_json TEXT NOT NULL CHECK(json_valid(canonical_primary_key_json)),
    relationships_json TEXT NOT NULL CHECK(json_valid(relationships_json)),
    canonical_row_encoding BLOB NOT NULL,
    canonical_row_sha256 TEXT NOT NULL CHECK(length(canonical_row_sha256) = 64),
    PRIMARY KEY (recovery_id, component_id, row_ordinal),
    FOREIGN KEY (recovery_id, component_id)
      REFERENCES workflow_artifact_recovery_components(recovery_id, component_id)
      ON DELETE RESTRICT
  );
  CREATE TABLE workflow_artifact_recovery_blobs (
    recovery_id TEXT NOT NULL,
    component_id TEXT NOT NULL,
    sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
    content_type TEXT NOT NULL,
    content BLOB NOT NULL,
    byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
    created_at INTEGER NOT NULL,
    CHECK(length(content) = byte_length),
    PRIMARY KEY (recovery_id, component_id, sha256),
    FOREIGN KEY (recovery_id, component_id)
      REFERENCES workflow_artifact_recovery_components(recovery_id, component_id)
      ON DELETE RESTRICT
  );
  CREATE TABLE workflow_artifact_recovery_receipts (
    recovery_id TEXT PRIMARY KEY,
    descriptor_sha256 TEXT NOT NULL CHECK(length(descriptor_sha256) = 64),
    recovery_recipe_sha256 TEXT NOT NULL CHECK(length(recovery_recipe_sha256) = 64),
    pre_schema_fingerprint_sha256 TEXT NOT NULL CHECK(length(pre_schema_fingerprint_sha256) = 64),
    migration_18_sha256 TEXT NOT NULL CHECK(length(migration_18_sha256) = 64),
    active_graph_sha256 TEXT NOT NULL CHECK(length(active_graph_sha256) = 64),
    quarantine_graph_sha256 TEXT NOT NULL CHECK(length(quarantine_graph_sha256) = 64),
    staged_row_count INTEGER NOT NULL CHECK(staged_row_count >= 0),
    restored_grant_count INTEGER NOT NULL CHECK(restored_grant_count >= 0),
    adopted_at INTEGER NOT NULL
  );` as const;

export const RECOVERY_RECIPE_MANIFEST = {
  recoveryId: RECOVERY_ID,
  beforeMigrationId: 18,
  stageTables: [
    "workflow_artifacts",
    "workflow_artifact_revisions",
    "workflow_artifact_annotations",
    "workflow_artifact_working_drafts",
    "workflow_artifact_decisions",
    "workflow_artifact_stewards",
    "workflow_artifact_mutations",
    "workflow_artifact_apply_intents",
    "workflow_artifact_blobs",
  ],
  collisionClasses: [
    "artifact-title",
    "artifact-content-type",
    "revision-blob",
    "revision-status",
    "revision-source-binding",
    "annotation-dependent-row",
    "working-draft-dependent-row",
    "decision-dependent-row",
    "steward-dependent-row",
    "mutation-dependent-row",
    "apply-intent-dependent-row",
    "artifact-kind-partial-unique",
    "admitted-revision-partial-unique",
    "active-apply-partial-unique",
    "steward-thread-partial-unique",
    "mutation-identity-partial-unique",
  ],
  transactionSteps: [
    "admit-exact-ledger-schema-host-and-migration-hashes",
    "classify-complete-origin-components",
    "stage-typed-rows-relationships-provenance-encodings-and-blobs",
    "remove-only-staged-components-from-working-v1",
    "execute-immutable-migrations-18-through-22",
    "restore-presentation-mounts-only-as-grants",
    "adopt-quarantine-and-immutable-recovery-receipt",
    "verify-active-and-quarantine-row-byte-parity",
    "write-separate-host-recovery-ledger-identity",
  ],
  parity: [
    "per-table-row-count",
    "per-row-canonical-sha256",
    "relationship-closure",
    "presentation-provenance",
    "referenced-blob-count",
    "referenced-blob-byte-length",
    "referenced-blob-sha256",
  ],
  prohibitions: [
    "no-winner-by-thread-time-row-order-title-or-digest",
    "no-synthesized-active-artifact-for-conflicting-origin",
    "no-edit-forge-renumber-or-skip-immutable-migration",
    "no-row-or-byte-loss",
    "no-presentation-scope-authority",
    "no-live-change-enablement",
  ],
} as const;

export const RECOVERY_DESCRIPTOR = {
  recoveryId: RECOVERY_ID,
  beforeMigrationId: 18,
  migration18Sha256:
    "aa760982bf7d933ab902f867062d4c11482e64a177b49db5ccdf3ec56dc0f91d",
  preSchemaFingerprintAlgorithm:
    "SHA-256(JSON.stringify sqlite_master rows ordered by type,name,tbl_name; keys type,name,tableName,sql)",
  preSchemaFingerprintSha256:
    "51a8174aa115545aebc378063c3d1a612ab5561ea22932bd744dea0506fa5afa",
  recoveryRecipeSha256:
    "ecbde76025e9b93e358badb75bdeee20284c1ce7e39e2a824afe416bdeaf5d79",
} as const;

type Scalar = string | number | null;
type StoredRow = Record<string, Scalar>;
type Scope = {
  campaignId: string;
  projectId: string;
  environmentId: string;
};

interface StagedRow {
  table: string;
  row: StoredRow;
  primaryKeyJson: string;
  relationshipsJson: string;
  encoding: Buffer;
  sha256: string;
}

interface StagedBlob {
  sha256: string;
  contentType: string;
  content: Buffer;
  byteLength: number;
  createdAt: number;
}

interface StagedComponent extends Scope {
  componentId: string;
  artifactId: string;
  collisionClasses: Set<string>;
  rows: StagedRow[];
  blobs: StagedBlob[];
  grants: Array<{ presentationThreadId: string; grantedAt: number }>;
}

const GRAPH_TABLES = RECOVERY_RECIPE_MANIFEST.stageTables.slice(0, -1);

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return JSON.stringify({ $bytes: Buffer.from(value).toString("base64") });
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function scopeKey(scope: Scope): string {
  return canonical([scope.campaignId, scope.projectId, scope.environmentId]);
}

function rowScope(row: Record<string, unknown>): Scope {
  return {
    campaignId: String(row.campaign_id),
    projectId: String(row.project_id),
    environmentId: String(row.environment_id),
  };
}

function addCollisionScopes(
  database: Database.Database,
  collisions: Map<string, { scope: Scope; classes: Set<string> }>,
  sql: string,
  classes: readonly string[],
): void {
  const rows = database.prepare(sql).all() as Array<Record<string, unknown>>;
  for (const row of rows) {
    const scope = rowScope(row);
    const key = scopeKey(scope);
    const entry = collisions.get(key) ?? { scope, classes: new Set<string>() };
    for (const collisionClass of classes) entry.classes.add(collisionClass);
    collisions.set(key, entry);
  }
}

function classifyCollisions(database: Database.Database) {
  const collisions = new Map<string, { scope: Scope; classes: Set<string> }>();
  const scope = "campaign_id, project_id, environment_id";
  addCollisionScopes(
    database,
    collisions,
    `SELECT ${scope} FROM workflow_artifacts GROUP BY ${scope}, id
     HAVING count(DISTINCT kind) > 1 OR count(DISTINCT title) > 1
       OR count(DISTINCT content_type) > 1`,
    ["artifact-kind-partial-unique", "artifact-title", "artifact-content-type"],
  );
  addCollisionScopes(
    database,
    collisions,
    `SELECT ${scope} FROM workflow_artifacts GROUP BY ${scope}, kind
     HAVING count(DISTINCT id) > 1`,
    ["artifact-kind-partial-unique"],
  );
  addCollisionScopes(
    database,
    collisions,
    `SELECT ${scope} FROM workflow_artifact_revisions
     GROUP BY ${scope}, artifact_id, revision HAVING
       count(DISTINCT blob_sha256) > 1 OR count(DISTINCT status) > 1 OR
       count(DISTINCT json_array(source_host_id, source_root_path,
         source_relative_path, source_sha256, produced_by_thread_id)) > 1`,
    ["revision-blob", "revision-status", "revision-source-binding"],
  );
  addCollisionScopes(
    database,
    collisions,
    `SELECT ${scope} FROM workflow_artifact_revisions WHERE status = 'admitted'
     GROUP BY ${scope}, artifact_id HAVING count(DISTINCT revision) > 1`,
    ["admitted-revision-partial-unique"],
  );
  for (const [table, id, collisionClass] of [
    ["workflow_artifact_annotations", "id", "annotation-dependent-row"],
    ["workflow_artifact_decisions", "id", "decision-dependent-row"],
    ["workflow_artifact_stewards", "role", "steward-dependent-row"],
    ["workflow_artifact_apply_intents", "id", "apply-intent-dependent-row"],
  ] as const) {
    addCollisionScopes(
      database,
      collisions,
      `SELECT ${scope} FROM ${table} GROUP BY ${scope}, ${id} HAVING count(*) > 1`,
      [collisionClass],
    );
  }
  addCollisionScopes(
    database,
    collisions,
    `SELECT ${scope} FROM workflow_artifact_mutations
     GROUP BY ${scope}, presentation_thread_id, actor, idempotency_key
     HAVING count(*) > 1`,
    ["mutation-dependent-row", "mutation-identity-partial-unique"],
  );
  addCollisionScopes(
    database,
    collisions,
    `SELECT ${scope} FROM workflow_artifact_apply_intents
     WHERE state IN ('prepared', 'file-applied', 'awaiting-source-host')
     GROUP BY ${scope}, artifact_id HAVING count(*) > 1`,
    ["active-apply-partial-unique"],
  );
  return collisions;
}

function tablePrimaryKeys(
  database: Database.Database,
  table: string,
): string[] {
  return (
    database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      pk: number;
    }>
  )
    .filter(({ pk }) => pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map(({ name }) => name);
}

function storedRow(row: Record<string, unknown>): StoredRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "number"
      ) {
        return [key, value];
      }
      throw new Error(`Recovery row ${key} has a non-canonical storage type`);
    }),
  );
}

function stageComponents(
  database: Database.Database,
  collisions: ReturnType<typeof classifyCollisions>,
): StagedComponent[] {
  const components = [...collisions.values()].map(({ scope, classes }) => ({
    ...scope,
    componentId: sha256(scopeKey(scope)),
    artifactId: `quarantine:${sha256(scopeKey(scope))}`,
    collisionClasses: classes,
    rows: [] as StagedRow[],
    blobs: [] as StagedBlob[],
    grants: [] as Array<{ presentationThreadId: string; grantedAt: number }>,
  }));
  for (const component of components) {
    const params = [
      component.campaignId,
      component.projectId,
      component.environmentId,
    ];
    for (const table of GRAPH_TABLES) {
      const primaryKeys = tablePrimaryKeys(database, table);
      const rows = database
        .prepare(
          `SELECT * FROM ${table} WHERE campaign_id = ? AND project_id = ? AND environment_id = ?`,
        )
        .all(...params) as Array<Record<string, unknown>>;
      for (const input of rows) {
        const row = storedRow(input);
        const encoding = Buffer.from(canonical(row));
        const relationships = Object.fromEntries(
          Object.entries(row).filter(
            ([key]) =>
              key.endsWith("_id") ||
              key.endsWith("_revision") ||
              key.endsWith("_sha256"),
          ),
        );
        component.rows.push({
          table,
          row,
          primaryKeyJson: canonical(
            Object.fromEntries(
              primaryKeys.map((key) => [key, row[key] ?? null]),
            ),
          ),
          relationshipsJson: canonical(relationships),
          encoding,
          sha256: sha256(encoding),
        });
        if (typeof row.presentation_thread_id === "string") {
          const presentationThreadId = String(row.presentation_thread_id);
          const grantedAt = Number(
            row.created_at ?? row.committed_at ?? row.updated_at ?? 0,
          );
          const grant = component.grants.find(
            (candidate) =>
              candidate.presentationThreadId === presentationThreadId,
          );
          if (grant === undefined) {
            component.grants.push({ presentationThreadId, grantedAt });
          } else {
            grant.grantedAt = Math.min(grant.grantedAt, grantedAt);
          }
        }
      }
    }
    const blobIds = new Set<string>();
    for (const staged of component.rows) {
      for (const key of ["blob_sha256", "target_blob_sha256"]) {
        const value = staged.row[key];
        if (typeof value === "string") blobIds.add(value);
      }
    }
    for (const blobId of [...blobIds].sort()) {
      const blob = database
        .prepare(
          `SELECT sha256, content_type AS contentType, content,
             byte_length AS byteLength, created_at AS createdAt
           FROM workflow_artifact_blobs WHERE sha256 = ?`,
        )
        .get(blobId) as
        | {
            sha256: string;
            contentType: string;
            content: Buffer | Uint8Array;
            byteLength: number;
            createdAt: number;
          }
        | undefined;
      if (blob === undefined)
        throw new Error(`Recovery blob ${blobId} is missing`);
      const content = Buffer.from(blob.content);
      if (
        content.length !== blob.byteLength ||
        sha256(content) !== blob.sha256
      ) {
        throw new Error(`Recovery blob ${blobId} failed byte verification`);
      }
      component.blobs.push({ ...blob, content });
    }
    for (const [table, collisionClass] of [
      ["workflow_artifact_annotations", "annotation-dependent-row"],
      ["workflow_artifact_working_drafts", "working-draft-dependent-row"],
      ["workflow_artifact_decisions", "decision-dependent-row"],
      ["workflow_artifact_stewards", "steward-dependent-row"],
      ["workflow_artifact_mutations", "mutation-dependent-row"],
      ["workflow_artifact_apply_intents", "apply-intent-dependent-row"],
    ] as const) {
      if (component.rows.some((row) => row.table === table)) {
        component.collisionClasses.add(collisionClass);
      }
    }
    component.rows.sort((left, right) =>
      `${left.table}:${left.primaryKeyJson}`.localeCompare(
        `${right.table}:${right.primaryKeyJson}`,
      ),
    );
  }
  return components;
}

function removeComponents(
  database: Database.Database,
  components: StagedComponent[],
): void {
  const deleteOrder = [...GRAPH_TABLES].reverse();
  for (const component of components) {
    const params = [
      component.campaignId,
      component.projectId,
      component.environmentId,
    ];
    for (const table of deleteOrder) {
      database
        .prepare(
          `DELETE FROM ${table} WHERE campaign_id = ? AND project_id = ? AND environment_id = ?`,
        )
        .run(...params);
    }
  }
}

function activeGraphSha256(database: Database.Database): string {
  const rows: unknown[] = [];
  for (const table of GRAPH_TABLES) {
    const tableRows = database.prepare(`SELECT * FROM ${table}`).all();
    rows.push([
      table,
      [...tableRows].sort((a, b) => canonical(a).localeCompare(canonical(b))),
    ]);
  }
  return sha256(canonical(rows));
}

function verifyActiveGraph(database: Database.Database): void {
  const violations = database.pragma("foreign_key_check") as Array<{
    table: string;
  }>;
  const artifactViolations = violations.filter(
    ({ table }) =>
      table.startsWith("workflow_artifact_") ||
      table.startsWith("workflow_campaign_"),
  );
  if (artifactViolations.length > 0) {
    throw new Error("Recovered artifact graph failed foreign-key verification");
  }
  const enabled = database
    .prepare(
      "SELECT count(*) FROM workflow_runs WHERE workflow_artifact_live_changes <> 0",
    )
    .pluck()
    .get() as number;
  if (enabled !== 0) throw new Error("Recovery enabled live artifact changes");
  const blobs = database
    .prepare(
      `SELECT sha256, content, byte_length AS byteLength
       FROM workflow_artifact_blobs`,
    )
    .all() as Array<{
    sha256: string;
    content: Buffer | Uint8Array;
    byteLength: number;
  }>;
  for (const blob of blobs) {
    const content = Buffer.from(blob.content);
    if (content.length !== blob.byteLength || sha256(content) !== blob.sha256) {
      throw new Error(
        "Recovered active artifact blob failed byte verification",
      );
    }
  }
}

function recoverBlockedState(
  context: PluginMigrationRecoveryContextV2,
): PluginMigrationRecoveryResultV2 {
  const { database, descriptor } = context;
  const collisions = classifyCollisions(database);
  if (collisions.size === 0) {
    throw new Error(
      "Migration 18 failed without an approved artifact collision",
    );
  }
  const components = stageComponents(database, collisions);
  const stagedRowCount = components.reduce(
    (count, component) => count + component.rows.length,
    0,
  );
  removeComponents(database, components);
  for (let id = descriptor.beforeMigrationId; id <= 22; id += 1) {
    context.executeMigration(id);
  }
  const adoptedAt = Date.now();
  let restoredGrantCount = 0;
  for (const component of components) {
    for (const grant of component.grants) {
      restoredGrantCount += database
        .prepare(
          `INSERT OR IGNORE INTO workflow_artifact_presentation_grants
             (campaign_id, project_id, environment_id, presentation_thread_id,
              presentation_run_id, granted_at, revoked_at)
           VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
        )
        .run(
          component.campaignId,
          component.projectId,
          component.environmentId,
          grant.presentationThreadId,
          grant.grantedAt,
        ).changes;
    }
    const componentEncoding = canonical({
      rows: component.rows.map((row) => row.sha256),
      blobs: component.blobs.map((blob) => blob.sha256).sort(),
    });
    database
      .prepare(
        `INSERT INTO workflow_artifact_recovery_components
           (recovery_id, component_id, campaign_id, project_id, environment_id,
            artifact_id, collision_classes_json, canonical_component_sha256,
            row_count, blob_count, adopted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        descriptor.recoveryId,
        component.componentId,
        component.campaignId,
        component.projectId,
        component.environmentId,
        component.artifactId,
        canonical([...component.collisionClasses].sort()),
        sha256(componentEncoding),
        component.rows.length,
        component.blobs.length,
        adoptedAt,
      );
    component.rows.forEach((staged, ordinal) => {
      database
        .prepare(
          `INSERT INTO workflow_artifact_recovery_rows
             (recovery_id, component_id, row_ordinal, table_name, campaign_id,
              project_id, environment_id, presentation_thread_id, row_id,
              artifact_id, artifact_revision, blob_sha256,
              canonical_primary_key_json, relationships_json,
              canonical_row_encoding, canonical_row_sha256)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          descriptor.recoveryId,
          component.componentId,
          ordinal,
          staged.table,
          component.campaignId,
          component.projectId,
          component.environmentId,
          String(staged.row.presentation_thread_id),
          typeof staged.row.id === "string" ? staged.row.id : null,
          typeof staged.row.artifact_id === "string"
            ? staged.row.artifact_id
            : staged.table === "workflow_artifacts"
              ? String(staged.row.id)
              : null,
          typeof staged.row.artifact_revision === "number"
            ? staged.row.artifact_revision
            : typeof staged.row.revision === "number"
              ? staged.row.revision
              : null,
          typeof staged.row.blob_sha256 === "string"
            ? staged.row.blob_sha256
            : null,
          staged.primaryKeyJson,
          staged.relationshipsJson,
          staged.encoding,
          staged.sha256,
        );
    });
    for (const blob of component.blobs) {
      database
        .prepare(
          `INSERT INTO workflow_artifact_recovery_blobs
             (recovery_id, component_id, sha256, content_type, content,
              byte_length, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          descriptor.recoveryId,
          component.componentId,
          blob.sha256,
          blob.contentType,
          blob.content,
          blob.byteLength,
          blob.createdAt,
        );
    }
  }
  const quarantineRows = database
    .prepare(
      `SELECT component_id AS componentId, row_ordinal AS rowOrdinal,
         canonical_row_sha256 AS rowSha256,
         canonical_row_encoding AS rowEncoding
       FROM workflow_artifact_recovery_rows WHERE recovery_id = ?
       ORDER BY component_id, row_ordinal`,
    )
    .all(descriptor.recoveryId) as Array<{
    componentId: string;
    rowOrdinal: number;
    rowSha256: string;
    rowEncoding: Buffer | Uint8Array;
  }>;
  const quarantineBlobs = database
    .prepare(
      `SELECT component_id AS componentId, sha256, byte_length AS byteLength,
         content FROM workflow_artifact_recovery_blobs WHERE recovery_id = ?
       ORDER BY component_id, sha256`,
    )
    .all(descriptor.recoveryId) as Array<{
    componentId: string;
    sha256: string;
    byteLength: number;
    content: Buffer | Uint8Array;
  }>;
  if (quarantineRows.length !== stagedRowCount) {
    throw new Error("Recovery quarantine row parity mismatch");
  }
  for (const row of quarantineRows) {
    if (sha256(Buffer.from(row.rowEncoding)) !== row.rowSha256) {
      throw new Error("Recovery quarantine row byte parity mismatch");
    }
  }
  for (const blob of quarantineBlobs) {
    const content = Buffer.from(blob.content);
    if (content.length !== blob.byteLength || sha256(content) !== blob.sha256) {
      throw new Error("Recovery quarantine blob parity mismatch");
    }
  }
  verifyActiveGraph(database);
  const activeGraph = activeGraphSha256(database);
  const quarantineGraph = sha256(
    canonical({
      quarantineRows: quarantineRows.map(
        ({ rowEncoding: _rowEncoding, ...row }) => row,
      ),
      quarantineBlobs: quarantineBlobs.map(
        ({ content: _content, ...blob }) => blob,
      ),
    }),
  );
  const receipt = {
    recoveryId: descriptor.recoveryId,
    descriptorSha256: sha256(JSON.stringify(descriptor)),
    recoveryRecipeSha256: descriptor.recoveryRecipeSha256,
    preSchemaFingerprintSha256: descriptor.preSchemaFingerprintSha256,
    migration18Sha256: descriptor.migration18Sha256,
    activeGraphSha256: activeGraph,
    quarantineGraphSha256: quarantineGraph,
    stagedRowCount,
    restoredGrantCount,
    adoptedAt,
  };
  database
    .prepare(
      `INSERT INTO workflow_artifact_recovery_receipts
         (recovery_id, descriptor_sha256, recovery_recipe_sha256,
          pre_schema_fingerprint_sha256, migration_18_sha256,
          active_graph_sha256, quarantine_graph_sha256, staged_row_count,
          restored_grant_count, adopted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(...Object.values(receipt));
  return {
    activeGraphSha256: activeGraph,
    quarantineGraphSha256: quarantineGraph,
    stagedRowCount,
    restoredGrantCount,
    receiptSha256: sha256(canonical(receipt)),
  };
}

export function createWorkflowMigrationPlanV2(
  statements: readonly string[],
): PluginMigrationPlanV2 {
  return {
    version: 2,
    statements,
    statementSha256: statements.map((statement) => sha256(statement)),
    recovery: {
      descriptor: RECOVERY_DESCRIPTOR,
      recoveryRecipeJson: JSON.stringify(RECOVERY_RECIPE_MANIFEST),
      recover: recoverBlockedState,
    },
  };
}
