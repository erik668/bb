# Packaged native runtime gate

Desktop packaging verifies the executable and native bindings that the artifact will run. Keep Electron exactly pinned in `apps/desktop/package.json` and install from the workspace lockfile. The runtime family, Electron version, embedded Node version, module ABI, platform and architecture are measured in fresh processes of the packaged executable.

The `afterPack` hook uses electron-builder's explicit target architecture and platform. Missing or unsupported targets fail with `PACKAGING_TARGET_INVALID`; there is no host-architecture fallback. A runtime that differs from the pin blocks before native installation. Native compatibility failure can trigger one preparation of the packaged SQLite copy. An already compatible copy skips that installer. SQLite and node-pty are verified again after preparation.

SQLite verification opens a private in-memory database, executes a query and closes it. The node-pty check loads the native binding without starting a terminal. Each load has a ten-second subprocess limit and 64 KiB output bound. Selected roots, entrypoints and native files must resolve inside their declared artifact/package boundaries. The parent validates the child's structured observations and checks observed input drift.

Preparation detaches hardlinked native binaries and node-pty helper files before changing their bytes or modes. Symlink escapes are rejected. This preserves the workspace's Node-compatible binding when the packaged copy needs Electron's ABI. Do not rebuild the shared pnpm dependency store for Electron.

`smoke:packaged` verifies native compatibility before starting its HTTP fixture or GUI. Its expected architecture comes from the checked-in platform target, independently of the Node process running the smoke command. Multiple configured architectures require an explicit target selection before this single-target smoke can run. Code signing and the existing UI/lifecycle smoke remain required release checks.

Receipts are written beside the platform output directory as `PLATFORM-ARCH-PHASE.native-runtime.json`. Phases are `before-preparation`, `after-pack` and `smoke`. The desktop workflow retains these files with its artifacts. A failed receipt blocks the hook or smoke step; a previous passing receipt does not authorize a later invocation. Each invocation probes again. Preserve phase receipts before intentionally replaying controls: a phase filename holds its latest observation.

The version-1 `bb-packaged-native-runtime` identity binds the measured executable digest and runtime tuple, lockfile digest, selected package names/versions, metadata, entrypoints and observed native-file digests. `identitySha256` hashes canonical JSON with sorted object keys and sorted module/native arrays, excluding timestamps. The proof covers these selected inputs. Full application content and signing are governed by the release pipeline.

Use the normal local directory packaging and smoke tasks, with no publish or installed-app replacement:

```sh
pnpm exec turbo run build --filter=@bb/desktop
node apps/desktop/scripts/run-electron-builder.mjs --mac --dir --arm64 --publish never
pnpm exec turbo run smoke:packaged --filter=@bb/desktop
```

On Linux, use `--linux --dir --x64 --publish never` for the packaging command and run the GUI smoke in the configured virtual display. CI's `desktop:build` / `desktop:build:linux` tasks already invoke the same hook. The package test task runs the standalone native-gate tests before its existing Vitest suite.

The gate is self-contained in the BB checkout and does not require a separately installed harness at release time. Its behavior is qualified against the V29 harness preflight on a real Electron/native artifact. The harness and desktop receipts describe different objects; compare their measured runtime/native fields explicitly rather than comparing their aggregate digests.
