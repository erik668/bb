# Staged assurance workflow validation

## Candidate boundary

- Parent candidate: `/Users/erik/.bb/thread-storage/workflow-router-pipeline-staged-assurance.candidate.js`
- Child candidate: `/Users/erik/.bb/thread-storage/workflow-router-staged-assurance.candidate.js`
- Live saved workflows were not modified or hot-swapped.
- Human decisions are caller-supplied, contract-revision-bound objects with decision and evidence references. The workflow validates their shape and revision match; the authenticated caller must validate actor identity, evidence provenance, temporal ordering, and replay protection.
- Verification commands, counts, and statuses are worker-reported structured output. The workflow validates and gates on those reports but does not independently execute or attest the commands.

## Deterministic lifecycle matrix

| Stage or mode                                      | Required evidence                                                                                           | Worker admission                                                                                                                                                                             | Expected terminal state                                                                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy, no lifecycle input                         | Existing v1 plan contract                                                                                   | Existing route, plan, budget, risk, mutation, and model-profile behavior                                                                                                                     | Existing `planned`, `completed`, `partial`, or `blocked` result                                                                                |
| `mvp-definition`                                   | Objective and optional prior draft                                                                          | Three architecture perspectives in parallel, then Sol synthesis                                                                                                                              | `awaiting-human-mvp-approval`                                                                                                                  |
| Any later stage without matching contract approval | Current contract plus caller-supplied human `approved` decision for the same revision                       | Zero child-planner or worker calls                                                                                                                                                           | `awaiting-human-mvp-approval`                                                                                                                  |
| `shakedown-build`                                  | Approved current contract                                                                                   | MVP functionality, nondeferrable safety, and low-regret PSA preparation only; future assurance remains visible as deferred                                                                   | `awaiting-human-shakedown-launch` only after every nondeferrable item has completed section coverage and required worker-reported verification |
| `customer-shakedown` without launch approval       | Matching caller-supplied human launch approval                                                              | Zero planner or worker calls                                                                                                                                                                 | `awaiting-human-shakedown-launch`                                                                                                              |
| `customer-shakedown`                               | Launch approval                                                                                             | Read-only shakedown-learning and newly triggered nondeferrable safety, in dependency waves                                                                                                   | `awaiting-human-design-stability-decision`                                                                                                     |
| `design-stability` without evidence                | Launch approval plus at least one evidence reference                                                        | Zero assessor calls                                                                                                                                                                          | `shakedown-evidence-required`                                                                                                                  |
| `design-stability`                                 | Evidence references and optional matching human decision                                                    | Sol advisory assessment; agent cannot make the gate decision                                                                                                                                 | `ready-for-psa`, `redesign-required`, or `awaiting-human-design-stability-decision`                                                            |
| PSA before human stability decision                | Matching caller-supplied human `stable` decision                                                            | Zero planner or worker calls                                                                                                                                                                 | `awaiting-human-design-stability-decision` or `redesign-required`                                                                              |
| PSA `audit`                                        | Stable decision                                                                                             | All eight PSA components, read-only, verification-required, parallel by dependency wave                                                                                                      | `awaiting-human-psa-review`; missing, skipped, failed, or unverified component blocks                                                          |
| PSA `remediate` without findings                   | Stable decision plus finding references                                                                     | Zero planner or worker calls                                                                                                                                                                 | `finding-ledger-required`                                                                                                                      |
| PSA `remediate`                                    | Human-reviewed finding references                                                                           | Explicitly mutating owners serialize; independent eligible read-only work fans out. If red-team and mutating work coexist, the human gate prunes non-red-team work and may block dependents. | `awaiting-psa-re-audit` only after a completed remediation run                                                                                 |
| PSA `re-audit`                                     | Stable decision                                                                                             | All eight PSA components, read-only and verification-required; inline availability approval is rejected                                                                                      | `awaiting-human-availability-decision`; unresolved coverage blocks                                                                             |
| PSA `availability-decision`                        | Stable decision plus a later human decision carrying an evidence reference to the completed re-audit result | Zero planner or worker calls                                                                                                                                                                 | `availability-approved`, `availability-not-ready`, or `awaiting-human-availability-decision`                                                   |

