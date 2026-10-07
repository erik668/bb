# Workflow Artifact Review Design Lab

Architecture revision: 2  
Human approval: `thr_izyqi5c7pj:2026-08-26:artifact-review-revision-2-approved`

## Current Objective

Make a workflow campaign reviewable and steerable from one place: show the
actual build dependencies, preserve the original requirements and architecture
as versioned artifacts, support anchored human review, and provide a durable
artifact-aware discussion agent without adding noise to the main orchestrator.

## Decisions Accepted

| Decision | Rationale | Status |
| --- | --- | --- |
| Draw actual `dependsOn` connectors, not a generic layer arrow. | A layer arrow visually implies all-to-all dependency semantics that the data does not contain. | accepted |
| Scope important artifacts to the workflow campaign/workstream, not an individual run. | Requirements and architecture must survive continuation workflows and redesign loops. | accepted |
| Keep editable source artifacts in ordinary files, but copy every admitted revision into workflow-owned content-addressed storage. | Paths and hashes detect drift but cannot recover old bytes. Immutable blobs preserve exactly what the workflow admitted across edits and worktrees. | accepted |
| Persist all substantive review state in the workflows plugin's local SQLite database, never only in browser memory or Web Storage. | Highlights, comments, suggestions, drafts, revision choices, and steward linkage must survive app reloads, plugin reloads, clean shutdowns, and crash recovery. | accepted |
| A review mutation is “saved” only after its SQLite transaction commits. | Optimistic UI can improve responsiveness, but acknowledging an uncommitted highlight or edit creates false durability. | accepted |
| Bind idempotency to the authorized scope, actor, operation kind, and canonical request digest. | A bare client mutation ID can be reused for different content and falsely acknowledge the wrong result. | accepted |
| Apply source-file suggestions through a durable intent/reconciliation state machine. | Filesystem CAS and SQLite cannot commit atomically; a prepared intent makes every crash point recoverable without silently changing the admitted contract. | accepted |
| Retain all referenced review state by default; purge only through an explicit confirmed operation. | Automatic cleanup must never delete a blob or revision still referenced by a draft, annotation, decision, steward message, or retry result. | accepted |
| Use Markdown as the canonical review format; allow optional network-denied sandboxed HTML or structured React views as presentations. | Markdown gives stable text and diff semantics. Arbitrary HTML is useful for diagrams and simulations but is a poor canonical comment anchor and must not gain an egress path to artifact contents. | accepted |
| Treat comments and suggestions as review records, not immediate edits. | A comment should not silently change the contract underneath executing agents. | accepted |
| Create one durable artifact-steward thread per campaign. | Reusing one thread preserves discussion continuity without repeatedly forking large main-orchestrator context. | accepted |
| Send compact artifact/version/decision deltas to the steward thread. | The steward should not reread the entire campaign or inherit the main thread on every turn. | accepted |
| Keep the steward advisory; route accepted changes through a durable campaign-change controller. | A discussion agent should not directly redirect workers. The controller sequences changes, enforces scope and revision barriers, and survives when no orchestrator model is currently running. | accepted |
| Bind every dispatched work call, checkpoint, result, and verification receipt to a contract snapshot and campaign transition sequence. | Delivery is not adoption. Revision binding makes stale work mechanically detectable after requirements or architecture changes. | accepted |
| Require affected live workers to acknowledge an admitted change at a safe point. | A durable acknowledgement records whether the worker adopted the delta, is blocked, or must stop; a sent thread message alone is insufficient evidence. | accepted |
| Use severity-aware live propagation. | Clarifications can flow at the next safe point, contract changes pause affected scheduling, and urgent safety/security invalidations stop affected calls immediately. | accepted |
| Separate human acceptance from workflow admission. | A revised artifact first becomes `accepted-pending-impact`; the controller later admits the revision, transition sequence, scheduler interlocks, and delivery outbox in one transaction so no worker can observe a new contract without its barrier. | accepted |
| Make an architect cohort—not the workflow orchestrator—the owner of material design-impact and redesign reasoning. | The orchestrator should route a change into architecture assessment, preserve its evidence, and later dispatch an approved decomposition. It must not silently invent the new architecture or collapse cross-arm criticism into local repair. | accepted |
| Launch artifact mutation as local-single-owner. | Plugin RPC currently attests local origin but not a human principal. V1 assigns a server-side `local-owner` actor and must not enable shared-host mutation until host-attested principal/permission context exists. | accepted |
| Any accepted requirements or architecture revision creates a new immutable revision and an impact-analysis transition. | Historical claims remain attributable; affected work can pause, continue, or route through redesign explicitly. | accepted |
| Introduce a shared host-owned artifact-review component rather than importing Docs or inline-vis internals. The owner spans `packages/plugin-sdk` and the host app surface in `apps/app`. | Plugin panel actions and RPC are private to their owning plugin. `ThreadChat` is reusable today; an annotation-capable document surface is not. | accepted design direction; platform API and host-app owner required |
| Bind artifact authority to the workflow run's origin campaign, project, and environment. Treat the visible presentation thread as a same-server access grant and UI mount, not as the source of project/environment scope. | Cross-project/environment presentation is intentional, but deriving artifact authority from the presentation thread would make scope depend on where the card is rendered. | accepted in revision 2 |
| Permit local-owner review mutations from an authorized presentation surface only through the artifact/change controller. Do not grant that thread the generic run-stop RPC; the controller may invoke the internal whole-run interlock after confirmed admission. | Review actions need a consistent authority path without making an unrelated presentation thread equivalent to the workflow origin thread. | accepted in revision 2 |
| Defer cross-environment campaign continuation and shared mutable review history from MVP. A presentation in another environment may mount the origin-scoped campaign, but it does not create or migrate a continuation campaign or source binding. | The current campaign model is keyed by origin project/environment and rejects an unknown campaign in another environment. | accepted in revision 2 |
| Keep the host migration ledger append-only once any statement may have run. "May have run" includes ephemeral tests, another checkout or host, and mixed-version access to the shared data directory; absence from this machine's durable ledger does not authorize an in-place edit. Correct dark schemas with later additive/rebuild statements and use artifact-scoped integrity checks; never delete unrelated legacy rows to make startup green. | Index-based migration identity cannot safely detect edits to an applied statement, and destructive legacy cleanup is outside the approved MVP. | accepted in revision 2; correction mode is append-only |
| Consolidate terminal workflow writers behind one transactional settlement entry point before installing the snapshot/interlock predicate. | Terminal writes currently occur through several paths, including restart recovery; a shared predicate is sound only when every writer uses it. | accepted in revision 2 |

