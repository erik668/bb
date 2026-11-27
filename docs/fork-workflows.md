# Workflows in this fork

This fork bundles the unmodified upstream Workflows plugin. It is disabled by
default, matching upstream. Enable it with `bb plugin enable workflows`; use
`bb workflows validate|run|status|history|list|stop` and the bundled `workflows`
skill for its standard JavaScript orchestration.

The former enhanced fork runtime, workflow-gates releases, campaign and artifact
review extensions, and their custom skills are not bundled. Ordinary agent
threads and task-relevant skills remain available alongside upstream Workflows.

The upstream plugin source is taken directly from the upstream revision recorded
by the fork's merge commit. Future syncs should keep that plugin aligned with
upstream instead of reintroducing the old extensions.

Previously retained workflow databases and artifacts are not deleted by this
source sync. Compatibility with historical enhanced-runtime data must be checked
on copies before activating an upgraded app against that data.
