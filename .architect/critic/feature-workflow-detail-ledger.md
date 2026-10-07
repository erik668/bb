SHA: e2b88b053c1e9823e56d71e7f7861fd351d94d5d
VERDICT: PASS
CRITIC: codex-live-change-propagation-critic-20260824-r2

# Independent live-build change-propagation design re-review

I am a different agent instance from the design author. This verdict is bound to
the base SHA above plus the complete tracked worktree diff and the two untracked
artifact-review documents, excluding this report and generated `output/`. That
reviewed material has combined SHA-256
`0a536d806f594481cae916c620cd64ac195c20fdcfda380fbb202c7a84011629`.

Finding count: 0 blocking / 0 warnings / 0 nits.

The repaired design is implementation-ready as a proposed, off-by-default live
change-control contract. The steward remains advisory; artifact acceptance is
separate from build-contract admission; a deterministic campaign controller
atomically installs revision, graph, scheduler, result, delivery, and promotion
barriers; and workers acknowledge exact per-call snapshot edges. The design no
longer treats chat delivery, bounded inspector data, model classification, or an
ephemeral wake as proof of adoption.

## Prior finding resolution

### Candidate revision and transition admission are one fail-closed boundary — PASS

- **Lens:** distinguished-engineer-review / authorization ordering
- **Location:** `.architect/design-lab/workflow-artifact-review.md:30-31,119-143,192-220,352-435`
- **Result:** Applying a suggestion produces immutable
  `accepted-pending-impact` bytes without changing the active contract. In V1,
  every non-editorial change requires the human to confirm the synthesizer's
  class, canonical affected closure, and action. The controller then recomputes
  the closure and live call states from the normalized campaign registry and, in
  one sequence/revision-CAS transaction, admits the artifact revision, increments
  transition sequence, installs interlocks/staleness/promotion barriers, and
  writes delivery outbox rows. A conflict commits none of those effects.

### Call execution state and contract interlock are orthogonal — PASS

- **Lens:** code-review / code-standards #1 / active-idle concurrency
- **Location:** `.architect/design-lab/workflow-artifact-review.md:437-464`
- **Result:** The design explicitly avoids adding `change-pending` to the current
  execution-status enum. Per-`(changeId, callId)` interlocks preserve a structurally
  running worker while one shared transactional predicate gates every checkpoint,
  structured result, idle fallback, replay, recovery, settlement, and promotion
  path. If settlement wins the admission race, its old evidence becomes stale; if
  admission wins, later old-snapshot output is retained as rejected/stale evidence
  but cannot settle. An adopted acknowledgement advances the exact call snapshot
  edge without ending the worker.

### Per-target snapshot and delivery ordering are closed under concurrent changes — PASS

- **Lens:** code-review / concurrency / replay safety
- **Location:** `.architect/design-lab/workflow-artifact-review.md:449-464,515-559`
- **Result:** Interlocks form an exact chain per affected call. A same-target N+1
  uses N's target as its prior edge even if N is not acknowledged; a disjoint
  intervening change may be bridged without inventing adoption. The dispatcher
  claims only the lowest unsettled sequence per durable `{callId, workItemId}`
  target, so N+1 cannot overtake N while disjoint targets still progress. V1 never
  coalesces. An acknowledgement accepts the interlock target as an admitted edge
  in the immutable campaign chain and requires campaign high-watermark only to be
  at least that sequence, so a later admitted change does not invalidate a valid
  acknowledgement of N.

### Worker and human mutation identity are derived from trusted boundaries — PASS

- **Lens:** authorization boundary / OWASP A01
- **Location:** `.architect/design-lab/workflow-artifact-review.md:30-31,174-190,397-424,488-514`;
  `.architect/inventory/workflow-artifact-review.md:16,24-25`
- **Result:** Local-single-owner V1 assigns `local-owner` server-side and disables
  shared-host mutation until host-attested principal/edit permission reaches RPC
  handlers. The worker acknowledgement input contains only the change claim,
  expected sequence/prior digest, outcome, and bounded explanation. The server
  starts from trusted tool-call `ctx.threadId`, loads the subject before checking
  scope, and derives call/run/thread/work IDs. It requires the exact lowest pending
  interlock and snapshot edge. Unique receipt identity distinguishes an exact
  idempotent retry from a conflicting outcome or snapshot.

### Lost wakes, restart reattachment, and failed delivery fail closed — PASS

