Give your agents a memory that survives across threads, projects, and providers. The agent reads a short catalog of past learning at the start of each turn. It proposes evidence-backed learning for the workspace owner to review.

## What you get

- Global memories for user preferences and cross-project habits.
- Project memories for commands, conventions, decisions, and verified quirks.
- A summary catalog that bb adds to the agent's instructions on every turn. The catalog holds summaries only, up to 3,900 characters.
- A candidate review queue in plugin settings where only the workspace owner approves or rejects proposals.
- A table in the plugin settings where you review, edit, and delete active memories.
- An opt-in, read-only native memory bridge that stores shadow metadata and reads selected content by hash.
- Kinds, tags, importance, pinning, provenance, and version history for each record.

## How it works

The agent uses the `bb memory` CLI. `bb memory search` finds summaries with keyword search. `bb memory get` reads one complete record. `bb memory propose` creates a candidate with evidence, and `bb memory challenge` attaches counterevidence before review. `bb memory add` is a proposal alias. Only the workspace owner can approve or reject candidates or edit and delete active memories through Settings. `bb memory catalog` and `bb memory history` list summaries and past versions.

Project writes use the project of the current thread. Global writes must pass `--scope global`. The bundled `memory` skill teaches the agent when to search and what to propose. The `memory-dreaming` skill guides evidence synthesis and challenges before owner review. The plugin rejects text that looks like a secret or a prompt injection.

## Requirements

The optional native observation bridge is disabled by default. When enabled, provider files remain an untrusted evidence source and never enter active memory automatically. The CLI connects to the local bb server. Some provider sandboxes ask for approval before they allow that connection.
