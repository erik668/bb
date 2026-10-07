# Workflow Artifact Review Capability Inventory

Current checkout: `bb-workflow-details`, branch `feature/workflow-detail-ledger`.
Architecture revision 2 binds artifact authority to the workflow run's origin
campaign/project/environment and treats a visible presentation thread as a
same-server access grant. It also assigns the proposed shared review component
to `packages/plugin-sdk` plus its host rendering owner in `apps/app`.
Production usage is not available per capability in this workspace, so every
shipped row is explicitly marked `unmeasured` rather than assigned a guessed
count. `exists-and-used` below means the capability is shipped and has a
repository consumer or test; it does not claim measured production adoption.

| Capability | Status | Code reference | Gating path | Prod usage | Evidence |
| --- | --- | --- | --- | --- | --- |
| Workflow plan and work-item dependency data | `exists-and-used` | `plugins/workflows/src/workflow-checkpoint.ts:35` | `checkpointToolInputSchema` -> `bb_workflow_checkpoint` -> `submitCheckpoint` | unmeasured | Strict plan/work-item schemas carry `dependsOn`; the workflow inspector consumes them. |
| Durable workflow transition evidence | `exists-and-used` | `plugins/workflows/src/workflow-checkpoint.ts:141` | transition checkpoint -> `bb_workflow_checkpoint` -> append/upsert in run ledger | unmeasured | Transition rows carry actor, from/to state, affected work-item IDs, rationale, and evidence references. They are evidence only; they do not enforce worker control. |
| Steer an active thread | `exists-and-used` | `packages/server-contract/src/public-api.ts:968` | `threads.send(mode=steer-if-active)` -> provider active target; otherwise start turn | unmeasured | BB supports active-thread steering, and workflows already use thread sends for corrective turns and origin notifications. Applying steering to worker changes is proposed-new and has no artifact-change acknowledgement today. |
| Ephemeral plugin UI signalling | `exists-and-used` | `packages/plugin-sdk/src/backend-contract.ts:209` | `bb.realtime.publish` -> connected-client WebSocket broadcast | unmeasured | Signals are explicitly not persisted and cannot be the delivery authority for orchestrators or workers. |
| Restartable plugin background service | `exists-and-used` | `packages/plugin-sdk/src/backend-contract.ts:219` | `bb.background.service` -> host lifecycle/restart loop -> AbortSignal shutdown | unmeasured | Suitable for draining a plugin-owned durable outbox, but the outbox and campaign-change dispatcher do not exist today. |
| Host-attested human principal in plugin RPC | `does-not-exist` | `packages/plugin-sdk/src/rpc-contract.ts:83` | — | — | Plugin RPC handlers receive validated input only. Local-origin authentication does not provide a user/principal object to the handler. |
| Cancel a whole workflow run and its children | `exists-and-used` | `plugins/workflows/src/service.ts:2134` | `stop(runId)` -> `cancelRun` -> run AbortController -> `stopChildren` | unmeasured | Whole-run cancellation is durable and propagates to child threads; it is too coarse for one affected work item. |
| Pause, invalidate, and restart one workflow call | `does-not-exist` | `plugins/workflows/src/runtime.ts:331` | — | — | Runtime creates internal per-agent AbortControllers, but the service cancellation API addresses only a whole run and its children. No durable call-level change/requeue state or externally addressable selective-cancel API exists. |
| Bind dispatched work and results to artifact revisions | `does-not-exist` | — | — | — | `WorkflowAgentOptions`, work-item checkpoints, and verification checkpoints carry no requirements/architecture revision snapshot or campaign transition sequence. |
| Authoritative campaign-wide work registry | `proposed-new` | — | Proposed normalized campaign work items/edges -> scheduler and impact closure | — | Current campaign inspection hydrates at most four checkpoint ledgers and the UI folds nodes into a map by checkpoint ID. That presentation view is not a complete enforcement graph across continuation runs. |
| Durable campaign-change controller | `proposed-new` | — | Accepted artifact revision -> change ledger -> impact decision -> scheduler barriers | — | Net-new control plane; transition checkpoints and thread steering are reusable evidence/delivery pieces but do not provide sequencing or enforcement. |
| Durable campaign-change delivery outbox | `proposed-new` | — | Artifact/transition transaction -> durable call/work-item target -> background dispatcher/startup drain -> current child-thread/UI delivery | — | Required because plugin realtime and in-memory wakeups are ephemeral. Durable targets must resolve the current child thread per attempt so restart re-attachment does not strand delivery. |
| Workflow runtime change point/wake | `proposed-new` | — | Durable change/interlock rows -> plugin-local post-commit notifier/startup drain -> `changePoint()` host promise | — | No durable host subscription exists. Correctness comes from persisted rows; the in-memory wake only reduces latency. |
| Multi-user artifact mutation authorization | `proposed-new` | — | Proposed host-attested RPC principal/permissions -> artifact/change write policy | — | V1 can be explicitly local-single-owner; shared-host use must remain disabled until the host supplies trusted principal context. |
| Worker change acknowledgement receipt | `proposed-new` | — | Change packet -> worker safe point -> scoped acknowledgement -> result/promotion gate | — | Net-new receipt needed so message delivery is not mistaken for adoption. |
| Layered build-DAG rendering | `exists-and-used` | `plugins/workflows/src/app.tsx:1259` | `workflowRunDetails` -> `buildDagLayers` -> `WorkflowDag` | unmeasured | The shipped baseline calculated dependency depth and displayed a generic arrow between layers. |
| Exact node-to-node build-DAG edges | `proposed-new` | `plugins/workflows/src/app.tsx:1304` | `dependsOn` edge projection -> measured SVG connectors in `WorkflowDag` | — | Implemented and tested in this uncommitted worktree, but not yet live; the shipped baseline has only the generic layer separator. |
| Workflow-owned original-requirements artifact | `does-not-exist` | — | — | — | Checkpoint union contains only plan, work-item, verification, and transition kinds. |
| Workflow-owned architecture artifact | `does-not-exist` | — | — | — | No artifact reference or architecture-document checkpoint field exists in `plugins/workflows/src/workflow-checkpoint.ts`. |
| Workflow-owned artifact versions or immutable snapshots | `proposed-new` | `plugins/workflows/src/artifact-storage.ts:79` | workflow plugin startup -> verified SQLite profile -> append-only migration | — | Implemented in this uncommitted worktree as dark storage for content-addressed blobs and scoped artifact revisions; no service, RPC, or live consumer is enabled yet. |
| Plugin-owned durable SQLite storage | `exists-and-used` | `apps/server/src/services/plugins/plugin-api.ts:563` | `bb.storage.database()` -> verified WAL/FULL/foreign-key profile -> `<dataDir>/plugins/workflows/data.db` -> host-managed close/reopen | unmeasured | The host supplies the file-backed database, and the workflows plugin now verifies the required durability profile before migration at `plugins/workflows/src/server.ts:107`. Production operation counts are unavailable. |
| Workflow side-panel details | `exists-and-used` | `plugins/workflows/src/app.tsx:1904` | `threadPanelAction(workflow-run)` -> `workflowRunDetails` | unmeasured | The workflow plugin already owns a persistent side-panel tab for a run. |
| Filesystem-backed rich Markdown editing | `exists-and-used` | `plugins/docs/app.tsx:400` | Docs `fileOpener`/`threadPanelAction` -> Docs RPC -> `bb.sdk.files` CAS write | unmeasured | Docs provides a Tiptap Markdown editor, autosave, and conflict detection. |
| Sandboxed HTML artifact preview | `exists-and-used` | `plugins/inline-vis/app.tsx:177` | `messageDirective(inline-vis)` -> path validation -> workspace preview iframe | unmeasured | Inline-vis and Docs render `sandbox="allow-scripts"` iframes without same-origin access. |
| Thread-linked document tab | `exists-and-used` | `plugins/docs/app.tsx:745` | Docs message directive -> `openThreadPanel(document)` | unmeasured | A Docs card opens editable Markdown or read-only HTML in the Docs-owned thread side panel. |
| Selected chat text as a discussion anchor | `exists-and-used` | `packages/plugin-sdk/src/app-contract.ts:954` | Host text-selection menu -> plugin `messageAction` | unmeasured | `selectedText` is passed to message actions; Side Chat uses it as the fork seed. |
| Persistent separate discussion agent | `exists-and-used` | `plugins/side-chat/server.ts:176` | Side Chat action -> `threads.fork({ visibility: hidden, workspace: reuse })` -> embedded `ThreadChat` | unmeasured | Side chats are durable BB threads in a persistent panel tab, separate from the main thread. |
| Highlight/comment anchors inside a workflow artifact | `proposed-new` | `plugins/workflows/src/artifact-storage.ts:132` | scoped artifact revision -> durable annotation row | — | The uncommitted dark schema stores version-bound anchor JSON and explicit open/resolved/orphaned state, but no UI or mutation service uses it yet. |
| Shared host artifact-review component | `proposed-new` | — | Proposed plugin-SDK `experimental_ArtifactReview` contract -> `apps/app` host renderer | — | Docs and inline-vis document surfaces are plugin-private. A shared host component is required for version-bound selection and annotations; only shared `ThreadChat` can be reused directly today. Revision 2 assigns both the shared contract and host-rendering ownership. |
| Workflow artifact review UI | `proposed-new` | — | Proposed workflow artifact registry -> shared host artifact-review component + `ThreadChat` | — | Would reuse shared file/navigation and chat contracts, but requires the new host-owned review component; it cannot directly compose Docs or inline-vis internals. |
| Artifact-scoped steward thread | `proposed-new` | — | Proposed campaign/workstream link -> one durable agent thread -> embedded `ThreadChat` | — | Existing Side Chat is message-scoped and does not automatically receive workflow artifact revisions or campaign decisions. |
| Version-bound comments with resolve/re-anchor state | `proposed-new` | `plugins/workflows/src/artifact-storage.ts:132` | scoped annotation mutation -> revision foreign key -> explicit resolution/orphan state | — | Dark persistence is implemented in this uncommitted worktree; re-anchoring logic, RPC authorization, and the review surface remain unimplemented. |
| Portable artifact-review export/import | `proposed-new` | — | Proposed host-authorized logical campaign export/import API | — | The plugin database is durable locally, but no artifact-specific portable archive contract exists. The host's internal plugin rollback snapshot is not a user-facing export API. |

## Searches And Usage Boundary

```sh
rg -n "artifact|version|snapshot|requirements|architecture" plugins/workflows/src
rg -n "comment|annotation|highlight" plugins/docs plugins/workflows plugins/side-chat
rg -n "fileOpener|messageAction|selectedText|ThreadChat|threadPanelAction|createPreview" \
  plugins/docs plugins/inline-vis plugins/side-chat packages/plugin-sdk/src
bb plugin list --json
```

`bb plugin list` reports only aggregate plugin handler counts, not invocation
counts for the individual capabilities above. Those aggregates are not used as
capability-usage evidence.
