# Workflow build-story capability inventory

Date: 2026-08-22

Scope: the Workflows plugin's durable run/checkpoint model and the workflow
progress inspector. The local BB server is the production surface for this
single-customer installation.

| Capability                                               | Status               | Code reference or gate                                                                                         | Local usage snapshot                                                                  | Disposition                                                                                                         |
| -------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Origin/presentation thread visibility                    | exists-and-used      | plugins/workflows/src/service.ts:681; plugins/workflows/src/server.ts:106                                      | 2 of the 50 most recent runs use a distinct presentation thread                       | Preserve as the authorization boundary for aggregated details                                                       |
| Causal parent/root run lineage                           | permitted-but-unused | plugins/workflows/src/data.ts:164; plugins/workflows/src/service.ts:681                                        | 0 of the 50 most recent runs have parentRunId; all are top-level                      | Preserve for causal provenance; do not reinterpret it as a multi-run build campaign                                 |
| Inline child workflow composition                        | exists-and-used      | plugins/workflows/src/runtime.ts:319; plugins/workflows/README.md:88                                           | unmeasured; inline children share one durable run instead of creating another run row | Preserve for continuous execution inside one run                                                                    |
| Per-run phase and agent progress                         | exists-and-used      | plugins/workflows/src/ui-view.ts:66; plugins/workflows/src/app.tsx:330                                         | present on the current run surface                                                    | Preserve; campaign aggregation must not erase per-run provenance                                                    |
| Structured plan, work-item, and verification checkpoints | exists-and-used      | plugins/workflows/src/workflow-checkpoint.ts:28; plugins/workflows/src/server.ts:137                           | present in workflow-router smoke runs                                                 | Extend compatibly                                                                                                   |
| Plan/work dependency edges                               | proposed-new         | plugins/workflows/src/workflow-checkpoint.ts:36; strict plan/work-item schemas reject undeclared edge fields   | no edge field or graph renderer found                                                 | Add bounded dependsOn fields and validate references/cycles in the view model                                       |
| Structured transition rationale                          | proposed-new         | plugins/workflows/src/workflow-checkpoint.ts:112; the discriminated union has only three kinds                 | no transition checkpoint or decision log found                                        | Add a transition checkpoint carrying actor, source/target state, affected nodes, rationale, and evidence            |
| Cross-run campaign identity                              | proposed-new         | plugins/workflows/src/data.ts:202; workflow_runs stores causal lineage but no campaign column                  | 7 recent workflow-router-family runs are independent top-level rows                   | Add an explicit campaign ID inherited across child/resumed runs and validated across independent continuations      |
| Campaign-scoped inspector aggregation                    | proposed-new         | plugins/workflows/src/server.ts:137 returns checkpoints for one authorized run only                            | unavailable                                                                           | Aggregate only runs sharing campaign, project, environment, and presentation thread; retain run IDs on every record |
| Root-card campaign continuity                            | proposed-new         | Current preview directives address a run ID, while the selected root inspector can resolve that run's campaign | unavailable                                                                           | Make any campaign member's inspector show the whole campaign; keep the wire directive backward compatible           |

## Evidence

Local snapshot:

    bb workflows list --limit 50
    total=50
    topLevel=50
    nested=0
    relatedPresentation=2
    routerFamily=7

Discovery searches:

    rg -n "parentRunId|rootRunId|presentationThreadId" plugins/workflows/src
    rg -n "dependsOn|transition|campaign" plugins/workflows/src

The proposal intentionally separates three concepts:

1. rootRunId remains causal execution lineage.
2. campaignId groups independent runs that belong to one human-visible build.
3. checkpoint dependency edges describe the work DAG inside that campaign.

This avoids fabricating parent/child causality while allowing a selected root
card or any related run card to tell the complete build story.
