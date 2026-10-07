# Artifact-review V3 host-foundation lab

This subtree is an unfrozen, non-admissible engineering prototype. It is not
F3 evidence, a product implementation, a migration authority, or approval for
construction, adoption, deployment, or rollout.

The current vertical slice proves only these neutral SQLite process facts:

- a parent-selected temporary database is written by a child transaction;
- the child blocks at real pre-commit and post-commit/pre-close barriers;
- the parent sends `SIGKILL` and confirms child death before observation;
- a pre-commit kill exposes zero durable lab effects and leaves the root reusable;
- a post-commit/pre-close kill exposes exactly one complete durable effect; and
- separate `node:sqlite` and `/usr/bin/sqlite3` observer processes agree;
- clean exit, `SIGTERM`, thrown-error, timeout, and wrong-barrier capsules are
  executed as real child processes and classified from parent-observed exits;
- child and observer modules execute from recorder-owned read-only snapshots,
  with source, snapshot, controller, Node, and sqlite3 byte identities checked
  before and after each successful scenario;
- a closed runtime validator rejects extra fields, chronology drift, forged
  phase observations, and byte-identity drift before returning a result; and
- a deliberate forbidden read run under macOS `sandbox-exec` yields a
  parent-retained `EPERM` receipt naming the denied path and syscall.

The access check proves enforcement and observation for a deliberate uncaught
read attempt. It does not claim that silence is a universal ledger of zero
hidden or caught access attempts; macOS did not expose such a per-process audit
stream to this unprivileged lab.

Run the focused check with the pinned Node runtime used by this workspace:

```sh
/Users/erik/.local/share/mise/installs/node/24.14.0/bin/node \
  --test tools/artifact-review-v3-host-foundation-lab/lab.test.mjs
```

Not yet proved: a universal forbidden-attempt ledger, hostile-writer resistance,
immutable transitive dependency closure, product/candidate imports, V12
authority, V2 compatibility, legacy non-adoption, darkness, SDK parity, or the
134/17/30 accounting. The JSON schema is an identity-bearing closed result
description; runtime enforcement is performed by `result-validator.mjs` and is
limited to this lab result family.
