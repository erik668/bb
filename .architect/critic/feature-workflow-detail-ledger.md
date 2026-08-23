SHA: 8bb8fbd0b57b1b5c5c5ca9c1566d05f791f5ee99
VERDICT: PASS
CRITIC: codex-pre-handoff-critic-20260822

# Independent pre-handoff review: workflow build story

I am an independent reviewer and did not author the implementation under review.

Finding count: 0 blocking / 4 warnings / 0 nits.

No blocking correctness, authorization, migration, or handoff-evidence findings remain at this SHA.

## Warnings

### 1. Rollback-compatible campaign predicates do not use the existing campaign index

- **Severity:** warn
- **Lens:** distinguished-engineer-review / simplify
- **Location:** `plugins/workflows/src/data.ts:359-375,480-537`
- **Scenario:** Correct rollback compatibility requires treating `campaign_id IS NULL` as the run's own ID. The current `COALESCE(campaign_id,id) = ?` predicates do that correctly, but SQLite plans them as full `workflow_runs` scans rather than using `workflow_runs_campaign_created_idx`. Campaign continuation and inspection can therefore become slower as retained run history grows.
- **Evidence:** An independent SQLite `EXPLAIN QUERY PLAN` against the same table/index shape returned `SCAN workflow_runs`.
- **Fix:** If retained history becomes material, use a sargable dual predicate or add an expression index matching `COALESCE(campaign_id,id)` and prove the query plan. This is not a blocker for the current bounded, single-customer installation.

### 2. Mutation testing was not attempted

- **Severity:** warn
- **Lens:** test-reviewer
- **Location:** campaign authorization/hydration, DAG merge, checkpoint validation, and migration tests
- **Scenario:** The 301-test suite is broad and the independent review found regressions that were repaired, but no mutation run proves every boundary assertion fails under targeted logic changes.
- **Fix:** Before wider multi-customer rollout, mutate campaign ancestry, rollback projection, detailed-run selection, scope-count comparison, `dependsOn` presence merge, and promotion-status mapping; retain assertions that kill those mutations.

### 3. `app.tsx` remains a large coupled edit surface

- **Severity:** warn
- **Lens:** code-standards #3 / simplify
- **Location:** `plugins/workflows/src/app.tsx:437-485,1129-1435`
- **Scenario:** `CampaignRunList`, `WorkflowDag`, and `TransitionNotes` are focused components, but details loading, stale-request handling, graph projection, and the surrounding inspector remain in a very large module.
- **Fix:** In a follow-up, extract the campaign-details loader and build-story projection while preserving the RPC/component tests.

### 4. Browser evidence reports 192 warnings without preserving their content

- **Severity:** warn
- **Lens:** factuality-claim-review / UI evidence quality
- **Location:** `output/playwright/workflow-campaign-inspector-console.txt`
- **Scenario:** The recorded Playwright console probe proves zero error-level messages, but reports 192 warnings without samples. This is sufficient for the stated zero-error gate, not for a claim of a fully clean console.
- **Fix:** Future evidence should retain warning text or explicitly classify known dev-environment noise.

## Prior blocker resolution

### Campaign payload cliff — resolved

Campaigns still retain 100 lightweight chronological run summaries, but only the selected run plus newest runs are detailed, up to four ledgers total. The selected ledger remains in the primary field and is not duplicated; older entries are marked `checkpointsOmitted`. Four independently bounded 4 MiB ledgers cap checkpoint detail at 16 MiB. `plugins/workflows/src/workflow-campaign.ts:3-10`; `plugins/workflows/src/data.ts:506-537`; `plugins/workflows/src/service.ts:545-558,978-1032`; `plugins/workflows/src/server.ts:171-199`; `plugins/workflows/src/ui-contract.ts:82-111`.

The regression retains every summary, selects the requested run plus newest three, and places malformed JSON in an omitted older ledger to prove it is not hydrated. `plugins/workflows/src/service-policy.test.ts:1506-1544`. The UI truthfully distinguishes an incomplete cross-run graph from an invalid graph when dependencies may live in omitted history. `plugins/workflows/src/app.tsx:1143-1236,1383-1435`; `plugins/workflows/src/app.test.tsx:998-1039`.

### Rendered interaction evidence — resolved

The independently inspected artifacts are:

- `output/playwright/workflow-campaign-inspector.png` — 814x1638 PNG, SHA-256 `1ff79ae1cc840893739b100dbd534468d8222e4b4815ba9ca559da0bdda0fcb9`.
- `output/playwright/workflow-campaign-inspector-details.png` — 814x1638 PNG, SHA-256 `05eea357ecde5451d6f9ea67557c42adcd62d80623d8f85e2eac170357cb3541`.
- `output/playwright/workflow-campaign-inspector-interaction.webm` — 12.04-second VP8, 800x600, 25 fps, SHA-256 `ce4beb8f069456b46c90ef853a97e333089ba09f1dd6153ddb6ae2bba5bc203b`.
- `output/playwright/workflow-campaign-inspector-console.txt` — zero error-level messages, SHA-256 `95917bee9ac11c369e671b1fe85a70ec9ac10b46ba5283dca1477545dc16908a`.

The screenshots show six related runs, the omission notice, DAG/gate/status presentation, truthful incomplete-graph diagnostics, selected plan, ticket references, implementation disclosures, and verification counts. Independent frame sampling of the WebM shows continuous collapse/expand interaction across plan, work-item, and verification disclosures.

