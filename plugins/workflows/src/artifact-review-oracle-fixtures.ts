import {
  ARTIFACT_REVIEW_MUTATION_OWNERSHIP,
  ARTIFACT_REVIEW_MUTATION_OWNERSHIP_MODULE,
} from "./artifact-review-mutation-ownership.js";

export const ARTIFACT_REVIEW_CONTRACT_ID =
  "bb-artifact-review-service:revision-1" as const;
export const ARTIFACT_REVIEW_ARCHITECTURE_REVISION = 2 as const;

export const ARTIFACT_REVIEW_INVARIANTS = [
  [
    "restart-migration",
    "storage",
    "Migrate before artifact RPC; recover committed state; gate only artifact-table integrity.",
  ],
  [
    "migration-ledger",
    "storage",
    "Every statement that may have run is immutable; corrections are append-only and preserve legacy rows.",
  ],
  [
    "pre18-quarantine-recovery",
    "storage",
    "Only the exact hash-bound pre-migration-18 collision state may recover; conflicting origin components remain losslessly quarantined and live changes remain dark.",
  ],
  [
    "origin-scope",
    "authority",
    "Derive campaign, project, and environment from the run origin; presentation is only an access grant.",
  ],
  [
    "controller-authority",
    "authority",
    "Presentation actions use controller authority; wrong-thread generic stop is rejected.",
  ],
  [
    "local-owner",
    "authority",
    "The server assigns local-owner; clients cannot assert a principal or acceptedBy.",
  ],
  [
    "immutable-bytes",
    "storage",
    "Admitted bytes are content addressed, read-back verified, and fail closed when absent or corrupt.",
  ],
  [
    "revision-anchor",
    "revision",
    "Draft, candidate, admitted, and superseded revisions remain distinct and append-only.",
  ],
  [
    "idempotency",
    "mutation",
    "Identity excludes operation kind; exact retries replay and changed operation or digest conflicts.",
  ],
  [
    "source-apply",
    "mutation",
    "Prepared source intents reconcile every crash point against their immutable source binding.",
  ],
  [
    "renderer",
    "presentation",
    "Markdown is canonical; HTML is preview-only, opaque, and network/navigation/form denied.",
  ],
  [
    "single-steward",
    "steward",
    "Exactly one origin-scoped steward is created; concurrent creators receive the winner.",
  ],
  [
    "architect-admission",
    "admission",
    "Every non-editorial candidate requires architect assessment and human confirmation before atomic admission.",
  ],
  [
    "snapshot-races",
    "concurrency",
    "Dispatch, settlement, replay, recovery, and promotion share one snapshot/interlock predicate.",
  ],
  [
    "ordered-delivery",
    "delivery",
    "A target receives N before N+1; disjoint targets progress; restart resolves the current child thread.",
  ],
  [
    "acknowledgement",
    "delivery",
    "Trusted call context and the exact lowest pending snapshot edge authorize acknowledgement.",
  ],
  [
    "stale-evidence",
    "promotion",
    "Old evidence stays historical but cannot settle or promote until required reverification.",
  ],
  [
    "promotion",
    "promotion",
    "Promotion requires current-snapshot accepted evidence, clear interlocks, and completed acknowledgements.",
  ],
  [
    "off-by-default",
    "rollout",
    "Live change propagation is disabled by default and enabled only for explicit test campaigns.",
  ],
  [
    "terminal-writers",
    "concurrency",
    "Every terminal/commit writer, including replay and recovery, uses the shared predicate.",
  ],
  [
    "one-repair-policy",
    "governance",
    "A second same-seam failure or cross-unit assumption routes to architecture synthesis.",
  ],
  [
    "retention",
    "storage",
    "No automatic deletion; referenced blobs, revisions, intents, drafts, and receipts are RESTRICT-protected.",
  ],
  [
    "cross-environment",
    "scope",
    "A cross-environment presentation may read but cannot continue, mutate source authority, or share mutable history.",
  ],
] as const satisfies readonly (readonly [string, string, string])[];

export type ArtifactReviewInvariantId =
  (typeof ARTIFACT_REVIEW_INVARIANTS)[number][0];

type AssertInvariantSubset<Invariant extends ArtifactReviewInvariantId> =
  Invariant;

export type ArtifactReviewMutationOwnershipInvariantSubset =
  AssertInvariantSubset<keyof typeof ARTIFACT_REVIEW_MUTATION_OWNERSHIP>;

export const ARTIFACT_REVIEW_ACCEPTANCE_SURFACES = [
  [
    "mutation-contract",
    "plugins/workflows/src/artifact-review-mutation-contract.ts",
    "Frozen discriminated input and admission contract for mutation proof.",
  ],
  [
    ARTIFACT_REVIEW_MUTATION_OWNERSHIP_MODULE.surfaceId,
    ARTIFACT_REVIEW_MUTATION_OWNERSHIP_MODULE.path,
    ARTIFACT_REVIEW_MUTATION_OWNERSHIP_MODULE.description,
  ],
  [
    "mutation-decision-table",
    "plugins/workflows/src/artifact-review-mutation-decision-table.ts",
    "Independently approved valid, negative, and metamorphic mutation authority.",
  ],
  [
    "mutation-reference-model",
    "plugins/workflows/src/artifact-review-mutation-reference-model.ts",
    "Outcome-independent reference state machine over admitted mutation inputs.",
  ],
  [
    "mutation-oracle-suite",
    "plugins/workflows/src/artifact-review-mutation-oracle.test.ts",
    "Exact 98-selection mutation proof and unconditional production conformance registration.",
  ],
  [
    "oracle-fixtures",
    "plugins/workflows/src/artifact-review-oracle-fixtures.ts",
    "Frozen contract-revision-1, architecture-revision-2 invariant, case, and unique-fault matrix.",
  ],
  [
    "oracle-suite",
    "plugins/workflows/src/artifact-review-oracle.test.ts",
    "Oracle integrity checks plus the production acceptance-driver seam.",
  ],
  [
    "artifact-storage-anchor",
    "plugins/workflows/src/artifact-storage.test.ts",
    "Real SQLite migration, durability-profile, scope, and constraint anchor.",
  ],
  [
    "sdk-review-contract",
    "packages/plugin-sdk/src/__tests__/artifact-review-contract.test.tsx",
    "Shared experimental_ArtifactReview contract and immutable caller-owned state.",
  ],
  [
    "host-renderer-contract",
    "apps/app/src/components/plugin/PluginArtifactReview.acceptance.test.tsx",
    "Host rendering, annotation interaction, history, save-state, and HTML containment acceptance.",
  ],
  [
    "production-driver",
    "plugins/workflows/src/artifact-review-service.ts#createArtifactReviewAcceptanceDriver",
    "Production-only adapter that must execute every table case after construction.",
  ],
] as const;

export const ARTIFACT_REVIEW_SUCCESSOR_MANIFEST_PATHS = [
  "plugins/workflows/src/artifact-review-mutation-contract.ts",
  ARTIFACT_REVIEW_MUTATION_OWNERSHIP_MODULE.path,
  "plugins/workflows/src/artifact-review-mutation-decision-table.ts",
  "plugins/workflows/src/artifact-review-mutation-reference-model.ts",
  "plugins/workflows/src/artifact-review-mutation-oracle.test.ts",
  "plugins/workflows/src/artifact-review-oracle-fixtures.ts",
  "plugins/workflows/src/artifact-review-oracle.test.ts",
  "packages/plugin-sdk/src/__tests__/artifact-review-contract.test.tsx",
  "apps/app/src/components/plugin/PluginArtifactReview.acceptance.test.tsx",
] as const;