The authenticated caller is responsible for ensuring each decision evidence reference points to the required prior successful stage result and cannot be replayed across projects, contracts, or superseded revisions.

## Safety and progress invariants

- Every nested plan is contract-validated before admission, including lifecycle stage, PSA mode, approved contract version, evidence references, and finding references.
- Risk triggers force red-team, nondeferrable-safety, read-only, and verification-required policy.
- PSA audit and re-audit force verification-required policy for every planned section.
- Verification-required work blocks on missing, failed, or skipped-only worker-reported verification and requires at least one worker-reported passing result with zero failures.
- A skipped mandatory section, failed dependency, uncovered nondeferrable contract item, or missing completed PSA component blocks the stage.
- Initial call-budget admission is dependency-closure-aware. A later red-team/mutation human gate may intentionally prune non-red-team sections; execution detects the broken dependency and blocks the dependent.
- Execution proceeds in dependency waves. Eligible read-only sections in a wave run in parallel; shared-workspace mutating owners remain serial.
- Selected-plan checkpoints expose route, model policy, lifecycle stage, contract reference, decision references, assurance class, PSA component, dependencies, mutation intent, contract coverage, verification requirement, and exit criterion.
- Work-item and verification checkpoints use stable IDs and record worker-reported commands and result counts.
- Instruction-level read-only behavior is not capability isolation. Workers inherit the origin filesystem permission mode; sensitive runs still require a restricted environment.

## Model routing

- The small model remains only on the schema-constrained intake classification call: `codex/gpt-5.4-mini/medium`.
- Lifecycle planning, contract synthesis, design-stability assessment, and judgment use `codex/gpt-5.6-sol/high`.
- Product/UX taste and authorized security-testing profiles use `claude-code/claude-fable-5/high`.
- Bounded implementation owners use `codex/gpt-5.6-luna/medium`.
- Critics keep deterministic profile routing; workers do not inherit the intake mini by default.

## Mechanical verification

Run against the final frozen candidates:

```sh
bb provider models codex --environment "$BB_ENVIRONMENT_ID" --json
bb provider models claude-code --environment "$BB_ENVIRONMENT_ID" --json
bb workflows validate --script "$(< /Users/erik/.bb/thread-storage/workflow-router-pipeline-staged-assurance.candidate.js)"
bb workflows validate --script "$(< /Users/erik/.bb/thread-storage/workflow-router-staged-assurance.candidate.js)"
node --check /Users/erik/.bb/thread-storage/workflow-router-pipeline-staged-assurance.candidate.js
node --check /Users/erik/.bb/thread-storage/workflow-router-staged-assurance.candidate.js
```

- Final parent SHA-256: `7679cbc1fc0ae8052e47a121116b69280e16e8f88b26cc0649244270c8eb145d`
- Final child SHA-256: `ebb7dc776d1d21dc2fde7ae6c04b8df3dee4e9757a60f705780e350530fe1367`
- Final validator/provider/test results on 2026-08-21 in `env_88g5eb749t`: both workflow validators returned `valid: true` (validator-reported source lengths: 87,677-byte parent; 29,312-byte child); provider discovery confirmed `codex/gpt-5.4-mini/medium`, `codex/gpt-5.6-sol/high`, `codex/gpt-5.6-luna/medium`, and `claude-code/claude-fable-5/high`; the QuickJS lifecycle matrix passed 7/7 tests; the workflows plugin passed 257/257 tests across 14 files and package typecheck, including the schema-valid terminal-reserve boundary regression and causal presentation authorization coverage; both candidates passed `node --check`; and `git diff --check` reported no diagnostics.
