# CHECKPOINT — workflow acceptance coverage

Initiative: give bb workflow campaigns a **write-once** outcome contract and a
**derived** coverage reading, so a campaign of all-green work items can be shown
to have built something other than what it committed to (the remote-evals drift
shape).

- Worktree: `/Users/erik/.bb/personal-workspaces/env_ycdb7z3gdg/bb-workflow-acceptance`
- Branch: `feature/workflow-acceptance-coverage` off `e2b88b053` (repo `env_88g5eb749t/bb-workflow-details`)
- Detail: [detail-acceptance-coverage.md](detail-acceptance-coverage.md)
- PR: https://github.com/erik668/bb/pull/1, base `main`

## Done

Five cuts, all **verified**: 344/344 plugin tests pass, lint and typecheck clean
(`pnpm exec turbo run test lint typecheck --filter=bb-plugin-workflows`, 6/6
tasks successful). `@bb/templates` (41 tests) and the server's skills/plugins
suites (463 tests) re-run green after the doc corrections.

**Cuts 1–2 — derived coverage (`855717620`) and immutability enforcement
(`7d5d28a04`)**. Fifth checkpoint kind `acceptance`; pure `workflow-coverage.ts`
derivation carried to the panel and `bb workflows details`; same-ID republish
refused (`acceptance_conflict`), a real scope change requiring a new ID with
`amends: { supersedes, reason }`, and `amendments[]` +
`unauthorizedAcceptanceIds[]` re-walked on read. Detail:
[archive/acceptance-coverage-cuts-1-2-through-2026-08-24.md](archive/acceptance-coverage-cuts-1-2-through-2026-08-24.md).

**Cut 3 — closure gating** (`18b2191d2`, 12 files, +592/-12). A
`nodeType: "gate"` plan item declares `requiresClosed: string[]` — the inverse
of `satisfies`, refused by the schema on a work node — and a claim of
`succeeded` on that item is refused (`{ kind: "gate_conflict"; openCriterionIds }`)
while any named criterion is open. Closure comes from
`deriveAcceptanceCoverage`, not a second query; fail closed, last plan wins, and
only _success_ is gated so honest `failed`/`blocked` reporting stays free. Two
mutation checks confirmed the tests kill the faults.

**Cut 4 — human-issued amendment approval** (`51edc0f68`, 19 files, +1342/-128
including the architect docs). A declared amendment is now **accepted but
inert** — stored, readable, listed as `pendingAmendments`, and not what coverage
measures until a human approves it. New `workflow_acceptance_approvals` table
(migration 15) outside the checkpoint ledger; reachable only via
`workflowApproveAmendment` (panel, origin thread) and `bb workflows
approve-amendment <run-id> --acceptance <id>` (CLI, project-scoped), both
recording the approving thread and surface. The approval is bound to the
canonical criteria body, not the ID. An approved narrowing does **not** open a
gate whose `requiresClosed` still names the dropped criterion. Tests: 4 coverage,
3 data, 2 panel, 2 CLI validation, plus an end-to-end `server-harness` block
that drives the real RPC and CLI handlers, including their refusals. Design:
[detail-acceptance-coverage.md](detail-acceptance-coverage.md#approval-is-a-different-record-than-the-amendment).

**Cut 5 — independent critic pass and its fixes.** A subagent critic returned
**BLOCK**; the findings were verified against the code and were right. Six fixes:

1. **The security claim was false** on four doc surfaces (plugin `SKILL.md`,
   plugin `README.md`, the `bb-cli` builtin skill, `bb-guide-plugins.md`).
   `PluginAgentConfiguration.tools` is a per-plugin selection and does not take
   the host's shell away from a worker. All four now state the property that
   actually holds — refusal by provenance, i.e. tamper-evidence.
2. **`gate_weakened`**: a plan that retires a gate the campaign is stuck behind
   is refused (demotion, dropped requirement, or deleted item), with a carve-out
   for a criterion the approved contract no longer declares.
3. **`ambiguous_body`**: when one acceptance ID names two bodies across sibling
   runs in a campaign, approval fails closed instead of taking the newest row.
4. **One gate-walk** (`gatesLeftOpen`) shared by the readable `openGates` and the
   write guard, with `deriveOpenGates` covering the no-contract case so an
   absent contract cannot fail open.
5. **Row identity**: `campaignCoverageInputs` now takes the checkpoint ID from
   the `checkpoint_id` column, not the `id` inside the JSON body.
6. **`requiresClosed: []`** refused by the schema.

Two boundaries the critic found untested (the RPC origin-thread check, the CLI
project scoping) now have mutation-verified tests, as does the campaign-wide
same-ID guard. A self-introduced bug was caught along the way: returning
`contractCanonical` through the `.strict()` UI RPC output would have broken the
panel's Approve button — fixed by projecting in `server.ts` and covered by a
real-handler `callRpc` test.

## Now

**Merged.** PR #1 landed on `erik668/bb` `main` as `fb28c9263` (merge commit,
history preserved). Nothing in flight.

Because the PR was retargeted from the unmerged `feature/workflow-detail-ledger`
to `main`, that branch's 8 commits (`ba43902`…`e2b88b053`) landed with this
work's 7.

- `fork` remote (`https://github.com/erik668/bb.git`). Upstream `get-bb/bb` is
  READ-only for this token, so nothing here has reached upstream.
- Dev server still running from this worktree: http://localhost:12089
  (`pnpm dev:stop` to stop).

**Conflict watch.** `feature/workflow-detail-ledger` is still dirty in
`env_88g5eb749t/bb-workflow-details` with uncommitted edits to files this work
changed — `app.tsx`, `service.ts`, `ui-contract.ts`, `README.md`, `SKILL.md`,
`server-harness.test.ts`. Those edits now need reconciling against merged `main`,
not against a sibling branch.

## Next

1. Reconcile the dirty `feature/workflow-detail-ledger` worktree against merged
   `main` (notes rendering in `app.tsx` / `ui-contract.ts`).
2. Unbuilt by design: composer status line, precondition budgets. Three
   non-blocking deferrals are recorded with reasons in
   [detail-acceptance-coverage.md](detail-acceptance-coverage.md#still-deferred-with-reasons).

## Known unrelated flake

`plugins/workflows/src/cli.test.ts > "keeps the removed workflow-specific
catalog command out of project documentation"` times out at 15s under
`turbo run ... --force` on a loaded machine. Reproduced on the **stashed
baseline** (301 tests) — pre-existing, not caused by this branch. Passes when
run alone or on an idle machine.
