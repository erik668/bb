SHA: 86e3067c8d5974d4b71d4fd5c0bfa84b472c59b5
VERDICT: PASS
CRITIC: codex-commit-critic-20260821

# Independent pre-production review

Finding count: 0 blocking / 1 warning / 0 nit.

## Findings

### Warning 1

- **Severity:** warn
- **Lens:** code-standards #3 / simplify
- **Location:** `plugins/workflows/src/app.tsx:398-448,620-768,963-1318`
- **Scenario:** The checkpoint loader, related-run card, and three ledger renderers bring `app.tsx` to 1,525 lines. No correctness defect was found, but polling, stale-request suppression, provenance controls, and detail rendering now share a large edit surface.
- **Fix:** In a follow-up, extract the checkpoint hook and ledger renderer into focused modules while preserving the existing RPC and UI tests. This is not a production-launch blocker.

## Ratified requirement conformance

- **Requirement:** “surface the related workflow card on the root workflow I kicked it off in, or the root agent who led to one or more agents further down to kick it off.”
  **Verdict:** honored. Hidden origins resolve to the nearest visible same-project/same-environment ancestor, and causally nested workflows inherit the parent's presentation/root identity. `plugins/workflows/src/service.ts:546-648`; `plugins/workflows/src/data.ts:271-323`.
- **Requirement:** “easily view the full plan that was selected,” “exact progress, like a per-ticket breakdown,” and “which tests were selected, what their status is.”
  **Verdict:** honored for workflows that publish the structured checkpoint contract. Plan details, work-item status/files/blockers, and verification commands/counts/statuses are durable and render in the inspector. `plugins/workflows/src/workflow-checkpoint.ts:28-120`; `plugins/workflows/src/data.ts:500-640`; `plugins/workflows/src/app.tsx:1083-1318`.
- **Requirement:** design/build the shakedown-ready MVP first, then proceed with PSA in parallel only when human-reviewed feedback does not require a material design change.
  **Verdict:** honored by the committed named workflows. Human decisions remain explicit inputs, material-change blocks PSA, and eligible read-only PSA work executes in dependency waves. `.bb/workflows/workflow-router-pipeline.js:1368-1854,2044-2462`; `.architect/validation/workflow-assurance-lifecycle.test.ts:94-450`.

## Inventory conformance

The qualifying migration and lifecycle redesign both have inventories: `.architect/inventory/workflow-presentation-target.md` and `.architect/inventory/workflow-assurance-lifecycle.md`. The committed changes preserve existing origin execution/completion semantics, mark presentation/checkpoint/lifecycle additions as not yet deployed, explicitly defer cross-server federation and thread-header projection, and record the instruction-only nature of read-only worker policy. No unlisted operation was found.

## Authorization boundary

| Axis | Result |
| --- | --- |
| Scoping | PASS. Explicit presentation targets must be a visible origin/ancestor. Every traversed ancestor and causal parent is constrained to the origin project and environment. Run views accept only the persisted origin or presentation thread. `plugins/workflows/src/service.ts:565-648`; `plugins/workflows/src/server.ts:110-146`. |
| Ordering | PASS. The run is loaded before origin/presentation checks and before stop mutation. `plugins/workflows/src/server.ts:110-159`. |
| Who may mutate | PASS for the stated local-UI provenance boundary. Presentation threads are read-only in the UI and server handler; stop remains origin-only. Worker checkpoint mutation is bound to the host-supplied worker thread context and active owning call. `plugins/workflows/src/server.ts:148-159,194-202`; `plugins/workflows/src/service.ts:1344-1402`; `plugins/workflows/src/app.tsx:1407-1422,1488-1501`. The RPC contract carries a caller-supplied thread ID and is not a separate authenticated multi-user boundary; this commit does not claim otherwise. |
| Concurrency | PASS. Checkpoint admission/upsert, stable-kind enforcement, producer ownership, and aggregate limits share one SQLite transaction with a unique `(run_id, checkpoint_id)` constraint. `plugins/workflows/src/data.ts:257-270,500-616`. |

No new egress, secret flow, raw HTML sink, broad project lookup, or destructive all-project operation was introduced.

## Correctness, migration, reuse, and rollout

