# Artifact Review Service Build Context Packet

Status: active; architecture revision 2 human-approved
Last updated: 2026-08-26
Current phase: shakedown build; deliver the accepted local-single-owner MVP
Architecture decision: `thr_izyqi5c7pj:2026-08-26:artifact-review-revision-2-approved`
Red-team gate: revision-2 clearance approved; fresh preflight still required before mutation
Execution envelope: intake workflow; at most 8 sections / 60 worker calls; one deterministic owner correction and one patch repair per unit

## Objective

Complete the BB workflow artifact-review service in this worktree: preserve and
review campaign requirements, architecture, and decisions; discuss them with a
durable campaign steward; and propagate accepted material changes through an
architect-owned redesign/decomposition path without allowing stale work to
promote.

## Decisions And Constraints

- The accepted design is `.architect/design-lab/workflow-artifact-review.md`.
- This is a local-single-owner beta. Server code assigns `local-owner`; shared-host mutation stays disabled until BB supplies a host-attested principal and permission.
- Canonical artifact authority is the workflow run's origin campaign/project/environment. A visible same-server presentation thread is an access grant and UI mount; its own project/environment never replaces origin scope.
- Authorized presentation UI actions enter the artifact/change controller. They do not grant the presentation thread the generic run-stop RPC; confirmed admission may invoke the controller's internal whole-run interlock.
- Cross-environment campaign continuation and source migration are out of the MVP. A cross-environment presentation may mount origin-scoped snapshots without creating a new continuation scope.
- Migration corrections are append-only once a statement may have run anywhere, including ephemeral tests, another checkout or host, or a mixed-version shared data directory. The artifact statement has run in tests, so its correction mode is already decided: use later additive/rebuild statements even if it is absent from this machine's durable ledger. Integrity checks block on artifact-table violations and log unrelated legacy violations; no destructive legacy cleanup is authorized.
- The shared review component has one explicit host owner spanning `packages/plugin-sdk` and `apps/app`. Terminal workflow writers must be consolidated before the shared snapshot/interlock predicate is installed.
- Canonical artifacts are Markdown. HTML is preview-only and network-denied; HTML selection/commenting is out of the MVP.
- Human acceptance creates `accepted-pending-impact`; it does not admit a new build contract.
- The orchestrator invokes architecture assessment and decomposition. The architect cohort/lead owns redesign reasoning; the orchestrator does not invent the redesign.
- Every scheduled call, result, verification receipt, and promotion decision is bound to an immutable contract snapshot and transition sequence.
- Existing dirty changes on `feature/workflow-detail-ledger` are part of this workstream. Preserve them and do not rewrite unrelated files.
- Durable artifact storage is already implemented, uncommitted, in `plugins/workflows/src/artifact-storage.ts`; extend it rather than replacing it.

## Constraint Descent

- Hard facts: workflow plugin RPC has local-origin authentication but no human principal; plugin SQLite is durable; `ThreadChat` is reusable; Docs and inline-vis UI/RPC are plugin-private; current workflow cancellation is whole-run.
- Derived constraints: resolve the presentation/run access grant, derive canonical campaign/project/environment from the run origin, and bind the presentation-thread grant plus immutable revision; use immutable blobs and revision FKs; acknowledge `Saved` only after commit; use CAS plus an apply-intent reconciliation saga for source writes.
- Assumptions: the shared plugin-SDK artifact-review renderer can be added without importing Docs internals; workflow settlement/promotion paths can share one transactional snapshot/interlock predicate.
- Foundational limitations: no live multi-host synchronization, portable export/import, arbitrary HTML annotation, multi-user mutation, or selective call abort in MVP. Urgent/unacknowledged material changes conservatively stop the whole run.

## Current Map

