export const retiredWorkflowMigrations = [
  `ALTER TABLE workflow_calls ADD COLUMN prompt_bytes INTEGER NOT NULL DEFAULT 0;
   UPDATE workflow_calls SET prompt_bytes = length(CAST(prompt AS BLOB));
   ALTER TABLE workflow_calls ADD COLUMN observed_context_used_tokens INTEGER;
   ALTER TABLE workflow_calls ADD COLUMN observed_model_context_window INTEGER;
   ALTER TABLE workflow_calls ADD COLUMN context_usage_estimated INTEGER;`,
  `ALTER TABLE workflow_calls ADD COLUMN context_minimum_tokens INTEGER;`,
  `ALTER TABLE workflow_calls ADD COLUMN context_profile_json TEXT;`,
  `CREATE TABLE IF NOT EXISTS workflow_checkpoints (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
     checkpoint_id TEXT NOT NULL,
     checkpoint_json TEXT NOT NULL,
     phase TEXT,
     source_call_id TEXT REFERENCES workflow_calls(id) ON DELETE SET NULL,
     ordinal INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE(run_id, checkpoint_id)
   );
   CREATE INDEX IF NOT EXISTS workflow_checkpoints_run_created_idx
     ON workflow_checkpoints(run_id, ordinal);`,
  `ALTER TABLE workflow_runs ADD COLUMN presentation_thread_id TEXT;
   ALTER TABLE workflow_runs ADD COLUMN parent_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL;
   ALTER TABLE workflow_runs ADD COLUMN root_run_id TEXT;
   UPDATE workflow_runs
     SET presentation_thread_id = origin_thread_id
     WHERE presentation_thread_id IS NULL;
   UPDATE workflow_runs SET root_run_id = id WHERE root_run_id IS NULL;
   CREATE INDEX IF NOT EXISTS workflow_runs_presentation_created_idx
     ON workflow_runs(presentation_thread_id, created_at DESC);
   CREATE INDEX IF NOT EXISTS workflow_runs_root_created_idx
     ON workflow_runs(root_run_id, created_at ASC);`,
  `ALTER TABLE workflow_runs ADD COLUMN campaign_id TEXT;
   UPDATE workflow_runs SET campaign_id = id WHERE campaign_id IS NULL;
   CREATE INDEX IF NOT EXISTS workflow_runs_campaign_created_idx
     ON workflow_runs(campaign_id, created_at ASC);`,
  `CREATE TABLE IF NOT EXISTS workflow_acceptance_approvals (
     id TEXT PRIMARY KEY,
     campaign_id TEXT NOT NULL,
     acceptance_checkpoint_id TEXT NOT NULL,
     contract_canonical TEXT NOT NULL,
     approved_by_thread_id TEXT NOT NULL,
     surface TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE(campaign_id, acceptance_checkpoint_id, contract_canonical)
   );`,
  `CREATE TABLE IF NOT EXISTS workflow_artifact_blobs (
     sha256 TEXT PRIMARY KEY,
     content BLOB NOT NULL,
     byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
     created_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS workflow_artifacts (
     id TEXT PRIMARY KEY,
     campaign_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     environment_id TEXT NOT NULL,
     presentation_thread_id TEXT NOT NULL,
     origin_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
     kind TEXT NOT NULL CHECK (kind IN ('requirements', 'architecture', 'decisions')),
     title TEXT NOT NULL,
     current_revision INTEGER NOT NULL CHECK (current_revision > 0),
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE(campaign_id, project_id, environment_id, presentation_thread_id, kind)
   );
   CREATE INDEX IF NOT EXISTS workflow_artifacts_scope_idx
     ON workflow_artifacts(campaign_id, project_id, environment_id, presentation_thread_id, kind);
   CREATE TABLE IF NOT EXISTS workflow_artifact_revisions (
     id TEXT PRIMARY KEY,
     artifact_id TEXT NOT NULL REFERENCES workflow_artifacts(id) ON DELETE RESTRICT,
     revision INTEGER NOT NULL CHECK (revision > 0),
     blob_sha256 TEXT NOT NULL REFERENCES workflow_artifact_blobs(sha256) ON DELETE RESTRICT,
     status TEXT NOT NULL CHECK (status IN ('draft', 'accepted-pending-impact', 'admitted', 'superseded')),
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE(artifact_id, revision)
   );
   CREATE INDEX IF NOT EXISTS workflow_artifact_revisions_artifact_idx
     ON workflow_artifact_revisions(artifact_id, revision DESC);
   CREATE TABLE IF NOT EXISTS workflow_artifact_annotations (
     id TEXT PRIMARY KEY,
     artifact_id TEXT NOT NULL REFERENCES workflow_artifacts(id) ON DELETE RESTRICT,
     artifact_revision INTEGER NOT NULL CHECK (artifact_revision > 0),
     kind TEXT NOT NULL CHECK (kind IN ('highlight', 'comment')),
     anchor_json TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'orphaned')),
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     resolved_at INTEGER,
     assistance_status TEXT
       CHECK (assistance_status IN ('pending', 'ready', 'error')),
     suggested_semantic_class TEXT
       CHECK (suggested_semantic_class IN ('editorial', 'refinement', 'contract', 'architecture')),
     suggested_rationale TEXT,
     assistance_error TEXT,
     FOREIGN KEY (artifact_id, artifact_revision)
       REFERENCES workflow_artifact_revisions(artifact_id, revision) ON DELETE RESTRICT
   );
   CREATE INDEX IF NOT EXISTS workflow_artifact_annotations_revision_idx
     ON workflow_artifact_annotations(artifact_id, artifact_revision, created_at);
   CREATE TABLE IF NOT EXISTS workflow_artifact_comments (
     id TEXT PRIMARY KEY,
     annotation_id TEXT NOT NULL REFERENCES workflow_artifact_annotations(id) ON DELETE RESTRICT,
     body TEXT NOT NULL,
     author TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS workflow_artifact_comments_annotation_idx
     ON workflow_artifact_comments(annotation_id, created_at);
   CREATE TABLE IF NOT EXISTS workflow_artifact_decisions (
     id TEXT PRIMARY KEY,
     annotation_id TEXT NOT NULL UNIQUE REFERENCES workflow_artifact_annotations(id) ON DELETE RESTRICT,
     outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'declined')),
     semantic_class TEXT NOT NULL CHECK (semantic_class IN ('editorial', 'refinement', 'contract', 'architecture')),
     rationale TEXT NOT NULL,
     decided_by TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS workflow_artifact_changes (
     id TEXT PRIMARY KEY,
     decision_id TEXT NOT NULL UNIQUE REFERENCES workflow_artifact_decisions(id) ON DELETE RESTRICT,
     artifact_id TEXT NOT NULL REFERENCES workflow_artifacts(id) ON DELETE RESTRICT,
     artifact_revision INTEGER NOT NULL,
     semantic_class TEXT NOT NULL CHECK (semantic_class IN ('editorial', 'refinement', 'contract', 'architecture')),
     status TEXT NOT NULL CHECK (status IN ('accepted-pending-impact', 'awaiting-confirmation', 'admitted')),
     architecture_verdict TEXT CHECK (architecture_verdict IN ('no-design-impact', 'bounded-design-delta', 'redesign-required')),
     architecture_summary TEXT,
     assistance_status TEXT
       CHECK (assistance_status IN ('pending', 'ready', 'error')),
     suggested_architecture_verdict TEXT
       CHECK (suggested_architecture_verdict IN ('no-design-impact', 'bounded-design-delta', 'redesign-required')),
     suggested_architecture_summary TEXT,
     assistance_error TEXT,
     worker_propagation TEXT NOT NULL DEFAULT 'disabled' CHECK (worker_propagation = 'disabled'),
     created_at INTEGER NOT NULL,
     admitted_at INTEGER,
     FOREIGN KEY (artifact_id, artifact_revision)
       REFERENCES workflow_artifact_revisions(artifact_id, revision) ON DELETE RESTRICT
   );
   CREATE INDEX IF NOT EXISTS workflow_artifact_changes_artifact_idx
     ON workflow_artifact_changes(artifact_id, created_at DESC);
   CREATE TABLE IF NOT EXISTS workflow_artifact_mutations (
     campaign_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     environment_id TEXT NOT NULL,
     presentation_thread_id TEXT NOT NULL,
     actor_key TEXT NOT NULL,
     client_mutation_id TEXT NOT NULL,
     operation TEXT NOT NULL,
     request_digest TEXT NOT NULL,
     result_json TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (
       campaign_id, project_id, environment_id, presentation_thread_id,
       actor_key, client_mutation_id
     )
   );
   CREATE TABLE IF NOT EXISTS workflow_artifact_stewards (
     campaign_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     environment_id TEXT NOT NULL,
     presentation_thread_id TEXT NOT NULL,
     reservation_token TEXT NOT NULL,
     thread_id TEXT,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (campaign_id, project_id, environment_id, presentation_thread_id),
     UNIQUE(thread_id)
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS workflow_artifacts_authority_kind_idx
     ON workflow_artifacts(campaign_id, project_id, environment_id, kind);
   CREATE UNIQUE INDEX IF NOT EXISTS workflow_artifact_stewards_authority_idx
     ON workflow_artifact_stewards(campaign_id, project_id, environment_id);`,
  `CREATE TABLE IF NOT EXISTS workflow_acceptance_approvals (
     id TEXT PRIMARY KEY,
     campaign_id TEXT NOT NULL,
     acceptance_checkpoint_id TEXT NOT NULL,
     contract_canonical TEXT NOT NULL,
     approved_by_thread_id TEXT NOT NULL,
     surface TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE(campaign_id, acceptance_checkpoint_id, contract_canonical)
   );`,
];