## Open Questions

| Open question | Why it materially changes the design | Options | Decision owner | Status |
| --- | --- | --- | --- | --- |
| Where should editable source artifacts live by default? | Determines portability and who may propose edits; admitted snapshots are separately preserved. | repo `.architect/`; thread storage; Docs vault | human + architect | recommend repo `.architect/` when a worktree exists, thread storage otherwise |
| Are requirements and architecture directly editable after campaign admission? | Direct edits can invalidate active work without an explicit transition. | comments only; suggestion/apply; unrestricted edit | human | recommend suggestion/apply with version bump |
| What is the minimum artifact set? | Too many mandatory documents recreate early audit drag. | requirements + architecture; add decisions; add verification strategy | human | recommend requirements, architecture, decision log |
| Can the steward mutate files? | Changes the risk and permission model substantially. | read-only advice; prepare patch; auto-apply | human | recommend read-only by default, explicit “apply suggestion” action |
| When does feedback force redesign? | Determines whether comments merely create repair work or invalidate the approach. | human-only flag; orchestrator judgment; architect-cohort assessment + human confirm | architecture lead + human | route every non-editorial accepted candidate through architecture triage; require human confirmation for material design deltas or redesign |
| How should comments re-anchor after edits? | Pure byte offsets become stale immediately. | line range; block id; quote + context fingerprint; semantic AST path | architect | recommend block id + quote/context fallback, surface orphaned comments |
| Should arbitrary HTML participate in selection/commenting? | Opaque-origin iframes cannot safely share normal DOM selection with the parent. | preview-only; controlled `postMessage` review protocol; same-origin | architect/security | recommend preview-only initially; controlled protocol later |
| Should the steward be one thread per artifact or one per campaign? | Per-artifact threads isolate context but fragment cross-artifact reasoning. | per artifact; per campaign; campaign manager + artifact children | human | recommend one per campaign initially |
| What happens to executing nodes after an accepted revision? | Continuing blindly may waste work; stopping everything harms throughput. | stop all; deterministic impact closure; human-selected pause set | architecture lead + controller + human | architect proposes the semantic closure/action; controller recomputes and enforces the dependency closure; human may widen or stop it |
| What long-term retention policy should replace the safe default? | Indefinite local retention grows storage, but cleanup affects auditability and retry safety. | project retention; archive after export; explicit purge only | human + platform | MVP default: no automatic deletion; explicit confirmed purge only, with reachability checks |
| May a continuation in a different environment edit the original source file? | The source path may resolve to different bytes or a different checkout. | snapshot-only review; explicit source migration; verified same repo/commit | human + orchestrator | resolved for MVP: cross-environment continuation is out of scope; a presentation mount does not migrate source authority |
| Should durable review state synchronize between BB hosts? | Local shutdown durability does not imply multi-machine replication, and silent multi-writer sync changes identity, conflict, and authorization semantics. | local-only; explicit portable export/import; encrypted host sync | human + platform | recommend local authoritative storage plus explicit export/import first; design host sync separately |
| How aggressively should working drafts autosave? | Per-keystroke durable writes are wasteful, while long debounce windows expose more unsaved typing during abrupt power loss. | per operation; short bounded debounce; manual save | product + platform | recommend short bounded debounce, visible Saving/Saved/Failed state, and flush before artifact/revision transitions |
| Which changes require another human confirmation after artifact acceptance? | Accepting revised text authorizes the contract, but the proposed affected-node set or stop policy may still be surprising. | always confirm; only approach-level/large closure; never confirm | human + architecture lead | V1 confirms every non-editorial architecture assessment/decomposition; consider deterministic bounded/local automation only after observing the gated rollout |
| How long may an affected live worker defer acknowledgement? | Waiting forever runs stale work; immediate cancellation wastes recoverable progress. | fixed timeout; phase-specific timeout; orchestrator-selected deadline | platform + orchestrator | recommend phase-specific deadline with immediate stop for critical invalidations |
| May several accepted changes coalesce into one worker packet? | Coalescing reduces interruptions but can obscure causality and acknowledgements. | never; only before delivery; contiguous sequence range | architect | no coalescing in V1; design an explicit multi-change packet/ack contract later if usage justifies it |
| When may shared-host users mutate artifacts? | Local-origin RPC is not user identity or edit authorization. | remain single-owner; add host RPC principal/permissions; plugin-managed accounts | platform + security | disabled until a host-attested principal and edit permission reach plugin RPC handlers |

