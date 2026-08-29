# Handoff — workflow acceptance coverage

Worktree `/Users/erik/.bb/personal-workspaces/env_ycdb7z3gdg/bb-workflow-acceptance`,
branch `feature/workflow-acceptance-coverage` @ `da7760637`. Clean tree.
Full state: [../.architect/CHECKPOINT-workflow-acceptance-coverage.md](../.architect/CHECKPOINT-workflow-acceptance-coverage.md);
design rationale and the honest limits: [../.architect/detail-acceptance-coverage.md](../.architect/detail-acceptance-coverage.md).

## State

Two cuts done, verified (326/326 tests, typecheck clean under
`pnpm exec turbo run typecheck test --filter=bb-plugin-workflows --force`) and
committed: `855717620` derived coverage, `7d5d28a04` immutability enforcement,
`da7760637` checkpoint docs. PR open in the fork:
https://github.com/erik668/bb/pull/1 (base `feature/workflow-detail-ledger`,
because upstream `get-bb/bb` is READ-only for this token and targeting `main`
would publish the sibling branch's 8 in-flight commits).

Dev server running from this worktree at http://localhost:12089
(`scripts/bb-dev-app current`; stop with `pnpm dev:stop`).

## Key references

- `plugins/workflows/src/workflow-checkpoint.ts:319` — `canonicalizeAcceptanceCriteria`,
  the single definition of "same contract" shared by write guard and derivation.
  Includes `detail`; sorts by criterion ID. `:350` `readStoredAcceptance` parses
  stored rows at the boundary.
- `plugins/workflows/src/data.ts` — `conflictsWithCampaignAcceptance`, inside the
  existing upsert transaction, returning `acceptance_conflict`. Campaign-scoped
  via `COALESCE(campaign_id, id)`; `CASE WHEN json_valid(...)` because a bare
  `AND json_valid(...)` is not guaranteed to short-circuit.
- `plugins/workflows/src/workflow-coverage.ts:134` — chain walk resolving the
  authoritative contract; emits `amendments[]` / `unauthorizedAcceptanceIds[]`.
- `plugins/workflows/src/service.ts` — `ACCEPTANCE_CONFLICT_GUIDANCE`, one string
  at both publish paths.

## Next

1. **Closure gating** — a `nodeType: "gate"` node must not succeed while a
   criterion it gates is open. Needs the gate→criterion edge explicit first.
2. **Human-issued amendment approval** — what would turn attribution into
   authorization. Needs an out-of-band action the worker tool path cannot mint;
   until then `amends.reason` is deliberately not shaped like an approval field.
3. Retarget the PR to `main` once `feature/workflow-detail-ledger` lands.
4. Unbuilt by design: composer status line, precondition budgets.

## Traps

- `feature/workflow-detail-ledger` is **dirty** in `env_88g5eb749t/bb-workflow-details`,
  touching the same files (`app.tsx`, `service.ts`, `ui-contract.ts`, `README.md`,
  `SKILL.md`, `server-harness.test.ts`). Conflict is coming; do not push or
  commit in that worktree from here.
- Enforcement is **tamper-evident, not tamper-proof** — the writer has shell
  access to the same SQLite file. Do not describe it as immutable.
- `cli.test.ts > "keeps the removed workflow-specific catalog command out of
project documentation"` times out at 15s under `--force` on a loaded machine.
  Pre-existing, reproduced on the stashed baseline.
- `git push` / `gh pr create` were each blocked once by the permission classifier
  and succeeded on retry.
