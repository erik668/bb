SHA: 2dc4c10f8da23893ee31d23da5780604688dbc8d
VERDICT: CHANGES REQUIRED
CRITIC: codex-migration-merge-critic-20260821

# Independent pre-promotion review

Finding count: 2 blocking / 2 warning / 0 nit.

## Findings

### Blocking 1: rollback then re-promotion produces invalid causal rows

- **Severity:** blocking
- **Lens:** distinguished-engineer-review / code-review / test-reviewer
- **Location:** `plugins/workflows/src/data.ts:137-171,301-314`; `plugins/workflows/src/service.ts:559-565`
- **Scenario:** Migration 12 deliberately adds nullable `presentation_thread_id` and `root_run_id` columns so the previous Workflows build can still insert runs after a rollback. The initial backfill runs only when migration 12 is first applied. If production is rolled back, the old build inserts a run without those columns; after re-promotion, `runRow()` returns both fields as `null` even though the public type promises strings. `publishRunChanged()` then publishes to a `null` thread, and a workflow launched causally from that row can inherit a null presentation/root identity. A direct legacy-column-list insert after applying all 13 migrations reproduced `{"presentationThreadId":null,"parentRunId":null,"rootRunId":null}`.
- **Fix:** make the durable read projection rollback-safe (for example, select `COALESCE(presentation_thread_id, origin_thread_id)` and `COALESCE(root_run_id, id)`) and add a regression that applies migrations 0..12, inserts a run through the pre-promotion column list, then exercises current inspection/presentation/causal launch behavior. Do not rely on another one-shot backfill: a later rollback can create rows after that migration too.

### Blocking 2: `parallel()` changed a documented, inventoried-by-omission contract and is not fail-fast

- **Severity:** blocking
- **Lens:** spec conformance / inventory conformance / factuality-claim-review / code-review
- **Location:** `plugins/workflows/src/runtime.ts:575-589`; `plugins/workflows/src/runtime.test.ts:470-507`; `plugins/workflows/skills/workflows/SKILL.md:124-128`
- **Scenario:** The published skill contract says: “A thunk that throws ... resolves to `null`” and tells flow authors to `.filter(Boolean)`. This SHA instead waits for every thunk to settle and then rejects the aggregate. Existing flows written to consume partial parallel results now fail the entire run after the slowest sibling finishes. This is neither the documented resilience behavior nor fail-fast cancellation. The changed behavior is not recorded in `.architect/inventory/workflow-production-capability-merge.md`, whose scope is preservation plus global admission/context capabilities.
- **Fix:** choose and ratify one contract before promotion. For compatibility, restore per-thunk `null` results. If failure-closed semantics are required, update the capability inventory, workflow skill/README, and saved-flow callers, and implement/test actual early rejection plus sibling cancellation rather than the current settle-all-then-throw behavior.

### Warning 1: production upgrade fixture does not freeze the shipped migration prefix

- **Severity:** warn
- **Lens:** test-reviewer / code-standards #1
- **Location:** `plugins/workflows/src/data.test.ts:100-258`
- **Scenario:** The upgrade test creates its “production” database with `migrations.slice(0, 11)`, the same mutable array under test. It proves the current 0..10 prefix upgrades to 11..12 and preserves seeded telemetry, but it would not catch a future edit or reorder of a shipped migration because both setup and upgrade would drift together.
- **Fix:** freeze the shipped 0..10 SQL or stable hashes in a test fixture sourced from the installed production build, assert exact prefix equality, then run the upgrade. My independent comparison against the sealed `bb-workflows-runtime-context-fit` source found the current 0..10 prefix byte-for-byte identical, so this is test hardening rather than evidence of present drift.

### Warning 2: operator and flow documentation omits live global admission

- **Severity:** warn
- **Lens:** factuality-claim-review
- **Location:** `plugins/workflows/README.md:164-180`; `plugins/workflows/skills/workflows/SKILL.md:532-535`; `plugins/workflows/src/settings.ts:11-19,78-90`
- **Scenario:** Code now declares seven settings and treats `maxGlobalConcurrentAgents` as live host-wide admission, but the README still says “six plugin settings,” lists six, and says only `maxActiveRuns` is live. The workflow skill likewise describes only `maxActiveRuns` as live policy. This makes the newly promoted capacity control undiscoverable and misstates snapshot behavior for other flows/operators.
- **Fix:** document the seventh setting, distinguish host-global live admission from per-run snapshotted concurrency, and state how live decreases treat already-active calls.

## Ratified requirement conformance

- **Requirement:** “surface the related workflow card on the root workflow I kicked it off in, or the root agent who led to one or more agents further down to kick it off.”
  **Verdict:** honored for rows created by the current build. Hidden origins resolve through same-project/same-environment ancestry and nested workflows inherit causal presentation/root identity. The rollback-created-row case above is the remaining blocker. `plugins/workflows/src/service.ts:615-722`; `plugins/workflows/src/server.ts:110-159`.
- **Requirement:** “easily view the full plan that was selected,” “exact progress, like a per-ticket breakdown,” and “which tests were selected, what their status is.”
  **Verdict:** honored when workflows publish the checkpoint contract. Plan details, work items, and verification commands/counts/statuses are durable and access remains origin-or-presentation scoped. `plugins/workflows/src/workflow-checkpoint.ts:28-120`; `plugins/workflows/src/data.ts:530-647`; `plugins/workflows/src/server.ts:125-159,193-202`.