export const ARTIFACT_REVIEW_LEGACY_COMPATIBILITY = [
  [
    "feature-off-replay-identity",
    "Contract snapshot identity is conditional so feature-off replay remains compatible.",
  ],
  [
    "legacy-integrity-isolation",
    "Unrelated legacy foreign-key violations are logged and never repaired or used to gate the workflows plugin.",
  ],
  [
    "may-have-run-migrations-immutable",
    "Every migration statement that may have run is hash-pinned; corrections append and preserve rows.",
  ],
  [
    "presentation-is-not-artifact-identity",
    "Existing presentation-thread-keyed dark rows are rebuilt so the grant remains data rather than canonical identity.",
  ],
  [
    "service-derived-actors",
    "Existing local-owner-only table checks are rebuilt so trusted service-derived agent actors remain representable.",
  ],
  [
    "operation-excluded-from-mutation-identity",
    "Existing operation-keyed mutation uniqueness is rebuilt so changed operation or digest conflicts within one scoped identity.",
  ],
] as const;

export const ARTIFACT_REVIEW_OBJECTIVE_CLOSURE = [
  [
    "migration/restart",
    ["restart-migration", "migration-ledger", "pre18-quarantine-recovery"],
  ],
  [
    "origin scope",
    [
      "origin-scope",
      "controller-authority",
      "local-owner",
      "cross-environment",
    ],
  ],
  ["immutable bytes", ["immutable-bytes", "revision-anchor", "retention"]],
  ["durable mutations", ["idempotency"]],
  ["source-apply crash recovery", ["source-apply"]],
  ["renderer/steward interactions", ["renderer", "single-steward"]],
  ["architect-owned admission", ["architect-admission"]],
  ["snapshot races", ["snapshot-races", "terminal-writers"]],
  ["ordered acknowledgement", ["ordered-delivery", "acknowledgement"]],
  ["stale evidence and promotion", ["stale-evidence", "promotion"]],
  ["off-by-default rollout", ["off-by-default"]],
  ["one-repair escalation", ["one-repair-policy"]],
] as const;

export const TERMINAL_WRITER_ORACLE = [
  "claimQueuedRun",
  "settleRun",
  "recoverInterruptedRuns",
  "startCall-replay-upsert",
  "attachCallThread",
  "queueCallProviderRetry",
  "storeStructuredResult",
  "settleCall",
  "idle-fallback",
  "checkpoint-terminal",
  "cancelRun",
  "promotion",
] as const;

type OracleDomain =
  | "storage"
  | "authority"
  | "revision"
  | "apply"
  | "presentation"
  | "steward"
  | "admission"
  | "settlement"
  | "transition"
  | "delivery"
  | "ack"
  | "promotion"
  | "rollout"
  | "repair"
  | "retention";

export interface ArtifactReviewOracleCase {
  readonly id: string;
  readonly invariant: ArtifactReviewInvariantId;
  readonly domain: OracleDomain;
  readonly input: Readonly<Record<string, string | number | boolean>>;
  readonly expected: string;
  readonly uniqueFault: string;
}

export type ArtifactReviewAcceptanceScenario = Pick<
  ArtifactReviewOracleCase,
  "invariant" | "domain" | "input"
>;

export type ArtifactReviewAcceptanceDriver = (
  scenario: ArtifactReviewAcceptanceScenario,
) => string;

