# Agent browser control capability inventory

Basis: `fff3ae82f` (`origin/main`) on 2026-08-22. This inventory describes
current code and a current local BB runtime. It does not treat unmerged remote
branches as shipped behavior.

Production usage telemetry was not available in this workspace. `unmeasured`
means no production-frequency claim is being made. The `exists-and-used`
status is limited to capabilities that have a shipped invocation path and are
exercised by current code/tests or the current local runtime; it does not imply
a production usage count.

| Capability | Status | Code reference | Gating path | Prod usage | Evidence |
| --- | --- | --- | --- | --- | --- |
| Desktop-only visible browser tab | `exists-and-used` | `apps/app/src/lib/bb-desktop.ts:105` | `getDesktopBrowserApi` returns non-null only when the desktop preload exposes `window.bbDesktop.browser` | unmeasured | The browser entry is absent on the web build and older desktop preloads. |
| Isolated persistent browser session | `exists-and-used` | `apps/desktop/src/desktop-browser-view.ts:56` | `createDesktopBrowserViewManager` uses `persist:bb-browser` | unmeasured | Browser cookies/storage persist but do not touch the BB app session or the user's external browser. |
| Browser navigation and lifecycle | `exists-and-used` | `packages/desktop-contract/src/browser.ts:300` | `BbDesktopBrowserApi` -> desktop preload IPC -> `DesktopBrowserViewManager` | unmeasured | Attach, detach, navigate, back, forward, reload, stop, focus, bounds, and visibility ship. |
| Find in page | `exists-and-used` | `packages/desktop-contract/src/browser.ts:348` | Optional preload capability -> `webContents.findInPage` | unmeasured | Optional for desktop-shell version skew; results are tab-scoped. |
| Browser URL and popup policy | `exists-and-used` | `apps/desktop/src/desktop-browser-policy.ts:4` | `isAllowedBrowserUrl` and `evaluatePopupRate` | unmeasured | Only HTTP(S) top-level navigation is allowed; native popups are denied and bounded in-panel tabs are requested. |
| Browser permission hardening | `exists-and-used` | `apps/desktop/src/desktop-browser-view.ts:306` | `isAllowedBrowserPermission` -> Electron session permission handlers | unmeasured | Only sanitized clipboard write is allowed; device permissions and downloads remain denied. |
| Browser-tab metadata synchronized by thread | `exists-and-used` | `apps/app/src/lib/thread-tabs-sync.ts:154` | `threadTabsSchema` + optimistic revision update | unmeasured | Browser tab id, URL, title, and environment id are server-persisted; live page state is not. |
| Native browser view associated with thread and environment in one app window | `exists-and-used` | `apps/app/src/components/secondary-panel/browserViewVisibilityCoordinator.ts:38` | `registerBrowserView` -> in-memory record -> thread/environment teardown | unmeasured | The registry is renderer-local; it is not a server-visible controller registry. |
| Internal transient browser bitmap capture | `exists-and-used` | `apps/desktop/src/desktop-browser-view.ts:395` | Native resize burst -> `webContents.capturePage` -> bounded JPEG data URL | unmeasured | Capture exists only for resize placeholders; callers cannot request it on demand. |
| Provider-neutral native plugin tools | `exists-and-used` | `packages/plugin-sdk/src/backend-contract.ts:803` | Loaded plugin registration + optional `configure` selection -> next provider session | unmeasured | Current local runtime showed 11,475 aggregate workflow-plugin handler calls; that is local aggregate evidence, not per-tool production telemetry. |
| Native tool image results | `exists-and-used` | `apps/server/src/services/plugins/plugin-service.ts:651` | `normalizeAgentToolResult` maps `{type: "image"}` to a provider `inputImage` data URL | unmeasured | A browser screenshot can already travel through the provider-neutral tool-result path. |
| Long-running native tool response | `exists-and-used` | `apps/server/src/internal/tool-calls.ts:23` | Authenticated daemon session + matching environment host -> streamed response body | unmeasured | The response head returns before plugin work completes, allowing minute-scale interactive waits and abort propagation. |
| Always-on trusted plugin frontend worker | `exists-and-used` | `packages/plugin-sdk/src/app-contract.ts:1211` | Enabled plugin frontend generation -> one content-script mount per BB app window/tab | unmeasured | A thin official plugin can keep a controller worker alive outside its visible panel. |
| Plugin app-to-server RPC | `exists-and-used` | `packages/plugin-sdk/src/backend-contract.ts:198` | Local-auth plugin RPC route + schema validation | unmeasured | A desktop controller can claim and complete server-owned work through existing request/response RPC. |
| Plugin server-to-app realtime signal | `exists-and-used` | `packages/plugin-sdk/src/backend-contract.ts:213` | `bb.realtime.publish` -> every connected app client | unmeasured | V1 is broadcast-only and therefore cannot safely choose one controlling desktop by itself. |
| Plugin-owned CLI command | `exists-and-used` | `packages/plugin-sdk/src/backend-contract.ts:322` | Enabled plugin CLI registration; core names win | unmeasured | An official plugin can expose discoverable `bb browser ...` commands without adding a core command. |
| On-demand browser screenshot for agents/CLI/SDK | `does-not-exist` | — | — | — | Absence search found only the resize-only `capturePage()` call. |
| DOM/accessibility inspection of the browsed page | `does-not-exist` | — | — | — | No browser-view `webContents.debugger`, `executeJavaScript`, or accessibility snapshot path exists. |
| Agent pointer/keyboard input into a browser tab | `does-not-exist` | — | — | — | No browser-view `sendInputEvent` or equivalent agent-control command exists. |
| Explicit single-controller lease for one BB desktop window/tab | `does-not-exist` | — | — | — | Browser tab metadata is server-synced, but the live view registry is renderer-local and plugin realtime broadcasts to every client. |
| Browser-control SDK/CLI surface | `does-not-exist` | — | — | — | No browser list/connect/snapshot/click/type command exists under `apps/cli`, `packages/sdk`, or server routes. |
| User-visible connect/revoke control for agent access | `proposed-new` | — | — | — | Net-new safety boundary required to select one live desktop controller and make access visible/revocable. |
| Bounded visible-page snapshot | `proposed-new` | — | — | — | Net-new on-demand screenshot plus a bounded, redacted semantic representation; never cookies, storage, passwords, or arbitrary JavaScript. |
| Bounded browser interaction | `proposed-new` | — | — | — | Net-new click/type/press/wait/navigation operations scoped to a granted live tab. |
| Official provider-neutral browser-control plugin | `proposed-new` | — | — | — | Net-new agent tools, standing instructions, status UI, and plugin CLI layered over a BB-owned desktop control broker. |

