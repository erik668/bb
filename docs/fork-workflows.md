# BB workflows in this fork

This fork omits the bundled Workflows plugin, including its agent tools,
instructions, skill, CLI commands, worker, and UI. Work uses ordinary agent
threads and task-relevant skills.

On upgrade, saved `builtin:workflows` registrations are disabled before their
code loads, even if an old plugin directory still exists. Enabling one again
leaves it disabled. Installing `builtin:workflows` is rejected because it is
no longer bundled. Existing workflow run data and artifacts are retained.

For an already installed app, `bb plugin disable workflows` persistently
disables the bundled plugin without replacing the app. Separately remove any
user-installed `workflow-gates` skill links and replace custom instructions
that still recommend BB workflow orchestration. Ordinary `workflow-router`
skill routing can remain.

Previously injected instructions remain part of existing conversation history.
Use a fresh agent session to start without that historical context.
