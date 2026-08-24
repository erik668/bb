# Workflows built-in plugin

Workflows is an opt-in built-in plugin (`builtin:workflows`) and is disabled on
fresh BB installations. It runs provider-independent JavaScript orchestration
inside QuickJS while delegating actual reasoning to ordinary BB threads.

The author-facing native surface is intentionally one tool:
`bb_workflow_run`. Validation, inspection, listing, and cancellation use the
`bb workflows` CLI documented below. Provider and model discovery uses BB's
built-in `bb provider` commands. Workflow workers separately receive
`bb_workflow_checkpoint` for durable plan, work-item, verification, and transition
progress; acceptance contracts are published by the orchestrator. Structured workers additionally receive `bb_workflow_result`;
ordinary authoring agents never receive either worker tool.

## Progress UI

A successful `bb_workflow_run` result includes a trusted
`previewDirective` such as:

```text
::workflow-preview{run="wfr_…"}
```

The authoring agent emits that returned value exactly once on a standalone
line. BB replaces the directive with a compact live run card in chat. The card
shows run state, declared phases, the active phase's workers, elapsed time, and
an action that opens the full workflow inspector in the thread's right panel.
While a thread has queued or running workflows, the plugin also contributes a
status card above that thread's composer. It lists every active run with its
current phase and agent-call progress and opens the full inspector; the card
disappears when the thread has no active runs.
The panel shows every phase and worker, links attached workers to their BB
threads, and progressively discloses the selected plan, per-ticket or per-work
item implementation state, changed files, blockers, exact verification
commands, and pass/fail/skip counts when the workflow publishes them. It also
renders dependency-aware work and gate nodes as a build DAG and keeps a
structured transition log explaining repair, redesign, human-review, and
promotion decisions. Top-level runs sharing a campaign ID appear as one
chronological build story without losing their individual run IDs. It also
reports cache and result state. In the origin thread it can stop an active run;
in a presentation thread it is read-only and links to the origin for control.
It may be opened directly from the thread panel action, in which case it shows
that thread's latest run.

Execution ownership and human presentation are tracked separately. The origin
thread still owns the environment, permissions, and completion notification;
the presentation thread receives the active card, realtime updates, and
inspector access. A visible top-level launch presents in its origin thread. A
workflow launched from a hidden worker inherits its parent run's presentation
thread and root run, or otherwise falls back to its nearest visible ancestor.
CLI launches can override the presentation target with `--present-in
<thread-id>`. Independent continuation runs join a build story with `--campaign
<campaign-id>` or the `campaignId` field on `bb_workflow_run`; causal children
and resumed runs inherit it and reject conflicts. A campaign is restricted to
one project, environment, and presentation thread and at most 100 runs.
`status`, `list`, and
`history` expose `originThreadId`,
`presentationThreadId`, `parentRunId`, `rootRunId`, and `campaignId` for
provenance. A
presentation target must be a visible thread in the same project and
environment and must be the origin or one of its ancestors. It must also be
available from the same BB server; this does not federate workflow state across
servers. The inspector and `details` command always list all campaign runs, but
hydrate checkpoint ledgers for only the selected run plus the newest runs, up
to four ledgers total. The selected ledger stays in the primary checkpoint
field instead of being duplicated in the campaign aggregate. Older runs are
marked `checkpointsOmitted`; this caps the combined details response at 16 MiB
while keeping its full chronology visible. Both surfaces additionally report
`acceptanceCoverage`, derived over the campaign's whole checkpoint ledger rather
than the hydrated subset: per-criterion `closed`/`in-flight`/`uncovered` state,
succeeded work items that advance no stated outcome, the declared amendment
chain with each reason, acceptance checkpoints whose body diverges without
declaring an amendment, links naming no declared criterion, and whether work is
landing while nothing has closed. It is `null` when the campaign declared no acceptance contract, and
`acceptanceCoverageTruncated` reports a ledger too large to read in full.