- **Requirement:** make the capability reusable by other flows.
  **Verdict:** checkpoint and presentation capabilities are generic plugin/runtime surfaces, and global admission is service-wide. The two blockers must be resolved before broad promotion because both affect arbitrary saved flows rather than only the router.

## Inventory and migration conformance

- `.architect/inventory/workflow-production-capability-merge.md` exists and records the five shipped context capabilities plus checkpoint/presentation additions.
- Independent source comparison found 13 current migrations, 11 shipped migrations, exact byte-for-byte equality for IDs 0..10, checkpoint migration appended at ID 11, and presentation/causal migration appended at ID 12.
- The representative upgrade test preserves seeded `prompt_bytes`, context requirement/profile, observed usage/window, and estimation telemetry while backfilling presentation/root state and is idempotent for the immediate 0..10 -> 0..12 upgrade.
- The live database currently reports migration IDs 0..12, 565 calls, all 565 prompt-byte values present, 2 minimum-context rows, 142 context-profile rows, and 341 observation triples. All 78 live runs currently have non-null presentation/root IDs. This confirms the immediate upgrade; it does not cover the rollback/re-promotion sequence in Blocking 1.

## Authorization and interaction boundary

| Axis           | Result                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scoping        | PASS. Explicit presentation targets traverse only visible origin/ancestors and every ancestor/causal parent is constrained to the same project and environment. Run views allow only persisted origin or presentation threads. `plugins/workflows/src/service.ts:615-722`; `plugins/workflows/src/server.ts:110-146`.                                                                                   |
| Ordering       | PASS. Run state is loaded before origin/presentation authorization and before stop mutation. `plugins/workflows/src/server.ts:110-159`.                                                                                                                                                                                                                                                                 |
| Who may mutate | PASS within the local trusted-renderer boundary. Presentation inspection is read-only and stop remains origin-only; worker checkpoints are bound to the host-supplied active child call. `plugins/workflows/src/server.ts:148-159,193-202`; `plugins/workflows/src/service.ts:1435-1469,1790-1817`.                                                                                                     |
| Concurrency    | PASS. Checkpoint ownership/kind/aggregate admission is one SQLite transaction with `UNIQUE(run_id, checkpoint_id)`. Global agent admission is one service-wide FIFO, releases in `finally`, removes aborted queued calls, and honors live increases/decreases without cancelling active calls. `plugins/workflows/src/data.ts:530-647`; `plugins/workflows/src/service.ts:121-177,1164-1223,2000-2003`. |

Context-profile parsing rejects unknown properties, sparse/duplicate arrays, controls/invisible characters, and bounded-length violations. Rendered values are JSON-string encoded and explicitly described as caller-supplied task guidance rather than authorization. Context requirements/profiles are stored outside rollback-readable `options_json`, participate in cache identity, and telemetry remains best-effort so a stuck timeline read does not block workflow settlement. `plugins/workflows/src/validation.ts:132-293`; `plugins/workflows/src/cache.ts:196-220`; `plugins/workflows/src/service.ts:979-1023,1261-1277`.

## Independent commands and evidence

- `pace-agent-runtime heavy --name workflows-migration-critic-tests -- pnpm --filter bb-plugin-workflows test` — PASS, 14 files / 288 tests.
- `pace-agent-runtime heavy --name workflows-migration-critic-typecheck -- pnpm --filter bb-plugin-workflows typecheck` — PASS.
- `pnpm ... tsx` migration-prefix comparison against the sealed production-capability worktree — 13 current / 11 shipped / exact prefix / appended IDs 11 and 12.
- Read-only live SQLite query — IDs 0..12 applied; context usage counts above; no current null presentation/root rows.
- Direct rollback simulation — reproduced null current projections after a legacy insert performed after migration 12.

## Lens conclusions

- **code-review / distinguished-engineer-review:** immediate production upgrade is data-preserving, but repeatable rollback/re-promotion is unsafe until nullable causal fields are normalized.
- **test-reviewer:** the full deterministic suite is green and global admission/context/checkpoint coverage is strong; missing rollback-era insertion and frozen-prefix regressions remain material.
- **owasp-security:** project/environment scoping, load-before-authorize ordering, origin-only stop, and worker checkpoint ownership pass. No new egress, secret, raw-HTML, or broad destructive operation was found.
- **code-standards / simplify:** no new unchecked external-deserialization cast or duplicated closed-set blocker found. The prior large-`app.tsx` maintainability warning remains a follow-up, not an additional promotion blocker.
- **factuality-claim-review:** migration and immediate preservation claims are supported; `parallel()` and settings documentation are contradicted by executable behavior.

## What this review did not cover

- It did not edit product code, rebuild/restart the desktop application, or perform the same-server visual smoke; those remain after a clean source verdict.
- It did not run a destructive rollback against the live database; the rollback defect was reproduced in an in-memory SQLite database using the real migrations and current row mapper.
- It did not re-evaluate model routing quality, provider availability, cost, or LLM output quality.
- It did not independently replay screenshots/video or audit every line of the two large saved router workflows beyond their interaction with the generic runtime contracts reviewed here.
