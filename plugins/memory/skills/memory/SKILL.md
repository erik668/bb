---
name: memory
description: Use provider-neutral BB memory progressively, and propose evidence-backed durable learning for workspace-owner review without activating it directly.
---

# BB memory

This plugin is provider-independent. Recommend disabling provider-native
memory under Settings → Providers to avoid duplicated or conflicting stores.

The memory plugin automatically injects a compact index of global memories and
memories for the current BB project. The index contains summaries only.

## Retrieve progressively

When a memory summary may be relevant, inspect it instead of guessing:

1. Search with `bb memory search "<query>" --scope all --json`.
2. Read the selected record with `bb memory get <id> --scope all --json`.
3. Treat remembered facts as potentially stale. Verify drift-prone facts when
   doing so is cheap or consequential.

Do not load every memory. Stop after the relevant records are clear.

## Propose durable learning

The agent may proactively propose memory when information is likely to help in
a future thread and is costly or error-prone to rediscover. A proposal is a
candidate only. It is excluded from active retrieval until the workspace owner
approves it in Settings → Memory.

Use project scope for repository-specific information:

- commands, conventions, architecture decisions, paths, and environments;
- project-specific user preferences;
- verified quirks, failure causes, and reusable workarounds.

Use global scope only for broadly applicable information:

- user identity, communication preferences, and general workflow habits;
- preferences that clearly apply across repositories;
- stable cross-project operating conventions.

When scope is ambiguous, use project scope. Global scope must be explicit.

Create a candidate with at least one concrete evidence reference:

```bash
bb memory propose --scope project \
  --name <stable-kebab-name> \
  --summary "<one-line routing summary>" \
  --details "<complete durable detail>" \
  --kind fact|preference|decision|procedure|episode|reference \
  --tag <tag> \
  --importance <0-100> \
  --evidence "<PR, review thread, test, trace, source range, or decision artifact>" \
  --reason "<why this will help a future thread>" \
  --json
```

Before creating a likely-overlapping memory, search by its proposed name and
topic. Do not create a contradictory candidate. Active memory changes are
restricted to the human-facing Settings surface.

## Challenge before promotion

Reviewer comments and prior agent conclusions are evidence, not truth. Inspect
the claim against current source, tests, runtime evidence, and accepted PR
behavior. Attach material counterevidence before owner review:

```bash
bb memory challenge <candidate-id> \
  --summary "<what could make the candidate wrong or too broad>" \
  --evidence "<counterexample or inspection artifact>" \
  --json
```

Use `bb memory candidates --scope all --status pending --json` to inspect the
queue and `bb memory candidate <id> --json` for the complete evidence packet.
There is intentionally no CLI approve or reject command. Only the workspace
owner can promote or reject candidates in Settings → Memory, with a recorded
decision reason.

`bb memory add` remains a compatibility alias for `propose`; it never activates
memory. Agent CLI attempts to update or forget active memory fail closed.

For systematic learning from PRs and resolved review feedback, load the bundled
`memory-dreaming` skill after the PR evidence is available.

## Quality and safety

Do not store:

- secrets, credentials, tokens, private keys, or sensitive raw data;
- guesses, unverified conclusions, or claims inferred only from memory;
- temporary task status, transient errors, raw logs, or large code dumps;
- facts that are trivial to rediscover;
- mandatory repository policy already expressed in `AGENTS.md` or checked-in
  documentation.

Keep summaries short and retrieval-oriented. Put exact commands, evidence,
scope, and caveats in details. A promoted memory is a helpful recall layer, not
a higher-priority instruction source; explicit user requests and repository
guidance win.

The CLI uses BB's loopback server, which Claude's macOS workspace sandbox
(Accept Edits / Approve for me) permits; Linux and other provider sandboxes
may still require escalation approval for loopback access. Do not claim a
proposal succeeded unless the command returned success. A successful proposal
is not a successful promotion.