export const ARTIFACT_REVIEW_ORACLE_CASES = [
  {
    id: "storage-restart-committed",
    invariant: "restart-migration",
    domain: "storage",
    input: { committed: true, acknowledged: true, restart: true },
    expected: "reload-identical",
    uniqueFault: "acknowledged review state disappears after plugin restart",
  },
  {
    id: "storage-restart-uncommitted",
    invariant: "restart-migration",
    domain: "storage",
    input: { committed: false, acknowledged: false, restart: true },
    expected: "absent-not-saved",
    uniqueFault: "uncommitted optimistic state is reported as durable",
  },
  {
    id: "storage-without-restart",
    invariant: "restart-migration",
    domain: "storage",
    input: { committed: true, acknowledged: true, restart: false },
    expected: "runtime-state-not-recovery",
    uniqueFault: "restart recovery result is claimed without a restart",
  },
  {
    id: "storage-rpc-before-migration",
    invariant: "restart-migration",
    domain: "storage",
    input: { migrated: false, artifactIntegrity: true, legacyIntegrity: true },
    expected: "migrate-before-artifact-rpc",
    uniqueFault: "artifact RPC becomes available before migrations finish",
  },
  {
    id: "storage-artifact-integrity-violation",
    invariant: "restart-migration",
    domain: "storage",
    input: { migrated: true, artifactIntegrity: false, legacyIntegrity: true },
    expected: "gate-artifact-rpc",
    uniqueFault: "artifact foreign-key damage reaches artifact RPC",
  },
  {
    id: "storage-unrelated-legacy-orphan",
    invariant: "restart-migration",
    domain: "storage",
    input: { migrated: true, artifactIntegrity: true, legacyIntegrity: false },
    expected: "log-legacy-and-continue",
    uniqueFault: "unrelated legacy orphan disables the workflows plugin",
  },
  {
    id: "storage-mixed-version-scope-backfill",
    invariant: "restart-migration",
    domain: "storage",
    input: {
      migrated: true,
      artifactIntegrity: true,
      legacyIntegrity: true,
      legacyNullScope: true,
      scopeBackfillable: true,
    },
    expected: "backfill-before-artifact-rpc",
    uniqueFault: "mixed-version null scope reaches artifact joins",
  },
  {
    id: "storage-mixed-version-scope-unresolved",
    invariant: "restart-migration",
    domain: "storage",
    input: {
      migrated: true,
      artifactIntegrity: true,
      legacyIntegrity: true,
      legacyNullScope: true,
      scopeBackfillable: false,
    },
    expected: "gate-artifact-rpc",
    uniqueFault: "unrecoverable mixed-version scope fails open",
  },
  {
    id: "migration-append-only-row-preservation",
    invariant: "migration-ledger",
    domain: "storage",
    input: { priorStatementMayHaveRun: true, existingRows: true },
    expected: "append-rebuild-preserve-rows",
    uniqueFault: "dark-schema correction edits history or drops existing rows",
  },
  {
    id: "migration-ledger-full-hash-pin",
    invariant: "migration-ledger",
    domain: "storage",
    input: { priorStatementMayHaveRun: true, priorHashChanged: true },
    expected: "reject-ledger-edit",
    uniqueFault: "a may-have-run migration changes without tripping the ledger",
  },
  {
    id: "migration-exact-pre18-quarantine-recovery",
    invariant: "pre18-quarantine-recovery",
    domain: "storage",
    input: {
      exactPre18State: true,
      migration18HashMatches: true,
      schemaFingerprintMatches: true,
      recoveryRecipeHashMatches: true,
    },
    expected: "recover-in-one-transaction",
    uniqueFault:
      "a non-exact migration state enters the bounded quarantine recovery path",
  },
  {
    id: "blob-valid-read",
    invariant: "immutable-bytes",
    domain: "storage",
    input: { blobPresent: true, digestMatches: true },
    expected: "return-verified-bytes",
    uniqueFault: "valid immutable bytes cannot be read by exact revision",
  },
  {
    id: "blob-missing-read",
    invariant: "immutable-bytes",
    domain: "storage",
    input: { blobPresent: false, digestMatches: false },
    expected: "storage-integrity-error",
    uniqueFault: "missing admitted blob is treated as empty content",
  },
  {
    id: "blob-digest-mismatch",
    invariant: "immutable-bytes",
    domain: "storage",
    input: { blobPresent: true, digestMatches: false },
    expected: "storage-integrity-error",
    uniqueFault:
      "damaged admitted bytes are returned without digest verification",
  },

  {
    id: "authority-recorded-presentation-grant",
    invariant: "origin-scope",
    domain: "authority",
    input: {
      recordedPresentation: true,
      clientScopeSupplied: false,
      originController: false,
      operation: "artifact-read",
    },
    expected: "authorize-origin-scope",
    uniqueFault: "presentation mount replaces origin campaign authority",
  },
  {
    id: "authority-wrong-presentation-thread",
    invariant: "origin-scope",
    domain: "authority",
    input: {
      recordedPresentation: false,
      clientScopeSupplied: false,
      originController: false,
      operation: "artifact-read",
    },
    expected: "wrong-scope",
    uniqueFault: "unrecorded visible thread gains artifact access",
  },
  {
    id: "authority-client-origin-scope",
    invariant: "origin-scope",
    domain: "authority",
    input: {
      recordedPresentation: true,
      clientScopeSupplied: true,
      originController: false,
      operation: "artifact-mutate",
    },
    expected: "reject-authority-input",
    uniqueFault: "client-supplied project or environment becomes authority",
  },
  {
    id: "authority-origin-cli-stop",
    invariant: "controller-authority",
    domain: "authority",
    input: {
      recordedPresentation: false,
      clientScopeSupplied: false,
      originController: true,
      operation: "generic-stop",
    },
    expected: "controller-stop",
    uniqueFault: "origin controller cannot invoke the existing stop path",
  },
  {
    id: "authority-presentation-cli-stop",
    invariant: "controller-authority",
    domain: "authority",
    input: {
      recordedPresentation: true,
      clientScopeSupplied: false,
      originController: false,
      operation: "generic-stop",
    },
    expected: "wrong-scope",
    uniqueFault: "presentation or worker CLI cancels the parent workflow run",
  },
  {
    id: "authority-cross-environment-snapshot-read",
    invariant: "cross-environment",
    domain: "authority",
    input: {
      recordedPresentation: true,
      clientScopeSupplied: false,
      originController: false,
      crossEnvironment: true,
      operation: "artifact-read",
    },
    expected: "origin-snapshot-read-only",
    uniqueFault:
      "cross-environment mount cannot read the admitted origin snapshot",
  },
  {
    id: "authority-cross-environment-source-mutation",
    invariant: "cross-environment",
    domain: "authority",
    input: {
      recordedPresentation: true,
      clientScopeSupplied: false,
      originController: false,
      crossEnvironment: true,
      operation: "source-mutate",
    },
    expected: "wrong-scope",
    uniqueFault: "cross-environment presentation migrates source authority",
  },

  {
    id: "revision-draft-is-not-admitted",
    invariant: "revision-anchor",
    domain: "revision",
    input: { revisionState: "draft" },
    expected: "draft-only",
    uniqueFault: "autosaved draft changes the active contract snapshot",
  },
  {
    id: "revision-candidate-is-not-admitted",
    invariant: "revision-anchor",
    domain: "revision",
    input: { revisionState: "accepted-pending-impact" },
    expected: "candidate-inactive",
    uniqueFault: "human acceptance alone changes the active revision",
  },
  {
    id: "revision-anchor-reanchored",
    invariant: "revision-anchor",
    domain: "revision",
    input: { revisionState: "superseded", quoteContextMatches: true },
    expected: "reanchored",
    uniqueFault:
      "deterministically matching annotation loses its revision history",
  },
  {
    id: "revision-anchor-orphaned",
    invariant: "revision-anchor",
    domain: "revision",
    input: { revisionState: "superseded", quoteContextMatches: false },
    expected: "orphaned",
    uniqueFault: "failed re-anchoring silently attaches to similar text",
  },

  {
    id: "apply-prepared-before-hash",
    invariant: "source-apply",
    domain: "apply",
    input: {
      intent: "prepared",
      source: "before",
      baseCurrent: true,
      bindingAvailable: true,
    },
    expected: "retry-cas",
    uniqueFault: "prepared intent is abandoned after restart",
  },
  {
    id: "apply-prepared-target-hash",
    invariant: "source-apply",
    domain: "apply",
    input: {
      intent: "prepared",
      source: "target",
      baseCurrent: true,
      bindingAvailable: true,
    },
    expected: "verify-finalize",
    uniqueFault: "crash after file write repeats or loses the write",
  },
  {
    id: "apply-file-applied",
    invariant: "source-apply",
    domain: "apply",
    input: {
      intent: "file-applied",
      source: "target",
      baseCurrent: true,
      bindingAvailable: true,
    },
    expected: "verify-finalize",
    uniqueFault: "file-applied state falsely reports Saved before finalization",
  },
  {
    id: "apply-third-party-edit",
    invariant: "source-apply",
    domain: "apply",
    input: {
      intent: "prepared",
      source: "other",
      baseCurrent: true,
      bindingAvailable: true,
    },
    expected: "conflict",
    uniqueFault: "reconciler overwrites a third-party edit",
  },
  {
    id: "apply-source-host-offline",
    invariant: "source-apply",
    domain: "apply",
    input: {
      intent: "prepared",
      source: "unknown",
      baseCurrent: true,
      bindingAvailable: false,
    },
    expected: "awaiting-source-host",
    uniqueFault:
      "unavailable immutable binding is mistaken for conflict or success",
  },
  {
    id: "apply-base-revision-changed",
    invariant: "revision-anchor",
    domain: "apply",
    input: {
      intent: "file-applied",
      source: "target",
      baseCurrent: false,
      bindingAvailable: true,
    },
    expected: "conflict",
    uniqueFault: "finalization silently rebases onto a newer admitted revision",
  },
  {
    id: "apply-source-migration-blocked",
    invariant: "source-apply",
    domain: "apply",
    input: {
      intent: "prepared",
      source: "before",
      baseCurrent: true,
      bindingAvailable: true,
      sourceMigration: true,
    },
    expected: "apply-in-progress",
    uniqueFault: "source migration retargets a nonterminal intent",
  },
  {
    id: "apply-competing-intent-blocked",
    invariant: "source-apply",
    domain: "apply",
    input: {
      intent: "prepared",
      source: "before",
      baseCurrent: true,
      bindingAvailable: true,
      competingApply: true,
    },
    expected: "apply-in-progress",
    uniqueFault: "two nonterminal source intents race for one artifact",
  },
  {
    id: "apply-finalized-response-loss",
    invariant: "source-apply",
    domain: "apply",
    input: {
      intent: "finalized",
      source: "target",
      baseCurrent: true,
      bindingAvailable: true,
      responseLost: true,
    },
    expected: "replay-finalized",
    uniqueFault: "response loss after finalize creates a second revision",
  },

  {
    id: "presentation-required-artifacts",
    invariant: "renderer",
    domain: "presentation",
    input: { requiredArtifactsPresent: true, contentType: "text/markdown" },
    expected: "open-review-panel",
    uniqueFault: "inspector omits requirements architecture or decisions",
  },
  {
    id: "presentation-required-artifacts-missing",
    invariant: "renderer",
    domain: "presentation",
    input: { requiredArtifactsPresent: false, contentType: "text/markdown" },
    expected: "missing-required-artifacts",
    uniqueFault: "incomplete inspector artifact set opens as reviewable",
  },
  {
    id: "presentation-markdown-selection",
    invariant: "renderer",
    domain: "presentation",
    input: { contentType: "text/markdown", selectionAnchored: true },
    expected: "durable-annotation-request",
    uniqueFault: "Markdown selection cannot create a revision-bound anchor",
  },
  {
    id: "presentation-html-preview",
    invariant: "renderer",
    domain: "presentation",
    input: { contentType: "text/html", networkDenied: true },
    expected: "preview-only",
    uniqueFault: "HTML preview receives network navigation or form capability",
  },
  {
    id: "presentation-html-network-enabled",
    invariant: "renderer",
    domain: "presentation",
    input: { contentType: "text/html", networkDenied: false },
    expected: "reject-unsafe-preview",
    uniqueFault: "network-capable HTML is accepted as a safe preview",
  },
  {
    id: "presentation-html-annotation",
    invariant: "renderer",
    domain: "presentation",
    input: { contentType: "text/html", selectionAnchored: true },
    expected: "reject-preview-annotation",
    uniqueFault: "preview-only HTML becomes a canonical annotation surface",
  },

  {
    id: "steward-concurrent-first-discussion",
    invariant: "single-steward",
    domain: "steward",
    input: { existingSteward: false, concurrentCreators: true },
    expected: "return-winning-thread",
    uniqueFault: "concurrent first discussion creates two campaign stewards",
  },
  {
    id: "steward-serial-first-discussion",
    invariant: "single-steward",
    domain: "steward",
    input: { existingSteward: false, concurrentCreators: false },
    expected: "create-thread",
    uniqueFault: "uncontended first discussion is treated as a lost race",
  },
  {
    id: "steward-subsequent-discussion",
    invariant: "single-steward",
    domain: "steward",
    input: { existingSteward: true, concurrentCreators: false },
    expected: "reuse-thread",
    uniqueFault: "later artifact discussion forks a new steward thread",
  },
  {
    id: "steward-direct-worker-steer",
    invariant: "architect-admission",
    domain: "steward",
    input: { directWorkerSteer: true },
    expected: "advisory-only",
    uniqueFault: "artifact steward directly redirects live workers",
  },
  {
    id: "steward-selected-text-seed",
    invariant: "single-steward",
    domain: "steward",
    input: {
      selectedQuoteBounded: true,
      surroundingBlockIds: true,
      fullConversationCopied: false,
    },
    expected: "seed-bounded-discussion",
    uniqueFault:
      "selected-text discussion requires an unbounded artifact reread",
  },
  {
    id: "steward-compact-revision-delta",
    invariant: "single-steward",
    domain: "steward",
    input: { compactDelta: true, fullConversationCopied: false },
    expected: "deliver-compact-delta",
    uniqueFault:
      "steward update reinjects full campaign or orchestrator context",
  },

  {
    id: "admit-editorial",
    invariant: "architect-admission",
    domain: "admission",
    input: {
      semanticClass: "editorial",
      architectVerdict: false,
      humanConfirmed: false,
      casMatches: true,
    },
    expected: "settle-editorial",
    uniqueFault: "editorial-only change unnecessarily interrupts workers",
  },
  {
    id: "admit-refinement-without-architect",
    invariant: "architect-admission",
    domain: "admission",
    input: {
      semanticClass: "refinement",
      architectVerdict: false,
      humanConfirmed: true,
      casMatches: true,
    },
    expected: "await-architecture",
    uniqueFault: "orchestrator self-classifies a refinement into admission",
  },
  {
    id: "admit-contract-without-human",
    invariant: "architect-admission",
    domain: "admission",
    input: {
      semanticClass: "contract",
      architectVerdict: true,
      humanConfirmed: false,
      casMatches: true,
    },
    expected: "await-human",
    uniqueFault: "architect result bypasses human confirmation",
  },
  {
    id: "admit-cas-conflict",
    invariant: "architect-admission",
    domain: "admission",
    input: {
      semanticClass: "architecture",
      architectVerdict: true,
      humanConfirmed: true,
      casMatches: false,
    },
    expected: "conflict-no-effects",
    uniqueFault:
      "partial interlocks or outbox rows survive an admission conflict",
  },
  {
    id: "admit-material-atomic",
    invariant: "architect-admission",
    domain: "admission",
    input: {
      semanticClass: "contract",
      architectVerdict: true,
      humanConfirmed: true,
      casMatches: true,
    },
    expected: "atomic-admission",
    uniqueFault:
      "revision becomes visible without graph, barriers, staleness, and outbox",
  },

  {
    id: "settlement-old-snapshot",
    invariant: "snapshot-races",
    domain: "settlement",
    input: {
      snapshotCurrent: false,
      interlockClear: false,
      evidenceAccepted: true,
    },
    expected: "retain-stale-reject-settlement",
    uniqueFault: "old-snapshot result settles after admission wins",
  },
  {
    id: "settlement-first-then-admission",
    invariant: "stale-evidence",
    domain: "settlement",
    input: {
      snapshotCurrent: false,
      interlockClear: true,
      evidenceAccepted: true,
      alreadyTerminal: true,
    },
    expected: "append-staleness",
    uniqueFault: "admission overwrites a historically terminal receipt",
  },
  {
    id: "settlement-current-clear",
    invariant: "snapshot-races",
    domain: "settlement",
    input: {
      snapshotCurrent: true,
      interlockClear: true,
      evidenceAccepted: true,
    },
    expected: "settle",
    uniqueFault: "shared predicate rejects current adopted evidence",
  },
  ...TERMINAL_WRITER_ORACLE.map((writer) => ({
    id: `terminal-writer-${writer}`,
    invariant: "terminal-writers" as const,
    domain: "settlement" as const,
    input: {
      writer,
      snapshotCurrent: true,
      interlockClear: false,
      evidenceAccepted: true,
    },
    expected: "retain-stale-reject-settlement",
    uniqueFault: `${writer} bypasses the shared snapshot/interlock predicate`,
  })),
  {
    id: "settlement-replay-old-snapshot",
    invariant: "snapshot-races",
    domain: "settlement",
    input: {
      snapshotCurrent: false,
      interlockClear: true,
      evidenceAccepted: false,
      replay: true,
    },
    expected: "cache-miss",
    uniqueFault: "replay cache identity omits contract snapshot",
  },
  {
    id: "settlement-no-evidence",
    invariant: "promotion",
    domain: "settlement",
    input: {
      snapshotCurrent: true,
      interlockClear: true,
      evidenceAccepted: false,
    },
    expected: "reject-evidence",
    uniqueFault: "promotion treats absent evidence as success",
  },
  {
    id: "dispatch-admission-wins",
    invariant: "snapshot-races",
    domain: "settlement",
    input: {
      operation: "dispatch",
      admissionCommittedFirst: true,
      snapshotCurrent: false,
      interlockClear: false,
      evidenceAccepted: false,
    },
    expected: "rebuild-before-dispatch",
    uniqueFault:
      "queued work dispatches on the old snapshot after admission wins",
  },
  {
    id: "dispatch-wins-before-admission",
    invariant: "snapshot-races",
    domain: "settlement",
    input: {
      operation: "dispatch",
      admissionCommittedFirst: false,
      snapshotCurrent: true,
      interlockClear: true,
      evidenceAccepted: false,
    },
    expected: "dispatch-bound-snapshot",
    uniqueFault:
      "dispatch omits the immutable snapshot used by the later admission race",
  },

  {
    id: "transition-same-target-chain",
    invariant: "snapshot-races",
    domain: "transition",
    input: {
      priorAffectedSequence: 8,
      admittedSequence: 9,
      oldSnapshotIsPriorNewSnapshot: true,
    },
    expected: "append-exact-edge",
    uniqueFault:
      "same-target N+1 chains from the still-adopted snapshot instead of N",
  },
  {
    id: "transition-same-target-broken-chain",
    invariant: "snapshot-races",
    domain: "transition",
    input: {
      priorAffectedSequence: 8,
      admittedSequence: 9,
      oldSnapshotIsPriorNewSnapshot: false,
    },
    expected: "reject-broken-edge",
    uniqueFault:
      "controller admits an invented or skipped same-target snapshot edge",
  },
  {
    id: "transition-disjoint-bridge",
    invariant: "snapshot-races",
    domain: "transition",
    input: {
      disjointInterveningSequence: 9,
      admittedSequence: 10,
      bridgeFromAdoptedSnapshot: true,
    },
    expected: "append-disjoint-bridge",
    uniqueFault:
      "disjoint campaign change forces a target to acknowledge a nonexistent affected edge",
  },

  {
    id: "delivery-n-before-n-plus-one",
    invariant: "ordered-delivery",
    domain: "delivery",
    input: { lowestUnsettled: true, targetSequence: 8, claimedSequence: 8 },
    expected: "claim",
    uniqueFault: "same-target N+1 overtakes N",
  },
  {
    id: "delivery-block-n-plus-one",
    invariant: "ordered-delivery",
    domain: "delivery",
    input: { lowestUnsettled: true, targetSequence: 8, claimedSequence: 9 },
    expected: "wait",
    uniqueFault: "same-target claimed sequence can skip the target sequence",
  },
  {
    id: "delivery-not-lowest-unsettled",
    invariant: "ordered-delivery",
    domain: "delivery",
    input: { lowestUnsettled: false, targetSequence: 8, claimedSequence: 8 },
    expected: "wait",
    uniqueFault: "blocked or leased N fails to hold the lowest target row",
  },
  {
    id: "delivery-expired-lease",
    invariant: "ordered-delivery",
    domain: "delivery",
    input: {
      lowestUnsettled: true,
      leaseExpired: true,
      targetSequence: 8,
      claimedSequence: 8,
    },
    expected: "reclaim",
    uniqueFault: "restart strands an expired delivery lease",
  },
  {
    id: "delivery-current-child",
    invariant: "ordered-delivery",
    domain: "delivery",
    input: {
      lowestUnsettled: true,
      childReattached: true,
      targetSequence: 8,
      claimedSequence: 8,
    },
    expected: "resolve-current-child-and-send",
    uniqueFault: "durable address stores obsolete child thread",
  },
  {
    id: "delivery-terminal-target",
    invariant: "stale-evidence",
    domain: "delivery",
    input: {
      lowestUnsettled: true,
      targetTerminal: true,
      targetSequence: 8,
      claimedSequence: 8,
    },
    expected: "stale-and-replan",
    uniqueFault: "dispatcher messages a target that settled before delivery",
  },
  {
    id: "delivery-attempt-budget",
    invariant: "ordered-delivery",
    domain: "delivery",
    input: {
      lowestUnsettled: true,
      attemptsExhausted: true,
      targetSequence: 8,
      claimedSequence: 8,
    },
    expected: "visible-blocked",
    uniqueFault: "failed delivery disappears or promotes",
  },
  {
    id: "delivery-disjoint-target-progress",
    invariant: "ordered-delivery",
    domain: "delivery",
    input: {
      lowestUnsettled: true,
      disjointTarget: true,
      targetSequence: 9,
      claimedSequence: 9,
    },
    expected: "claim-disjoint",
    uniqueFault:
      "one target's unsettled change globally serializes all delivery",
  },
  {
    id: "delivery-provider-cannot-steer",
    invariant: "ordered-delivery",
    domain: "delivery",
    input: {
      lowestUnsettled: true,
      providerCanSteer: false,
      targetSequence: 8,
      claimedSequence: 8,
    },
    expected: "retain-interlock-retry",
    uniqueFault: "provider steering failure clears the durable interlock",
  },

  {
    id: "ack-exact-lowest-edge",
    invariant: "acknowledgement",
    domain: "ack",
    input: {
      trustedCall: true,
      lowestPending: true,
      priorMatches: true,
      edgeAdmitted: true,
      edgeSequence: 8,
      campaignHighWatermark: 9,
      duplicate: false,
    },
    expected: "adopt-edge",
    uniqueFault:
      "valid acknowledgement requires latest campaign edge rather than its exact edge",
  },
  {
    id: "ack-wrong-thread",
    invariant: "acknowledgement",
    domain: "ack",
    input: {
      trustedCall: false,
      lowestPending: true,
      priorMatches: true,
      edgeAdmitted: true,
      duplicate: false,
    },
    expected: "wrong-scope",
    uniqueFault: "model-supplied call or thread IDs become authority",
  },
  {
    id: "ack-skips-pending",
    invariant: "acknowledgement",
    domain: "ack",
    input: {
      trustedCall: true,
      lowestPending: false,
      priorMatches: true,
      edgeAdmitted: true,
      duplicate: false,
    },
    expected: "ack-conflict",
    uniqueFault: "worker skips an affected transition",
  },
  {
    id: "ack-wrong-prior",
    invariant: "acknowledgement",
    domain: "ack",
    input: {
      trustedCall: true,
      lowestPending: true,
      priorMatches: false,
      edgeAdmitted: true,
      duplicate: false,
    },
    expected: "ack-conflict",
    uniqueFault: "worker acknowledges from an invented snapshot",
  },
  {
    id: "ack-exact-retry",
    invariant: "acknowledgement",
    domain: "ack",
    input: {
      trustedCall: true,
      lowestPending: true,
      priorMatches: true,
      edgeAdmitted: true,
      duplicate: true,
      duplicateMatches: true,
    },
    expected: "replay-ack",
    uniqueFault: "response loss after ack creates a conflicting second receipt",
  },
  {
    id: "ack-retry-different-outcome",
    invariant: "acknowledgement",
    domain: "ack",
    input: {
      trustedCall: true,
      lowestPending: true,
      priorMatches: true,
      edgeAdmitted: true,
      duplicate: true,
      duplicateMatches: false,
    },
    expected: "ack-conflict",
    uniqueFault: "same receipt identity changes outcome",
  },
  {
    id: "ack-nonadmitted-edge",
    invariant: "acknowledgement",
    domain: "ack",
    input: {
      trustedCall: true,
      lowestPending: true,
      priorMatches: true,
      edgeAdmitted: false,
      duplicate: false,
    },
    expected: "ack-conflict",
    uniqueFault:
      "worker acknowledges an edge outside the immutable campaign chain",
  },
  {
    id: "ack-blocked-persists",
    invariant: "acknowledgement",
    domain: "ack",
    input: {
      trustedCall: true,
      lowestPending: true,
      priorMatches: true,
      edgeAdmitted: true,
      duplicate: false,
      outcome: "blocked",
    },
    expected: "record-blocked-keep-interlock",
    uniqueFault: "blocked acknowledgement advances the adopted snapshot",
  },
  {
    id: "ack-stop-required-persists",
    invariant: "controller-authority",
    domain: "ack",
    input: {
      trustedCall: true,
      lowestPending: true,
      priorMatches: true,
      edgeAdmitted: true,
      duplicate: false,
      outcome: "stop-required",
    },
    expected: "controller-whole-run-fallback",
    uniqueFault: "worker directly invokes whole-run stop from acknowledgement",
  },

  {
    id: "promotion-current-complete",
    invariant: "promotion",
    domain: "promotion",
    input: {
      snapshotCurrent: true,
      evidenceAccepted: true,
      interlocksClear: true,
      acknowledgementsComplete: true,
      requiredReverificationComplete: true,
    },
    expected: "promote",
    uniqueFault: "complete current-snapshot closure cannot promote",
  },
  {
    id: "promotion-pending-acknowledgement",
    invariant: "promotion",
    domain: "promotion",
    input: {
      snapshotCurrent: true,
      evidenceAccepted: true,
      interlocksClear: false,
      acknowledgementsComplete: false,
      requiredReverificationComplete: true,
    },
    expected: "block-promotion",
    uniqueFault: "promotion treats delivery as worker adoption",
  },
  {
    id: "promotion-stale-evidence",
    invariant: "stale-evidence",
    domain: "promotion",
    input: {
      snapshotCurrent: false,
      evidenceAccepted: true,
      interlocksClear: true,
      acknowledgementsComplete: true,
      requiredReverificationComplete: false,
    },
    expected: "retain-history-require-reverification",
    uniqueFault:
      "historical green evidence promotes after an affecting transition",
  },
  {
    id: "promotion-reverification-complete",
    invariant: "stale-evidence",
    domain: "promotion",
    input: {
      snapshotCurrent: true,
      evidenceAccepted: true,
      interlocksClear: true,
      acknowledgementsComplete: true,
      requiredReverificationComplete: true,
      historicalEvidenceRetained: true,
    },
    expected: "promote-with-history",
    uniqueFault:
      "reverification erases the historical stale receipt instead of appending closure",
  },

  {
    id: "rollout-default",
    invariant: "off-by-default",
    domain: "rollout",
    input: { definitionEnabled: false, explicitTestCampaign: false },
    expected: "disabled",
    uniqueFault: "live steering becomes default-on",
  },
  {
    id: "rollout-definition-enabled-nontest",
    invariant: "off-by-default",
    domain: "rollout",
    input: { definitionEnabled: true, explicitTestCampaign: false },
    expected: "disabled",
    uniqueFault: "definition gate enables every campaign",
  },
  {
    id: "rollout-explicit-test",
    invariant: "off-by-default",
    domain: "rollout",
    input: { definitionEnabled: true, explicitTestCampaign: true },
    expected: "enabled",
    uniqueFault: "explicit test campaign cannot exercise the gated stack",
  },

  {
    id: "repair-first-bounded",
    invariant: "one-repair-policy",
    domain: "repair",
    input: {
      repairAttempts: 0,
      sameSeamRepeated: false,
      crossUnitSignal: false,
      approachFinding: false,
    },
    expected: "allow-one-repair",
    uniqueFault: "first bounded production defect escalates prematurely",
  },
  {
    id: "repair-second-same-seam",
    invariant: "one-repair-policy",
    domain: "repair",
    input: {
      repairAttempts: 1,
      sameSeamRepeated: true,
      crossUnitSignal: false,
      approachFinding: false,
    },
    expected: "architecture-synthesis",
    uniqueFault: "micro-patch churn continues on the same seam",
  },
  {
    id: "repair-cross-unit",
    invariant: "one-repair-policy",
    domain: "repair",
    input: {
      repairAttempts: 0,
      sameSeamRepeated: false,
      crossUnitSignal: true,
      approachFinding: false,
    },
    expected: "architecture-synthesis",
    uniqueFault: "shared assumption is patched independently in sibling units",
  },
  {
    id: "repair-approach-finding",
    invariant: "one-repair-policy",
    domain: "repair",
    input: {
      repairAttempts: 0,
      sameSeamRepeated: false,
      crossUnitSignal: false,
      approachFinding: true,
    },
    expected: "architecture-synthesis",
    uniqueFault:
      "approach or dependency finding is misclassified as local repair",
  },

  {
    id: "retention-automatic-cleanup",
    invariant: "retention",
    domain: "retention",
    input: { automatic: true, referenced: false, humanConfirmed: false },
    expected: "disabled",
    uniqueFault: "background retention silently deletes review history",
  },
  {
    id: "retention-referenced-explicit-purge",
    invariant: "retention",
    domain: "retention",
    input: { automatic: false, referenced: true, humanConfirmed: true },
    expected: "restrict",
    uniqueFault: "confirmed purge deletes a still-referenced blob or revision",
  },
  {
    id: "retention-unreferenced-explicit-purge",
    invariant: "retention",
    domain: "retention",
    input: { automatic: false, referenced: false, humanConfirmed: true },
    expected: "explicit-purge",
    uniqueFault:
      "safe explicit cleanup cannot remove unreachable campaign data",
  },
] as const satisfies readonly ArtifactReviewOracleCase[];

