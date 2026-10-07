import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  artifactRepositoryFoundationMigration,
  artifactRepositoryFoundationRepairMigration,
  artifactStorageMigrations,
  initializeWorkflowStorage,
  resolveLocalArtifactOwnerScope,
  storeVerifiedArtifactBlob,
  verifyArtifactStorageIntegrity,
} from "./artifact-storage.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("workflow artifact storage initialization", () => {
  const openDatabases: Database.Database[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const db of openDatabases.splice(0)) db.close();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function openFileDatabase(): Database.Database {
    const directory = mkdtempSync(join(tmpdir(), "workflow-artifacts-"));
    temporaryDirectories.push(directory);
    const db = new Database(join(directory, "data.db"));
    openDatabases.push(db);
    return db;
  }

  it("establishes and verifies the durable SQLite profile", () => {
    const db = openFileDatabase();
    expect(initializeWorkflowStorage(db)).toEqual({
      journalMode: "wal",
      synchronous: 2,
      foreignKeys: 1,
      busyTimeoutMs: 5_000,
    });
  });

  it("leaves post-migration integrity admission scoped and explicit", () => {
    const db = openFileDatabase();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.pragma("foreign_keys = OFF");
    db.exec(`
      CREATE TABLE parent (id TEXT PRIMARY KEY);
      CREATE TABLE child (parent_id TEXT REFERENCES parent(id));
      INSERT INTO child (parent_id) VALUES ('missing');
    `);

    expect(initializeWorkflowStorage(db)).toEqual(
      expect.objectContaining({ foreignKeys: 1 }),
    );
    verifyArtifactStorageIntegrity(db);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("unrelated legacy foreign-key violation"),
    );
  });

  it("fails closed when an artifact-owned table violates foreign keys", () => {
    const db = openFileDatabase();
    db.pragma("foreign_keys = OFF");
    db.exec(`
      CREATE TABLE workflow_artifact_parent (id TEXT PRIMARY KEY);
      CREATE TABLE workflow_artifact_child (
        parent_id TEXT REFERENCES workflow_artifact_parent(id)
      );
      INSERT INTO workflow_artifact_child (parent_id) VALUES ('missing');
    `);

    expect(() => initializeWorkflowStorage(db)).not.toThrow();
    expect(() => verifyArtifactStorageIntegrity(db)).toThrow(
      /artifact storage foreign_key_check found 1 violation\(s\)/,
    );
  });
});

