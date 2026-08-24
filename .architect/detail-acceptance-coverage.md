# Detail — acceptance coverage design decisions

Component notes for [CHECKPOINT-workflow-acceptance-coverage.md](CHECKPOINT-workflow-acceptance-coverage.md).
These are the non-obvious choices; the code carries the rest.

## Why the contract sits above the orchestrator

The remote-evals drift had two structural causes: the anchor (`MISSION.md`) was
**agent-writable**, so drift rewrote it rather than tripping it; and the original
plan was orphaned in a directory sessions are told to ignore. Acceptance
therefore belongs to the **campaign**, not to the orchestrator that authors
plans — handing it to the orchestrator rebuilds the agent-writable-anchor bug one
level up. Subagents get their slice **in-band plus the ledger**, never a file:
files are exactly how remote evals failed.

## Coverage is derived, never authored

Every input already exists in the ledger. A drifting orchestrator authors both
the plan and the progress, so only a reading it does **not** author can
contradict it. Nothing in `workflow-coverage.ts` asks an agent to report on
itself.

## Two different resolutions of "the plan" (workflow-coverage.ts)

- `currentPlan = plans.at(-1)` for criterion state — a criterion a later plan
  **dropped** must revert to `uncovered`. Unioning all plans would let a
  criterion run 1 claimed and run 40 quietly abandoned stay green forever; that
  is precisely the drift being hunted.
- `planItemsById` merges all plans (last write wins) **only** to resolve a work
  item back to its declaration, since a work item may belong to a superseded
  plan.

Test coverage for both: "re-opens a criterion the newest plan dropped" and
"resolves orphan status through a superseded plan".

## Preconditions are legitimate orphans

A containment/bring-up gate is a `nodeType: "gate"` work item that satisfies
nothing, so succeeded-but-unanchored work is *normal*. Drift is **sustained**
orphan work with no acceptance movement — captured mechanically as
`unanchoredProgress = closedCount === 0 && orphanWorkItemIds.length > 0`. No
tuned threshold.

## Absence is reported as absence

`deriveAcceptanceCoverage` returns `null` when no acceptance checkpoint exists.
Inferring criteria from the plan would measure the plan against itself and always
agree.

## Why coverage does not reuse campaign inspection

`MAX_WORKFLOW_CAMPAIGN_DETAILED_RUNS = 4`. Deriving from the hydrated campaign
view would drop the acceptance contract itself as soon as a campaign outgrew four
runs — i.e. exactly when drift-checking starts to matter. Hence
`listCampaignCoverageCheckpoints` in `data.ts`: a narrow campaign-wide read
(`COALESCE(run.campaign_id, run.id)`, ordered `run.created_at, run.rowid,
checkpoint.ordinal`) capped at `MAX_WORKFLOW_COVERAGE_CHECKPOINTS = 5_000` with
truncation reported, not silent.

## Two bugs the tests caught (keep the tests)

1. **`json_extract` raises on malformed JSON.** The campaign-wide read touches
   rows bounded hydration never parses, and `service-policy.test.ts` deliberately
   plants a `not-json` row on an omitted run. One corrupt row would have taken
   down the whole campaign view. Guarded with
   `CASE WHEN json_valid(...) THEN json_extract(...) END`. SQLite guarantees
   `CASE` short-circuits; a bare `AND json_valid(...)` does not, since the
   planner may reorder WHERE terms.
2. **`WorkflowCheckpointDetails` short-circuits on an empty ledger** — which is
   the exact state of a campaign whose contract lives in an omitted older run.
   The empty-state guard now also checks `state.coverage === null`.

## Deferred, with reasons

- **Immutability.** A rewritten contract is currently reported
  (`amendmentCount`) with the *first* body staying authoritative — not refused.
  Reordering is tolerated (`canonicalCriteria` sorts by id before stringifying),
  so only a genuine rewrite counts. Enforcement needs a human-approved amendment
  path, otherwise a legitimate scope change has no legal move.
- **Closure gating.** A `gate` node should not be allowed to succeed while a
  criterion it gates is open. Needs the gate→criterion edge to be explicit
  first.