## Claim / Evidence Register

| Item | Current stance | Evidence | Confidence | Promote? |
| --- | --- | --- | ---: | --- |
| BB can display rich Markdown and sandboxed HTML in side panels. | supported now inside the owning plugins | Docs and inline-vis plugin implementations | 0.98 | yes, with private-boundary caveat |
| BB can host a persistent separate agent conversation. | supported now | Side Chat durable hidden fork + host `ThreadChat` | 0.98 | yes |
| BB can capture exact selected chat text. | supported now | plugin message-action contract | 0.99 | yes |
| BB currently supports inline artifact comments. | false | capability inventory found no annotation model | 0.95 | yes |
| Existing HTML previews are safe canonical comment surfaces. | false | opaque-origin iframe intentionally isolates DOM | 0.95 | yes |
| Workflow checkpoints currently carry requirements/architecture artifacts. | false | strict four-kind checkpoint union | 0.99 | yes |
| Workflows can directly embed the Docs editor or inline-vis directive. | false | panel actions and RPC target the same owning plugin; neither exposes a shared component | 0.99 | yes |
| BB can persist workflow-owned structured review state across process restarts. | supported host capability, artifact schema not implemented | plugin-owned file-backed SQLite at `<dataDir>/plugins/workflows/data.db` | 0.98 | yes, with proposed-new schema caveat |
| Artifact highlights/comments currently survive restart. | false | capability inventory found durable storage but no artifact annotation tables or RPC | 0.99 | yes |
| Existing transition checkpoints can enforce a live design change. | false | transition rows are durable evidence but do not pause, steer, or invalidate calls | 0.99 | yes |
| Existing thread steering proves a worker adopted revised requirements. | false | `threads.send` can deliver a corrective turn but has no contract revision or acknowledgement receipt | 0.99 | yes |
| Existing workflow runtime can selectively restart one affected call. | false | one AbortController is owned per run; call-level invalidation/requeue is absent | 0.98 | yes |

## Risks And Reviewer Concerns

- A mutable source document without preserved admitted bytes lets agents reason
  from different contracts and makes earlier workflow evidence unrecoverable.
- Automatically injecting the entire main thread into the steward recreates
  the context-spend problem this surface is intended to solve.
- Comments anchored only to line numbers will drift; silent mis-anchoring is
  worse than showing an explicit orphan.
- An architecture comment must not default to a local repair. Accepted
  approach-level feedback should route to impact synthesis and the redesign
  gate before implementation resumes.
- Interactive HTML must stay opaque-origin, receive no workspace or BB
  credentials, and execute under a preview CSP/host policy that denies network
  egress (`default-src 'none'`; narrowly validated local script/style assets
  only). Opaque origin alone does not prevent artifact bytes from being sent
  through `fetch`, images, forms, or navigation. A future selection bridge
  should use a narrow validated `postMessage` contract. Preview tests must
  prove external requests, top navigation, and form submission are denied.
- The review system should not make polished artifact generation a universal
  admission blocker. Artifact requirements should be lifecycle- and
  risk-profile-aware.
- Every read/write must resolve the presentation-thread/run access grant, then
  derive campaign, project, and environment from the workflow run's origin
  scope and require the exact artifact revision. Presentation-thread
  project/environment values never replace the origin scope. A bare artifact
  ID, campaign ID, or client-supplied scope is insufficient.
- Accept/apply must compare-and-swap the current admitted revision. Concurrent
  first discussion must use a unique campaign steward constraint and return the
  winning thread rather than creating duplicates.
- Direct steward-to-worker messages are advisory and lossy as a control plane.
  The durable change row must exist before any push, and workers must acknowledge
  the exact contract snapshot before their later evidence can promote.
- A requirements change can stale completed implementation and verification,
  not only currently running descendants. Staleness must remain visible rather
  than overwriting earlier green receipts.
- Repeated small edits can thrash active agents. V1 keeps one packet and
  acknowledgement per change; future coalescing requires an explicit ordered
  multi-change contract rather than an implicit batching optimization.

## Design Threads

### 1. Campaign Artifact Registry

Each campaign exposes ordered artifacts such as `requirements`, `architecture`,
and `decision-log`:

```text
ArtifactRef
  id, campaignId, originProjectId, originEnvironmentId, presentationThreadId
  kind, title, contentType
  editableSource?: hostId + rootPath + relativePath + expectedSha256
  revision, blobSha256, createdAt
  status: draft | accepted-pending-impact | admitted | superseded
  producedByThreadId?, stewardThreadId?
```

Workflow-owned SQLite stores immutable content-addressed blobs keyed by SHA-256
plus append-only revision metadata. Ingest reads an editable source through
`bb.sdk.files.read` with explicit `hostId` and `rootPath`, enforces a size/type
limit, hashes the bytes, stores them transactionally, and reads them back for
digest verification before admitting the revision. Every review RPC first
resolves `{ presentationThreadId, runId }` through the existing workflow access
path. It derives the canonical campaign/project/environment scope from that
run's origin record and treats the presentation thread only as an access grant;
the presentation thread's own project/environment never becomes artifact
authority. Blob reads fail closed on missing bytes or digest mismatch.