- `plugins/workflows/src/artifact-storage.ts`: verified SQLite profile and dark artifact tables.
- `plugins/workflows/src/data.ts`: append-only workflow migration ledger.
- `plugins/workflows/src/service.ts`: workflow run/call lifecycle and promotion boundaries.
- `plugins/workflows/src/server.ts`: plugin startup, RPC authorization, agent tools.
- `plugins/workflows/src/ui-contract.ts`: strict frontend RPC schemas.
- `plugins/workflows/src/app.tsx`: campaign inspector and future Artifacts panel entry.
- `packages/plugin-sdk/src/app-contract.ts`: shared plugin UI contract.
- `packages/plugin-sdk/src/app.tsx`: shared frontend exports/host components.
- `apps/app`: host rendering owner for the new shared `experimental_ArtifactReview` component; targeted files must be enumerated by the UI unit before mutation.
- `plugins/side-chat`: durable hidden-thread + `ThreadChat` reference.
- `plugins/docs` and `plugins/inline-vis`: capability references only; do not import their private internals.

## Interface Contracts

- U1 Artifact repository: authorized campaign scope + immutable bytes -> verified blob/revision registry; owns ingest/list/read/history.
- U2 Review mutations: authorized scope + revision-bound anchor/draft/decision + scoped idempotency -> commit-confirmed result; owns annotation/draft/decision state.
- U3 Source apply: accepted suggestion + source/revision CAS -> prepared/write/verify/finalize intent; owns crash reconciliation and explicit conflict states.
- U4 Review surface: workflow campaign -> artifact cards -> shared Markdown review component + comments/history + campaign `ThreadChat`.
- U5 Steward: first discussion -> one campaign-scoped durable hidden thread; receives compact artifact/version/decision deltas and remains advisory.
- U6 Change controller: accepted non-editorial candidate from an authorized presentation grant -> architecture assessment -> decomposition -> human confirmation -> atomic revision/graph/sequence/interlock/outbox admission; may request the internal whole-run interlock but does not extend direct stop RPC authority.
- U7 Worker adoption: durable call/work target -> ordered delta delivery -> server-derived acknowledgement -> consolidated terminal writer -> settlement/promotion predicate; owns stale evidence and controller-invoked whole-run fallback.

Revision-2 preflight deltas that are already authorized and must be absorbed by
the oracle and owning units, rather than reopened as human choices:

- Correct the dark artifact schema through a later append-only rebuild so the
  presentation-thread grant is carried as data rather than artifact identity,
  and actor keys are service-derived without a `local-owner`-only table CHECK.
- Run artifact-scoped integrity checks after migration; log unrelated legacy
  violations and gate artifact RPC only.
- Add an idempotent scope backfill plus a fail-closed guard for mixed-version
  workflow rows with null campaign/presentation fields.
- Restrict plugin CLI whole-run stop to the origin controller thread.
- Include restart recovery, replay upsert/read, failed-to-queued retry, run
  settlement/cancellation, and all call terminal writers in consolidation
  before installing the snapshot/interlock predicate.
- Add contract snapshot identity conditionally so feature-off replay identity
  remains compatible.

## Transition / Rollout Rows

- Artifact storage schema -> dark/off by absence of service and RPC consumers -> migration/restart tests.
- Artifact service/RPC -> local-owner only -> scope/idempotency/CAS tests.
- Review UI/steward -> explicit test campaigns -> rendered interaction and restart persistence proof.
- Live change controller -> definition-level `workflowArtifactLiveChanges` off by default -> fault/race matrix before enablement.
- Selective abort, multi-host sync, export/import, and multi-user editing -> deferred separate designs.

## Acceptance Closure

