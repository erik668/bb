# CHECKPOINT — workflow acceptance coverage

Initiative: give bb workflow campaigns a **write-once** outcome contract and a
**derived** coverage reading, so a campaign of all-green work items can be shown
to have built something other than what it committed to (the remote-evals drift
shape).

- Worktree: `/Users/erik/.bb/personal-workspaces/env_ycdb7z3gdg/bb-workflow-acceptance`
- Branch: `feature/workflow-acceptance-coverage` off `e2b88b053` (repo `env_88g5eb749t/bb-workflow-details`)
- Detail: [detail-acceptance-coverage.md](detail-acceptance-coverage.md)
- PR: https://github.com/erik668/bb/pull/1 (3 commits pushed, 19 files, +2057/-30;
  cuts 3 and 4 below are local-only)

## Done

Four cuts, all **verified**: 342/342 plugin tests pass, lint and typecheck clean
(`pnpm exec turbo run test lint typecheck --filter=bb-plugin-workflows --force`,
6/6 tasks successful).

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

**Cut 4 — human-issued amendment approval** (uncommitted, 17 files, +1255/-80
including both architect docs). A declared amendment is now **accepted but
inert** — stored, readable, listed as `pendingAmendments`, and not what coverage
measures until a human approves it. New `workflow_acceptance_approvals` table
(migration 15) outside the checkpoint ledger; reachable only via
`workflowApproveAmendment` (panel, origin thread) and `bb workflows
approve-amendment <run-id> --acceptance <id>` (CLI, project-scoped), both
recording the approving thread and surface. The approval is bound to the
canonical criteria body, not the ID. An approved narrowing does **not** open a
gate whose `requiresClosed` still names the dropped criterion. Tests: 4 coverage,
3 data, 2 panel, 2 CLI validation, plus an end-to-end `server-harness` block that
first asserts the live worker has no approval tool. Design:
[detail-acceptance-coverage.md](detail-acceptance-coverage.md#approval-is-a-different-record-than-the-amendment).

## Now

Nothing in flight. Shipped and loaded:

- PR open in the **fork** (`erik668/bb`), base `feature/workflow-detail-ledger`.
  Upstream `get-bb/bb` is READ-only for this token, so nothing can be pushed
  there; the stacked base keeps the diff to this work's 3 commits instead of the
  11 that targeting `main` would show. Retarget to `main` when the base lands.
- `fork` remote added (`https://github.com/erik668/bb.git`). Both branches
  pushed there.
- Dev server running from this worktree: http://localhost:12089
  (`scripts/bb-dev-app current`; `pnpm dev:stop` to stop).

**Conflict coming.** `feature/workflow-detail-ledger` is dirty in
`env_88g5eb749t/bb-workflow-details` with uncommitted edits to the same files
this branch changed — `app.tsx`, `service.ts`, `ui-contract.ts`, `README.md`,
`SKILL.md`, `server-harness.test.ts`. Whichever lands second reconciles the
notes rendering in `app.tsx` and `ui-contract.ts`.

## Next

1. Commit cut 4 and push `feature/workflow-acceptance-coverage` to `fork` —
   `3dfcb94c7`, `18b2191d2`, and cut 4 are all unpushed, so PR #1 does not show
   closure gating or approval yet.
2. An **independent** pre-handoff critic pass (not self-review) before the PR is
   updated for review.
3. Retarget PR #1 to `main` once `feature/workflow-detail-ledger` lands.
4. Unbuilt by design: composer status line, precondition budgets.

## Known unrelated flake

`plugins/workflows/src/cli.test.ts > "keeps the removed workflow-specific
catalog command out of project documentation"` times out at 15s under
`turbo run ... --force` on a loaded machine. Reproduced on the **stashed
baseline** (301 tests) — pre-existing, not caused by this branch. Passes when
run alone or on an idle machine.