Applying a human-accepted suggestion uses `bb.sdk.files.write` with the source
`expectedSha256`; a conflict creates no revision. After a successful write, the
server reads back, stores a new immutable blob, and appends an
`accepted-pending-impact` candidate with a compare-and-swap against the admitted
revision the human reviewed. The active admitted revision changes only in the
later controller transaction that also installs transition barriers.

### 2. Local Durability and Recovery

The workflows plugin's existing file-backed database at
`<dataDir>/plugins/workflows/data.db` is the authoritative local store. The
artifact feature adds append-only migrations for:

```text
artifact_blobs            immutable admitted bytes, keyed by SHA-256
artifact_revisions        ordered artifact history and source bindings
artifact_annotations      highlights, comments, suggestions, resolution state
artifact_working_drafts   autosaved editable text and its base revision
artifact_decisions        accepted/declined steering records
artifact_stewards         unique campaign-to-thread linkage
artifact_mutations        idempotency keys and committed outcomes
artifact_apply_intents    prepared/file-applied/finalized/conflict source edits
artifact_change_outbox    durable post-commit worker/orchestrator/UI deliveries
```

Every row carries the origin campaign/project/environment plus the authorized
presentation-thread grant defined above. A standalone highlight is an annotation with kind
`highlight`; adding a comment or suggestion advances the same durable record
rather than creating browser-only state. The steward conversation remains in
BB's durable thread store, while `artifact_stewards` preserves its scoped link.

One `initializeWorkflowStorage` routine must run immediately after
`bb.storage.database()` and before any migration or RPC registration. It sets
and reads back `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, and
the busy timeout. It then runs artifact-table-scoped foreign-key checks; a
mismatch, unsupported pragma, or artifact-table violation blocks artifact RPC
startup with a classified storage error. Unrelated legacy violations are logged
and remain outside this feature's authority; the artifact feature never deletes
legacy rows to make startup green. Any correction after a migration statement
may have run anywhere, including an ephemeral test database or another host, is
appended as a new migration. A statement's absence from the current machine's
durable ledger is not evidence that it is safe to edit in place. If a dark
schema shape must change, use later additive statements or replacement-table
copy/swap steps that preserve existing rows. An existing-database upgrade
fixture must prove this ordering.

Each SQLite-only mutation is one synchronous transaction. In local-single-owner
V1, the server assigns `actorKey=local-owner` for UI RPC; the client cannot
supply `principalId` or `acceptedBy`. Agent-tool mutations derive an actor key
from the host-attested tool thread/call context. The server first resolves the
presentation/run access grant and derives the origin
campaign/project/environment scope. Within that scope,
the idempotency identity is
`{ actorKey, campaignId, projectId, environmentId, presentationThreadId,
clientMutationId }`; the row also stores the operation kind and a digest of a
versioned, canonically encoded request. An exact operation/digest retry returns
the committed outcome. Reusing the scoped identity with a different operation
or digest returns a typed `idempotency_conflict` without exposing the prior
result. Completed keys remain reachable at least as long as their referenced
artifact revision or result. The server returns `saved` only after commit; the
client shows
`Saving`, `Saved`, `Conflict`, or `Failed` and treats optimistic state as
pending. Browser storage may cache presentation preferences, but it is never
the source of truth for artifact content or review records.

Applying a suggestion to an editable source uses a recoverable saga rather
than claiming cross-resource atomicity:

```text
1. prepare: authorize; verify base admitted revision and source-before hash;
   store target bytes as an immutable blob; commit an apply intent containing
   scope, actor, operation/digest, source-before hash, target hash, base rev,
   and that revision's immutable host/root/relative-path source binding
2. write: perform source CAS from source-before hash to target bytes
3. verify: read the source back and verify the target hash
4. finalize: in one SQLite transaction append an
   `accepted-pending-impact` candidate revision, record the source binding,
   and mark the intent/result finalized; the currently admitted revision does
   not change yet
