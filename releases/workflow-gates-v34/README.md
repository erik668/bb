# BB runtime companion for workflow-gates V34

This source release contains the cumulative frozen runtime through V34, including accepted-result cleanup, cancellation/replay protection, packaged-native compatibility gates, pinned-source admission, supervisor notifications, pure notice reads and bounded cached-provider readiness. V35 is excluded. Publication does not install or restart BB.

## Obtain and verify

```sh
git clone --branch release/workflow-gates-v34 https://github.com/erik668/bb.git bb-workflow-v34
cd bb-workflow-v34
git rev-parse HEAD
node releases/workflow-gates-v34/verify.mjs
```

Record the commit for subsequent checkouts. The portable verifier checks 104 cumulative patch files and published-base ancestry; the Git commit pins the rest of BB. Publication additionally matched all 5,842 frozen source files and verified 398 retained build files. The matching private harness branch is `erik668/claude-harness:release/workflow-gates-v34`; its source-manifest digest is pinned in `RELEASE.json`.

## Build and qualify on the destination machine

Use the repository's pinned package manager and lockfile. The isolated server/daemon/CLI validation used Node 22.19.0. Install locked dependencies and build the matched components:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/cli --filter=@bb/sdk
```

Follow this checkout's [release process](../../docs/bb-release-process.md) for application packaging and [native compatibility guide](../../docs/native-runtime-packaging.md) for Electron/native checks. Ordinary Node bindings cannot be assumed compatible with packaged Electron. Linux, signing, full packaged-BB qualification and fleet rollout remain separate obligations.

Keep server, Workflows plugin, SDK bundles, daemon and CLI on this compatible source. Host protocol is **183**; the server distribution must include both `plugin-sdk-runtime.js` and `plugin-sdk-host-runtime.js`. The required provider-host bundle and bridge artifacts must also be available in an isolated runtime; a cached-readiness probe does not silently download or warm them and does not prove credentials, TLS or a real model turn.

This release includes database migrations **0113, 0114 and 0115**. Back up the existing database before any approved rollout. Start testing with a fresh, separate data directory and loopback listener, never the active database. If rollback becomes necessary after migration, use the matching prior runtime and a pre-migration backup; switching binaries alone is not a safe database downgrade.

An installed-app replacement is a separate action: follow `AGENTS.md`, obtain approval, have the user quit the app, and use the documented foreground installer. Updating the harness skill alone does not deploy these runtime changes.

## Evidence and limits

Frozen V34 passed 86 unique affected checks, 11 typecheck tasks and nine build tasks. Publication reused those successful checks after verifying source/build identity; it did not rerun the whole monorepo or claim a fresh desktop qualification. The qualified installed Astra owner/critic campaign completed; native notice queue-to-request and request-to-acceptance were 26 ms and 34 ms in that control. These are bounded observations, not general speedup claims.

Only runtime source, synthetic tests and portable release metadata are published here. Private session histories, credentials, local databases and build artifacts are excluded. Active BB, upstream BB and V35 work remain untouched. Older versioned release verifiers require their corresponding old checkout.
