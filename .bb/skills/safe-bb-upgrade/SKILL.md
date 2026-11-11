---
name: safe-bb-upgrade
description: Use when asked to pull or upgrade the running BB installation, sync its fork, or upgrade its Electron runtime while preserving local behavior and a working recovery path. Excludes advice-only version questions, ordinary feature development, and unrelated Electron apps.
---

# Safe BB upgrade

The canonical skill and foreground helper ship in this repository's BB guide
plugin. Before performing an upgrade, resolve the repository root with
`git rev-parse --show-toplevel`, then read and follow:

`<repo>/plugins/bb-guide/skills/safe-bb-upgrade/SKILL.md`

Resolve every supporting reference and script relative to that canonical skill
directory. This entry makes the procedure discoverable in a fresh checkout before
its running BB has been upgraded; the bundled plugin makes it available across
projects afterward.

Keep the serving checkout unchanged while staging integration and complete-stack
checks. Activation and recovery must run from an independent foreground harness
that survives BB stopping. Reading this skill does not authorize an upgrade beyond
the user's request.
