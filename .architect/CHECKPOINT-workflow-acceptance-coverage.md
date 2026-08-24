# CHECKPOINT — workflow acceptance coverage

Initiative: give bb workflow campaigns a write-once outcome contract and a
**derived** coverage reading, so a campaign of all-green work items can be shown
to have built something other than what it committed to (the remote-evals drift
shape).

- Worktree: `/Users/erik/.bb/personal-workspaces/env_ycdb7z3gdg/bb-workflow-acceptance`
- Branch: `feature/workflow-acceptance-coverage` off `e2b88b053` (repo `env_88g5eb749t/bb-workflow-details`)
- Detail: [detail-acceptance-coverage.md](detail-acceptance-coverage.md)

## Done

First cut is complete and **verified**: 318/318 plugin tests pass, typecheck
clean (`pnpm exec turbo run typecheck test --filter=bb-plugin-workflows`).
12 files, +678 lines, **uncommitted**.

- `plugins/workflows/src/workflow-checkpoint.ts` — fifth checkpoint kind
  `acceptance` (1–100 criteria: `id`/`statement`/`provenBy`/`detail`); plan items
  gained `satisfies`, verifications gained `acceptanceId`.
- `plugins/workflows/src/workflow-coverage.ts` — pure derivation (no DB).
  `closed` / `in-flight` / `uncovered` per criterion + `orphanWorkItemIds`,
  `amendmentCount`, `unknownReferences`, `unanchoredProgress`.
- `plugins/workflows/src/data.ts` — dedicated campaign-wide checkpoint read
  (`listCampaignCoverageCheckpoints`).
- `service.ts` / `ui-contract.ts` / `server.ts` / `app.tsx` / `cli.ts` — carry
  `coverage` + `coverageTruncated` to the panel and to `bb workflows details`.
- Tests: `workflow-coverage.test.ts` (10, derivation), acceptance cases in
  `workflow-checkpoint.test.ts`, a campaign-ledger case in
  `service-policy.test.ts`, a render case in `app.test.tsx`.
- Docs: `plugins/workflows/README.md`, `skills/workflows/SKILL.md`.

## Now

Nothing in flight. Awaiting a user decision: commit this cut, or start
acceptance immutability enforcement.

## Next

1. Commit the branch (nothing is committed yet — a kill loses 678 lines).
2. **Immutability**: a republished acceptance body is currently only *reported*
   as `amendmentCount`, not refused. This is the one remaining place a drifting
   orchestrator can edit its own anchor. Needs a human-approved amendment path.
3. **Closure gating**: a `gate` node must not succeed while a criterion it gates
   is open.
4. Unbuilt by design: composer status line, precondition budgets.

## Known unrelated flake

`plugins/workflows/src/cli.test.ts > "keeps the removed workflow-specific
catalog command out of project documentation"` times out at 15s under
`turbo run ... --force` on a loaded machine. Reproduced on the **stashed
baseline** (301 tests) — pre-existing, not caused by this branch. Passes when
run alone or on an idle machine.
