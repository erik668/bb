SHA: 970204852ab0b0228700be969710052d71a387cf
VERDICT: PASS
CRITIC: codex-migration-merge-critic-20260821

# Independent post-remediation pre-promotion review

Finding count: 0 blocking / 1 warning / 0 nit.

## Finding

### Warning: workflow UI remains a large edit surface

- **Severity:** warn
- **Lens:** code-standards #3 / simplify
- **Location:** `plugins/workflows/src/app.tsx:398-448,620-768,963-1350`
- **Scenario:** The checkpoint loader, causal run card, and three ledger renderers leave `app.tsx` at 1,557 lines. No correctness defect was found in this review, but polling, stale-request suppression, provenance controls, and detail rendering still share a large edit surface.
- **Fix:** In a follow-up, extract the checkpoint hook and ledger renderer into focused modules while preserving the RPC/UI tests. This is not a promotion blocker.

## Prior blocker resolution

### Rollback-era causal projection — resolved

`RUN_SELECT` now normalizes rows written by a rolled-back build with `COALESCE(presentation_thread_id, origin_thread_id)` and `COALESCE(root_run_id, id)`. The regression applies migrations 0..12, inserts a run through the legacy column list after migration 12, observes non-null presentation/root IDs, and creates a causal child that inherits the normalized presentation/root identity. `plugins/workflows/src/data.ts:160-171`; `plugins/workflows/src/data.test.ts:117-345`.

Independent in-memory reproduction with the real migrations produced:

```json
{
  "parent": {
    "presentationThreadId": "t",
    "rootRunId": "wfr_rollback"
  },
  "child": {
    "presentationThreadId": "t",
    "parentRunId": "wfr_rollback",
    "rootRunId": "wfr_rollback"
  }
}
```

The service relationship path reads causal parents through the normalized mapper before inheriting presentation/root IDs, so the data-layer fallback reaches actual workflow start. `plugins/workflows/src/service.ts:680-779`. Existing service coverage separately exercises worker-launched causal inheritance. `plugins/workflows/src/service-policy.test.ts:1417-1460`.

### `parallel()` contract — resolved

The published contract says: “A thunk that throws ... resolves to `null`” and defines `parallel()` as a barrier. Runtime now catches each thunk independently, maps failures to `null`, and awaits the complete `Promise.all` barrier. The runtime regression proves the aggregate stays pending until the final sibling settles and then returns `[null, "ok", "last"]`. Service integration proves a failed nested workflow plus a successful sibling produces a succeeded `[null,"inline"]` run. `plugins/workflows/src/runtime.ts:575-586`; `plugins/workflows/src/runtime.test.ts:470-509`; `plugins/workflows/src/service-policy.test.ts:618-660`; `plugins/workflows/skills/workflows/SKILL.md:124-128`.

The saved router workflow expects exactly this contract: critic failures become explicit missing workers, the three-architect cohort blocks unless all three values are non-null, and section-wave nulls become failed work items rather than an unhandled workflow rejection. `.bb/workflows/workflow-router-pipeline.js:1165-1209,1220-1334,1375-1424,2325-2377`.

### Shipped migration prefix — resolved

The upgrade test now freezes SHA-256 values for migration IDs 0..10 and asserts the executable prefix before constructing the production-shaped database. Independent comparison against the sealed `bb-workflows-runtime-context-fit` source found 11 shipped migrations, 13 current migrations, byte-for-byte equality for IDs 0..10, and only checkpoint/presentation additions at IDs 11 and 12. The frozen hashes exactly match both sources. `plugins/workflows/src/data.test.ts:83-139`; `plugins/workflows/src/data.ts:201-324`.

### Global admission documentation — resolved

README and workflow skill now describe all seven settings, identify `maxActiveRuns` and `maxGlobalConcurrentAgents` as live plugin-global policy, and state that a live decrease does not cancel active calls but blocks admission until usage falls below the new limit. The remaining five values are correctly identified as per-run snapshots. `plugins/workflows/README.md:164-187`; `plugins/workflows/skills/workflows/SKILL.md:532-539`; `plugins/workflows/src/settings.ts:11-90`.

## Ratified requirement conformance

- **Requirement:** “surface the related workflow card on the root workflow I kicked it off in, or the root agent who led to one or more agents further down to kick it off.”
  **Verdict:** honored. Hidden origins resolve through same-project/same-environment ancestry; nested workflows inherit causal presentation/root identity; rollback-era rows project safe defaults. `plugins/workflows/src/service.ts:615-722`; `plugins/workflows/src/data.ts:160-171`; `plugins/workflows/src/server.ts:110-159`.
