# Agent browser control: risk gate

Approach under review: BB-owned single-controller broker plus a thin official
provider-neutral browser-control plugin.

Constraint descent summary: Electron remains the page owner; server core owns
grant/lease/command policy; the plugin owns agent-facing tools and CLI. The
first proof is snapshot-only for one active visible tab.

## Blockers

No known blocker prevents a snapshot-only walking skeleton. Broad interaction
remains blocked until the access-boundary and content-egress red-team gate is
completed.

## Mitigatable risks

- **[S3×L2]** Two BB windows claim the same logical tab, or stale metadata points
  at a different native view -> an action reaches the wrong signed-in session ->
  detect duplicate claims, owner mismatch, and lease-generation mismatch -> use
  an opaque user-granted single-writer lease with compare-and-swap generation;
  include exact controller, thread, and tab identity in every command; fail closed
  on ambiguity -> residual risk is user selection of the wrong visible tab.
- **[S3×L2]** A snapshot or later semantic output includes customer data,
  password values, cookies, storage, or hidden page content -> authenticated
  information leaves the visible browser boundary -> detect with adversarial
  pages and payload inspection tests -> begin with a bounded visible bitmap;
  never expose cookies/storage/raw JavaScript/password values; make the grant
  visibly connected and revocable in the UI until disconnect -> residual risk
  is sensitive content that is genuinely visible in the screenshot.
- **[S3×L2]** Untrusted page text instructs the agent to take a destructive or
  off-task action -> browser control amplifies prompt injection -> detect with an
  agent eval set containing hostile page content and destructive action attempts
  -> label page output as untrusted, expose only bounded operations, require
  confirmation for destructive/high-impact actions, and retain origin/navigation
  policy -> residual risk is social engineering within otherwise allowed actions.
- **[S2×L3]** Plugin realtime wakes every connected client -> multiple clients
  attempt one command or a passive web client acts as controller -> detect
  duplicate completion/claim telemetry -> realtime may notify but never
  authorize; server lease ownership is the only execution gate and rejects all
  non-owners -> residual is harmless redundant wakeup traffic.
- **[S2×L2]** The controller disconnects, reloads, or is revoked while a tool call
  waits -> calls hang or late results complete against a replacement lease ->
  detect timeout, socket close, and generation mismatch -> use request IDs,
  bounded deadlines, abort propagation, idempotent completion, and cleanup on
  disconnect/revoke -> residual is a surfaced retry the agent may need to make.
- **[S2×L2]** The SPA runs against an older desktop shell -> optional IPC methods
  are missing or a new message is rejected -> detect capability negotiation and
  explicit unsupported responses -> feature-detect new desktop operations and
  make old shells fail as unavailable; if any host-daemon wire changes, increment
  `HOST_DAEMON_PROTOCOL_VERSION` -> residual is temporary unavailability during
  upgrade, not a reconnect loop.
- **[S2×L2]** Thread-synced inactive tab metadata has no live native view -> the
  broker silently loads a stale URL or captures nothing -> detect missing active
  controller/view state -> require an active, visible, attached tab for the first
  proof and never auto-materialize inactive metadata -> residual is an explicit
  user step to activate the tab.
- **[S2×L2]** Captured image size exceeds a provider, server, or connector limit ->
  tool completion fails after successful capture -> measure actual end-to-end
  payload limits in the spike -> bound dimensions/quality and reject oversize
  output before completion -> residual is reduced visual fidelity on very large
  pages.

## Biggest unknowns and ordered spikes

1. **Can one exact live controller complete one screenshot tool call?** Build the
   snapshot-only walking skeleton. This has the most power to invalidate A.
2. **What are the real end-to-end image size and latency limits?** Record encoded
   bytes and timings at capture, server completion, daemon receipt, and provider
   result. This changes capture policy, not the approach unless no safe bound works.
3. **Can access and data egress be kept narrow under adversarial use?** Before
   enabling interaction or broader rollout, run a full tailored security/DLP
   red-team covering wrong-target races, revocation, hidden/secret data, hostile
   page instructions, and non-desktop clients.

## Transition and rollout matrix

| State / transition | Expected contract | Required proof |
| --- | --- | --- |
| Feature disabled or plugin absent | Existing browser behavior is byte-for-byte unaffected; control tools are absent/unavailable | Existing browser tests plus absence of new controller registration |
| No user grant | Snapshot and action requests fail closed | Tool/SDK/CLI contract tests |
| One granted live desktop tab | Only the exact lease owner can snapshot it | Walking-skeleton integration test and manual visual QA |
| Multiple connected app clients | Notifications may broadcast; only one lease owner may claim/complete | Duplicate-client race test |
| Controller disconnect/reload/revoke | Lease expires; pending work fails; late completion is rejected | Disconnect and generation-mismatch tests |
| Older desktop shell | Explicit unsupported/unavailable response; no invalid-message loop | Version-skew contract test |
| Web/mobile client | Cannot become controller; request fails closed without a desktop owner | Capability/negative test |

## Walking-skeleton proof gate

Broad fan-out is allowed only after a single explicit grant produces exactly one
bounded screenshot from the visibly selected BB browser tab, returns it through
one provider-neutral tool call, and revoke/disconnect demonstrably prevents any
later completion. The evidence must include the visible tab, returned image,
lease identity/generation, and teardown result.

## Load-bearing assumptions / tripwires

- The existing BB browser can be extended rather than replaced — **grounded**:
  desktop core already owns `WebContentsView` and `capturePage()`.
- Provider-neutral tools can carry a screenshot and wait for a desktop response
  — **grounded**: native tool results support images and the internal tool route
  streams long-running completion.
- One controller can be selected through generic plugin realtime — **verified
  false**: V1 broadcasts to every client. This corrected the design toward a
  core-owned lease; if core cannot bind that lease to an authenticated live app
  connection, return to the approach gate.
- The bridge can avoid a host-daemon wire change — **asserted**. Escalate if the
  walking skeleton needs new daemon messages; versioning and ownership must then
  be redesigned and `HOST_DAEMON_PROTOCOL_VERSION` bumped.

## Verdict

**Go with mitigations for the snapshot-only walking skeleton.** Do not enable
general interaction or broad rollout yet. The top three de-risking items are the
single-controller screenshot round trip, disconnect/revoke race behavior, and a
full access-boundary/content-egress red-team.

Handoff to decomposition is intentionally withheld until the human approach gate
accepts Approach A and the walking-skeleton scope.
