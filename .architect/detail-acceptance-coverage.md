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
nothing, so succeeded-but-unanchored work is _normal_. Drift is **sustained**
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

## Three bugs the tests caught (keep the tests)

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
3. **The `app.test.tsx` coverage fixture was untyped**, sitting inside a fake RPC
   response. When the coverage contract changed it drifted silently, failed the
   `.strict()` parse, and surfaced as "Unable to find text: Acceptance" instead
   of a compile error. Now `satisfies WorkflowAcceptanceCoverage`.

## Immutability: what is actually enforced

The first cut had a hole worse than the one it documented. Checkpoints are keyed
`(run_id, checkpoint_id)` and an existing row is **UPDATEd in place**
(`data.ts`), so republishing acceptance under the same ID destroyed the original
body. `amendmentCount` compared distinct acceptance _rows_, saw one, and
reported zero amendments — the anchor was rewritten and coverage said nothing.
That was the remote-evals `MISSION.md` failure reproduced inside the ledger.

Now closed at the write path (`conflictsWithCampaignAcceptance`, returning the
new `acceptance_conflict` outcome), campaign-scoped because acceptance belongs to
the campaign and a child run publishing its own contract is the same rewrite one
level out:

- Same ID, changed body → refused unconditionally. An amendment cannot overwrite
  the thing it supersedes, so `amends` cannot rescue it (the schema also refuses
  `supersedes === id`).
- New ID, changed body → accepted only with `amends: { supersedes, reason }`
  naming an acceptance the campaign really published.
- Restating the same body, in any criterion order → always accepted. A resumed
  run legitimately republishes its checkpoints, and refusing that would push an
  orchestrator into working around the contract entirely.

**This is tamper-evidence, not tamper-proofing, and the distinction is
deliberate.** The writer is an agent with shell access to the same SQLite file,
so no in-process design makes the anchor unwritable. What is achievable is that
the original survives, every change is attributed with a reason, and the
_derivation independently re-checks the amendment chain on read_ — so a contract
edited around the tool path is reported (`unauthorizedAcceptanceIds`) and does
NOT become what coverage measures. Enforcement and derivation are two separate
readings; defeating one is not enough.

`amends.reason` is written by the same agent the contract constrains, so it is
attribution, not authorization. It was deliberately NOT named or shaped like an
approval field. Authorization is now a separate record — see "Approval is a
different record than the amendment" below.

One canonicalizer (`canonicalizeAcceptanceCriteria` in `workflow-checkpoint.ts`)
serves both the write guard and the derivation — two would be two different
answers to "is this the same contract". It sorts by criterion ID (order is not
part of the contract) and **includes `detail`**, because a quietly deleted
qualifier ("must also pass in the EU region") narrows what done means. `title`
and `summary` are excluded, so retitling stays free.

## Closure gating: the edge, then the guard

The gate→criterion edge is `requiresClosed` on a `nodeType: "gate"` plan item —
the **inverse** of `satisfies`. It is named for what it waits on rather than
`gates`, because "this node gates X" reads equally as the reverse edge. The
schema refuses it on a work node: a field that reads as a gate and is never
enforced is worse than no field.

The edge and the claim live in different checkpoints by design — the plan
declares the requirement, and success is reported later on a work-item row — so
the guard is a campaign-wide read ordered exactly like the coverage read. **Last
plan wins** for a given item ID, matching how coverage resolves a work item back
to its declaration; a gate only an older plan declared is not something the
campaign is still stuck behind.

Closure is resolved by calling `deriveAcceptanceCoverage`, not by a second
query, so "closed" has exactly one definition. Two consequences worth keeping:

- **Fail closed.** A criterion no contract declares can never close, so it
  counts as open. A typo in `requiresClosed` blocks the gate loudly instead of
  silently disabling it.
- **Only a claim of success is gated.** `failed`, `blocked`, and `running` are
  always accepted — that is the honest reporting the refusal steers toward, so
  blocking it too would push an agent into working around the gate.

The refusal is a `{ kind: "gate_conflict"; openCriterionIds }` variant of the
write outcome (a mixed `string | object` union, narrowed with
`typeof outcome !== "string"`), so the agent is told what to close instead of
guessing. Coverage exposes the same set as `openGates`: the readable side of the
refusal, so a campaign can see what it is waiting on without tripping the guard.

Two mutation checks confirmed the tests bind: `false && …` on the guard, and
dropping the `status === "succeeded"` restriction. Both were caught, so the
"honest reporting is allowed" assertions hold as well as the refusal ones.

## Approval is a different record than the amendment

Declaring a change is not authorizing one. A declared amendment is now
**accepted but inert**: stored, readable, listed as `pendingAmendments`, and not
what coverage measures. It becomes the contract only when an approval exists.

Why this is a real gate rather than another self-attestation: the workflow
worker's tool list is exactly `["bb_workflow_checkpoint", "bb_workflow_result"]`
(`server.ts`), so an approval reachable only through the UI RPC and the CLI is
structurally outside the path a drifting workflow can use. This is still
tamper-**evidence** — an agent with shell access can reach the CLI — but the
approval names the thread it came from and the surface (`panel` | `cli`), both
set by the entry point and never by the caller's payload. A self-reported actor
string is exactly what this replaces.

- **Bound to the body, not just the ID.** The approval stores
  `canonicalizeAcceptanceCriteria` of what was approved, so approving one set of
  criteria cannot bless a different set republished later under the same
  checkpoint ID. The canonical string is stored rather than a hash to keep
  `node:crypto` out of a module the browser bundle reaches.
- **Approvals live outside the checkpoint ledger** (`workflow_acceptance_approvals`,
  campaign-scoped, `ON CONFLICT DO NOTHING` so clicking twice is one approval).
  Putting them in the ledger would put them back on the surface the worker
  writes to.
- **`approvals` is a required parameter** of `deriveAcceptanceCoverage`. A
  default would let a forgetful caller report every amendment as pending — a
  wrong answer that looks like a working one.
- **Rows are parsed on read** (`acceptanceApprovalSchema.safeParse` per row,
  invalid rows dropped). A dropped row makes the amendment pending again, which
  is the safe direction: an unreadable approval must not read as consent.
- **A pending amendment still counts as "seen"** for a later amendment's
  `supersedes`. It is a real, readable checkpoint, and approving the later one
  approves the body it carries.
- **The gate guard reads approvals too**, for the same reason coverage does:
  otherwise a gated run could open its own gate by publishing an amendment that
  deletes the criterion it is stuck on.

One deliberate strictness: an **approved narrowing does not by itself open a
gate** whose `requiresClosed` still names the dropped criterion. The criterion
is now undeclared, and fail-closed says undeclared can never close. The plan has
to be restated without that requirement, so both the contract change and the
gate change are on the record. Tested on both sides
(`workflow-coverage.test.ts`, `data.test.ts`).

## Still deferred, with reasons

- Composer status line and precondition budgets: unbuilt by design.