## Gating and ownership map

- Desktop main owns the untrusted `WebContentsView`, persistent isolated
  partition, navigation policy, and the only existing pixel capture primitive.
- The React app owns per-thread browser-tab presentation and syncs tab metadata
  to the server, but live native views remain local to each app window.
- The server owns product policy and native plugin-tool execution. Tool calls
  are authenticated through the originating daemon session and checked against
  the thread's environment host before plugin execution.
- An official plugin can already provide provider-neutral tools, image results,
  long-running calls, a global frontend content script, app/server RPC,
  realtime wakeups, and a CLI. It cannot currently inspect or drive a native
  browser view, nor safely select one client from the realtime broadcast.

## Absence searches

```bash
rg -n 'webContents\.debugger|\.debugger\.attach|sendInputEvent\(|executeJavaScript\(|capturePage\(' \
  apps/desktop/src/desktop-browser* packages/desktop-contract/src/browser.ts apps/desktop/src/preload.ts
# Result: apps/desktop/src/desktop-browser-view.ts:410: .capturePage()
```

```bash
rg -n 'browser (list|open|snapshot|click|type)|commands?.*browser|class Browser|browser:' \
  apps/cli/src packages/sdk/src apps/server/src/routes --glob '*.ts'
# Result: no browser-control SDK/CLI command or route.
```

```bash
rg -n 'plugin-screenshot|ui-inspection|ui-inspector' \
  apps packages plugins docs --glob '!**/dist/**' --glob '!pnpm-lock.yaml'
# Result on origin/main: no shipped UI-inspector or plugin-screenshot capability.
```

## Runtime observations

- Earlier in this same BB thread, the provider browser runtime loaded but
  selecting `iab` returned `Browser is not available: iab`. This confirms that
  provider-side browser tooling is present while BB supplies no connected
  in-app-browser instance.
- `bb plugin list --json` on 2026-08-22 showed the workflows plugin running with
  11,475 aggregate handler invocations and three registered agent tools. This
  proves the local plugin/tool framework is active; it is not production usage
  telemetry for any row above.

## Existing rows touched by the proposed feature

- Extend **Internal transient browser bitmap capture** into a separate bounded,
  on-demand capture operation; preserve the resize path unchanged.
- Extend **Native browser view associated with thread and environment** with an
  explicit controller identity rather than inferring control from synchronized
  tab metadata.
- Reuse **Provider-neutral native plugin tools**, **Native tool image results**,
  **Long-running native tool response**, **Always-on trusted plugin frontend
  worker**, **Plugin app-to-server RPC**, and **Plugin-owned CLI command**.
- Do not reuse broadcast-only **Plugin server-to-app realtime signal** as the
  authority for executing an action; it may wake clients, but a single lease
  must decide which client can claim a command.

## Explicitly excluded from current behavior

The fetched remote refs named `ui-inspector-*` and `plugin-screenshot` are not
ancestors of `origin/main`. Their diffs concern BB-shell/plugin UI inspection
and marketplace listing screenshots, respectively; neither is evidence of a
shipped bridge to a browsed page.