- The append-only migrations create checkpoint storage before adding presentation/causal metadata, backfill legacy presentation to origin and root to self, and preserve parent deletion with `ON DELETE SET NULL`. `plugins/workflows/src/data.ts:257-281`.
- Startup recovery interrupts stale running checkpoints before requeueing interrupted runs; the focused recovery regression passed. `plugins/workflows/src/data.ts:689-724`; `plugins/workflows/src/data.test.ts:736-786`.
- Terminalization reserves enough aggregate bytes for `running`/`pending` to become `interrupted`, preserves already-terminal rows, and rejects cross-producer and cross-kind overwrites. `plugins/workflows/src/data.ts:431-453,500-616`; `plugins/workflows/src/service.ts:276-309,1344-1402`.
- Active origin and presentation surfaces receive deduplicated realtime updates, while completion notification still goes only to the origin. `plugins/workflows/src/service.ts:484-507,1420-1432`.
- The checkpoint capability is installed once in the generic QuickJS runtime and exposed to every active workflow worker, so the ledger is reusable by workflows beyond the two committed routers. `plugins/workflows/src/runtime.ts:699-714`; `plugins/workflows/src/server.ts:194-202,226-254`.
- The named workflows are repository-local under `.bb/workflows/`, parse through the real BB validator, and their committed hashes exactly match the lifecycle-test candidates: parent `7679cbc1fc0ae8052e47a121116b69280e16e8f88b26cc0649244270c8eb145d`, child `ebb7dc776d1d21dc2fde7ae6c04b8df3dee4e9757a60f705780e350530fe1367`.

## Independent commands and evidence

- `bb workflows validate --file .bb/workflows/workflow-router.js` — PASS, `valid: true`, 29,313 source bytes.
- `bb workflows validate --file .bb/workflows/workflow-router-pipeline.js` — PASS, `valid: true`, 87,678 source bytes.
- `BB_THREAD_STORAGE=/Users/erik/.bb/thread-storage pnpm exec vitest run --config .architect/validation/vitest.config.ts` — PASS, 1 file / 7 tests.
- Targeted plugin boundary suite across `data`, `service-policy`, `server-harness`, `runtime`, and `app` — PASS, 5 files / 12 selected tests (119 skipped).
- Focused interrupted-run startup recovery — PASS, 1 selected test (22 skipped).
- `shasum -a 256` over committed workflows and frozen candidates — exact pairwise match.
- `git diff --check HEAD^..HEAD` — PASS.
- Follow-up commit `86e3067c8` changes only the two assurance evidence documents, removes the invalid `node --check` recipe and pass claims, and explains why BB validation is authoritative for top-level-return workflow source.

## Lens conclusions

- **code-review:** no blocking correctness, compatibility, migration, or production-startup defect found.
- **owasp-security:** the four authorization axes pass within BB's local trusted-renderer model; presentation does not confer mutation control.
- **test-reviewer:** deterministic storage, migration, ownership, runtime, RPC, stale-view, UI, and lifecycle gates have observable tests using real in-memory SQLite and the real QuickJS runtime.
- **code-standards / simplify:** no new unchecked external-deserialization cast, free-form message classifier, duplicated closed set, or lost logger stack found. The large UI module remains the maintainability warning above.
- **factuality-claim-review:** implementation, hash, and verification claims are supported. The follow-up documentation commit resolved the prior invalid `node --check` claim without changing product code.
- **distinguished-engineer-review:** origin control, human presentation, causal lineage, legacy backfill, same-server scope, and generic checkpoint reuse form a coherent production boundary. Cross-server federation remains explicitly deferred.

## What this review did not cover

- It did not build, install, restart, or smoke the production BB application; those remain the promotion gate after this source verdict.
- It did not rerun the full 257-test plugin suite or package typecheck; those are author-reported evidence for this exact commit. This critic independently ran the high-risk boundary subset listed above.
- It did not replay the prior screenshot/video pixel by pixel.
- It did not independently re-query production provider/model availability; model routing quality, cost, and taste still require live workflow trials/evals.
- It did not prove authenticated actor identity, evidence-reference provenance, temporal ordering, or replay prevention for human lifecycle decisions; the validation document assigns those to the caller/runtime.