Both surfaces are implemented by the plugin app with `@bb/shared-ui` controls
and BB theme tokens. Directive attributes and restored panel parameters are
treated as untrusted input. The backend additionally binds every requested run
to the directive message or panel thread, so a run ID from an unrelated thread
cannot be inspected through these UI RPCs. Only the origin thread may stop a
run. The service publishes a deduplicated `workflow-runs` realtime signal for
the origin and presentation threads when a run starts, is claimed, settles, or
is cancelled, so the composer status surface learns about new runs without a
standing poll; it and the active message cards poll once per second only while
a run is active and the page is visible, refresh once when the page or the
realtime connection comes back, and stop when terminal.

The security boundary is the QuickJS context: workflow code has JSON data and
explicit orchestration capabilities, but no Node, filesystem, shell, network,
imports, clock, or randomness. The QuickJS WASM is embedded in the plugin's
single-file server bundle so packaged built-ins need no sidecar asset.
JSON Schema compilation and result validation necessarily run in the Node host,
not inside QuickJS, so every metadata and agent-output schema is restricted
before Ajv sees it. The supported subset covers boolean schemas plus common
structured-output keywords: `type`, `properties`, `required`,
`additionalProperties`, `items`, scalar `enum`, `const`, numeric/string/array/
object size bounds, `nullable`, and annotation keywords. Regex and format
validation, references, combinators/conditionals, `uniqueItems`, `contains`,
dependent/unevaluated schemas, unknown keywords, structured enums, and excessive
property or enum fanout are rejected with the schema path and safety reason.
Schemas also retain the 64 KiB, 4,096-node, depth, cycle, and prototype-safety
limits. This deliberately conservative subset keeps host-side validation
bounded and preserves ordinary object/array structured results.

Metadata may declare an ordered literal `phases` array. Every entry has a
required non-empty, unique `title` and an optional non-empty `detail`; unknown
fields and malformed entries are rejected. Declaration order is preserved.
`phase(title)` changes the current phase, and later agent calls inherit it.
An agent-level `phase` applies only to that call and does not change the current
phase.

`checkpoint(value)` durably upserts structured progress by `value.id` and
inherits the current phase. Supported checkpoint kinds are `acceptance`, `plan`,
`work-item`, `verification`, and `transition`. An `acceptance` checkpoint states
the campaign's outcomes — stable criterion IDs with a statement, a `provenBy` of
`command`, `artifact`, or `human`, and optional detail — so plans can be
measured against something they did not author. Plan items link to it through
`satisfies` and verifications through `acceptanceId`. Acceptance is the one kind
that cannot be rewritten in place: once a campaign has published a contract, a
write that changes its criteria body is refused campaign-wide unless it arrives
as a new checkpoint ID carrying `amends: { supersedes, reason }`. Restating the
same body is always accepted, criterion order is not part of the contract, and
`detail` is. Coverage measures the head of the declared amendment chain and
re-derives that chain on read, so a contract changed by writing to the database
directly is reported rather than adopted. Plan and work-item checkpoints may publish
bounded `dependsOn` edges; plan-local dependencies must reference known items
and remain acyclic. Work items may be typed as work or gate nodes. Transitions
record the actor, source and target states, affected work items, rationale, and
evidence references. Reuse stable IDs to update state instead of appending prose;
the latest value stays inspectable after the run finishes. Workers can publish
the same contract through `bb_workflow_checkpoint`, and their rows retain a
link to the worker thread. Checkpoints are accepted only while the run and, for
worker updates, the source call are active. A worker may update only rows it
originally created; sibling workers cannot take over its stable IDs. The
orchestrator may reconcile or terminalize any row, but no update may change a
row's checkpoint kind. Plans carry bounded multiline
`detail` on the plan and each item so the inspector can retain the complete
human-reviewable route rather than only titles. Status is one of `pending`,
`running`, `succeeded`, `failed`, `blocked`, `skipped`, or `interrupted`;
unfinished rows become `interrupted` when their producer or run terminates.
Each checkpoint is limited to 64 KiB/8,192 JSON nodes, and a run is limited to
512 rows/4 MiB. Updating an existing stable ID remains allowed at the row cap
when the aggregate byte cap is still satisfied. Admission reserves the small
amount of byte headroom needed to terminalize `pending` and `running` rows as
`interrupted`, so a valid ledger remains readable after termination.

