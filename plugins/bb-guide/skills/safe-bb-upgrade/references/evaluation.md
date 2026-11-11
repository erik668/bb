# Validation record

Validated on 2026-11-08 without updating, stopping, starting, or migrating the
user's BB installation.

## Fresh-context evaluations

Three independent evaluations were run according to the skill-creator workflow.
All were read-only and explicitly prohibited app commands and live mutations.

| Case        | Prompt / expected result                                                                                                                                                                                                                                                       | Observed result                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Positive    | Upgrade running BB/Electron with active threads, dirty preview/Connect fixes, and replaced upstream preview code. Stage integration first, preserve behavior, test the entire stack and migration copies, activate from outside the app, and require post-activation evidence. | Passed. The evaluator followed the sequence and identified missing durable recovery copies and command/script receipts. Both were implemented and regression-tested.                                                                |
| Baseline    | Same request without exposing this skill.                                                                                                                                                                                                                                      | The baseline also chose staging and a recovery handoff. No improvement in general planning quality is claimed. The added helper makes ordering, source identity, recovery records, and customization gates executable and testable. |
| Near misses | Advice about Electron support; BB sidebar development; another app's Electron upgrade; adding the skill itself.                                                                                                                                                                | All excluded. Updating the running BB installation while preserving its fork matched the trigger.                                                                                                                                   |

## Executable checks

`python3 -m unittest discover -s scripts -p 'test_*.py' -v` passed all 16 tests
using disposable Git repositories/worktrees, synthetic commands, and SQLite data.
Coverage includes phase order, source drift, dirty candidate rejection, new live
edits, app-hosted activation refusal, inherited live environment removal, pending
customizations, failed/interrupted attempts, SQLite snapshots refreshed at stop,
wrong post-update revisions, recovery-copy survival/integrity, exact command/script
receipts, script mutation detection, and the complete foreground phase sequence.

Frontmatter, skill/directory naming, resource links, and helper paths also passed.

These checks exercise the guard and instruction selection. They do not establish
that an arbitrary future BB release, target-specific operator script, migration,
plugin combination, or macOS permission transition works. Each actual upgrade
must supply and pass its own complete-stack and recovery checks before activation.