```

Only one nonterminal apply intent may exist per artifact; a competing apply
returns `apply_in_progress` or a revision conflict. On startup and before any
new apply, reconciliation reads each nonterminal intent through its recorded
base-revision host/root/relative-path binding, never whichever editable source
binding is current later. Target hash means verify and finalize, source-before
hash means safely retry the CAS, and any other hash or unavailable binding
becomes a human-visible conflict or `awaiting_source_host` state.
Finalization also compare-and-swaps the currently admitted revision against the
intent's base revision; a mismatch becomes a conflict. The reconciler never
overwrites a third-party edit. `Prepared` and
`file-applied` are visible pending states, never `Saved`. A crash after finalize
but before the response is handled by the scoped idempotency record, which
returns the same finalized outcome once.

On plugin/app restart, append-only migrations run before artifact RPC starts,
SQLite performs WAL recovery, and the review surface reloads authoritative
state from the server. Blob reads recheck SHA-256 and fail closed on a missing
or damaged object. A draft remains separate from the admitted contract: its
autosave can recover local work without changing what running agents are
authorized to build. Promotion, redesign, archive, and source-migration actions
flush or reject pending draft writes before advancing state.
Source migration is also blocked while a nonterminal apply intent exists. The
human must first reconcile it against the recorded source binding or explicitly
reject it after proving the source still has the before-hash; migration never
retargets an in-flight intent to a new host, root, or path.

Clean shutdown closes the host-managed handle. Abrupt process exit or machine
power loss may discard only UI operations that were never acknowledged as
saved; committed records must survive.

The safe retention default is no automatic deletion for active or archived
campaigns. Foreign keys and reachability checks use `RESTRICT` semantics for
every blob/revision referenced by drafts, annotations, decisions, steward
links, nonterminal intents, or retained idempotency outcomes. Purge requires an
explicit human-confirmed campaign operation and must enumerate what will be
removed; no background quota job may silently weaken the guarantee.

Portable export/import is a separate `proposed-new` host/API capability, not
the host's internal plugin rollback snapshot. A later
`workflowArtifactExport` must take a transactionally consistent logical
campaign snapshot, write a versioned manifest plus referenced blobs through a
host-authorized destination, and verify every digest before reporting success.
Import must validate schema/scope and classify campaign/artifact/revision ID
collisions rather than overwrite. Until that contract ships, explicit purge
must not claim an export prerequisite is available. Copying a live database and
its WAL files independently is never a supported export. Multi-host live
synchronization remains a separate design.

Required fault-injection verification before launch covers: termination before
and after each SQLite commit; response loss after commit; restart with committed
WAL frames; idempotency-key reuse across scope, operation, and payload; every
apply-intent phase; plugin reload against an existing migrated database; and a
source-migration attempt while an apply intent is nonterminal. A logical
export/import round trip is also required once that optional capability ships. Each case
must settle as finalized, safely retryable, or an explicit conflict—never a
false `Saved` state or silent admitted-revision change.

### 3. Review Surface

The workflow page gains an `Artifacts` section with cards for Requirements,
Architecture, and Decisions. Opening one uses a full-height workflow panel:

```text
┌ Artifact title · revision · admitted status ───────────────┐
│ Document / structured architecture view │ Review sidebar  │
│                                          │ open comments   │
│ selected text / block highlight          │ steward chat    │
└────────────────────────────────────────────────────────────┘
```

The document half requires a proposed shared host-owned
`experimental_ArtifactReview` component that renders admitted Markdown bytes,
exposes stable block/selection anchors, and accepts annotation state and
callbacks. This is a new plugin-SDK capability; the workflow plugin cannot
import Docs components or call Docs RPC. File editing remains a separate
`FileLink`/preferred-opener action until that shared component gains an audited
editing contract. HTML is a preview-only, self-contained admitted blob in an
opaque-origin sandbox with host-enforced network denial and a restrictive CSP
(starting from `default-src 'none'`). It does not participate in selection
anchoring, cannot navigate the top frame or submit forms, and may load only
validated bytes from its admitted blob. The sidebar switches between comments,
revision history, and the already-shared host `ThreadChat`.

### 4. Annotation Contract

```text
Annotation
  id, campaignId, projectId, environmentId, presentationThreadId
  artifactId, artifactRevision
  anchor: blockId + start/end + exactQuote + prefix/suffix
  body, author, createdAt
  status: open | resolved | orphaned
  stewardThreadMessageId?
  resolution?: accepted | declined | superseded
```

New document revisions attempt deterministic re-anchoring. Failure produces an
`orphaned` annotation requiring human placement; it never silently attaches to
similar text.

### 5. Artifact Steward

The first artifact discussion creates one campaign-scoped thread in the same
workspace, with a compact context packet containing campaign objective,
artifact registry, current admitted hashes, DAG summary, and decision log. The
panel embeds that thread through host `ThreadChat`. Later artifact revisions or
accepted comments send bounded delta messages rather than full context forks.

The steward receives a scoped, read-only `workflowArtifactRead` tool (or the
equivalent host capability) that accepts the presentation-thread/run access
tuple plus artifact ID and immutable revision. The server resolves that tuple
through the same presentation/run grant as the panel and derives origin
campaign/project/environment from the run,
loads the content-addressed blob, verifies its SHA-256, enforces per-read and
per-turn byte limits, and returns bounded text blocks with stable block IDs.
It never resolves the mutable source path. A cross-project or cross-environment
presentation mount may discuss the origin-scoped admitted snapshot, but MVP
does not create a continuation campaign or migrate source authority. For a
selected-text discussion, the initiating
delta also includes the exact bounded quote and surrounding block IDs so the
first answer does not require a full-artifact read.

Creation is serialized by a unique origin-scoped
`(campaignId, originProjectId, originEnvironmentId, role=artifact-steward)` row.
Concurrent creators return the already-recorded thread. Each lookup rechecks
the presentation/run access grant and derives the same origin campaign scope.

The steward can:

- explain or critique selected text;
- identify cross-artifact contradictions;
- propose a comment, decision, or patch;
- classify likely impact as local, multi-unit, or approach-level;
- prepare an affected-node set for human confirmation.

It cannot silently revise admitted artifacts or instruct running workers to
change course.

The campaign owns the steward lifecycle. Completing or archiving a campaign
stops the worker runtime but preserves the thread and annotations under the
project retention policy; deletion requires an explicit campaign cleanup
operation after retention/export rules are decided.

### 6. Live Change Propagation

The steward-to-build boundary is a durable control plane, not a model-to-model
chat chain:

```text
comment / steward discussion
  -> structured change proposal (advisory)
  -> human accepts candidate revision (`accepted-pending-impact`)
  -> impact preflight compiles evidence + provisional affected closure
  -> orchestrator invokes architecture-impact section
       -> parallel architect/scout/critic lenses when material
       -> designated architecture lead synthesizes one assessment
       -> no design impact | bounded design delta | redesign | insufficient evidence
  -> orchestrator invokes decomposition section on the selected architecture
  -> human confirms material architecture/decomposition transition
  -> campaign controller atomically admits revisions + work graph + transition N + barriers
  -> orchestrator dispatches the admitted work-unit deltas
  -> scheduler barriers + worker delta packets
  -> worker acknowledgements / stale evidence
  -> continue | reverify | return to architecture
