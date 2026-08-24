# Archive — acceptance coverage, cuts 1 and 2 (through 2026-08-24)

Verbatim from CHECKPOINT-workflow-acceptance-coverage.md, moved out when the
checkpoint went over its inject budget. Design rationale lives in
[../detail-acceptance-coverage.md](../detail-acceptance-coverage.md).

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

**Cut 2 — immutability enforcement** (`7d5d28a04`, 14 files, +878/-106).
Everything is committed; the tree is clean. The contract is now
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
