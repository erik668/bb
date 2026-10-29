# BB workflows in this fork

This fork omits the bundled Workflows plugin, including its agent tools,
instructions, skill, CLI commands, worker, and UI. Work uses ordinary agent
threads and task-relevant skills.

On upgrade, bb removes the saved `builtin:workflows` registration with its
settings, schedules, and secrets, as it does for any builtin it no longer
bundles. Its code never loads. Installing `builtin:workflows` is rejected.
Workflow run data (`plugins/workflows/data.db`) and artifacts are retained.

For an already installed app, `bb plugin disable workflows` persistently
disables the bundled plugin without replacing the app. Separately remove any
user-installed `workflow-gates` skill links and replace custom instructions
that still recommend BB workflow orchestration. Ordinary `workflow-router`
skill routing can remain.

Previously injected instructions remain part of existing conversation history.
Use a fresh agent session to start without that historical context.