```

Authority stays separated:

| Actor | Authority |
| --- | --- |
| Artifact steward | Explain, critique, and propose a structured change; never redirect workers. |
| Human reviewer | Accept a candidate requirements or architecture revision and confirm material architecture, decomposition, or large/irreversible stop changes; acceptance alone does not admit the build contract. |
| Impact preflight | Compile steward comments, critic findings, changed blocks, likely semantic class, urgency, and a provisional affected closure. It is routing input, not a redesign decision. |
| Architect cohort | Assess assumptions, contracts, interfaces, invariants, alternatives, work-graph consequences, and verification consequences. Specialist arms may work in parallel and challenge one another's premises. |
| Architecture lead | Receive every material cohort finding, resolve or preserve dissent, and emit one typed architecture assessment and proposed artifact/decomposition delta. It owns the redesign proposal, not the orchestrator. |
| Decomposition section | Turn the selected architecture into explicit work units, dependency edges, interface contracts, and reverification obligations for admission. |
| Campaign controller | Non-model service that sequences durable changes, validates DAG closure, enforces barriers, delivers packets, and gates promotion. |
| Workflow orchestrator | Invoke architecture assessment and decomposition sections, provide bounded evidence packets, wait for their typed results, and dispatch only after approval/admission. It does not author or approve the redesign or decomposition itself. |
| Worker | Acknowledge the exact change/snapshot as adopted, blocked, or requiring stop; it cannot self-dismiss an admitted change. |

The architecture section returns a durable result rather than prose hidden in
the orchestrator context:

```text
ArchitectureChangeAssessmentV1
  sourceChangeId, baseContractSnapshot
  verdict: no-design-impact | bounded-design-delta
         | redesign-required | insufficient-evidence
  invalidatedAssumptionIds, affectedDecisionIds
  affectedContractIds, interfaceIds, invariantIds
  alternativesConsidered, selectedApproach?, rationale, dissent
  proposedArtifactRevisions
  proposedWorkGraphChanges, affectedClosureIds
  requiredReverification, stopOrContinueRecommendation
  evidenceRefs, confidence

DecompositionDeltaV1
  sourceAssessmentId, baseWorkGraphRevision
  addOrReviseWorkUnits, supersededWorkUnitIds
  dependencyEdges, interfaceContracts
  implementationAcceptance, reverificationObligations
  migrationOrder, evidenceRefs
```

For a local clarification, one architecture lead can return
`no-design-impact` quickly. For a cross-cutting change or corroborating signals
from several build arms, the orchestrator fans out bounded architecture lenses
in parallel and gives their complete material findings to one architecture lead
for synthesis. Critics identify failure modes and may recommend redesign, but
they do not independently rewrite the plan or command workers. The lead must
explain why patching is sufficient or produce revised architecture artifacts and
work-graph changes. `insufficient-evidence` pauses affected admission rather
than allowing the orchestrator to guess.

Fanout is policy-driven rather than an orchestrator-model preference. A
provisional `contract` or `architecture` class, findings from more than one work
arm, a changed shared interface/invariant, a closure above the configured bound,
or any critic recommendation for redesign requires the cohort path. The
orchestrator cannot downgrade that route; the human may always escalate a
smaller change into it.

Every scheduled call and every later checkpoint/result carries:

```text
ContractSnapshot
  requirements: artifactId + revision + blobSha256
  architecture: artifactId + revision + blobSha256
  decisions: artifactId + revision + blobSha256
  campaignTransitionSequence
```

Impact enforcement uses a proposed normalized campaign work registry, not the
inspector's bounded multi-run checkpoint view. Each logical unit has one
campaign-global `workItemId`, its current dependency edges, and aliases for the
run/checkpoint rows that report it. Continuation runs update that registry with
CAS/versioned transitions; duplicate local checkpoint IDs cannot collapse two
units. The controller computes closure over the complete registry and expresses
delivery targets as `{ campaignWorkItemId, runId?, callId? }`.

An accepted candidate creates an append-only record. In local-single-owner V1,
`acceptedBy` is assigned by the server as `local-owner`, never copied from RPC
input:

```text
CampaignChangeV1
  id, campaign/project/environment/presentation scope, admittedSequence?
  fromSnapshot, toSnapshot, sourceAnnotationIds, acceptedBy
  architectureAssessmentId, architectureVerdict, decompositionDeltaId
  semanticClass: editorial | refinement | contract | architecture
  urgency: normal | urgent
  changedBlockRefs, evidenceRefs, rationale
  directlyAffectedWorkItemIds, dependencyClosureIds
  activeIds, pendingIds, completedIds
  action: observe | continue-with-delta | pause-and-replan | stop-and-redesign
  status: proposed | accepted-pending-impact | awaiting-human
        | admitted | delivering | settled | conflict