describe("canonical origin-scoped artifact repository foundation", () => {
  const scope = ["campaign-1", "project-1", "environment-1"] as const;
  const openDatabases: Database.Database[] = [];
  const temporaryDirectories: string[] = [];
  let db: Database.Database;

  afterEach(() => {
    vi.restoreAllMocks();
    for (const database of openDatabases.splice(0)) database.close();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function openFileDatabase(): Database.Database {
    const directory = mkdtempSync(join(tmpdir(), "workflow-artifact-v5-"));
    temporaryDirectories.push(directory);
    const database = new Database(join(directory, "data.db"));
    database.pragma("foreign_keys = ON");
    openDatabases.push(database);
    return database;
  }

  function applyRevision1(database: Database.Database): void {
    database.exec(artifactStorageMigrations.join("\n"));
  }

  function applyFoundation(database: Database.Database): void {
    database.transaction(() => {
      database.exec(artifactRepositoryFoundationMigration);
    })();
  }

  function applyCurrentSchema(database: Database.Database): void {
    applyRevision1(database);
    applyFoundation(database);
  }

  function insertRevision1Mount(
    database: Database.Database,
    input: { threadId: string; title?: string; content?: string },
  ): string {
    const content = input.content ?? "# Requirements\n";
    const digest = sha256(content);
    database
      .prepare(
        `INSERT OR IGNORE INTO workflow_artifact_blobs
           (sha256, content_type, content, byte_length, created_at)
         VALUES (?, 'text/markdown', ?, ?, 1)`,
      )
      .run(digest, content, Buffer.byteLength(content));
    database
      .prepare(
        `INSERT INTO workflow_artifacts
           (campaign_id, project_id, environment_id, presentation_thread_id,
            id, kind, title, content_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'requirements', 'requirements', ?,
           'text/markdown', 1, 1)`,
      )
      .run(...scope, input.threadId, input.title ?? "Requirements");
    database
      .prepare(
        `INSERT INTO workflow_artifact_revisions
           (campaign_id, project_id, environment_id, presentation_thread_id,
            artifact_id, revision, blob_sha256, status, created_at)
         VALUES (?, ?, ?, ?, 'requirements', 1, ?, 'admitted', 1)`,
      )
      .run(...scope, input.threadId, digest);
    return digest;
  }

  function insertCanonicalArtifact(
    database: Database.Database,
    artifactId: "requirements" | "architecture" | "decision-log",
  ): string {
    const digest = storeVerifiedArtifactBlob(database, {
      contentType: "text/markdown",
      content: `# ${artifactId}\n`,
      createdAt: 1,
    });
    database
      .prepare(
        `INSERT INTO workflow_artifacts
           (campaign_id, project_id, environment_id, id, kind, title,
            content_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'text/markdown', 1, 1)`,
      )
      .run(...scope, artifactId, artifactId, artifactId);
    database
      .prepare(
        `INSERT INTO workflow_artifact_revisions
           (campaign_id, project_id, environment_id, artifact_id, revision,
            blob_sha256, status, created_at)
         VALUES (?, ?, ?, ?, 1, ?, 'admitted', 1)`,
      )
      .run(...scope, artifactId, digest);
    return digest;
  }

  it("migrates an applied revision-1 database into one canonical artifact with two presentation grants and one snapshot", () => {
    db = openFileDatabase();
    applyRevision1(db);
    const digest = insertRevision1Mount(db, { threadId: "thread-a" });
    insertRevision1Mount(db, { threadId: "thread-b" });

    applyFoundation(db);

    expect(
      db.prepare("SELECT count(*) FROM workflow_artifacts").pluck().get(),
    ).toBe(1);
    expect(
      db
        .prepare("SELECT count(*) FROM workflow_artifact_revisions")
        .pluck()
        .get(),
    ).toBe(1);
    expect(
      db
        .prepare(
          `SELECT presentation_thread_id FROM workflow_artifact_presentation_grants
           ORDER BY presentation_thread_id`,
        )
        .pluck()
        .all(),
    ).toEqual(["thread-a", "thread-b"]);
    expect(
      db
        .prepare("PRAGMA table_info(workflow_artifacts)")
        .all()
        .filter((column) => (column as { pk: number }).pk > 0)
        .map((column) => (column as { name: string }).name),
    ).toEqual(["campaign_id", "project_id", "environment_id", "id"]);

    const snapshotDigest = "s".repeat(64);
    db.prepare(
      `INSERT INTO workflow_campaign_contract_snapshots
         (campaign_id, project_id, environment_id, snapshot_digest, created_at)
       VALUES (?, ?, ?, ?, 2)`,
    ).run(...scope, snapshotDigest);
    db.prepare(
      `INSERT INTO workflow_campaign_contract_snapshot_artifacts
         (campaign_id, project_id, environment_id, snapshot_digest, slot,
          artifact_id, artifact_revision, blob_sha256)
       VALUES (?, ?, ?, ?, 'requirements', 'requirements', 1, ?)`,
    ).run(...scope, snapshotDigest, digest);

    verifyArtifactStorageIntegrity(db);
    db.prepare(
      `UPDATE workflow_campaign_contract_snapshot_artifacts
       SET blob_sha256 = ? WHERE snapshot_digest = ?`,
    ).run("x".repeat(64), snapshotDigest);
    expect(() => verifyArtifactStorageIntegrity(db)).toThrow(
      /snapshot integrity found 1 digest mismatch/,
    );
    db.prepare(
      `UPDATE workflow_campaign_contract_snapshot_artifacts
       SET blob_sha256 = ? WHERE snapshot_digest = ?`,
    ).run(digest, snapshotDigest);
    const databasePath = db.name;
    db.close();
    openDatabases.splice(openDatabases.indexOf(db), 1);
    const reopened = new Database(databasePath);
    openDatabases.push(reopened);
    expect(initializeWorkflowStorage(reopened)).toEqual(
      expect.objectContaining({ journalMode: "wal", foreignKeys: 1 }),
    );
    expect(
      reopened
        .prepare("SELECT count(*) FROM workflow_campaign_contract_snapshots")
        .pluck()
        .get(),
    ).toBe(1);
  });

  it("fails the correction on a divergent canonical identity without losing revision-1 rows", () => {
    db = openFileDatabase();
    applyRevision1(db);
    insertRevision1Mount(db, { threadId: "thread-a" });
    insertRevision1Mount(db, {
      threadId: "thread-b",
      title: "Conflicting requirements",
    });

    expect(() => applyFoundation(db)).toThrow(/UNIQUE constraint failed/);
    expect(
      db.prepare("SELECT count(*) FROM workflow_artifacts").pluck().get(),
    ).toBe(2);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_artifacts_v2'",
        )
        .get(),
    ).toBeUndefined();
  });

  it("derives local-owner origin scope from the stored run and grant, never caller scope", () => {
    db = openFileDatabase();
    applyCurrentSchema(db);
    db.exec(`
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        campaign_id TEXT,
        project_id TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        presentation_thread_id TEXT
      );
    `);
    db.prepare(
      `INSERT INTO workflow_runs
         (id, campaign_id, project_id, environment_id, presentation_thread_id)
       VALUES ('run-1', ?, ?, ?, 'origin-thread')`,
    ).run(...scope);
    db.prepare(
      `INSERT INTO workflow_artifact_presentation_grants
         (campaign_id, project_id, environment_id, presentation_thread_id,
          presentation_run_id, granted_at)
       VALUES (?, ?, ?, 'mounted-thread', 'run-1', 1)`,
    ).run(...scope);

    expect(
      resolveLocalArtifactOwnerScope(db, {
        runId: "run-1",
        presentationThreadId: "mounted-thread",
      }),
    ).toEqual({
      actorKey: "local-owner",
      campaignId: scope[0],
      projectId: scope[1],
      environmentId: scope[2],
      presentationThreadId: "mounted-thread",
    });
    expect(() =>
      resolveLocalArtifactOwnerScope(db, {
        runId: "run-1",
        presentationThreadId: "ungranted-thread",
      }),
    ).toThrow(/presentation grant is unavailable/);
  });

  it("stores verified immutable bytes and detects a digest collision or later corruption", () => {
    db = openFileDatabase();
    applyCurrentSchema(db);
    const content = "same length good";
    const digest = sha256(content);
    db.prepare(
      `INSERT INTO workflow_artifact_blobs
         (sha256, content_type, content, byte_length, created_at)
       VALUES (?, 'text/markdown', ?, ?, 1)`,
    ).run(digest, "same length evil", Buffer.byteLength(content));

    expect(() =>
      storeVerifiedArtifactBlob(db, {
        contentType: "text/markdown",
        content,
        createdAt: 2,
      }),
    ).toThrow(/blob integrity mismatch/);
    expect(() => verifyArtifactStorageIntegrity(db)).toThrow(
      /blob integrity mismatch/,
    );
  });

  it("keeps idempotency operation data under one service-derived actor key", () => {
    db = openFileDatabase();
    applyCurrentSchema(db);
    db.prepare(
      `INSERT INTO workflow_artifact_presentation_grants
         (campaign_id, project_id, environment_id, presentation_thread_id,
          granted_at)
       VALUES (?, ?, ?, 'thread-1', 1)`,
    ).run(...scope);
    const insertMutation = db.prepare(
      `INSERT INTO workflow_artifact_mutations
         (campaign_id, project_id, environment_id, presentation_thread_id,
          actor, operation_kind, idempotency_key, request_digest,
          outcome_json, committed_at)
       VALUES (?, ?, ?, 'thread-1', ?, ?, 'client-1', ?, '{}', 1)`,
    );
    insertMutation.run(...scope, "local-owner", "comment", "a".repeat(64));

    expect(() =>
      insertMutation.run(...scope, "local-owner", "resolve", "b".repeat(64)),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      insertMutation.run(
        ...scope,
        "tool:thread-1:call-1",
        "resolve",
        "b".repeat(64),
      ),
    ).not.toThrow();
  });

  it("installs only dark normalized work, snapshot, receipt, and outbox tables", () => {
    db = openFileDatabase();
    applyCurrentSchema(db);
    db.exec(`
      CREATE TABLE workflow_calls (id TEXT PRIMARY KEY);
      CREATE TABLE workflow_checkpoints (
        run_id TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        UNIQUE (run_id, checkpoint_id)
      );
    `);
    db.exec(artifactRepositoryFoundationRepairMigration);
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND (name LIKE 'workflow_campaign_%'
               OR name IN ('workflow_artifact_change_outbox', 'workflow_artifact_change_receipts'))
           ORDER BY name`,
        )
        .pluck()
        .all(),
    ).toEqual([
      "workflow_artifact_change_outbox",
      "workflow_artifact_change_receipts",
      "workflow_campaign_contract_snapshot_artifacts",
      "workflow_campaign_contract_snapshots",
      "workflow_campaign_contract_state",
      "workflow_campaign_transition_receipts",
      "workflow_campaign_work_edges",
      "workflow_campaign_work_item_aliases",
      "workflow_campaign_work_items",
    ]);
  });

  it("keeps source apply serialization artifact-scoped across presentation mounts", () => {
    db = openFileDatabase();
    applyCurrentSchema(db);
    db.prepare(
      `INSERT INTO workflow_artifact_presentation_grants
         (campaign_id, project_id, environment_id, presentation_thread_id, granted_at)
       VALUES (?, ?, ?, 'thread-a', 1), (?, ?, ?, 'thread-b', 1)`,
    ).run(...scope, ...scope);
    const admittedBlob = insertCanonicalArtifact(db, "requirements");
    const candidateBlob = storeVerifiedArtifactBlob(db, {
      contentType: "text/markdown",
      content: "# candidate\n",
      createdAt: 2,
    });
    const insertIntent = db.prepare(
      `INSERT INTO workflow_artifact_apply_intents
         (campaign_id, project_id, environment_id, presentation_thread_id,
          id, artifact_id, base_revision, source_host_id, source_root_path,
          source_relative_path, source_before_sha256, target_sha256,
          target_blob_sha256, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'requirements', 1, 'host-1', '/repo',
         '.architect/requirements.md', ?, ?, ?, 'prepared', 1, 1)`,
    );
    insertIntent.run(
      ...scope,
      "thread-a",
      "intent-a",
      admittedBlob,
      candidateBlob,
      candidateBlob,
    );

    expect(() =>
      insertIntent.run(
        ...scope,
        "thread-b",
        "intent-b",
        admittedBlob,
        candidateBlob,
        candidateBlob,
      ),
    ).toThrow(/UNIQUE constraint failed/);
  });
});