function bool(
  input: Readonly<Record<string, string | number | boolean>>,
  key: string,
): boolean {
  return input[key] === true;
}

/**
 * Oracle-owned contract evaluator. It derives outcomes only from scenario
 * inputs and the accepted contract rules; expected outcomes and fault labels
 * are deliberately excluded from its input type.
 */
export function evaluateArtifactReviewContract(
  scenario: ArtifactReviewAcceptanceScenario,
): string {
  const input = scenario.input;
  switch (scenario.domain) {
    case "storage":
      if (input.exactPre18State !== undefined)
        return bool(input, "exactPre18State") &&
          bool(input, "migration18HashMatches") &&
          bool(input, "schemaFingerprintMatches") &&
          bool(input, "recoveryRecipeHashMatches")
          ? "recover-in-one-transaction"
          : "fail-closed";
      if (bool(input, "priorHashChanged")) return "reject-ledger-edit";
      if (bool(input, "priorStatementMayHaveRun"))
        return bool(input, "existingRows")
          ? "append-rebuild-preserve-rows"
          : "append-correction";
      if (input.blobPresent !== undefined)
        return bool(input, "blobPresent") && bool(input, "digestMatches")
          ? "return-verified-bytes"
          : "storage-integrity-error";
      if (bool(input, "legacyNullScope"))
        return bool(input, "scopeBackfillable")
          ? "backfill-before-artifact-rpc"
          : "gate-artifact-rpc";
      if (input.migrated === false) return "migrate-before-artifact-rpc";
      if (input.artifactIntegrity === false) return "gate-artifact-rpc";
      if (input.legacyIntegrity === false) return "log-legacy-and-continue";
      if (input.restart === false) return "runtime-state-not-recovery";
      return bool(input, "committed") && bool(input, "acknowledged")
        ? "reload-identical"
        : "absent-not-saved";
    case "authority":
      if (bool(input, "clientScopeSupplied")) return "reject-authority-input";
      if (input.operation === "generic-stop")
        return bool(input, "originController")
          ? "controller-stop"
          : "wrong-scope";
      if (!bool(input, "recordedPresentation")) return "wrong-scope";
      if (bool(input, "crossEnvironment"))
        return input.operation === "artifact-read"
          ? "origin-snapshot-read-only"
          : "wrong-scope";
      return "authorize-origin-scope";
    case "revision":
      if (input.revisionState === "draft") return "draft-only";
      if (input.revisionState === "accepted-pending-impact")
        return "candidate-inactive";
      return bool(input, "quoteContextMatches") ? "reanchored" : "orphaned";
    case "apply":
      if (input.intent === "finalized" && bool(input, "responseLost"))
        return "replay-finalized";
      if (bool(input, "sourceMigration") || bool(input, "competingApply"))
        return "apply-in-progress";
      if (!bool(input, "bindingAvailable")) return "awaiting-source-host";
      if (!bool(input, "baseCurrent") || input.source === "other")
        return "conflict";
      if (input.source === "target") return "verify-finalize";
      return input.source === "before" ? "retry-cas" : "conflict";
    case "presentation":
      if (input.contentType === "text/html") {
        if (input.networkDenied === false) return "reject-unsafe-preview";
        return bool(input, "selectionAnchored")
          ? "reject-preview-annotation"
          : "preview-only";
      }
      if (input.requiredArtifactsPresent === false)
        return "missing-required-artifacts";
      return bool(input, "selectionAnchored")
        ? "durable-annotation-request"
        : "open-review-panel";
    case "steward":
      if (bool(input, "directWorkerSteer")) return "advisory-only";
      if (bool(input, "selectedQuoteBounded")) return "seed-bounded-discussion";
      if (bool(input, "compactDelta")) return "deliver-compact-delta";
      if (bool(input, "existingSteward")) return "reuse-thread";
      return bool(input, "concurrentCreators")
        ? "return-winning-thread"
        : "create-thread";
    case "admission":
      if (input.semanticClass === "editorial") return "settle-editorial";
      if (!bool(input, "architectVerdict")) return "await-architecture";
      if (!bool(input, "humanConfirmed")) return "await-human";
      return bool(input, "casMatches")
        ? "atomic-admission"
        : "conflict-no-effects";
    case "settlement":
      if (input.operation === "dispatch")
        return bool(input, "admissionCommittedFirst")
          ? "rebuild-before-dispatch"
          : "dispatch-bound-snapshot";
      if (bool(input, "replay") && !bool(input, "snapshotCurrent"))
        return "cache-miss";
      if (bool(input, "alreadyTerminal") && !bool(input, "snapshotCurrent"))
        return "append-staleness";
      if (!bool(input, "evidenceAccepted")) return "reject-evidence";
      return bool(input, "snapshotCurrent") && bool(input, "interlockClear")
        ? "settle"
        : "retain-stale-reject-settlement";
    case "transition":
      if (input.disjointInterveningSequence !== undefined)
        return bool(input, "bridgeFromAdoptedSnapshot")
          ? "append-disjoint-bridge"
          : "reject-broken-edge";
      return bool(input, "oldSnapshotIsPriorNewSnapshot")
        ? "append-exact-edge"
        : "reject-broken-edge";
    case "delivery":
      if (bool(input, "targetTerminal")) return "stale-and-replan";
      if (!bool(input, "lowestUnsettled")) return "wait";
      if (input.targetSequence !== input.claimedSequence) return "wait";
      if (bool(input, "attemptsExhausted")) return "visible-blocked";
      if (input.providerCanSteer === false) return "retain-interlock-retry";
      if (bool(input, "disjointTarget")) return "claim-disjoint";
      if (bool(input, "childReattached"))
        return "resolve-current-child-and-send";
      if (bool(input, "leaseExpired")) return "reclaim";
      return "claim";
    case "ack":
      if (bool(input, "duplicate"))
        return bool(input, "duplicateMatches") ? "replay-ack" : "ack-conflict";
      if (!bool(input, "trustedCall")) return "wrong-scope";
      if (input.outcome === "blocked") return "record-blocked-keep-interlock";
      if (input.outcome === "stop-required")
        return "controller-whole-run-fallback";
      return bool(input, "lowestPending") &&
        bool(input, "priorMatches") &&
        bool(input, "edgeAdmitted")
        ? "adopt-edge"
        : "ack-conflict";
    case "promotion":
      if (!bool(input, "snapshotCurrent"))
        return "retain-history-require-reverification";
      if (
        !bool(input, "evidenceAccepted") ||
        !bool(input, "interlocksClear") ||
        !bool(input, "acknowledgementsComplete") ||
        !bool(input, "requiredReverificationComplete")
      )
        return "block-promotion";
      return bool(input, "historicalEvidenceRetained")
        ? "promote-with-history"
        : "promote";
    case "rollout":
      return bool(input, "definitionEnabled") &&
        bool(input, "explicitTestCampaign")
        ? "enabled"
        : "disabled";
    case "repair":
      return bool(input, "sameSeamRepeated") ||
        bool(input, "crossUnitSignal") ||
        bool(input, "approachFinding") ||
        Number(input.repairAttempts) >= 1
        ? "architecture-synthesis"
        : "allow-one-repair";
    case "retention":
      if (bool(input, "automatic")) return "disabled";
      if (bool(input, "referenced")) return "restrict";
      return bool(input, "humanConfirmed") ? "explicit-purge" : "disabled";
  }
}

