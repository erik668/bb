# Workflow Deterministic Admission Context Packet

Status: walking skeleton complete
Last updated: 2026-08-27
Current phase: handoff-ready walking skeleton; constrained check capability and malformed-HCL admission proven without an agent call
Walking-skeleton gate: implementation and independent critic recheck complete
Execution envelope: one implementation agent; targeted workflow-plugin tests; stop on a contract or host-routing reversal

## Objective

Prevent deterministic defects from reaching paid workflow owners and critics by running contract-pinned, script-computed admission checks in the workflow origin environment.

## Decisions And Constraints

- Add a named `check()` workflow capability, not a general shell escape.
- A workflow supplies a suite identifier and pinned contract/candidate identity; it does not supply an executable.
- Suite contracts must be non-mutating, bounded, cancelled with the run, and rerun after resume. BB does not claim an atomic source snapshot or OS read-only sandbox: project-owned suite code is trusted, and source digests checked before and after execution detect stable or persistent drift, not an adversarial swap-and-restore. The Terraform suite detects candidate mutation by recomputing identity before and after execution.
- Admission fails closed on zero selection, failures, skips, malformed output, timeout, cancellation, or digest mismatch.
- Prove one malformed-HCL check before adding Terraform escaping, tag inheritance, or IAM completeness.
- Do not modify `/Users/erik/Documents/bb-agent-browser-control` or `/Users/erik/claude-harness`; both clean implementation branches live under this thread workspace.

## Constraint Descent

- Hard facts: the workflow QuickJS VM currently exposes `agent`, nested `workflow`, `log`, and `phase`; workflow service calls already pin an origin `environmentId`; plugin host RPC provides the host-local execution primitive.
- Derived constraints: the new capability must preserve the QuickJS process/require sandbox and cannot let candidate-controlled files select arbitrary host commands.
- Assumptions: the plugin host lifecycle can provide bounded output, exit status, process-group cancellation, and correct origin cwd without a new public SDK surface. Adding the host RPC payload requires a host-daemon protocol bump.
- Foundational limitations: workflow resume currently replays agent-call prefixes; deterministic filesystem checks cannot reuse evidence until their complete input closure is modeled.

## Current Map

- `plugins/workflows/src/types.ts`: workflow capability contract.
- `plugins/workflows/src/runtime.ts`: QuickJS host-function bridges and scheduler.
- `plugins/workflows/src/service.ts`: origin environment, run lifecycle, replay, and capability wiring.
- `packages/sdk/src/areas/terminals.ts`: environment-scoped terminal API.
- `plugins/workflows/src/runtime.test.ts`: VM capability and sandbox coverage.
- `plugins/workflows/src/server-harness.test.ts`: workflow service and resume integration coverage.
- `../workflow-gates-checks/skills/workflow-gates/templates/gated-suffix.workflow.js`: deterministic admission and paid owner/critic/G1 tail.

## Interface Contracts

- U1 BB check primitive: suite id plus pinned JSON input -> structured JSON receipt; owns VM-to-origin-environment execution and lifecycle.
- U2 admission runner: immutable suite id plus manifest-pinned suite version, pre/post implementation-source digests, and contract/candidate digests -> fail-closed receipt; owns executable selection and domain-check dispatch within the trusted-workspace threat model.
- U3 suffix wiring: pre-owner and post-owner receipt -> block, bounded repair, or critic launch; owns model-call admission order.

## Transition / Rollout Rows

- Existing workflows without `check()` -> identical behavior -> existing workflow tests.
- `check()` workflow with valid named suite -> command runs in origin environment and returns bounded receipt -> runtime/service integration test.
- Invalid, unknown, timed-out, cancelled, skipped, or zero-selection suite -> no paid downstream call -> walking-skeleton workflow test.
- Resumed workflow -> check reruns live -> resume integration test.

## Read Budget For Agents

Must read:

- this packet
- `plugins/workflows/src/types.ts`
- `plugins/workflows/src/runtime.ts` host-function installation ranges
- `plugins/workflows/src/service.ts` `resolveOrigin` and `executeRun`
- terminal SDK contract ranges

May inspect:

- workflow runtime/service tests
- terminal public tests for lifecycle behavior
- workflow-gates suffix admission and owner/critic phase ranges

Do not read unless blocked:

- app UI
- provider plugins
- unrelated daemon commands
- monorepo mission artifacts

## Validation

- `./scripts/related-specs.sh plugins/workflows/src/runtime.ts plugins/workflows/src/service.ts`
- targeted workflow plugin tests through Turbo
- workflow-gates unit/fixture command discovered from its README/package metadata
- end-to-end malformed HCL fails before an agent call; valid HCL reaches the next phase

## Fault List For Committed Tests

- VM boundary accepts malformed or extra request fields, or leaks host execution when `check` is unavailable.
- Non-`full` workflow permission reaches host execution.
- Manifest path escapes the workspace, its SHA pin is ignored, or an unknown suite executes.
- Host execution interpolates through a shell, leaves descendant processes alive on cancellation, or returns unbounded output.
- Manifest bytes stay fixed while the expected suite version or a project-owned implementation input changes.
- Non-zero, timed-out, truncated, malformed, contradictory, or differently pinned receipts are treated as green.
- A resumed workflow reuses an agent result after a live check instead of treating the check as a replay barrier.

## Open Questions

- Whether a future built-in suite allowlist should replace trusted project-owned suite execution when adversarial filesystem isolation is required.
- Whether the first receipt can remain in workflow result/checkpoint state or needs a persisted first-class call row. Prefer no migration unless evidence shows it is required.

## Stop / Replan Triggers

- Candidate-controlled input can choose the executable or alter the suite definition.
- Environment terminal commands cannot be cancelled or bounded without a new daemon contract.
- A second load-bearing semantic reversal, two compactions, or three failures at the same live seam.

## Handoff Prompt Stub

Use this packet as the source of truth. Work only on the current unit and named files. Return changed paths, targeted validation, and any tripped assumption.