Workflow input follows the native Claude source modes: provide exactly one of
an inline `script`, a workspace `scriptPath`, or a workflow `name`. The older
`source` field remains an explicit alias for inline `script`; `script` and
`source` cannot be supplied together. Name lookup is project-local at
`.bb/workflows/<name>.js`. There is no plugin-bundled workflow discovery.

File and name sources are resolved on the workflow origin environment's host,
not on the bb server machine. BB reads them through the environment `hostId`
with `rootPath` confinement to its workspace. Traversal and outside absolute or
UNC paths, missing workspace roots, non-UTF-8 content, and sources larger than
512 KiB are rejected. QuickJS receives only the resolved source text and never
receives a filesystem capability.

Durability lives in the plugin-owned SQLite database. Runs and ordered agent
calls are persisted independently. On restart the source is evaluated from the
beginning and successful calls are replayed by a SHA-256 key until the first
divergence. Explicit resume uses the same longest-unchanged-prefix rule against
the selected prior run. Parallel calls receive identities in deterministic
invocation order, so concurrency does not stop replay. The first edited, new,
failed, cancelled, incomplete, or null-result call and the entire suffix run
live. Successful calls are reusable regardless of which tools they used,
including file edits and other writes, because resume is restricted to the same
environment workspace where those effects remain. Runs created before
replay-safety metadata existed replay nothing.

Agent calls retry transient provider failures twice with bounded backoff before
the failure reaches the workflow script. Retryability comes from an explicit
SDK `retryable` marker when available or conservative overload, rate-limit,
provider 5xx, and network-error signatures. Authentication, configuration,
schema, and other deterministic failures are not retried. Retry attempts are
persisted on the call so a plugin restart cannot reset the retry budget.

Worker output is either the final assistant text or an Ajv-validated value
submitted through `bb_workflow_result`. All active workers can submit durable
progress through `bb_workflow_checkpoint`; structured workers receive two
corrective retries after their initial invalid result attempt.

Workflow workers use BB's generic hidden-thread visibility. They remain
out of sidebar organization without contributing unread/pending favicon
attention. Ordinary search, prompt history,
lifecycle, and direct operations remain available. Workers are root threads,
so no parent notification applies; a hidden thread that does have a parent
still reports its turns and blockers to it. Workflows does not create a
temporary Workflow folder.

Workflows may invoke one child workflow level with
`workflow(nameOrRef, args)`. A string and `{ name }` resolve under
`.bb/workflows`, `{ scriptPath }` uses the same origin-workspace confinement as
top-level runs, and `{ script }` is inline source. Each child is parsed,
schema-validated, and evaluated in a separate QuickJS VM. Parent and child VMs
share one FIFO agent scheduler, call budget, cancellation signal, replay order,
and phase/progress record. A child cannot invoke a grandchild.

## Settings

Workflows declares seven plugin settings:

- `maxActiveRuns` limits runs dispatched at once across the plugin.
- `maxGlobalConcurrentAgents` limits live agent calls across all workflow runs
  in this BB host.
- `maxConcurrentAgents` limits live agent calls within one run, including its
  child workflow.
- `maxAgentCalls` bounds the shared parent/child call count.
- `totalRunTimeoutMs` fails a run independently of explicit cancellation.
- `retentionDays` controls terminal-run cleanup while preserving active runs
  and retained resume ancestors.
- `maxNotificationBytes` bounds completion messages by UTF-8 byte length.

`maxActiveRuns` and `maxGlobalConcurrentAgents` are live plugin-global policy.
Changing `maxActiveRuns` immediately changes how many queued runs the worker may
claim. Increasing global agent admission releases queued calls; decreasing it
does not cancel calls already active and blocks new admission until usage falls
below the new limit. The other five values are snapshotted into each new run and
remain fixed for that run, including a resumed run. Saving settings does not
require a plugin reload.
Terminal runs send an agent-only completion input back to the origin thread. It
steers an active origin immediately or starts a turn when the origin is idle,
while remaining absent from the user-facing timeline and search. Polling the
compact `status` summary remains authoritative when a completion message is
truncated or temporarily cannot be delivered. Completion delivery is
at-least-once: a successful `threads.send` followed by a crash before its durable
acknowledgement may produce a duplicate because the API has no idempotency key.
Duplicates carry the same stable run ID marker. Failed attempts use durable,
capped exponential backoff. Status exposes notification outcome as `pending`,
`delivered`, or `abandoned`; a missing or deleted origin permanently records
`abandoned` so it cannot block retention.