### Rollback-era campaign projection — resolved

Runs inserted by an older build after migration 13 can have null campaign/presentation columns. Admission, first-run lookup, count, summary listing, and run projection now use compatible `COALESCE` semantics; cap/list scope also coalesces presentation to origin. `plugins/workflows/src/data.ts:173-190,359-375,480-537`. The production-shaped upgrade test proves self-campaign projection, lookup/list/count, bounded continuation inheritance, and count increment for a rollback-era insert. `plugins/workflows/src/data.test.ts:288-372`.

## Governing requirements and conformance

- **Requirement:** “easily view the full plan that was selected,” “exact progress, like a per-ticket breakdown,” and “which tests were selected, what their status is.”
  **Verdict:** honored for the selected run and bounded recent campaign history. Plans carry detail/tickets, work items carry status/files/blockers, verification carries command/count/status, and omitted older ledgers are explicitly disclosed. `plugins/workflows/src/workflow-checkpoint.ts:35-188`; `plugins/workflows/src/app.tsx:1421-1429`.
- **Requirement:** “one overarching workflow that encompasses all of the smaller sections,” with a “DAG” and “notes on why certain transitions occurred.”
  **Verdict:** honored through explicit campaign identity, dependency edges, and transition checkpoints without fabricating causal lineage. `plugins/workflows/src/workflow-checkpoint.ts:19-155`; `plugins/workflows/src/app.tsx:1129-1435`; `.architect/inventory/workflow-build-story.md:38-45`.
- **Requirement:** “surface the related workflow card on the root workflow I kicked it off in, or the root agent who led to one or more agents further down to kick it off.”
  **Verdict:** honored without exposing private-origin campaign details. Presentation ancestry remains project/environment scoped; aggregation is available only in the shared presentation thread. `plugins/workflows/src/service.ts:631-842`; `plugins/workflows/src/server.ts:117-199`.
- **Repository requirement:** “Use strict schemas and deterministic validation when crossing process or tool boundaries.”
  **Verdict:** honored. Campaign IDs, checkpoint unions, dependency topology, transition fields, byte/node limits, run summaries, and RPC results are bounded and validated. `plugins/workflows/src/workflow-campaign.ts:3-16`; `plugins/workflows/src/workflow-checkpoint.ts:3-199`; `plugins/workflows/src/ui-contract.ts:71-111`.
- **Repository requirement:** “New commands or flags must update both the relevant `bb guide` chapter and `apps/server/src/services/skills/builtin-skills/bb-cli/SKILL.md`.”
  **Verdict:** honored for `--campaign`, campaign-aware `details`, and four-ledger omission semantics. `packages/templates/src/templates/bb-guide-plugins.md:60-89`; `apps/server/src/services/skills/builtin-skills/bb-cli/SKILL.md:663-689`.

## Authorization, ordering, mutation, and concurrency audit

- **Scope/order:** The selected run is authorized against the requesting origin/presentation thread before aggregation. Campaign SQL is constrained by campaign, project, environment, and coalesced presentation; a global count mismatch fails closed. `plugins/workflows/src/server.ts:117-139,171-199`; `plugins/workflows/src/data.ts:480-537`; `plugins/workflows/src/service.ts:1000-1032`.
- **Lineage:** Unknown campaigns are rejected. Causal children/resumed runs inherit campaign identity; conflicts fail. Independent continuation/resume resolves the campaign presentation through origin ancestry. `plugins/workflows/src/service.ts:696-842`.
- **Ordering:** Summaries are stable by `created_at ASC, rowid ASC`; selected plus newest ledgers are deterministic. `plugins/workflows/src/data.ts:506-537`; `plugins/workflows/src/service.ts:545-558`.
- **Mutation:** Stop remains origin-only; checkpoint writes remain bound to the active owning child call and stable ID. Campaign grouping adds no cross-run edit operation. `plugins/workflows/src/server.ts:201-212,248-256`.
- **Concurrency:** Campaign cap check and insert remain one SQLite transaction; the 99-to-100/101 race admits exactly one contender. `plugins/workflows/src/data.ts:351-399`; `plugins/workflows/src/service-policy.test.ts:1692-1727`.
- **Destructive/egress boundary:** No delete-all, broad-project mutation, credential flow, raw HTML sink, or new network egress is introduced.

## Independent verification

- `pace-agent-runtime heavy --name critic-final-remediation-tests -- pnpm exec turbo run test --filter=bb-plugin-workflows --force` — PASS, 14 files / 301 tests.
- `pace-agent-runtime heavy --name critic-final-remediation-typecheck -- pnpm exec turbo run typecheck --filter=bb-plugin-workflows --force` — PASS.
- `git diff --check HEAD` — PASS.
- The two screenshots were inspected at original resolution; the WebM metadata and sampled frames were independently inspected; the console record and all artifact hashes were independently checked.
- Canonical mirror parity and config policy/live validation are recorded in the sibling config report.

## What this review did not cover

- No mutation test was attempted.
- The 192 browser-console warnings were not classified because the artifact records only their count.
- I did not run a destructive downgrade against the live SQLite database, delete runtime state, push, commit, or deploy.
- I did not evaluate provider/model output quality, cost, or long-duration agent drift.