- **Requirement:** “easily view the full plan that was selected,” “exact progress, like a per-ticket breakdown,” and “which tests were selected, what their status is.”
  **Verdict:** honored when flows publish the generic checkpoint contract. Plan details, work items, and verification commands/counts/statuses are durable and access remains origin-or-presentation scoped. `plugins/workflows/src/workflow-checkpoint.ts:28-120`; `plugins/workflows/src/data.ts:530-647`; `plugins/workflows/src/server.ts:125-159,193-202`.
- **Requirement:** make the capability reusable by other flows.
  **Verdict:** honored. Checkpoint/presentation capabilities are generic plugin/runtime surfaces, global admission is service-wide, and the documented `parallel()` contract matches both the saved routers and arbitrary workflow scripts.

## Inventory, authorization, and operational boundary

- `.architect/inventory/workflow-production-capability-merge.md` records the five shipped context capabilities plus checkpoint/presentation additions. IDs 0..10 remain append-only and IDs 11/12 contain only the proposed additions.
- The representative upgrade preserves seeded UTF-8 prompt bytes, context requirement/profile, observed usage/window, and estimation telemetry, backfills immediate legacy rows, remains idempotent, and now covers post-migration legacy inserts.
- Presentation scoping remains same-project/same-environment origin-or-visible-ancestor; the run is loaded before authorization; stop remains origin-only; worker checkpoint mutation remains bound to the active owning child call. `plugins/workflows/src/service.ts:615-722`; `plugins/workflows/src/server.ts:110-159,193-202`.
- Checkpoint ownership/kind/aggregate admission is one SQLite transaction with `UNIQUE(run_id, checkpoint_id)`. Global agent admission is one service-wide FIFO, releases in `finally`, removes aborted queued calls, and honors live increases/decreases without cancelling active calls. `plugins/workflows/src/data.ts:530-647`; `plugins/workflows/src/service.ts:121-177,1164-1223,2000-2003`.
- Context-profile parsing rejects unknown properties, sparse/duplicate arrays, controls/invisible characters, and bounded-length violations. Values are JSON-string encoded into a manifest explicitly framed as caller-supplied guidance, not authorization. `plugins/workflows/src/validation.ts:132-293`; `plugins/workflows/src/service.ts:979-1023`.

No new egress, secret flow, raw HTML sink, broad project lookup, or destructive all-project operation was introduced by the remediation.

## Independent verification

- `pace-agent-runtime heavy --name workflows-postfix-critic-tests -- pnpm --filter bb-plugin-workflows test` — PASS, 14 files / 288 tests.
- `pace-agent-runtime heavy --name workflows-postfix-critic-typecheck -- pnpm --filter bb-plugin-workflows typecheck` — PASS.
- `pnpm exec vitest run --config .architect/validation/vitest.config.ts` — PASS, 1 file / 7 lifecycle tests.
- Independent sealed-source migration comparison — 13 current / 11 shipped / exact 0..10 prefix / appended IDs 11 and 12.
- Independent rollback simulation — non-null parent projection and correct causal child inheritance.
- `git diff --check HEAD^..HEAD` — PASS.

## Lens conclusions

- **code-review / distinguished-engineer-review:** immediate upgrade, rollback-era inserts, re-promotion, causal inheritance, and parallel failure handling now form a compatible rollout boundary.
- **test-reviewer:** the prior regression gaps are covered at data, QuickJS runtime, service-integration, and saved-workflow lifecycle tiers; full plugin and lifecycle suites pass.
- **owasp-security:** project/environment scoping, load-before-authorize ordering, origin-only stop, and worker checkpoint ownership remain intact.
- **code-standards / simplify:** frozen migration hashes establish a mechanical cross-version invariant. The large UI module remains the non-blocking maintainability warning above.
- **factuality-claim-review:** runtime, tests, saved flows, README, and workflow skill now agree on parallel and settings behavior.

## What this review did not cover

- It did not edit product code, rebuild/restart the desktop application, or perform the same-server visual smoke; those remain the promotion/runtime gate after this source PASS.
- It did not run a destructive rollback against the live database; rollback behavior was reproduced in-memory with the real migration and row-mapping code.
- It did not re-evaluate model routing quality, provider availability, cost, or LLM output quality.
- It did not replay prior screenshots/video pixel by pixel or audit unrelated application subsystems.
