# Agent browser control U0: snapshot walking skeleton

Approach: BB-owned ephemeral controller broker plus a built-in, provider-neutral
browser plugin. Sequencing constraint: U0 must prove one exact visible tab can
round-trip one screenshot before any click/type/DOM/general plugin API work.

## UX intent

The user is already looking at a page in BB and wants an agent to see that exact
state. Success is a single toolbar action whose connected state remains visible
and whose second activation revokes access. There is no setup modal. The control
is disabled when no page is loaded or the desktop capture capability is absent;
errors explain that the tab was not connected or the connection was lost.

## U0 contract card — one visible-tab snapshot

**Live path:** user toggles `Share this tab with agents` on one mounted visible
desktop browser tab -> the app registers that tab on its existing realtime
WebSocket -> the server binds a grant to that exact socket, controller, thread,
tab, and generation -> `sdk.browser.snapshot({threadId})` creates exactly one
snapshot command on the owning socket -> only that socket and generation may
complete it -> Electron captures and then revalidates the exact visible
`WebContentsView` -> a bounded JPEG result returns through the SDK -> the
built-in plugin maps it to one provider-neutral image result.

### Typed interface contract

```ts
interface BrowserGrantRequest {
  controllerId: string;
  tabId: string;
  threadId: string;
}

interface BrowserGrant {
  controllerId: string;
  generation: number;
  grantId: string;
  tabId: string;
  threadId: string;
}

type BrowserControllerCommand = {
  commandId: string;
  type: "snapshot";
};

interface BrowserSnapshot {
  data: string; // raw base64, bounded by the contract
  height: number;
  mimeType: "image/jpeg";
  tabId: string;
  threadId: string;
  url: string;
  width: number;
}

interface BrowserArea {
  snapshot(input: {
    signal?: AbortSignal;
    threadId: string;
  }): Promise<BrowserSnapshot>;
}

type BrowserControllerClientMessage =
  | ({ type: "browser-controller-connect" } & BrowserGrantRequest)
  | { type: "browser-controller-disconnect"; controllerId: string }
  | {
      type: "browser-controller-complete";
      controllerId: string;
      generation: number;
      grantId: string;
      commandId: string;
      outcome: { status: "success"; snapshot: BrowserSnapshot } |
        { status: "error"; message: string };
    };

interface BbDesktopBrowserApi {
  capturePage?(tabId: string): Promise<BrowserDesktopCapture>;
}
```

### Invariants and errors

- At most one live grant exists per thread. A new grant increments generation,
  revokes the old credential, and rejects its late waits/completions.
- A random controller identity is held only in renderer memory. The owning
  realtime socket plus controller id, grant id, and generation are all required
  for completion; controller lifecycle is not exposed through the public SDK.
- `capturePage` rejects unless the exact `(hostWindow, tabId)` entry exists,
  remains visible, has a non-empty HTTP(S) URL, and produces a non-empty image.
- Snapshot output is JPEG, bounded at the desktop-contract boundary, and contains
  no cookies, storage, DOM, password fields, or injected page JavaScript.
- Commands have IDs and deadlines. Completion is idempotent only for the first
  valid completion; stale, duplicate, wrong-generation, wrong-tab, and late
  completion fail closed.
- Public errors distinguish not connected, revoked/lost connection, timeout,
  unsupported desktop shell, and capture failure without exposing credentials.

### Tripwires

- If the screenshot needs host-daemon transport, stop and redesign/version the
  daemon contract instead of smuggling it through an existing field.
- If the app cannot bind the credential to one mounted visible tab, return to
  the approach gate.
- If the provider image path cannot carry a safe bounded image, stop before
  adding input or semantic inspection.

### Ownership and rollout

- Depends on: approved Approach A and the snapshot-only risk verdict.
- Consumers: browser toolbar controller, SDK callers, `browser_snapshot` agent
  tool, and `bb browser snapshot`.
- Default: built-in plugin installed but disabled; enabling that plugin is the
  single rollout/cutback decision for tool, CLI, snapshot route, controller
  registration, and toolbar. No tab grant exists by default. With no grant or
  on any ambiguity, snapshot fails closed. Existing browser behavior is
  unchanged while disconnected.
- Transition rows owned: no grant, connected tab, replacement grant, explicit
  revoke, component/window disconnect, old desktop shell, inactive/hidden tab,
  timed-out command, and plugin disabled.
- Privacy/security: visible bitmap only; controller/grant identity never enters
  plugin output, logs, persisted tabs, or agent context. Snapshot callers
  receive the bitmap because the user explicitly granted that thread's tab.
- Expertise: Electron IPC, server concurrency/state, TypeScript contracts/SDK,
  React accessibility, native plugin tools/CLI.
- Ownership: **human-review-required** because this adds an access boundary and
  authenticated page-content egress.
- Execution: one implementation actor, one independent security/conformance
  critic after the vertical slice, compact packet = the three architecture
  artifacts plus this card and exact touched files.

### Acceptance tests authored before implementation

1. Broker: no grant rejects snapshot; one grant delivers one command; only the
   owning socket with matching controller, grant, and generation can complete;
   replacement, revoke, socket close, and abort reject stale completion; timeout
   settles and removes the command.
2. Desktop: capture rejects missing, hidden, empty, destroyed, and empty-image
   tabs; visible tab returns bounded JPEG metadata; preload feature-detects the
   optional method; IPC resolves the sender's own window.
3. SDK/routes: every public body is boundary-parsed; snapshot abort propagates;
   route errors map to stable codes; controller lifecycle is absent from the
   public SDK and controller identity never appears in snapshot output.
4. UI: button is disabled with no page/unsupported shell, toggles connected and
   revoked labels/states, runs commands only for its own tab, and cleanup revokes
   plus aborts in-flight work.
5. Plugin: agent tool uses `ctx.threadId`, returns one text metadata part plus one
   JPEG image part, and returns an error result when disconnected; CLI snapshots
   the current BB thread and emits JSON metadata without printing image bytes.
6. Stack proof: a deterministic fake desktop capture drives socket grant ->
   snapshot command -> completion -> agent image result once; a second socket
   cannot complete it; revoke/disconnect makes a pending call fail.

Validation uses targeted package tests first, then Turbo typechecks/tests for
changed packages. The real UI is visually checked at normal and compact widths;
the live screenshot round trip is manually exercised in the desktop dev app.

## Dependency graph and phase envelope

```text
U0 contract tests -> U0 broker/routes/SDK -> U0 desktop capture + UI controller
                  -> U0 built-in plugin -> U0 stack proof -> independent review
```

Parallel now: none; this is one proof unit and shared contracts must land first.
Broad fan-out after proof: click/type, semantic snapshot, richer status UI, and
multi-window takeover remain separate future decisions.

Phase envelope: one vertical slice, targeted validation, real desktop proof, and
independent review. Replan after a second load-bearing semantic reversal, two
context compactions, or three failures at the same live boundary.
