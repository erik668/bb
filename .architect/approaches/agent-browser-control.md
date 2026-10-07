# Agent browser control: approach gate

Deciding now: where the authority to connect an agent to BB's existing visible
in-app browser should live.

Objective / impact: let Codex, Claude, and future providers inspect and operate
the same authenticated browser tab the user can see in BB, so visual QA is
connected rather than reproduced in a separate browser. Preserve explicit user
control, provider neutrality, and equivalent SDK/CLI access.

## Constraint descent

- **Hard facts:** the desktop app already owns an isolated persistent
  `WebContentsView`, navigation policy, and a resize-only `capturePage()` path;
  native plugin tools already return provider-neutral image results and may wait
  for interactive work; plugin realtime currently broadcasts to every connected
  app client. See the companion
  [capability inventory](../inventory/agent-browser-control.md).
- **Derived constraints:** an action must bind to one live app window and one
  exact browser tab; ambiguity must fail closed; the user must see and revoke
  the grant; browsed pages must never receive a BB preload; the public surface
  must ship through agents, SDK, and CLI together.
- **Assumptions:** a server-owned lease can select one desktop controller without
  moving browser ownership out of Electron; a bounded screenshot can traverse
  the existing tool image path within practical limits; the first proof can
  require an active visible tab instead of materializing inactive metadata.
- **Foundational limitations:** the desktop browser session is intentionally
  separate from BB and the user's external browser; web/mobile clients cannot
  host the native view; screenshots can contain sensitive visible customer data
  even when cookies, storage, and hidden DOM are excluded.
- **Design pressure:** keep sensitive page primitives in desktop core, keep agent
  semantics in an official provider-neutral plugin, and add the narrowest core
  broker that makes controller selection explicit and deterministic.

## Criteria

| Criterion | Weight |
| --- | ---: |
| Controls the same visible, authenticated BB browser session | 30 |
| Selects the target safely and deterministically | 25 |
| Gives providers, SDK, and CLI one consistent contract | 20 |
| Handles rollout and desktop/client version skew | 15 |
| Reuses current infrastructure and limits initial scope | 10 |

Scores use 1 (poor) through 5 (strong).

| Approach | Same session | Safe target | Contract parity | Rollout | Leverage | Weighted total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A. BB-owned controller broker + thin official plugin | 5 | 5 | 5 | 4 | 3 | **465 / 500** |
| B. Plugin-owned broker over generic RPC/realtime | 5 | 3 | 4 | 3 | 4 | 390 / 500 |
| C. Separate Playwright/headless browser | 2 | 5 | 4 | 4 | 3 | 355 / 500 |

## Approach A: BB-owned controller broker + thin official plugin [recommended]

Mechanism: desktop core exposes bounded snapshot and, later, input primitives
for its existing `WebContentsView`; server core owns an opaque, user-granted
single-controller lease and command lifecycle; an official `browser-control`
plugin supplies provider-neutral tools, standing instructions, status UI, and
CLI commands over that broker.

Assumes: the lease can be tied to an authenticated live app connection and exact
thread/tab identity; a screenshot round trip works without exposing arbitrary
JavaScript, cookies, storage, or raw page internals.

Strongest reason to reject it: it is a cross-layer change touching Electron,
desktop IPC, server connection state, SDK/CLI contracts, and an access boundary.
That is more core surface than a plugin-only implementation.

## Approach B: plugin-owned broker over generic RPC/realtime

Mechanism: add a minimal experimental desktop plugin API, let the official
plugin coordinate pending commands via plugin RPC, and wake content scripts via
plugin realtime.

Assumes: the plugin can layer a correct controller claim protocol over broadcast
signals and can safely receive a public API for authenticated page control.

Strongest reason to reject it: generic plugin realtime has no client targeting,
and a public plugin API would expose a high-impact browser-session primitive to
every full-trust plugin. The apparent implementation savings move authority and
versioning complexity into a weaker boundary.

## Approach C: separate Playwright/headless browser

Mechanism: run browser automation beside the provider/daemon and optionally show
captures or a stream in BB.

Assumes: users will accept a separate cookie jar and a browser that is not the
visible BB tab, or will repeatedly authenticate it.

Strongest reason to reject it: it solves reliable automation but misses the
core product outcome—connected QA of the same browser state the user sees.

## Recommendation and proof boundary

Choose A. BB core is already the sole owner of the native page, and it is the
only layer that can authoritatively decide which live view an action reaches.
The official plugin remains the correct home for agent-facing behavior because
its tools and image results are already provider-neutral.

The strongest case against A is scope: a broker can become a premature platform.
The response is to prove one end-to-end seam before adding generalized control.

Kill criterion: abandon A in favor of a narrower direct-desktop broker or
reconsider B if one explicitly leased desktop tab cannot return one screenshot
to one agent tool call without broadcast action authority, raw browser secrets,
or a new host-daemon wire dependency.

Cheapest de-risking experiment / walking skeleton:

1. One desktop app client claims one active, visible browser tab with an explicit
   user grant.
2. One `browser_snapshot` tool call creates a bounded command for that lease.
3. Only the lease owner captures the current visible page and completes it.
4. The tool returns one image result to the provider.
5. Revoke/disconnect tears down the lease and causes pending work to fail closed.

Deferred until that proof passes: click/type/key input, semantic/AX snapshots,
multi-window takeover, inactive-tab loading, web/mobile controllers, provider-
specific adapters, generalized third-party plugin access, and background runs.

First-phase envelope: one vertical spike and its narrow tests, with no public
platform fan-out. Checkpoint and replan after a second load-bearing semantic
reversal, two context compactions, or three failures at the same live boundary.

## Handoff to architect-risks

Chosen approach: A. Key assumptions are that a single authenticated desktop
controller can be leased deterministically, the existing image tool path can
carry a bounded screenshot, and no host-daemon protocol change is necessary.
Open risks are wrong-window execution, sensitive-page egress, prompt injection,
broadcast races, disconnect cleanup, and desktop/client version skew.

