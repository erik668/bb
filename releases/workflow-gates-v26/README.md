# BB runtime companion for workflow-gates v26

This beta source branch carries the isolated, validated runtime changes used by the v26 harness. It is not a packaged desktop installer, a deployment, or a claim that the complete BB monorepo suite passed.

The patch provides typed accepted-result cleanup, accurate completion notifications, manual-stop handling, safe old-result replay, and the Plugin SDK `/host` import bundle. The matching harness is in `erik668/claude-harness`, branch `release/workflow-gates-v26`; its exact 193-file source manifest digest is pinned in `RELEASE.json`.

## Obtain and verify

```sh
git clone --branch release/workflow-gates-v26 https://github.com/erik668/bb.git bb-workflow-v26
cd bb-workflow-v26
git rev-parse HEAD
node releases/workflow-gates-v26/verify.mjs
```

Record the commit ID and use it for subsequent checkouts. The verifier checks the 31 patch files and base ancestry; the full Git commit pins the remainder of BB. No machine-specific paths or saved credentials are required. The verifier is identical in both standalone companion repositories; byte parity is checked when publishing, since one repository cannot import the other.

## Build on the destination machine

Use Node 22.19.0 or a compatible version admitted by the root package, and the package-manager version pinned by `package.json`. Install from the lockfile, then use the repository's normal Turbo build and setup instructions. A full source build is:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@bb/scripts --filter=@bb/app --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/cli --filter=bb-app
```

Keep server, Workflows plugin source, daemon, CLI, and protocol 181 together. The server distribution must contain both `plugin-sdk-runtime.js` and `plugin-sdk-host-runtime.js`. Installing the harness skill alone does not install these runtime fixes. Do not point a test runtime at an existing live database or copy credentials from the original canary.

Follow this checkout's `AGENTS.md` and `docs/debugging-and-qa.md` for an isolated smoke test. For an installed macOS app replacement, obtain explicit approval, have the user quit the app, and invoke the documented `install:packaged:macos` workflow once in the foreground. Pushing this branch neither replaces nor restarts an installed application.

## Validation and limits

The exact patch has 126 passing focused runtime tests, two passing targeted typechecks, and a passing server build. Existing matching daemon/CLI builds were reused. An isolated real-provider canary verified normal accepted-result cleanup, manual cancellation without correction, and old-result replay without stopping a resumed turn. Recorded stop-transport failure is covered by a retry control. Notification evidence combines real queued classification and DOM rendering, not a desktop visual smoke test.

An idempotent cleanup with no original durable cleanup record requires explicit intervention. Manual cancellation checks do not constitute an atomic transaction across the core and plugin databases. Cross-platform installation, fleet adoption, matched efficiency, and complete cost/drift attribution remain unproven. Preserve a known-good previous application before rollout; do not blindly roll back live databases.

Only runtime source, synthetic regression tests, and release metadata are published here. Private harness canary histories, auth state, logs, and local databases are deliberately excluded.
