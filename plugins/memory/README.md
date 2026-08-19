# bb-plugin-memory

BB's official plugin for durable, progressively disclosed agent memory. It
provides:

Because this memory store works across providers, we recommend turning off
provider-native memory under Settings → Providers while using it. That avoids
duplicated or conflicting memories split between Codex, Claude Code, and bb.

- plugin-private SQLite storage with append-only migrations;
- global and current-project memory scopes;
- an automatically injected, 3,900-character summary catalog through
  `bb.agents.contributeInstructions`;
- CLI-only agent access through `bb memory` (no native agent tools);
- FTS5 search followed by full-record reads;
- explicit provenance, tags, kinds, importance, pinning, and version history;
- evidence-backed candidate memories and adversarial challenges;
- workspace-owner-only promotion and rejection through Settings, with durable
  decision receipts;
- optimistic Settings edits and soft deletion for active memories;
- basic prompt-injection and secret-pattern rejection;
- bundled `memory` and progressively loaded `memory-dreaming` skills;
- a Settings → Memory table for reviewing, editing, and deleting every stored
  global or project memory.

## Install

Install Memory from the BB Official catalog:

```bash
bb plugin install memory
bb plugin list
```

## Try it

```bash
bb memory propose \
  --scope project \
  --name turbo-validation \
  --summary "Use Turbo for builds and typechecks" \
  --details "Run pnpm exec turbo run typecheck --filter=@bb/<pkg>." \
  --kind procedure \
  --tag build \
  --tag testing \
  --importance 80 \
  --evidence "Merged PR and focused test output" \
  --reason "Durable repository validation convention" \
  --json

bb memory candidates --scope all --status pending --json
bb memory search "Turbo typecheck" --scope all --json
bb memory get <id> --scope all --json
```

Project proposals take the invoking CLI's BB project context. Global proposals
must explicitly pass `--scope global`. Proposals and challenges never enter the
injected catalog. The workspace owner reviews them under Settings → Memory; an
approval atomically creates the active memory and a decision receipt. The
catalog refreshes at every thread start / turn submission, so the promoted
memory is visible on the next turn.

`bb memory add` is a compatibility alias for `propose`; it no longer writes
active memory. Agents cannot approve/reject candidates or update/delete active
memory through the CLI.

## Limitations

- CLI calls require loopback access to the local server. Claude's macOS
  workspace sandbox permits this; Linux and other provider sandboxes may
  still block it.
- Retrieval is FTS5 keyword search in this version; embeddings and automatic
  background PR ingestion remain deferred. The bundled `memory-dreaming` skill
  provides the evidence-first synthesis/challenge phase when explicitly loaded.
- The safety scanner is a guardrail, not a substitute for avoiding sensitive
  memory content.

## Develop

```bash
pnpm exec turbo run test typecheck --filter=bb-plugin-memory
bb plugin dev ./plugins/memory
```
