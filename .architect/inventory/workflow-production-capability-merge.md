# Workflows production capability merge inventory

Date: 2026-08-21

This inventory records capabilities present in the installed Workflows plugin and its live database before merging the workflow-detail ledger branch. The production source is preserved in the installed 0.35.1 source map and in the sealed `bb-workflows-runtime-context-fit` worktree. Usage counts are from `/Users/erik/.bb/plugins/workflows/data.db` immediately after the 0.39.0 promotion exposed the migration-ordinal conflict.

| Capability | Status | Code reference | Gating path | Prod usage | Merge decision |
| --- | --- | --- | --- | --- | --- |
| UTF-8 prompt byte accounting | `exists-and-used` | `/Users/erik/.bb/personal-workspaces/env_izgiwmqiuy/bb-workflows-runtime-context-fit/plugins/workflows/src/data.ts:669` | Every persisted workflow call through `createCall` | 564 / 564 calls | Preserve field, migration 8, persistence, replay, CLI, and UI projection. |
| Minimum context requirement | `exists-and-used` | `/Users/erik/.bb/personal-workspaces/env_izgiwmqiuy/bb-workflows-runtime-context-fit/plugins/workflows/src/data.ts:670` | Optional `agent(..., { contextRequirement })` validated by parser/runtime | 1 / 564 calls | Preserve migration 9, validation, persistence, replay, and fit calculation. |
| Phase context manifest injection | `exists-and-used` | `/Users/erik/.bb/personal-workspaces/env_izgiwmqiuy/bb-workflows-runtime-context-fit/plugins/workflows/src/service.ts:770` | Optional `agent(..., { contextProfile })`; rendered by `renderContextProfile` | 141 / 564 calls | Preserve migration 10, prompt injection, persistence, replay, and inspection. |
| Observed context-window usage | `exists-and-used` | `/Users/erik/.bb/personal-workspaces/env_izgiwmqiuy/bb-workflows-runtime-context-fit/plugins/workflows/src/service.ts:1065` | Child timeline completion through `recordCallContextUsage` | 340 / 564 calls | Preserve measured/estimated usage capture and replay metadata. |
| Context-fit inspection | `exists-and-used` | `/Users/erik/.bb/personal-workspaces/env_izgiwmqiuy/bb-workflows-runtime-context-fit/plugins/workflows/src/service.ts:626` | `inspect`/`details` derive `fit`, `undersized`, `unknown`, or `untracked` | 340 calls have observations; 1 has an explicit minimum | Preserve server calculation, RPC schema, CLI output, and UI badge. |
| Durable plan/work-item/verification checkpoints | `proposed-new` | `plugins/workflows/src/workflow-checkpoint.ts:1` | Active-run and source-call ownership checks in `upsertWorkflowCheckpoint` | Not live before this promotion | Append its schema migration after all 11 shipped migration IDs; do not reuse an existing ordinal. |
| Origin/presentation/root workflow projection | `proposed-new` | `plugins/workflows/src/data.ts:25` | Same-project, same-environment origin/ancestor authorization in the workflow service | Not live before this promotion | Append its schema/backfill migration after all 11 shipped migration IDs; keep stop ownership origin-only. |

## Production usage query

```sql
SELECT
  COUNT(*) AS total_calls,
  SUM(CASE WHEN prompt_bytes > 0 THEN 1 ELSE 0 END) AS prompt_bytes_recorded,
  SUM(CASE WHEN context_minimum_tokens IS NOT NULL THEN 1 ELSE 0 END) AS context_minimum_recorded,
  SUM(CASE WHEN context_profile_json IS NOT NULL THEN 1 ELSE 0 END) AS context_profiles_recorded,
  SUM(CASE WHEN observed_context_used_tokens IS NOT NULL THEN 1 ELSE 0 END) AS observed_usage_recorded,
  SUM(CASE WHEN observed_model_context_window IS NOT NULL THEN 1 ELSE 0 END) AS observed_window_recorded,
  SUM(CASE WHEN context_usage_estimated IS NOT NULL THEN 1 ELSE 0 END) AS estimation_flags_recorded
FROM workflow_calls;
```

Result: 564 total; 564 prompt-byte rows; 1 minimum-context row; 141 context-profile rows; 340 observed-usage/window/estimation rows.

## Production migration evidence

```sql
SELECT id, applied_at FROM _bb_migrations ORDER BY id;
```

The live database has applied IDs 0 through 10. Installed source-map migration IDs 8 through 10 add prompt/observation fields, `context_minimum_tokens`, and `context_profile_json`. The workflow-detail branch initially placed checkpoint and presentation migrations at IDs 8 and 9, so the host correctly skipped them. The compatible sequence must restore the shipped IDs unchanged and append the new migrations as IDs 11 and 12.
