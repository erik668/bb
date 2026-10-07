import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  createWorkflowMigrationPlanV2,
  RECOVERY_DESCRIPTOR,
} from "./artifact-recovery.js";
import { migrations } from "./data.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function seedPre18(
  bb: ReturnType<typeof createFakePluginHost>["bb"],
  options: { divergent: boolean },
) {
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations.slice(0, 18));
  const contentA = Buffer.from("# Requirements A\n");
  const contentB = Buffer.from(
    options.divergent ? "# Requirements B\n" : "# Requirements A\n",
  );
  for (const content of [contentA, contentB]) {
    db.prepare(
      `INSERT OR IGNORE INTO workflow_artifact_blobs
         (sha256, content_type, content, byte_length, created_at)
       VALUES (?, 'text/markdown', ?, ?, 1)`,
    ).run(digest(content.toString()), content, content.length);
  }
  const artifact = db.prepare(
    `INSERT INTO workflow_artifacts
       (campaign_id, project_id, environment_id, presentation_thread_id,
        id, kind, title, content_type, created_at, updated_at)
     VALUES ('campaign', 'project', 'environment', ?, 'requirements',
       'requirements', ?, 'text/markdown', 1, 1)`,
  );
  artifact.run("thread-a", "Requirements");
  artifact.run(
    "thread-b",
    options.divergent ? "Conflicting requirements" : "Requirements",
  );
  const revision = db.prepare(
    `INSERT INTO workflow_artifact_revisions
       (campaign_id, project_id, environment_id, presentation_thread_id,
        artifact_id, revision, blob_sha256, status, source_host_id,
        source_root_path, source_relative_path, source_sha256,
        produced_by_thread_id, created_at)
     VALUES ('campaign', 'project', 'environment', ?, 'requirements', 1, ?, ?,
       ?, ?, ?, ?, ?, 1)`,
  );
  revision.run(
    "thread-a",
    digest(contentA.toString()),
    "draft",
    "host",
    "/root",
    "requirements.md",
    digest(contentA.toString()),
    "producer-a",
  );
  revision.run(
    "thread-b",
    digest(contentB.toString()),
    options.divergent ? "admitted" : "draft",
    "host",
    "/root",
    "requirements.md",
    digest(contentB.toString()),
    options.divergent ? "producer-b" : "producer-a",
  );
  db.prepare(
    `INSERT INTO workflow_artifact_annotations
       (campaign_id, project_id, environment_id, presentation_thread_id, id,
        artifact_id, artifact_revision, kind, anchor_json, body, author,
        status, created_at, updated_at)
     VALUES ('campaign', 'project', 'environment', 'thread-a', 'annotation-a',
       'requirements', 1, 'comment', '{}', 'review', 'local-owner', 'open', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_artifact_working_drafts
       (campaign_id, project_id, environment_id, presentation_thread_id,
        artifact_id, base_revision, content, content_sha256, state, updated_at)
     VALUES ('campaign', 'project', 'environment', 'thread-a', 'requirements',
       1, 'draft', ?, 'saved', 1)`,
  ).run(digest("draft"));
  return db;
}