export const MIGRATION_ORACLE = {
  mode: "append-only-non-destructive",
  profileBeforeMigration: [
    "journal_mode=WAL",
    "synchronous=FULL",
    "foreign_keys=ON",
    "busy_timeout>=5000",
  ],
  artifactScopedIntegrity: true,
  artifactRpcRegistrationAfterMigration: true,
  artifactRpcRemainsDarkAfterRecovery: true,
  artifactUiRendererRemainsDarkAfterRecovery: true,
  preserveLegacyOrphans: true,
  pinEveryMayHaveRunStatement: true,
  rebuildIdentityWithoutPresentationThread: true,
  rebuildPreservesExistingRows: true,
  mutationPrimaryKeyExcludesOperationKind: true,
  normalizeLegacyNullScopeBeforeArtifactJoin: true,
} as const;

/** Contract-owned immutable migration 22; production may adopt these exact bytes only after review. */
export const RECOVERY_MIGRATION_22_SQL = `
  CREATE TABLE workflow_artifact_recovery_components (
    recovery_id TEXT NOT NULL,
    component_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    collision_classes_json TEXT NOT NULL CHECK(json_valid(collision_classes_json)),
    canonical_component_sha256 TEXT NOT NULL CHECK(length(canonical_component_sha256) = 64),
    row_count INTEGER NOT NULL CHECK(row_count >= 1),
    blob_count INTEGER NOT NULL CHECK(blob_count >= 0),
    adopted_at INTEGER NOT NULL,
    PRIMARY KEY (recovery_id, component_id)
  );
  CREATE TABLE workflow_artifact_recovery_rows (
    recovery_id TEXT NOT NULL,
    component_id TEXT NOT NULL,
    row_ordinal INTEGER NOT NULL CHECK(row_ordinal >= 0),
    table_name TEXT NOT NULL CHECK(table_name IN ('workflow_artifacts', 'workflow_artifact_revisions', 'workflow_artifact_annotations', 'workflow_artifact_working_drafts', 'workflow_artifact_decisions', 'workflow_artifact_stewards', 'workflow_artifact_mutations', 'workflow_artifact_apply_intents')),
    campaign_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    presentation_thread_id TEXT NOT NULL,
    row_id TEXT,
    artifact_id TEXT,
    artifact_revision INTEGER,
    blob_sha256 TEXT,
    canonical_primary_key_json TEXT NOT NULL CHECK(json_valid(canonical_primary_key_json)),
    relationships_json TEXT NOT NULL CHECK(json_valid(relationships_json)),
    canonical_row_encoding BLOB NOT NULL,
    canonical_row_sha256 TEXT NOT NULL CHECK(length(canonical_row_sha256) = 64),
    PRIMARY KEY (recovery_id, component_id, row_ordinal),
    FOREIGN KEY (recovery_id, component_id)
      REFERENCES workflow_artifact_recovery_components(recovery_id, component_id)
      ON DELETE RESTRICT
  );
  CREATE TABLE workflow_artifact_recovery_blobs (
    recovery_id TEXT NOT NULL,
    component_id TEXT NOT NULL,
    sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
    content_type TEXT NOT NULL,
    content BLOB NOT NULL,
    byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
    created_at INTEGER NOT NULL,
    CHECK(length(content) = byte_length),
    PRIMARY KEY (recovery_id, component_id, sha256),
    FOREIGN KEY (recovery_id, component_id)
      REFERENCES workflow_artifact_recovery_components(recovery_id, component_id)
      ON DELETE RESTRICT
  );
  CREATE TABLE workflow_artifact_recovery_receipts (
    recovery_id TEXT PRIMARY KEY,
    descriptor_sha256 TEXT NOT NULL CHECK(length(descriptor_sha256) = 64),
    recovery_recipe_sha256 TEXT NOT NULL CHECK(length(recovery_recipe_sha256) = 64),
    pre_schema_fingerprint_sha256 TEXT NOT NULL CHECK(length(pre_schema_fingerprint_sha256) = 64),
    migration_18_sha256 TEXT NOT NULL CHECK(length(migration_18_sha256) = 64),
    active_graph_sha256 TEXT NOT NULL CHECK(length(active_graph_sha256) = 64),
    quarantine_graph_sha256 TEXT NOT NULL CHECK(length(quarantine_graph_sha256) = 64),
    staged_row_count INTEGER NOT NULL CHECK(staged_row_count >= 0),
    restored_grant_count INTEGER NOT NULL CHECK(restored_grant_count >= 0),
    adopted_at INTEGER NOT NULL
  );` as const;