Useful checks:

```bash
pnpm exec turbo run typecheck --filter=bb-plugin-workflows
pnpm exec turbo run test --filter=bb-plugin-workflows --force
bb plugin build plugins/workflows
```

User-facing commands (run these from a BB project thread) are:

```bash
bb workflows validate --script '<javascript>'
bb workflows validate --file .bb/workflows/review.js
bb workflows validate --name review
bb workflows run --script '<javascript>' --args '<json>'
bb workflows run --file .bb/workflows/review.js --resume <run-id>
bb workflows run --name review --present-in <thread-id>
bb workflows run --name review --campaign <campaign-id>
bb workflows status <run-id>
bb workflows details <run-id>
bb workflows history <run-id> --cursor 0 --limit 100
bb workflows list --limit 20
bb workflows stop <run-id>
bb provider list --environment "$BB_ENVIRONMENT_ID" --json
bb provider models <provider-id> --environment "$BB_ENVIRONMENT_ID" --json
```

`status` is deliberately bounded: it returns run state, phase, call counts,
notification state, and only a small final result. It omits source, arguments,
and call history so polling cannot be truncated into invalid JSON.
`list` is likewise bounded and returns compact run summaries rather than source
or result bodies. Untrusted names, phases, and errors are capped by UTF-8 bytes;
the adjacent `*Truncated` fields report when a displayed value was shortened.

`history` returns one strict JSONL snapshot page ordered by call index. Redirect
it before inspecting it so large prompts and results never enter the agent
transcript:

```bash
run=<run-id>
mkdir -p "$BB_THREAD_STORAGE/workflows"
bb workflows history "$run" --cursor 0 --limit 100 \
  > "$BB_THREAD_STORAGE/workflows/$run.jsonl"
```

The final `page` record reports `hasMore` and `nextCursor`. Fetch the next page
with that cursor and append it to the same file. A full `run` record appears on
the first page, later pages include a small `run-reference`, and every call
record includes requested options, resolved provider/model/reasoning/permission,
cache/live state, child thread ID, repairs, result, and error. Pages are
snapshots; while a run is active, rewrite the file from cursor `0` when a fresh
detailed view is needed.

This redirection intentionally happens in the invoking agent's shell. The
canonical state remains in the plugin's server-side SQLite database, while the
JSONL file lands in `$BB_THREAD_STORAGE` on that thread's execution host. The
same flow therefore works for local and remote environments without granting
the server arbitrary filesystem-write access.

Before selecting an explicit provider tuple, query only the relevant provider
with BB's built-in commands above. Never infer ACP model IDs from a provider
name: for example, an ACP provider can advertise `grok-4.5` even though neither
that model ID nor its reasoning options can be derived from `acp-grok`.

`--source` is retained as an inline alias for `--script`. `run` and `validate`
share source resolution and validation. Validation checks the 512 KiB limit,
hidden control characters, JavaScript syntax and unsafe constructs, literal
metadata and JSON Schemas, partial literal provider/model/reasoning tuples, and
every discoverable literal tuple against the live origin-host provider data.
Errors distinguish unavailable providers, model-load failures, model
mismatches, and unsupported reasoning levels.

For the CLI, a relative `--file` is resolved from the invoking CLI's current
directory. That directory and the final path must both remain inside the
origin environment workspace; absolute and traversal escapes are rejected.
Relative agent-tool `scriptPath` values remain rooted at the workspace root.

Agent options accept native `label`, `phase`, and `schema` alongside BB's
existing `title` and `outputSchema`. `label` resolves to canonical `title`, and
`schema` resolves to canonical `outputSchema`. Both spellings of an alias may
be provided only when structurally identical; schema object key order is
ignored.
`provider`, `model`, and `reasoningLevel` remain all-or-none. Title/label/phase
are display-only and do not participate in resume cache identity. The canonical
output schema does participate, regardless of which accepted spelling supplied
it.

Resume requires a terminal prior run from the same project and environment
workspace. Another origin thread may resume it only when that thread uses the
same environment. Successful writer calls are cached just like read-only calls;
their effects are not copied into another workspace.