describe("hash-bound pre-18 artifact recovery", () => {
  it("keeps collision-free revision-1 mounts on the ordinary append-only path", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "workflows" });
    try {
      const db = seedPre18(bb, { divergent: false });
      bb.storage.migrate(
        db,
        createWorkflowMigrationPlanV2(migrations) as never,
      );
      expect(
        db.prepare("SELECT count(*) FROM workflow_artifacts").pluck().get(),
      ).toBe(1);
      expect(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE name = '_bb_migration_recoveries'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      await harness.dispose();
    }
  });

  it("quarantines the complete divergent component with row and blob parity", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "workflows" });
    try {
      const db = seedPre18(bb, { divergent: true });
      bb.storage.migrate(
        db,
        createWorkflowMigrationPlanV2(migrations) as never,
      );
      expect(
        db
          .prepare(
            `SELECT table_name AS tableName, count(*) AS count
             FROM workflow_artifact_recovery_rows
             GROUP BY table_name ORDER BY table_name`,
          )
          .all(),
      ).toEqual([
        { tableName: "workflow_artifact_annotations", count: 1 },
        { tableName: "workflow_artifact_revisions", count: 2 },
        { tableName: "workflow_artifact_working_drafts", count: 1 },
        { tableName: "workflow_artifacts", count: 2 },
      ]);
      expect(
        db
          .prepare(
            `SELECT count(*) FROM workflow_artifact_recovery_blobs
             WHERE length(content) = byte_length`,
          )
          .pluck()
          .get(),
      ).toBe(2);
      expect(
        db
          .prepare(
            "SELECT staged_row_count AS stagedRows FROM workflow_artifact_recovery_receipts",
          )
          .get(),
      ).toEqual({ stagedRows: 6 });
      expect(
        db.prepare("SELECT count(*) FROM workflow_artifacts").pluck().get(),
      ).toBe(0);
      expect(
        db
          .prepare("SELECT count(*) FROM workflow_artifact_presentation_grants")
          .pluck()
          .get(),
      ).toBe(2);
      expect(() =>
        db
          .prepare(
            `INSERT INTO workflow_runs
               (id, project_id, origin_thread_id, environment_id,
                origin_provider, origin_model, origin_reasoning_level,
                origin_permission_mode, name, source, source_hash, args_json,
                settings_json, status, created_at, workflow_artifact_live_changes)
             VALUES ('dark', 'project', 'thread', 'environment', 'codex',
               'model', 'medium', 'full', 'dark', '', '', 'null', '{}',
               'queued', 1, 1)`,
          )
          .run(),
      ).toThrow(/live changes are not admitted/);
    } finally {
      await harness.dispose();
    }
  });

  it("rolls back staging, migrations, quarantine adoption, and ledgers on a late fault", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "workflows" });
    try {
      const db = seedPre18(bb, { divergent: true });
      const plan = createWorkflowMigrationPlanV2(migrations);
      const failingPlan = {
        ...plan,
        recovery: {
          ...plan.recovery,
          recover(context: Parameters<typeof plan.recovery.recover>[0]) {
            plan.recovery.recover(context);
            throw new Error("late recovery fault");
          },
        },
      };
      expect(() => bb.storage.migrate(db, failingPlan as never)).toThrow(
        /late recovery fault/,
      );
      expect(
        db.prepare("SELECT id FROM _bb_migrations ORDER BY id").pluck().all(),
      ).toEqual(Array.from({ length: 18 }, (_, id) => id));
      expect(
        db.prepare("SELECT count(*) FROM workflow_artifacts").pluck().get(),
      ).toBe(2);
      expect(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE name = 'workflow_artifact_recovery_rows'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      await harness.dispose();
    }
  });

  it("fails closed on statement hashes and noncontiguous migration state", async () => {
    const first = createFakePluginHost({ pluginId: "workflows-hash" });
    const second = createFakePluginHost({ pluginId: "workflows-ledger" });
    try {
      const plan = createWorkflowMigrationPlanV2(migrations);
      expect(() =>
        first.bb.storage.migrate(first.bb.storage.database(), {
          ...plan,
          statementSha256: ["0".repeat(64), ...plan.statementSha256.slice(1)],
        } as never),
      ).toThrow(/statement hash mismatch/);
      const db = second.bb.storage.database();
      db.exec(
        `CREATE TABLE _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
         INSERT INTO _bb_migrations VALUES (0, 1), (2, 1);`,
      );
      expect(() => second.bb.storage.migrate(db, plan as never)).toThrow(
        /noncontiguous or unknown/,
      );
    } finally {
      await first.harness.dispose();
      await second.harness.dispose();
    }
  });

  it("is restart-idempotent and retains one hash-bound host recovery identity", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "workflows" });
    try {
      const db = seedPre18(bb, { divergent: true });
      const plan = createWorkflowMigrationPlanV2(migrations);
      bb.storage.migrate(db, plan as never);
      bb.storage.migrate(db, plan as never);
      expect(
        db
          .prepare(
            `SELECT recovery_id AS recoveryId, count(*) AS count
             FROM _bb_migration_recoveries GROUP BY recovery_id`,
          )
          .get(),
      ).toEqual({ recoveryId: RECOVERY_DESCRIPTOR.recoveryId, count: 1 });
      expect(
        db.prepare("SELECT count(*) FROM _bb_migrations").pluck().get(),
      ).toBe(23);
    } finally {
      await harness.dispose();
    }
  });
});
