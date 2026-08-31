# Adopting workflow checks in your repository

`check()` lets a workflow run a deterministic, project-owned suite in its origin
workspace and refuse to spend a model call when the suite says no. The plugin
README describes the capability from the _workflow author's_ side. This document
is for the **repository owner** who has to make `check()` work at all: nothing
runs until your repo has a `.bb/workflow-checks.json`, and BB deliberately gives
you no way to point a workflow at an unpinned command.

This repository dogfoods its own guidance. The three files below are real:

| file                       | role                                                            |
| -------------------------- | --------------------------------------------------------------- |
| `.bb/workflow-checks.json` | the manifest — the only place a suite's command may be declared |
| `.bb/checks/bb-config.mjs` | a reference suite, node built-ins only, ~130 lines              |
| `.bb/checks/pin.mjs`       | recomputes the digests, which you cannot do reliably by hand    |

`plugins/workflows/src/check-manifest-example.test.ts` runs all three on every
test run, so the example cannot rot into a lie.

## 1. Write the suite

A suite is any executable. It gets one JSON object on stdin and must write one
JSON receipt to stdout:

```jsonc
// stdin
{
  "suite": "bb-config",
  "manifestSha256": "…",
  "contractSha256": "…",
  "candidateSha256": "…",
}
```

```jsonc
// stdout — the four pins echoed verbatim, plus your verdict
{
  "suite": "bb-config",
  "suiteVersion": 1,
  "manifestSha256": "…",
  "contractSha256": "…",
  "candidateSha256": "…",
  "selected": 2,
  "passed": 2,
  "failed": 0,
  "skipped": 0,
  "admitted": true,
  "findings": [],
}
```

Four rules BB enforces, so getting them wrong fails the workflow rather than
producing a wrong verdict:

- Echo all four pins **verbatim**. A receipt pinned to anything else is rejected.
- `suiteVersion` must equal the `version` the manifest declares for this suite.
  Bumping the manifest without bumping the suite is caught here.
- `selected` must equal `passed + failed + skipped`, and `admitted` must equal
  `selected > 0 && failed === 0 && skipped === 0`. BB recomputes both — a suite
  cannot admit itself past a skip or a zero-selection run.
- Exit 0. A non-zero exit, a signal, a timeout, output past 1 MiB, or malformed
  JSON fails the workflow. There is no partial credit.

### What a suite can and cannot know

The request carries **only digests — never a path**. A suite therefore chooses
its own target set (`bb-config.mjs` scans `.bb/**/*.json`); it cannot be told
per-call which file to look at. `contractSha256` and `candidateSha256` are
opaque values the workflow chose, and your suite's obligation is to echo them.

That is enough for the useful pattern: the workflow hashes the candidate it just
produced, your suite independently reads that candidate by its own convention
and hashes it too, and refuses if the two disagree — proving the suite graded the
artifact the workflow meant. If you need to check an arbitrary path chosen at
runtime, this contract cannot express it today.

## 2. Declare it in the manifest

```json
{
  "version": 1,
  "suites": {
    "bb-config": {
      "version": 1,
      "argv": ["node", ".bb/checks/bb-config.mjs"],
      "inputs": [{ "path": ".bb/checks/bb-config.mjs", "sha256": "…" }],
      "timeoutMs": 60000
    }
  }
}
```

`argv` is started directly with **no shell**, so every argument is literal —
globs, pipes, `&&`, and `$VAR` are not expanded. `argv[0]` is resolved on the
host, and relative paths resolve against the workspace root. `timeoutMs` may not
exceed 15 minutes. Every `inputs[].path` must be a normalized, workspace-relative
forward-slash path; BB hashes each one before _and_ after the suite runs.

Suite ids match `^[a-z0-9][a-z0-9._-]{0,63}$`. The authoritative schema is
`checkManifestSchema` in `plugins/workflows/src/check-runner.ts` — read it rather
than inferring the shape from this example.

## 3. Pin the digests, in this order

This is the step that has no obvious right answer, because the digests nest:

1. Each `inputs[].sha256` is the digest of that file's **bytes**.
2. `manifestSha256` is the digest of the whole manifest file **after** step 1.
3. `manifestSha256` goes in the **workflow**, never in the manifest — a file
   cannot contain its own digest.

So editing a suite invalidates its input pin, which changes the manifest bytes,
which changes the value your workflow pins. All three move together. Run:

```console
$ node .bb/checks/pin.mjs
manifestSha256 73c101379024177c4864dda6fe299d82d365f91068247a00a0bc7dff7da1c484
```

then pass that value to `check()`:

```js
const receipt = await check({
  suite: "bb-config",
  manifestSha256: args.checkManifestSha256,
  contractSha256: args.contractSha256,
  candidateSha256: args.candidateSha256,
});
if (!receipt.admitted) return receipt;
```

Pinning in the workflow rather than reading it from disk is the point: a workflow
admits results only from the exact suite bytes its author reviewed.

> **Your formatter changes the digest.** `manifestSha256` covers the manifest's
> exact bytes, so running Prettier over `.bb/workflow-checks.json` changes it.
> `pin.mjs` edits the digest literals in place and never reserialises, so the
> formatter stays the single authority on layout — but re-pin _after_ formatting,
> not before.

Wire `node .bb/checks/pin.mjs --check` into CI. It exits 1 on a stale pin and
names the file, which is a far better failure than the digest mismatch a
workflow would otherwise hit at run time.

## 4. Grant the permission

`check()` executes project-owned code on the origin host, so it refuses unless
the run's origin permission mode is `full`. A workflow that calls `check()` under
any weaker mode fails immediately rather than silently skipping the check.

## Failure modes, and what you will see

| what happened                                 | how it surfaces                                              |
| --------------------------------------------- | ------------------------------------------------------------ |
| no `.bb/workflow-checks.json`                 | the `check()` call fails; the manifest is read, not optional |
| manifest edited after the workflow pinned it  | `sha256 … does not match pinned …`                           |
| suite edited without re-pinning               | `implementation … sha256 … does not match pinned …`          |
| suite id absent from the manifest             | `Unknown workflow check suite "…"`                           |
| suite wrote to a pinned input while running   | same digest mismatch — inputs are hashed again after the run |
| suite exceeded `timeoutMs` or 1 MiB of output | `timed out` / `exceeded the output limit`                    |
| receipt counts contradict each other          | schema rejection before any verdict is trusted               |
| origin permission is not `full`               | refused before anything is executed                          |

## What this is not

Suite code is **trusted project code** running with the origin's `full`
permission. BB digests inputs before and after execution, which catches stable or
persistent drift — it is not an atomic filesystem snapshot, and a concurrent
adversarial swap-and-restore can evade it. There is no OS read-only sandbox, so
"suites must be non-mutating" is a contract you keep, not one BB imposes. If you
need adversarial isolation, run the suite in a disposable workspace.

Checks are also never replayed: every `check()` runs live on resume and acts as a
replay barrier, so every `agent()` call after it re-runs too. Await checks
sequentially — they cannot overlap an agent call or another check — and a run may
invoke at most 32.
