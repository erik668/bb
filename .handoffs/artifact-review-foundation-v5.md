# Handoff — artifact-review canonical repository foundation v5

**State:** complete. Owner unit `artifact-review-canonical-repository-foundation-v5`, workflow `wfr_9cd772db-824b-4c12-9ba7-c717e8675bd0`. Checkout `/Users/erik/.bb/personal-workspaces/env_88g5eb749t/bb-workflow-details`, branch `feature/workflow-detail-ledger` (dirty; same-workstream changes preserved).

**Changed:** `plugins/workflows/src/data.test.ts` (two new tests, sha256 bbbbd1dc…), `.architect/evidence/artifact-review/section-1-foundation.json` (sha256 b72c416d…). `artifact-storage.ts` sha256 13f92392… unchanged.

**Verified fresh:** targeted tests 38/0/0; `tsc --noEmit` exit 0; prettier + `git diff --check` + evidence invariant exit 0. Mutation on `resolveLocalArtifactOwnerScope` NOT NULL predicate killed and restored.

**Open note:** `mcp__bb-bridge__bb_workflow_result` returned "workflow call is no longer active"; the full schema-conformant JSON is in the session's final assistant message. If the router lacks the result, re-submit from that JSON.

**Key refs:** host migrate runner `apps/server/src/services/plugins/plugin-api.ts:570`; fake host `packages/plugin-sdk/src/testing/fake-plugin-host.ts:919`; migration ledger `plugins/workflows/src/data.ts:240-520`; scope resolver `plugins/workflows/src/artifact-storage.ts` (`resolveLocalArtifactOwnerScope`).

**Next for the production unit:** wire `verifyArtifactStorageIntegrity` into server startup when the artifact RPC lands; keep COALESCE (feature-off reads) and raw-null (artifact authority) scope derivations distinct.
