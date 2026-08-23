# Memory dreaming and promotion contract

Status: implementation contract for the first PR-learning slice.

Promotion authority: the workspace owner. Agents may propose and challenge;
only the human-facing Settings → Memory surface may approve or reject.

## Requirements

- `MEM-RQ-001` Candidate proposals must remain absent from active catalog,
  search, and full-record retrieval until approval.
- `MEM-RQ-002` Every candidate must carry at least one evidence item and pass
  the existing content safety checks.
- `MEM-RQ-003` Agents may append counterevidence, and each challenge must
  advance the candidate version so a stale human review fails closed.
- `MEM-RQ-004` Approval must atomically create one active memory, terminalize
  the candidate, and persist a decision receipt bound to the reviewed version.
- `MEM-RQ-005` Rejection must terminalize the candidate without creating active
  memory; a terminal candidate cannot receive another decision or challenge.
- `MEM-RQ-006` No agent-accessible CLI command may approve/reject a candidate or
  update/delete active memory. `add` must be a candidate-only alias.
- `MEM-RQ-007` The PR-learning skill must treat reviewer comments as evidence,
  distinguish adopted preferences from correctness claims, challenge candidate
  lessons, and stop before promotion.
- `MEM-RQ-008` Provider-native memory observation must be explicitly enabled,
  read-only, project-scoped, metadata-only at rest, and unable to create an
  active memory or candidate by itself.
- `MEM-RQ-009` A provider source read must be confined to the resolved memory
  root and bound to the content hash recorded by the latest scan. Traversal,
  symlinks, oversize input, stale content, and unavailable sources fail closed.
- `MEM-RQ-010` Dreaming over native observations must retain the five-candidate
  cap, cluster overlapping sources, discount echoes, generalize only as far as
  the evidence proves, challenge survivors, and retain owner-only promotion.

## Acceptance tests

| ID           | Initial state        | Action                                                   | Observable result                                                    | Forbidden result                        | Environment                          | Evidence                               |
| ------------ | -------------------- | -------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------- | ------------------------------------ | -------------------------------------- |
| `MEM-AT-001` | Empty active catalog | Propose a valid candidate                                | Candidate is readable only through candidate commands                | Candidate appears in catalog/search/get | Source harness + packaged runtime    | Focused test output and packaged probe |
| `MEM-AT-002` | Pending candidate v1 | Append a grounded challenge, then approve v1             | Challenge returns v2; v1 approval fails                              | Stale approval activates memory         | Source harness                       | Focused test output                    |
| `MEM-AT-003` | Pending candidate    | Approve current version in Settings                      | Active memory, approved candidate, and owner receipt appear together | Any partial state persists              | Source harness + packaged runtime    | RPC test and packaged probe            |
| `MEM-AT-004` | Pending candidate    | Reject in Settings, then try approval                    | No active memory; second decision fails                              | Rejected claim becomes retrievable      | Source harness                       | Focused test output                    |
| `MEM-AT-005` | Active memory        | Invoke agent CLI update/forget and inspect command list  | Both fail closed; no approve/reject command exists                   | Agent mutates or promotes active memory | Source harness + packaged runtime    | CLI test and live help/probe           |
| `MEM-AT-006` | Candidate review UI  | Leave reason empty, then enter reason and approve        | Action disabled until reason; current version is submitted           | Unreasoned or stale UI promotion        | jsdom UI test + rendered Settings QA | UI test and screenshot                 |
| `MEM-AT-007` | Native bridge off    | Finish a Claude thread or request a manual scan          | No host read; manual scan explains how to opt in                     | Provider storage is accessed            | Source harness                       | Focused test output                    |
| `MEM-AT-008` | Native bridge on     | Scan, rescan changed/removed sources, then list projects | Project A sees deduped versions/removals; project B sees none        | Observation enters catalog/candidates   | Source harness                       | Focused test output                    |
| `MEM-AT-009` | Indexed source hash  | Read source, mutate it, then read with the old hash      | First read is labeled untrusted; second refuses as stale             | Stale or escaping content is returned   | Host + source harness                | Focused test output                    |

## Failure and recovery tests

- `MEM-FRT-001`: force an active-name collision during approval. The transaction
  must leave the candidate pending and create neither memory nor receipt.
- `MEM-FRT-002`: add a challenge after a reviewer loads v1. Approval against v1
  must fail and preserve the pending v2 candidate.
- `MEM-FRT-003`: restart/reload the plugin between proposal and decision. The
  candidate, challenges, version, and eventual receipt must persist.

## Claim boundary

This slice provides durable candidate state and an owner-only BB Settings
boundary. The receipt actor label is `memory-settings-owner`; it does not claim
cryptographically distinct human identity. Automatic candidate generation,
Codex native-memory observation, embedding retrieval, eval-based
auto-promotion, and multi-user approval policy are not implemented. Claude Code
native memory is an optional evidence source only.