export const RECOVERY_MIGRATION_SHA256 = [
  [0, "cb3f719d56d0d09658bef9a0f021ed11496d29c58d9d9c078d239f9dbe78afa6"],
  [1, "25757204d3d451e18471a5122c763c0713f59ea85372aa0ed49400bf599e5071"],
  [2, "caf5bb39ebbd7372639f2421d50ce8427231529489c25c30d1ca71c105ac603d"],
  [3, "d2b6765d51e13028cc32da4b8668d00468a97ae02be20bce217099d6362d3ea1"],
  [4, "ba7ff8bfedbd1f8dc16210aede0bd5deeeb4b340090022355629730d6dd54c14"],
  [5, "8f7b44eb0118c659b96d5f867e01b4fb2a126891c5f3a6dc499641be742337b1"],
  [6, "e2cfdd1965dbb3320046ee9ea102f118a1392a570bc5074ca058ae5e507d7465"],
  [7, "eac1a950ae997157aaa3c69c13065ee3d8e74e4e733b1e371c290160a71b9337"],
  [8, "a8fb5039dfa92cad024ee86cd5982e28ac541c7c4a96b0b0db5544889372c1d2"],
  [9, "e9288122a6224c3e6d88f56a45c88900157d7161425fefcf83ead399db6f9b89"],
  [10, "bc4f2cb47b1c15a87b574678dadf01ea9dbe424a2e71253cbeb1a9cec9829c4d"],
  [11, "89f614b25f424c27f61d6308f1d93373420fff3cea5a4958b471668bf31ccf24"],
  [12, "5c980eccd9a3a40da158ef41806df8f212b494cbc60b2768762bf05fe58c09c2"],
  [13, "5951a693ab7a49e5f1b4cecb2e4bc6385853584de204f48b974aaa3fb19e2bfa"],
  [14, "1767f3322d25f443f073ff49cada30950ace97d2d348d57696d1baeee7d7a3e3"],
  [15, "65e86c96105b3f48f8e0faa5f168e7f5e0d66f916cd4c1ea6d6f8a8a89111f83"],
  [16, "5b44b70d6b98aa04374afeefff2860733465d4a1156ac33917b15646073014d8"],
  [17, "d147cd626d4887587d4efa99fea9a9f801960d6c9c18b0fb8ac6c9a0b636f01e"],
  [18, "aa760982bf7d933ab902f867062d4c11482e64a177b49db5ccdf3ec56dc0f91d"],
  [19, "03afb93d68a7018bed783ce9bb72665b52a9c6f544564956d35dbda7d65997a3"],
  [20, "1d0f7ebcbc92d9bc7e175a4b70ac430ef42498191b4c57ff46620f82af17434e"],
  [21, "57defc2f33da6307d6887fcb357dcf030fd614b56a342f310796ae1fe2b81e14"],
  [22, "045811cf8748bb6ca9a33242449f58a2c72dc8e42972e4acc63f2807bef0053e"],
] as const satisfies readonly (readonly [number, string])[];

