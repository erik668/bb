# Source upgrade runbook

The bundled helper requires Python 3.9+ and POSIX file locking (macOS/Linux).

Run artifacts belong in a private durable directory outside both checkouts and
outside the app data directory, such as `~/bb-upgrade-runs/<timestamp>`. Never put
credentials in commands, customization evidence, or the runbook. Output logs may
contain sensitive data; the helper creates private directories/files. They are not
repository artifacts to commit or publish.

## Prepare the operator scripts

Use the actual installation's documentation; do not reuse historical ports or
assume `origin/main` is the desired fork. The scripts below are files the agent
prepares for this particular installation, not commands bundled by this skill.
Use argv arrays through the helper; invoke a shell explicitly for a reviewed shell
script. Do not feed generated shell text through `eval`.

The independent recovery runbook must contain:

- Existing and candidate revisions, Node/Electron/native module versions, serving
  path, data path, ports, and the current supported start/stop commands.
- How to observe that the whole instance is stopped and free its listeners without
  killing unrelated processes. Account for active agents/automations.
- The exact activation commands, SQLite databases and other data/config assets,
  backup paths, rollback commands, and verification checks.
- What to do if stop, source update, build, startup, migration, or smoke fails.
  Leave a failed stage failed. Recover explicitly; do not blindly loop/retry.
- How the old build and database remain compatible. If restoring the database is
  necessary, first stop the failed instance and preserve newer writes for recovery.
  Database restoration is a separate deliberate action, never an automatic helper
  rollback. A code rollback is safe only when the database remains compatible.

Use an environment JSON object containing the candidate's explicit local ports
and URLs. The helper strips inherited `BB_*` variables from candidate commands and
sets `BB_DATA_DIR` to `<run>/staging-data`. This is a guardrail, not an OS sandbox:
scripts must still verify resolved paths/ports and must not load live credentials
or address live services. Do not copy the live `.env` file wholesale.
Install dependencies into the candidate itself. Do not symlink its `node_modules`
or build outputs to the live checkout. Follow the supported native-binary repair
procedure so rebuilding a hardlinked binary cannot change the live installation.

Create `customizations.json` as an array. Each committed fork behavior and dirty
fix gets an entry, for example:

```json
[
  {
    "behavior": "Markdown preview links keep the owning host and environment",
    "status": "pending",
    "evidence": ""
  }
]
```

After a real check passes, use `"status": "verified"` and point `evidence` at its
result. If there are no customizations, use `[]` only after inspecting fork history
and local edits. The helper accepts only verified entries at candidate smoke time.
An intentional behavior removal requires an explicit user decision documented in
the evidence; do not mark an untested replacement verified.

## Helper invocation

All paths are absolute. `RUN` below is a fresh directory. The candidate must be
clean and committed; place scripts, environment JSON, checklist, and recovery
runbook outside it. `init` snapshots the live main database automatically if it
exists; add every plugin/other migration-relevant SQLite DB with repeated
`--database` arguments. Non-database assets require a separate private backup.

```sh
python3 /path/to/safe-bb-upgrade/scripts/upgrade_guard.py init \
  --live-repo /path/to/serving-bb \
  --candidate /path/to/staged-bb \
  --live-data /path/to/live-data \
  --run /path/to/upgrade-run \
  --recovery-file /path/to/operator/RECOVERY.md \
  --checklist /path/to/operator/customizations.json \
  --candidate-env /path/to/operator/candidate-env.json \
  --database /path/to/live-data/plugins/example/plugin.db

python3 /path/to/upgrade_guard.py step --run /path/to/upgrade-run \
  --phase prepare-candidate -- /bin/bash /path/to/operator/prepare-candidate.sh
python3 /path/to/upgrade_guard.py step --run /path/to/upgrade-run \
  --phase smoke-candidate -- /bin/bash /path/to/operator/smoke-candidate.sh
```

Run the five remaining phases in order using the same syntax and one reviewed
operator script per phase, from the independent terminal/harness. Candidate steps
run in the candidate checkout; live steps run in the serving checkout. No command
is passed to an implicit shell. `status --run ...` needs neither BB nor a server.
The helper checks the clean candidate revision before and after each phase, checks
the original live source snapshot before shutdown/update, and requires the live
source to match the candidate after `update-live` and throughout activation.
If those checks fail, keep the artifacts, recover the actual state, and start a new
run; never edit `state.json` to manufacture a successful receipt.
The run directory retains its own `RECOVERY.md`, exact private argv/cwd receipts,
executable/script hashes, and copies of explicitly supplied script files. Imported
helpers and command semantics still require review; this is not a sandbox or an
automatic proof that a user-written smoke script covers the required workflows.
Do not pass credentials in argv or embed them in operator scripts.

Each phase must finish with zero only after meeting its contract:

| Phase             | Contract                                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| prepare-candidate | Frozen-lockfile install, native setup, entire required runtime built.                                                                                             |
| smoke-candidate   | Actual isolated stack starts; migrations and every required workflow/customization check pass; shut the rehearsal down before returning.                          |
| stop-live         | Instance fully stopped, including desktop and stateful services; prove listeners/processes are gone. Helper then refreshes DB snapshots before accepting success. |
| update-live       | Bring the existing serving checkout to the exact integrated candidate commit, preserving original edits in the recorded backup. Never reset unknown new edits.    |
| prepare-live      | Install locked dependencies and prepare the stopped checkout with supported orchestration; remove stale outputs only according to repo guidance.                  |
| start-live        | Supported launcher starts the stack and verifies readiness before returning.                                                                                      |
| smoke-live        | Verify running revisions/versions, actual UI/API/daemon/plugin workflows, and computer-use permissions where relevant.                                            |

## Required complete-stack checks

Cover these against the actual prepared candidate and again after activation:

1. The frontend, server, daemon, desktop, plugins, and native modules agree on their
   versions/contracts. Check reported runtime versions, not only package.json.
2. Rehearse schema/data migration on a copy of all required DB backups. Confirm the
   correct isolated data path before starting the candidate. Exercise opening
   representative existing threads and their history.
3. Open and create a thread; send a message using a synthetic provider fixture in
   staging; observe its completion and realtime updates. Do not launch real agents
   from a copied user's pending queue or automations. Disable automatic scheduling,
   hosted sync, and real provider execution using supported controls before any
   copied-data startup. Use fresh isolated data if such isolation cannot be proven;
   then keep copied-data migration validation offline.
4. Preview links/images, workspace/host ownership, file opening, and each fork
   customization pass representative behavior checks.
5. Connect routing, authentication, assets/API/WebSocket proxying and uploads work
   using an isolated fixture or authorized staging service. Never modify the
   production Connect gate for testing.
6. Desktop/preload startup, embedded browser and relevant native/computer-use paths
   work. Permission prompts are a tracked activation item. Do not automatically
   restart/quit an installed packaged app to satisfy them.
7. Confirm the recorded recovery procedure works on disposable data/fixtures,
   including failure after a migration. Stop if a rollback assumption is unproven.

## Packaged installation route

The helper's Git-based source identity checks do not apply to packaged installs.
Keep the same inventory, isolated candidate validation, recovery/data safeguards,
and post-activation checks. Prepare a reviewed installation-specific foreground
runbook. Obey current repository policy for explicit app replacement, user quit /
launch, signature preflight, and the one supported installer invocation. Do not
create an unattended replacement or relaunch loop.
