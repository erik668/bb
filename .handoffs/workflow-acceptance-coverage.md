# Handoff — workflow acceptance coverage (MERGED)

Worktree `/Users/erik/.bb/personal-workspaces/env_ycdb7z3gdg/bb-workflow-acceptance`,
branch `feature/workflow-acceptance-coverage` @ `c5dfaa4dc`. Clean tree, pushed.
Full state: [../.architect/CHECKPOINT-workflow-acceptance-coverage.md](../.architect/CHECKPOINT-workflow-acceptance-coverage.md);
design rationale and the honest limits: [../.architect/detail-acceptance-coverage.md](../.architect/detail-acceptance-coverage.md).

## State — done

Five cuts, merged. PR #1 landed on `erik668/bb` `main` as merge commit
`fb28c9263`; `be0d8f729` on `main` carries the checkpoint update. Verified:
`pnpm exec turbo run test lint typecheck --filter=bb-plugin-workflows` — 6/6
tasks, 344 tests. `@bb/templates` (41) and the server's skills/plugins suites
(463) green after the doc corrections.

Commits: `855717620` derived coverage · `7d5d28a04` immutability ·
`18b2191d2` closure gating · `51edc0f68` human-issued approval ·
`e6646ec09` critic-pass fixes.

Nothing is in flight. Nothing reached upstream `get-bb/bb` (read-only token).

## Where the work lives

- `plugins/workflows/src/workflow-checkpoint.ts` — the `acceptance` checkpoint
  kind, `canonicalizeAcceptanceCriteria`, `readStoredCheckpoint` /
  `readStoredAcceptance` (the raw-JSON boundary parse, ~:381 and ~:394).
- `plugins/workflows/src/workflow-coverage.ts` — the pure derivation.
  `gatesLeftOpen` is the single gate-walk; `deriveOpenGates` wraps it for the
  no-contract case (fail closed); `deriveAcceptanceCoverage` returns `null` when
  no contract exists, deliberately.
- `plugins/workflows/src/data.ts` — `campaignCoverageInputs` (checkpoint identity
  comes from the `checkpoint_id` **column**, not the body's `id`),
  `openGatesForCampaign`, `gateWeakeningsInPlan`, `gateRequirementsLeftOpen`,
  and `workflow_acceptance_approvals` (migration 15).
- `plugins/workflows/src/server.ts` — `workflowApproveAmendment`. The service's
  `contractCanonical` is **projected away** here; the UI RPC contract is
  `.strict()` and returning it would break the panel's Approve button.

## Next, if resumed

1. Reconcile the dirty `feature/workflow-detail-ledger` worktree at
   `env_88g5eb749t/bb-workflow-details` against merged `main` — it has
   uncommitted edits to `app.tsx`, `service.ts`, `ui-contract.ts`, `README.md`,
   `SKILL.md`, `server-harness.test.ts`, and its 8 commits merged with this work.
   The conflict is the notes rendering in `app.tsx` / `ui-contract.ts`.
2. Three non-blocking deferrals, with reasons, in
   [detail-acceptance-coverage.md](../.architect/detail-acceptance-coverage.md#still-deferred-with-reasons):
   splitting `approveAmendment` into per-surface entry points, the
   `JSON.parse(...) as` cast in `upsertWorkflowCheckpoint`, and why
   `HOST_DAEMON_PROTOCOL_VERSION` stays at 146.
3. Unbuilt by design: composer status line, precondition budgets.

## Gotchas for a fresh session

- This worktree's `.git` is outside the sandbox write allowlist: every `git`,
  `pnpm`, and `turbo` call needs `dangerouslyDisableSandbox: true`.
- `$TMPDIR` differs between sandboxed and unsandboxed shells — a log written by
  an unsandboxed turbo run is not readable by a sandboxed `sed` resolving
  `$TMPDIR`. Use the absolute path.
- Dev server still running from this worktree at http://localhost:12089
  (`pnpm dev:stop`).
- Known unrelated flake: `plugins/workflows/src/cli.test.ts > "keeps the removed
  workflow-specific catalog command out of project documentation"` times out at
  15s under `--force` on a loaded machine. Pre-existing; reproduced on the
  stashed baseline.
