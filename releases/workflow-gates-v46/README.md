# Workflow gates V46 — BB runtime source

Source-only release to **erik668/bb**, paired with the private
`erik668/claude-harness` V46 release. This does not replace an installed BB app,
restart a daemon, or enable a production campaign.

## Scope

There are **17 changed/added files since published V40**: V41 builtin plugin
source-watch integration and supporting documentation/tests, plus V46's
project-scoped native retry-admission hook and regression tests. The complete
5,859-file source projection matches the frozen, live-qualified runtime.
`SOURCE-MANIFEST.json` carries 156 cumulative workflow patch paths;
`RUNTIME-SOURCE-MANIFEST.json` binds the full qualified source projection.

Retries for explicitly bound projects are admitted before the original
`client/turn/requested` event is appended. The hook checks original request and
environment identity, later requests/manual cancellation, immutable authority
and controller pins, and an external capacity reservation. Projects without the
explicit admission table/binding retain existing behavior. Publication does not
create bindings or mutate any database.

No host-daemon wire schema changed since V40: protocol **184** remains unchanged.
No new database migration is introduced in this delta. The optional project
admission table belongs to the explicitly commissioned qualification profile;
this release does not silently provision a global runtime policy.

## Validation and deployment boundary

Run `node releases/workflow-gates-v46/verify.mjs` from the checkout for read-only
source/evidence verification. This release reuses the exact frozen runtime build
and native retry/runner controls. The companion helper's retained full suite was
1,138 passed / 1 historical skip. Installed Sol/high owner and critic plus actual
busy-manager application and public settlement passed. These facts are not a new
full monorepo test run or a signed desktop/fleet qualification.

For a destination build, install the locked workspace dependencies and use the
repository's Turbo build/typecheck graph for server, host daemon, CLI and Plugin
SDK. Generate the official marketplace and declared builtin host artifacts using
that build graph; do not copy an incomplete private server bundle. Match the Node
or Electron ABI to native bindings. The qualified runtime used Node 22.19.0;
the companion helper used Node 24.20.0.

Any plugin/controller path, provider permission, cache ownership or runtime change
requires destination preflight before model dispatch. Use owned cache/temp roots;
the pinned Jiti profile disables filesystem cache with boolean `false`, not a path.
The exact host-specific controller is a reference in the companion repository,
not a portable auto-installer. Active rollout remains a separate operation.

The comparison-only Astra controller amendment and external benchmark adapter
patches are not included. No private worker prompts, credentials, campaign
databases, telemetry streams, raw frozen archives or compiled outputs are shipped
in this public repository. Compact identities and qualified limits are in
`VALIDATION.json`; earlier failed attempts remain retained locally.
