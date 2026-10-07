# P1 fault-first capsule map

This map is fixed before tests or actor implementation. Every capsule traverses
the scheduler's ordinary dispatcher and is admitted only by an independently
observed behavioral kill. Descriptor text, self-attested booleans, and source
inspection are not evidence.

| Fault class | Known-bad capsule | Unique observer-owned kill |
| --- | --- | --- |
| Stimulus-derived normalization | A defective normalizer probes unavailable semantic bait; legitimate normalization is repeated with bait permutations over identical sealed raw and reopen bytes. | `NORMALIZER_CAPABILITY_DENIED` plus invariant legitimate digest |
| SDK receipt or cache replay | A prior SDK receipt is replayed under a fresh opaque identity and empty target root while the named target is poisoned. | `SDK_ROW_LIFECYCLE_ABSENT` from missing row-owned command start/completion, process/root, and target-output observations |
| Descriptor-derived kills | Decoy reason and receipt-type values are permuted outside observer capability while the same opaque mutant is injected at the same slot. | `DESCRIPTOR_DIVERGENCE` while the boundary-owned typed code remains stable |
| Reused candidate handle or cache | Candidate capability material is offered to reopen instead of closing the candidate and launching a fresh observer handle. | `REOPEN_CAPABILITY_REJECTED` with distinct candidate and observer process facts |
| Candidate-selected persistence path | The candidate attempts to substitute its own state root for the recorder-issued root. | `RECORDER_ROOT_MISMATCH` from recorder attestation and independent reopen |
| Expectation leakage | An actor probes private authority before the actual ledger is sealed. | `PRIVATE_AUTHORITY_DENIED` with reveal absent and unchanged actual digest |

The six kill codes are intentionally disjoint. A capsule that does not produce
its assigned code through the ordinary runtime path consumes this seam.