```

The impact preflight may use a cheaper bounded model because it compiles and
routes evidence; its output is only provisional. Every non-editorial candidate
enters the architecture-impact section before admission. The designated
architecture lead should use the stronger architecture/planning model and see
all material cross-arm findings, not a positional truncation of them. In V1,
every non-editorial change requires the human to confirm the cohort's verdict,
affected closure, proposed artifact/decomposition delta, and action before
admission. Neither the preflight nor the orchestrator can make a change eligible
for propagation merely by labeling it a refinement. Editorial changes can
settle with no worker interruption; later automation requires deterministic
bounded-change rules.

Human acceptance alone leaves the candidate revision out of the active
`ContractSnapshot`. Once the architecture assessment, its proposed artifact
revisions, and required human confirmation are ready, one SQLite transaction
compare-and-swaps the prior artifact/transition versions,
recomputes the proposed affected closure and every pending/active/completed call
from the canonical work registry, marks the candidate revision admitted,
increments the campaign transition sequence, creates orthogonal contract-
interlock rows for affected calls, blocks pending scheduling/promotion on older
snapshots, and inserts durable delivery outbox rows. A conflict or changed work
state commits none of those effects and returns to synthesis. The preflight's
earlier scheduling view is never trusted as the admission-time scheduler state.

The interlock is not a new `workflow_calls.status`: current checkpoint, result,
idle, recovery, and settlement paths treat non-running statuses as terminal.
Calls remain structurally running while separate
`workflow_call_contract_interlocks` rows keyed by `(changeId, callId)` record
the required sequence, old/new snapshot, and `pending | adopted | blocked |
stop-required` state. A call's adopted transition high-watermark plus its
lowest pending sequence derives whether the contract interlock is clear. Every
tool, idle/result, replay, recovery, and promotion path uses one shared
transactional predicate over those rows. The contract snapshot is also part of
the workflow call/replay cache identity, so a prior result cannot replay across
an admitted revision.

Interlock snapshots form an exact chain per affected call. If sequence N+1
affects a call while N is unsettled for that call, N+1's `oldSnapshot` is N's
`newSnapshot`, not the call's still-adopted snapshot. If intervening admitted
changes were disjoint from the call, its next affected interlock may bridge from
the call's adopted snapshot directly to the then-current admitted snapshot. The
controller validates that chain while inserting interlocks; acknowledgement can
therefore advance only across the exact lowest unsettled edge without inventing
or skipping an affected transition.

The admission/result race has two explicit outcomes. If terminal settlement
commits first, admission rereads the call as completed and appends staleness for
its old-snapshot evidence. If admission commits first, later old-snapshot tool,
idle, or structured output is retained as rejected/stale evidence but cannot
settle the call. An `adopted` acknowledgement transaction advances the call's
snapshot/high-watermark and marks that exact interlock row adopted without
ending the worker.

It delivers a bounded packet containing the change ID, old/new snapshot,
relevant changed blocks, rationale, affected work item, and required action—not
the full steward conversation. The complete discussion remains linked by
reference.

Delivery policy depends on work state and urgency:

- Pending work is not started until its prompt/context packet is rebuilt on the
  new snapshot.
- Active work receives the committed interlock/outbox row before
  `threads.send(mode="steer-if-active")`. Thread delivery is an optimization;
  the interlock and outbox remain authoritative until acknowledgement.
- Normal refinements allow the worker to reach the next safe point. Contract or
  architecture changes leave its orthogonal contract interlock `pending` and
  prevent a stale success/result from settling it.
- Urgent safety, security, or integrity invalidations use a proposed call-level
  abort/requeue primitive immediately. Whole-run cancellation remains a last
  resort; current code does not yet provide selective call cancellation.
- Completed implementation and verification remain historically green for
  their old snapshot but become `stale` for the affected closure. Required
  rework/reverification is appended rather than rewriting prior evidence.

The worker responds through a proposed `bb_workflow_change_ack` tool. Its agent-
supplied input is deliberately narrow:

```text
ChangeAckInputV1
  changeId, expectedSequence, expectedPriorSnapshotDigest
  outcome: adopted | blocked | stop-required
  summary, blocker?