- **Lens:** capability inventory / operational recovery / factuality-claim-review
- **Location:** `.architect/design-lab/workflow-artifact-review.md:151-160,515-548,590-599`;
  `.architect/inventory/workflow-artifact-review.md:14-15,21-25`
- **Result:** The design no longer claims a durable host subscription. Durable
  interlock/outbox rows are authoritative; a process-local post-commit notifier
  only reduces latency, while startup drain and a bounded background-service timer
  recover missed wakes without a model polling loop. At-least-once delivery uses
  leased rows, bounded retry, visible blocked/dead-letter handling, and idempotent
  change identity. The durable address is call/work item, and each attempt resolves
  the current active child thread, allowing plugin restart to reattach a call
  instead of sending forever to an obsolete thread. Queued and terminal targets
  remain barriered or route through stale/replan handling.

### Rollout scope is bounded and reversible — PASS

- **Lens:** distinguished-engineer-review / simplify / standing constraints
- **Location:** `.architect/design-lab/workflow-artifact-review.md:561-599`
- **Result:** `workflowArtifactLiveChanges` is a definition-level gate that is off
  by default. Four monotonic implementation changes separate dark schema/recovery,
  snapshot and settlement enforcement, delivery/acknowledgement, and UI/steward
  enablement. Live steering remains disabled until the fault/race matrix passes.
  Selective call abort/requeue is explicitly deferred; urgent or unacknowledged V1
  changes conservatively stop the whole run and resume in the campaign, with that
  scope disclosed in the UI.

## Requirement conformance

- **Requirement quoted verbatim:** “I'm unsure what the best way to handle passing
  information from the design artifact stewards should look like back to the
  workflow orchestrators. Refinements, changes in requirements, etc should be
  communicated down the chain during a live build”.
- **Verdict:** honored as a proposed design. The steward sends a structured
  advisory proposal, not an imperative model-to-model message. Human-confirmed
  candidate changes become one atomic campaign transition. Pending work is rebuilt,
  active work receives bounded versioned deltas and must acknowledge a safe-point
  outcome, completed evidence remains historically true but can become stale, and
  the orchestrator receives compact durable transition records without polling the
  steward conversation.

## Capability and authority audit

- **Inventory:** Existing dependency checkpoints, transition evidence, active
  thread steering, whole-run cancellation, internal per-agent abort controllers,
  run-level service cancellation, ephemeral realtime, restartable background
  service, and durable SQLite are distinguished from the proposed normalized work
  registry, artifacts, controller, outbox, change point, and acknowledgement.
- **Scoping:** Artifact, transition, interlock, outbox, and acknowledgement lookup
  is constrained by campaign, project, environment, presentation thread, call,
  work item, revision, and transition sequence as applicable.
- **Ordering:** Subjects are loaded from trusted thread context before worker
  authorization. Candidate content stays inactive until atomic admission. Result
  races, concurrent transitions, outbox retries, and acknowledgements have explicit
  deterministic order.
- **Who may mutate:** The steward cannot admit or redirect. Local human mutation is
  server-attributed; multi-user mutation remains disabled. The controller enforces
  a human-confirmed proposal but does not grant semantic authority to the model.
- **Concurrency:** Revision/sequence CAS, canonical closure recomputation,
  per-change/per-call interlock chains, target-local delivery order, unique
  receipts, idempotent retries, and immutable stale evidence close the reviewed
  race surface.
- **Destructive/egress:** No new broad deletion, credential flow, or external
  egress is introduced. Whole-run cancellation is the explicit conservative V1
  safety fallback, not an implied selective stop.

## Independent verification

- Inspected the current design and inventory plus the current workflow service,
  data, cache, runtime, plugin RPC, realtime/background-service, and thread-send
  boundaries cited by the review.
- Recomputed the complete reviewed-content hash after the final admission,
  acknowledgement, sequence-chain, outbox, restart, and rollout repairs.
- `git diff --check` passed for the two reviewed design/inventory documents.
- Unchanged production tests were intentionally not rerun for this design-only
  delta.

## What this review did not cover

- I did not claim the proposed artifact schema, campaign registry, controller,
  interlocks, outbox, acknowledgement tool, change point, UI, or selective abort
  is implemented.
- I did not rerun unchanged code tests, execute destructive restart/power-loss
  experiments, or assess provider/model output quality and cost.
- I did not re-review the already-reviewed exact-DAG implementation or visual
  artifact-review UI fidelity except where their contracts constrain this live
  control plane.
