# BB runtime companion for workflow-gates V40

This is the cumulative frozen runtime through V40, including the final cache-policy propagation repair. It adds supported plugin-cache inspection, cache-only Codex maintenance and turn-bound conditional cancellation to the earlier admission, supervision, replay and packaged-native protections. There are 55 changed or added source files since published V34; the cumulative patch manifest contains 144 files. V41 is excluded.

This is source publication to **Erik668's fork**, not an installed BB upgrade, desktop installer or upstream release.

## Obtain and verify

```sh
git clone --branch release/workflow-gates-v40 https://github.com/erik668/bb.git bb-workflow-v40
cd bb-workflow-v40
git rev-parse HEAD
node releases/workflow-gates-v40/verify.mjs
```

Record the commit for reproducible use. The portable verifier checks the cumulative patch hashes and published-base ancestry; the Git commit pins the rest of BB. Publication additionally matched all **5,855 frozen source files**, 398 retained build files and seven entrypoints. Older versioned verifiers require their corresponding old checkout. The matching private harness is `erik668/claude-harness:release/workflow-gates-v40`; its source-manifest digest is pinned in `RELEASE.json`.

## Build and qualify on the destination

Use the repository's pinned package manager and lockfile. The isolated runtime qualification used Node 22.19.0; helper checks used Node 24.20.0. Install locked dependencies in a separate checkout and build the matched components:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/cli --filter=@bb/sdk
```

Follow this checkout's [release process](../../docs/bb-release-process.md) for application packaging and [native compatibility guide](../../docs/native-runtime-packaging.md) for Electron/native checks. Do not reuse ordinary Node native bindings as proof of Electron compatibility. Linux, signing, full packaged-BB qualification and fleet rollout remain separate obligations.

Keep server, Workflows, SDK bundles, daemon, CLI and provider bridges on this compatible source. Host protocol is **184**, up from V34's 183. The distribution needs both `plugin-sdk-runtime.js` and `plugin-sdk-host-runtime.js`, plus the required provider-host and bridge artifacts. Installing the helper alone does not deploy the runtime.

V40 adds no database migration beyond V34; the cumulative release still includes **0113, 0114 and 0115**. Before an approved upgrade, back up the database and test against fresh separate data on loopback. A binary rollback is not a safe database downgrade: retain the matching prior runtime and a pre-migration backup. Installed-app replacement is a separate approved foreground operation under `AGENTS.md`; the user must quit the app first.

## Cached-only bootstrap and cancellation

For an isolated host, set `BB_CODEX_MAINTENANCE_POLICY=cache-only` before starting its provider bridge. The final provider declaration propagates this policy and bootstrap phase. It disables Codex registry/usage refresh and installation actions, while preserving local version/credential inspection; it does not restrict model execution or other providers. The default `standard` policy is unchanged. See [configuration](../../docs/configuration.md).

`bb plugin cache-inspect --base-dir <plugins-directory> --json` is read-only. A cache report does not install or warm dependencies and does not prove model access. Use the matching helper's bootstrap guard and bounded readiness recipe to qualify exact caches, binaries and execution context. Keep TLS verification enabled. Cold dependency acquisition and destination credentials are separate authorized setup steps, not implied by a cache proof.

The first V40 smoke passed but strict bootstrap failed on three denied npm metadata calls because policy was dropped at the provider environment boundary. That failure remains recorded. The repaired smoke passed in 8.605 seconds; its ledger remained at zero package-manager attempts through the campaign, lifecycle control and shutdown. This proof covers the owned PATH, not absolute-path bypasses. Bootstrap phase identifies bridge launch, not later request-level timing.

Conditional cancellation uses a separate route and advertised provider capability. Old servers/providers refuse before ordinary stop side effects; an unconditional stop is not a safe fallback. The live original-stop/resume/stale-stop control preserved the replacement turn. A retained provider session may hold resources until explicitly released or shut down. See the [thread guide](../../packages/templates/src/templates/bb-guide-threads.md) for the shipped command contract.

## Evidence and limits

The final source-bound affected tests, 16-package typecheck scope, later policy checks and nine-task build passed. Publication reverified source/build identity instead of repeating unchanged heavy validation. Exact scope and retained receipt hashes are in `RELEASE.json`; no full-monorepo, fresh desktop or universal provider-callability claim is made.

The real installed owner/critic CLI build and independent parent checks passed with four required check executions and zero false worker interruptions. Final campaign settlement required offline reconciliation of recorded live delivery evidence, with native effects disabled; this was not a fresh native observation. Setup failures and finalization friction remain queued. No matched overall efficiency or complete cost claim is established.

Only runtime source, tests and portable metadata are included. Private canary histories, credentials, databases, caches and native build artifacts are excluded. Seven unrelated active-BB Connect/Vite changes remain an exact ownership-unconfirmed preservation exception and are not published. Active BB, upstream BB and global installations are untouched by this publication.
