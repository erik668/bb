---
name: safe-bb-upgrade
description: Upgrade a running BB source checkout or its Electron runtime using staged integration, complete-stack smoke checks, preserved fork behavior, and an independent foreground activation/recovery runner. Use when asked to pull/update BB, sync its fork, or upgrade Electron in the BB installation the user runs. Do not use for ordinary BB feature development, checking available versions, or updating an unrelated Electron app.
---

# Safe BB upgrade

Keep the running installation usable throughout preparation. Finish an authorized
upgrade through activation and verification, using a recovery harness that survives
BB being stopped. Existing user authorization persists; this skill adds no blanket
permission gate. A request for advice or for this skill alone does not authorize an
actual upgrade.

## Read before writing to the serving checkout

Read its AGENTS.md and current launch/update documentation. For BB source installs,
find the documented prepared-worktree restart procedure. Identify the checkout and
data directory actually used by the running server, daemon, desktop, and frontend.
Record their versions, ports, Node version, launch commands, and active agents.
Keep credentials out of records and command arguments.

Read [the runbook](references/runbook.md) when performing an upgrade. Use
`python3 scripts/upgrade_guard.py --help` for the helper. The helper journals ordered
foreground commands; it does not provide the target-specific build, smoke, launch,
stop, update, or recovery scripts. Write and inspect those scripts before activation.

## Required sequence

1. Fetch only the needed remote/ref. Pin a candidate commit and create a separate
   worktree. Do not pull, stash, install dependencies, generate sources, build, or
   switch branches in the serving checkout while it is running.
2. Inventory every local customization, including committed fork differences,
   tracked edits, untracked files, configuration, and installed plugin behavior.
   Preserve dirty edits and deletions before integrating them in staging. For each
   behavior, record its check, result, and evidence in `customizations.json`.
   A backup alone does not preserve functionality. Do not silently retire a fix
   because upstream replaced its implementation; verify the replacement or port it.
   Ask only if preserving a behavior requires an unresolved product/security choice.
3. Commit the integrated candidate on its staging branch. Use the helper's `init`
   to capture the live baseline, patch/files, listed SQLite databases, recovery
   runbook, and an isolated staging data directory outside both checkouts. Inventory
   all migration-relevant databases; SQLite backups must use its backup API. Record
   non-database configuration and assets needed for recovery separately and privately.
4. Run `prepare-candidate`: locked dependency install, required native setup,
   and the complete runtime build via the repository's supported orchestration.
   Run `smoke-candidate`: rehearse migrations on copies of the backups; launch the
   actual server, daemon, desktop/frontend, and relevant plugins on isolated ports
   and data; perform the checks in the runbook. Use synthetic agent/provider
   fixtures for message sending so a rehearsal cannot execute real user tasks.
   The smoke command must exit nonzero when any required check fails.
5. Review the recovery command and exact candidate revision. Execute remaining
   helper steps from an independent terminal or external harness, outside the BB
   instance being updated: `stop-live`, `update-live`, `prepare-live`, `start-live`,
   `smoke-live`. Drain active work or identify its interruption before stopping.
   Keep the serving checkout path, live data directory, and ports unchanged.
   Immediately after verified shutdown, the helper refreshes the SQLite backups.
6. Verify the running versions and workflows. Report complete only after
   `smoke-live` succeeds. If activation is interrupted or fails, report the exact
   completed phase and use the recorded recovery procedure from outside BB. Keep
   the last usable build and backups until post-activation checks succeed.

## Boundaries that prevent repeat failures

- Typechecks and component tests supplement the complete-stack smoke checks.
  A desktop shell talking to a fake health endpoint is insufficient evidence.
- Never leave new frontend/source/dependencies paired with old running services.
  "Downloaded", "candidate validated", and "running version verified" are distinct
  statuses. A restart still pending means activation is incomplete.
- Electron upgrades include native module compatibility, desktop/preload startup,
  browser operations, and the actual computer-use/Apple Events path when used.
  Record the new bundle path and any permissions requiring user interaction.
- Reuse supported launchers. Do not invent launchd jobs, background watchers,
  detached installers, or retry loops. A foreground helper may invoke an existing
  supported launcher that returns after checking readiness.
- Packaged app replacement follows the repository's explicit replacement policy;
  never apply source-checkout Git commands to a packaged install. Use the runbook's
  packaged route; the bundled helper supports source checkouts only.
- Do not restart the app hosting the only recovery agent. The helper blocks its
  live phases when `BB_THREAD_ID` is set. Never unset that marker to bypass it.
  Prepare a concrete external handoff and label activation pending until that
  harness observes the outcome.
- A failed smoke test remains an unresolved concern until investigated. A targeted
  rerun can establish a transient failure; record both outcomes and the reason.
- Recovery includes database compatibility. Do not automatically restore a backup
  over newer user writes or assume changing Git revisions reverses migrations.

## Completion evidence

Provide old/new commits and runtime versions, customization check results, the
full-stack/migration and activation results, any permission handoff, and the private
recovery/log location. State limits plainly. Retain artifacts for an independent
Codex harness; do not make recovery depend on BB's API, CLI server, or agent session.

When maintaining this skill, consult the [validation record](references/evaluation.md).