```

The server starts from the host-attested tool-call `ctx.threadId`, resolves that
child thread through `workflow_calls` to its call, run, campaign, project,
environment, presentation, and campaign work items, and derives those values in
the stored receipt. It does not accept `runId`, `callId`, `childThreadId`, or
`workItemIds` as authority from model input. The acknowledgement transaction
requires a matching pending `(changeId, callId)` interlock, the exact lowest
unsettled sequence for that call, the exact prior snapshot digest, and the
interlock's `newSnapshot` as an exact admitted edge in the immutable campaign
transition chain, with campaign high-watermark at least that edge's sequence.
It does not require that edge to equal the latest campaign snapshot when later
changes are already admitted. The same transaction advances the call high-
watermark to that exact edge. The stored receipt is unique on
`(changeId, callId, adoptedSequence)`: an exact repeat is idempotent; a different
outcome or snapshot is `ack_conflict` and settles nothing.

`adopted` permits continued work and subsequent evidence on the new snapshot;
`blocked` routes the packet back to orchestration; `stop-required` terminates
and replans that call. Acknowledgement has a phase-specific deadline. Missing
acknowledgement prevents promotion and eventually triggers selective stop;
urgent changes do not wait for the deadline.

Outbox delivery is at-least-once and restart-safe. The same admission
transaction inserts one ordered outbox row per durable `{callId, workItemId}`
target, never a child-thread ID as the lasting delivery address. A workflow
background service transactionally claims only the lowest unsettled sequence
for each target from pending or expired-lease rows. At every attempt it resolves
the call's current active `childThreadId`; this lets restart recovery reattach a
call without dead-lettering its change against an obsolete thread. A queued call
remains barriered until it is attached and its prompt is rebuilt; a call that
became terminal is reclassified through the admission/result rules as stale and
replanned instead of messaged.

The dispatcher attempts thread delivery and records success or bounded-backoff
failure. Sequence N+1 for the same target cannot be claimed while N is pending,
leased, `blocked`, or `stop-required`; disjoint targets can deliver concurrently.
After the bounded attempt/age budget, the row becomes visibly `blocked`, its
interlock continues to block settlement and promotion, and the human can retry
delivery or conservatively stop the run. A process-local post-commit wake starts
draining promptly; startup recovery and a bounded service timer drain anything
the wake missed. `bb.realtime.publish` may refresh connected panels only after
commit, but it is explicitly ephemeral and never settles an outbox row. A crash
after send but before delivery commit can resend the same change ID; packet
handling and acknowledgement are idempotent.

The runtime checks the campaign sequence automatically before dispatching an
agent call, after an agent returns, before accepting terminal checkpoints or
structured results, and at promotion. A proposed `changePoint()` workflow
primitive provides an explicit safe boundary for longer orchestration stages.
It waits on the plugin service's process-local post-commit notifier and always
re-reads the durable change/interlock rows when woken; startup drain covers a
missed wake. The bounded service timer is infrastructure reconciliation, not a
model polling loop. If no orchestrator model is currently running, the
campaign controller still persists and enforces the change, and the next
orchestrator invocation receives the compact transition record before it can
schedule more work.

Accepting a suggestion remains CAS-bound to the current admitted artifact
revision and creates an immutable candidate ID, but does not reserve a campaign
transition sequence. The controller assigns `admittedSequence` only in the
successful admission transaction. Concurrent admissions compare-and-swap the
same high-watermark; a loser returns to impact synthesis against the winner.
V1 never coalesces changes. Each `(changeId, callId)` retains its own interlock
and receipt, and a target adopts admitted changes strictly in transition-
sequence order. A revision or transition conflict never silently rebases worker
context. Any future coalescing feature needs an explicit ordered multi-change
packet and acknowledgement schema.

### 7. Change-Control Delivery Slices

Ship the capability behind a definition-level
`workflowArtifactLiveChanges` gate that is off by default. The rollout is four
monotonic changes; no PR depends on an unshipped later PR for its safety:

1. Add dark schemas/migrations for the normalized campaign work registry,
   snapshots, changes, per-change/per-call interlocks, receipts, and outbox;
   prove recovery and uniqueness/order invariants without delivering changes.
2. Consolidate every terminal-status writer, including restart recovery, behind
   one transactional settlement entry point. Then bind dispatch, evidence,
   replay, settlement, staleness, and promotion to the shared
   snapshot/interlock predicate; the gate remains off and no thread steering
   occurs.
3. Add the ordered outbox dispatcher, best-effort thread steering,
   server-derived acknowledgement tool, timeout handling, and conservative
   whole-run stop fallback; prove the fault/race matrix before enablement.
4. Wire the artifact review UI, steward thread, synthesizer, human confirmation,
   and controller admission path, then enable the definition only for explicit
   test campaigns before broader promotion.

This complete gated stack is the first slice that truthfully supports a
requirements refinement during a live build. Selective call abort/requeue can
follow as a precision improvement rather than delaying safe propagation.

Until selective abort ships, urgent or unacknowledged material changes
conservatively stop the whole run and resume under the same campaign; the UI
must state that scope. A presentation thread does not receive the generic stop
RPC: after human confirmation, the change controller invokes the internal
whole-run interlock under system authority rather
than imply only affected calls stopped. Automated compatible-change coalescing
and richer human policy thresholds can also follow after observing real usage.

Launch verification must exercise: change admission racing call dispatch;
change admission racing idle/result settlement; failed thread delivery with
durable retry; exact and wrong-scope acknowledgements; two concurrent accepted
revisions; same-target N and N+1 admitted before N is acknowledged; a disjoint
intervening revision followed by a newly affected call; cache replay across
snapshots; completed verification becoming stale without losing history;
provider paths that cannot steer mid-turn; restart with admitted-but-unsettled
change rows; and restart/re-attachment where a call receives a new child thread.
No affected old-snapshot result may promote, even if message delivery or an
orchestrator model is unavailable.

## Diagrams / Tables To Promote

- Campaign artifact registry and revision-state diagram.
- Comment-to-redesign transition sequence.
- Steward/architect-cohort/controller/orchestrator authority table.
- Live change delivery and acknowledgement sequence for pending, active, and
  completed work.
- Review panel wireframe.
- Capability inventory showing reused versus net-new pieces.

## Ready-To-Promote Queue

- Node-to-node DAG edge requirement.
- Campaign-scoped versioned artifacts.
- Markdown canonical / HTML presentation split.
- Persistent campaign steward with compact deltas.
- Durable local review state with commit-before-ack and restart recovery.
- Version-bound annotation contract and explicit orphaning.
- Human-confirmed steering transition for approach-level changes.
- Revision-bound work dispatch, durable live change packets, and worker
  acknowledgement/promotion gates.

## Snapshot Log

No frozen review snapshot yet. The open questions above should be resolved or
explicitly carried before packaging an implementation review.

## Post-Snapshot Deltas

None.