export const RECOVERY_RECIPE_MANIFEST = {
  recoveryId: "artifact-review-v6:hash-bound-pre18-quarantine-recovery-v1",
  beforeMigrationId: 18,
  stageTables: [
    "workflow_artifacts",
    "workflow_artifact_revisions",
    "workflow_artifact_annotations",
    "workflow_artifact_working_drafts",
    "workflow_artifact_decisions",
    "workflow_artifact_stewards",
    "workflow_artifact_mutations",
    "workflow_artifact_apply_intents",
    "workflow_artifact_blobs",
  ],
  collisionClasses: [
    "artifact-title",
    "artifact-content-type",
    "revision-blob",
    "revision-status",
    "revision-source-binding",
    "annotation-dependent-row",
    "working-draft-dependent-row",
    "decision-dependent-row",
    "steward-dependent-row",
    "mutation-dependent-row",
    "apply-intent-dependent-row",
    "artifact-kind-partial-unique",
    "admitted-revision-partial-unique",
    "active-apply-partial-unique",
    "steward-thread-partial-unique",
    "mutation-identity-partial-unique",
  ],
  transactionSteps: [
    "admit-exact-ledger-schema-host-and-migration-hashes",
    "classify-complete-origin-components",
    "stage-typed-rows-relationships-provenance-encodings-and-blobs",
    "remove-only-staged-components-from-working-v1",
    "execute-immutable-migrations-18-through-22",
    "restore-presentation-mounts-only-as-grants",
    "adopt-quarantine-and-immutable-recovery-receipt",
    "verify-active-and-quarantine-row-byte-parity",
    "write-separate-host-recovery-ledger-identity",
  ],
  parity: [
    "per-table-row-count",
    "per-row-canonical-sha256",
    "relationship-closure",
    "presentation-provenance",
    "referenced-blob-count",
    "referenced-blob-byte-length",
    "referenced-blob-sha256",
  ],
  prohibitions: [
    "no-winner-by-thread-time-row-order-title-or-digest",
    "no-synthesized-active-artifact-for-conflicting-origin",
    "no-edit-forge-renumber-or-skip-immutable-migration",
    "no-row-or-byte-loss",
    "no-presentation-scope-authority",
    "no-live-change-enablement",
    "no-post-recovery-artifact-rpc-activation",
    "no-post-recovery-ui-or-renderer-activation",
  ],
} as const;