- Existing-database migration and plugin reload preserve prior workflow rows.
- Restart after every acknowledged review mutation reloads identical server state.
- Wrong origin campaign/project/environment, unauthorized presentation grant, or wrong revision cannot read or mutate an artifact by ID; presentation-thread scope is never accepted from the client as project/environment authority.
- Missing/damaged blob or digest mismatch fails closed.
- Comment anchors are revision-bound; failed re-anchoring becomes explicit `orphaned` state.
- Idempotency reuse with a different operation or digest is a conflict, never a false success.
- Apply-intent crash points resolve as finalized, retryable, awaiting source host, or conflict; never false `Saved`.
- Concurrent steward creation returns one winning campaign thread.
- User can open Requirements, Architecture, and Decisions from the workflow inspector and see revision/status/history/comments.
- Selected Markdown text can become a durable highlight/comment and can seed a bounded steward discussion.
- Accepted non-editorial feedback cannot directly steer workers; architecture assessment and decomposition precede admission.
- Old-snapshot dispatch/results/replay/checkpoints cannot settle or promote after an affecting admitted transition.
- Same-target transitions deliver and acknowledge in sequence; disjoint targets can proceed concurrently.
- Failed delivery/restart/reattachment remains durable and visible; no model polling loop is used.
- Urgent or expired material changes disclose and use whole-run stop until selective abort exists.
- Full workflows plugin tests/typecheck and rendered UI interaction matrix pass with no error-level console output.

## Anti-Churn Beta Policy

- Oracle owner must inventory the complete related acceptance closure before production units begin; an independent oracle reviewer must approve it.
- Acceptance tests assert contract/state-machine outcomes and fault classes, not the implementer's internal call shape. Do not add one assertion per discovered patch when a table-driven invariant covers the class.
- Each production unit runs implement -> independent review -> at most one bounded patch repair. No second repair owner is permitted in the same campaign revision.
- A repeated same-seam failure after repair, findings from multiple units against one assumption/interface, or any approach-level/dependency-deadlock finding routes to architecture synthesis.
- The architecture lead receives all material findings and returns one typed no-impact/delta/redesign/insufficient-evidence verdict before decomposition resumes.
- Critics may recommend redesign but do not patch, rewrite the plan, or command workers.
- Do not launch another broad critic unless the prior verdict caused a production change or architecture decision.
- Prefer prevention: stabilize schemas, authority boundaries, state transitions, and the full acceptance matrix before parallel production work.

## Read Budget For Agents

Must read:
- `.architect/context-packets/artifact-review-service-build.md`
- `.architect/design-lab/workflow-artifact-review.md`
- `.architect/inventory/workflow-artifact-review.md`
- the exact files and tests in the assigned unit

May inspect:
- `.architect/critic/feature-workflow-detail-ledger.md`
- `plugins/docs`, `plugins/inline-vis`, `plugins/side-chat`, and plugin-SDK declarations for cited boundaries

Do not read unless blocked:
- unrelated monorepo applications/packages, generated `output/`, Tempo Evals artifacts, or full conversation history

## Validation

- `pnpm --filter bb-plugin-workflows test`
- `pace-agent-runtime heavy --name artifact-review-typecheck -- pnpm --filter bb-plugin-workflows typecheck`
- targeted plugin-SDK/app/server tests for any shared host component
- rendered workflow-inspector interaction matrix with restart persistence and console capture

## Open Questions

- Revision 2 closes the presentation/origin authority, cross-environment continuation, migration, host-component ownership, and terminal-writer questions for the local-owner MVP. Surface another human gate only if implementation requires shared-host mutation, destructive migration, external credentials, cross-environment continuation, or widening the accepted scope.

## Stop / Replan Triggers

- One bounded repair fails to close a production unit.
- Two or more units report the same assumption/interface deficiency.
- A required host component or transactional interception point is demonstrably unavailable.
- An acceptance oracle contradicts an accepted design decision rather than an implementation detail.
- A proposed fix weakens snapshot binding, scope, durability, or architect-owned redesign authority.

## Handoff Prompt Stub

Use this packet as source of truth. Work only on the assigned unit and owned
paths. Read the accepted design and relevant code ranges, not the full history.
Return exact changes, fresh verification evidence, unresolved risks, and any
design signal. After one patch repair, escalate rather than continuing to
micro-patch.
