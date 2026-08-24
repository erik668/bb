# CHECKPOINT — workflow acceptance coverage

Initiative: give bb workflow campaigns a **write-once** outcome contract and a
**derived** coverage reading, so a campaign of all-green work items can be shown
to have built something other than what it committed to (the remote-evals drift
shape).

- Worktree: `/Users/erik/.bb/personal-workspaces/env_ycdb7z3gdg/bb-workflow-acceptance`
- Branch: `feature/workflow-acceptance-coverage` off `e2b88b053` (repo `env_88g5eb749t/bb-workflow-details`)
- Detail: [detail-acceptance-coverage.md](detail-acceptance-coverage.md)

## Done

Two cuts, both **verified**: 326/326 plugin tests pass, typecheck clean
(`pnpm exec turbo run typecheck test --filter=bb-plugin-workflows --force`).

**Cut 1 — derived coverage** (`855717620`, 17 files, +1282/-28).

- `plugins/workflows/src/workflow-checkpoint.ts` — fifth checkpoint kind
  `acceptance` (1–100 criteria: `id`/`statement`/`provenBy`/`detail`); plan items
  gained `satisfies`, verifications gained `acceptanceId`.
- `plugins/workflows/src/workflow-coverage.ts` — pure derivation (no DB).
  `closed` / `in-flight` / `uncovered` per criterion + `orphanWorkItemIds`,
  `unknownReferences`, `unanchoredProgress`.
- `plugins/workflows/src/data.ts` — dedicated campaign-wide checkpoint read
  (`listCampaignCoverageCheckpoints`).
- `service.ts` / `ui-contract.ts` / `server.ts` / `app.tsx` / `cli.ts` — carry
  `coverage` + `coverageTruncated` to the panel and to `bb workflows details`.
- Docs: `plugins/workflows/README.md`, `skills/workflows/SKILL.md`.

**Cut 2 — immutability enforcement** (10 files). The contract is now
write-once in practice, not just by intent. Design and the honest limits are in
[detail-acceptance-coverage.md](detail-acceptance-coverage.md#immutability-what-is-actually-enforced);
the short version:

- The first cut's real hole was the **silent in-place** one, not the one the
  notes described: checkpoints are keyed `(run_id, checkpoint_id)` and UPDATEd,
  so a same-ID republish destroyed the original body and `amendmentCount`
  reported `0`. Refused now (`acceptance_conflict`, campaign-scoped, inside the
  existing write transaction).
- A genuine scope change has a legal move: a **new** acceptance ID carrying
  `amends: { supersedes, reason }`. Restating the same body in any criterion
  order stays free.
- `amendmentCount` → `amendments[]` + `unauthorizedAcceptanceIds[]`. The
  derivation re-walks the chain on read, so a contract edited around the tool
  path is _reported_, not adopted. The panel renders undeclared divergence as a
  warning ahead of every other note.
- One shared `canonicalizeAcceptanceCriteria` for the guard and the derivation;
  it now includes `detail`, so a quietly deleted qualifier counts as a change.
- Tests: 3 in `data.test.ts`, 4 rewritten in `workflow-coverage.test.ts`, 2 in
  `workflow-checkpoint.test.ts`, an end-to-end refusal on a live worker in
  `server-harness.test.ts`. Two mutation checks confirmed the tests kill the
  faults (write-side refusal → `return false`; read-side gate → `if (true)`).

## Now

Nothing in flight.

## Next

1. **Closure gating**: a `gate` node must not succeed while a criterion it gates
   is open. Needs the gate→criterion edge to be explicit first.
2. **Human-issued amendment approval** — the one thing that would turn
   attribution into authorization. Needs an out-of-band action (a panel
   affordance writing a record the worker tool path cannot mint).
3. Unbuilt by design: composer status line, precondition budgets.

## Known unrelated flake

`plugins/workflows/src/cli.test.ts > "keeps the removed workflow-specific
catalog command out of project documentation"` times out at 15s under
`turbo run ... --force` on a loaded machine. Reproduced on the **stashed
baseline** (301 tests) — pre-existing, not caused by this branch. Passes when
run alone or on an idle machine.