export const RECOVERY_PRE18_LEDGER_ORACLE = Array.from(
  { length: 18 },
  (_, id) => ({ id, appliedAt: id }),
);

export const RECOVERY_DESCRIPTOR_ORACLE = {
  recoveryId: RECOVERY_RECIPE_MANIFEST.recoveryId,
  beforeMigrationId: 18,
  migration18Sha256:
    "aa760982bf7d933ab902f867062d4c11482e64a177b49db5ccdf3ec56dc0f91d",
  preSchemaFingerprintAlgorithm:
    "SHA-256(JSON.stringify sqlite_master rows ordered by type,name,tbl_name; keys type,name,tableName,sql)",
  preSchemaFingerprintSha256:
    "51a8174aa115545aebc378063c3d1a612ab5561ea22932bd744dea0506fa5afa",
  recoveryRecipeSha256:
    "a13f7073da036d0f163b640779710327cd88dca9b2cd75259aef39a0afe5c6b5",
} as const;

export const RECOVERY_STATE_ORACLE = [
  ["fresh", "ordinary-append-only"],
  ["migration-18-applied", "ordinary-append-only"],
  ["exact-blocked-pre18", "recover-in-one-transaction"],
  ["failed-ledger", "fail-closed"],
  ["noncontiguous-ledger", "fail-closed"],
  ["future-ledger", "fail-closed"],
  ["malformed-ledger", "fail-closed"],
  ["partial-recovery", "fail-closed"],
  ["migration-hash-mismatch", "fail-closed"],
  ["schema-fingerprint-mismatch", "fail-closed"],
  ["recovery-recipe-hash-mismatch", "fail-closed"],
  ["old-host-without-v2", "fail-closed"],
] as const;

export const RECOVERY_FAULT_POINTS = [
  "post-admission-pre-first-write",
  ...RECOVERY_RECIPE_MANIFEST.stageTables.map((table) => `stage:${table}`),
  "remove-staged-components",
  "migration:18",
  "migration-ledger:18",
  "migration:19",
  "migration-ledger:19",
  "migration:20",
  "migration-ledger:20",
  "migration:21",
  "migration-ledger:21",
  "migration:22",
  "migration-ledger:22",
  "restore-presentation-grants",
  "adopt-quarantine",
  "write-recovery-receipt",
  "verify-active-integrity",
  "verify-quarantine-integrity",
  "write-host-recovery-ledger",
] as const;

export const RECOVERY_EDGE_ORACLE = [
  ["collision-free-origin", "canonical-active-artifact"],
  ...RECOVERY_RECIPE_MANIFEST.collisionClasses.map(
    (collision) =>
      [collision, "reversible-quarantine-no-active-artifact"] as const,
  ),
  ["zero-colliding-origins", "no-quarantine-components"],
  ["one-colliding-origin", "one-complete-quarantine-component"],
  ["many-colliding-origins", "all-complete-quarantine-components"],
  ["every-v1-table-row-parity", "identical-canonical-row-multiset"],
  ["referenced-blob-byte-parity", "identical-byte-multiset"],
  ["restart-after-success", "idempotent-recovery-receipt"],
  ["restart-after-fault", "original-pre18-state"],
  ["active-corruption", "rollback-and-fail-closed"],
  ["quarantine-corruption", "rollback-and-fail-closed"],
  ["service-before-migration-21", "startup-rejected"],
  ["artifact-rpc-before-recovery", "startup-rejected"],
  ["artifact-rpc-after-recovery", "disabled"],
  ["artifact-ui-renderer-after-recovery", "disabled"],
  ["live-change-request-after-recovery", "disabled"],
] as const;

export const REQUIRED_ARTIFACT_KINDS = [
  "requirements",
  "architecture",
  "decisions",
] as const;
