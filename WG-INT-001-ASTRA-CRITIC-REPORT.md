# WG-INT-001 independent exact-source critic

Verdict: **CHANGES REQUIRED**

Critic identity: `/root/astra_critic`, commissioned as the fresh Astra critic. No owner conversation/history was supplied. The critic received the commission, frozen candidate, bounded review instructions, and artifact locations. Model routing identity is owned by the parent/orchestrator; this report does not independently attest runtime model metadata.

The IN_PROGRESS receipt was persisted before source inspection. The critic changed no production/test source, lockfile, candidate freeze, or existing evidence. Review used code-review, test-reviewer and its rubric, simplify (review only), code-standards, code-navigation, and an OWASP access-control/design lens. Scope restrictions took precedence over simplify's repair instruction. No memory/history lookup or secondary delegation was used.

## Exact object

- Root: `/Users/erik/.bb/thread-storage/thr_vfqhedcjfx/bb-wg-int001-source`
- Branch: `bb/wg-int001-personal-workspace-selection-exact`
- Base commit: `7cdd77ba9cd23f71f7833bd989d63565128c6fea`
- Base tree: `f6fadacc570e7771e2474a15d1d996f5be8e1281`
- Candidate freeze SHA-256: `76aed3207ea9e513fb3c58cd15e56b97fdabe2cf65d20fe32a9740a3a0b11701`
- Candidate `git diff --no-ext-diff --binary` SHA-256: `14232d4424af2c62de5204022ef5c53cfe5c80dc06c60f3c1f00f4b3228310cf`

All four changed-path hashes, both unchanged pins (eligibility source and lockfile), base commit/tree/branch, and the four changed files' baseline hashes matched the supplied freezes. The tracked diff comprises only the two selector/caller files and their two corresponding test files: 260 insertions and 15 deletions. `git diff --check` passed. The diff hash was rechecked after the independent probe and remained unchanged.

## Finding requiring change

**P2 / high confidence — the ready-path predicate admits a value rejected by the existing create boundary.**

At `apps/server/src/services/threads/thread-default-policy.ts:146`, a ready personal parent is reusable when `environment.path !== null`. This includes the empty string. The authoritative domain contract permits that value (`packages/domain/src/environment.ts:72`, `z.string().nullable()`), but the existing create boundary rejects it at `apps/server/src/services/threads/thread-create.ts:723` with `environment.status === "ready" && !environment.path`.

For a live same-project personal parent, matching requested host, ready status and `path: ""`, the new selector therefore synthesizes a reuse request that is known to fail the later boundary, instead of preserving the requested personal-host creation path. This violates requirement 1's usable-path condition. It is a source/contract edge defect; no claim is made that this state was observed in a deployed system.

Independent read-only reproduction imported the actual domain schema and actual `resolveCreateThreadEnvironment` from the frozen checkout using Node/tsx from `apps/server`. The input parent had `id: "thr-parent"`, `archivedAt: null`, `deletedAt: null`, `environmentId: "env-parent"`, `parentThreadId: null`, and the personal project ID. Environment facts were matching host/project, personal kind, ready status, and empty path. The request was `{type:"host",hostId:"host-1",workspace:{type:"personal"}}`. Output:

```json
{"emptyPathAcceptedByDomain":true,"result":{"type":"reuse","environmentId":"env-parent"},"existingBoundaryRejectsReadyPath":true}
```

Required successor change: align ready-path usability with the existing boundary and add a regression asserting that an empty ready path preserves the original host request. Keep explicit reuse validation unchanged. The current null-path case at `apps/server/test/threads/thread-default-policy.test.ts:343` does not catch this distinction. No repair or mutation was made by the critic.

## Required behavior, quoted verbatim

> 1. `resolveCreateThreadEnvironment` may implicitly reuse a personal parent's environment only after authority-owned environment facts establish same project, `workspaceProvisionType=personal`, compatible requested host, and usable lifecycle/path semantics at the existing server boundary.

**CHANGES REQUIRED.** Facts come from the parent's environment ID through `getEnvironment` at `thread-create.ts:610-616`; the selector requires a live same-project parent at `thread-default-policy.ts:275-286` and fact compatibility at `:132-147`. Project, kind, and requested-host restrictions are correct. Provisioning is preserved; retiring is intentionally revivable at `thread-create.ts:710-715`, covered by `thread-create-seed-without-run.test.ts:881-925`. Ready empty-path handling is defective as above.

> 2. A personal parent attached to a same-project unmanaged environment must not be rewritten into an invalid reuse request. Preserve the caller's requested personal-host intent so normal creation/selection proceeds through existing authority.

**PASS.** `thread-default-policy.ts:136` refuses unmanaged facts and `:305` returns the original request. The caller forwards that request through `resolveStableThreadRequestEnvironment` at `thread-create.ts:682-686`. The new selector regression at `thread-default-policy.test.ts:295-312` and database-backed creation regression at `thread-create-seed-without-run.test.ts:104-146` assert observable behavior, including the resulting personal environment and non-reuse of the unmanaged environment.

> 3. An explicit personal host request must not silently discard a different requested host in favor of the parent.

**PASS.** The explicit host comparison is at `thread-default-policy.ts:137-138`; fallback at `:305` preserves the entire original request. Tests at `thread-default-policy.test.ts:314-329` and `thread-create-seed-without-run.test.ts:148-193` cover different-host selection and persisted host identity.

> 4. Preserve explicit environment-ID reuse, exact fork-source unmanaged exception, standard-project managed-worktree isolation, and the existing eligibility guard. Do not add a blanket unmanaged bypass or a global personal project/host singleton.

**PASS.** Explicit reuse bypasses the personal-host rewrite and passes through at `thread-default-policy.ts:305`; existing coverage is at `thread-default-policy.test.ts:242-256`. The fork-source ID computation at `thread-create.ts:597-605` and forwarding at `:683` preserve the exact-ID exception. `thread-request-eligibility.ts:92-104` retains the unmanaged-plus-exact-ID condition and `:170-182` retains project and host checks; the entire file's hash is unchanged. Positive and negative fork exception tests remain at `thread-create-seed-without-run.test.ts:942-1044`. Standard managed-worktree selection remains at `thread-default-policy.ts:294-302`, tested at `thread-default-policy.test.ts:206-240`. No singleton, blanket bypass, host-daemon wire-contract change, or expanded authority was introduced.

> 5. Return typed bounded compatibility/selection diagnostics where the existing contract supports them. Do not parse error-message text and do not retry a possibly accepted thread create.

**PASS for the existing contract.** The selector returns the existing typed `EnvironmentArgs` at `thread-default-policy.ts:270-272`; it has no diagnostic-result field. Existing eligibility failures retain `ApiError` status/code behavior (`thread-request-eligibility.ts:100-111`, `:170-175`), and existing lifecycle failures remain at `thread-create.ts:721-724`. The diff adds neither diagnostic contracts nor free-text error classification, catches, retries, or race handling. No diagnostic expansion is required to fix the finding.

> 6. Feature-off or unaffected legacy paths must remain observationally unchanged.

**PASS for inspected unaffected paths.** No feature flag is added or consumed by this patch. The repair is limited to implicit personal-parent host requests; non-personal, explicit reuse, explicit unmanaged path, and absent/deleted-parent paths retain the prior branches and returned values (`thread-default-policy.ts:294-305`; tests at `thread-default-policy.test.ts:206-256`, `:388-431`). The new environment lookup is gated to the personal-host shape (`thread-create.ts:610-616`). This is a bounded source/parity assessment, not proof of every external side effect or any deployed rollback state.

## Test quality and evidence assessment

The added tests use domain-derived fixture types and observable return/DB-state assertions. The integration regressions call the production `createThreadFromRequest` and read the persisted thread/environment through DB functions. Their existing harness uses a real connection to a migrated SQLite template (`apps/server/test/helpers/test-app.ts:130`); the change does not mock database behavior. No existing assertions were weakened; the compatible-parent unit test was supplied with the newly required authority facts. Test review requires the empty-path regression described above. No other blocking test-quality, reuse, efficiency, or OWASP access-control finding was identified in this diff.

Evidence levels remain distinct:

- `WG-INT-001-CANDIDATE-FREEZE.json:21-23` claims eight baseline failures, 64 green tests, and four failures after inversion of the personal-kind predicate. Raw red and mutation logs were not persisted. Those counts and temporal red-first ordering remain author attestations; current exact-byte restoration is verified, but it does not prove the prior mutation run. Baseline source inspection supports why the unmanaged/different-host regression tests would detect the old behavior.
- `WG-INT-001-FOCUSED-TEST.log:56-70` shows 2 files / 64 passed, but `:54` explicitly says the server test result is a **cache hit, replaying logs**. Its SHA-256 is `0408fa9f3a172bb3fbbfd8621f3eb1ca2d71a037b282132f0fd68b59c877abae`. This is persisted replay evidence, not a new independent execution. The package-suite log independently records these two files passing at lines 182 and 222.
- `WG-INT-001-SERVER-TYPECHECK.log:23-32` shows a cache-miss server typecheck and four successful Turbo tasks. SHA-256: `988cf13e70499c72f6669d15c9f450e403d8f6f95af67e60e2e2d25598405665`. This supports the recorded source/static check, not runtime correctness.
- `WG-INT-001-SERVER-PACKAGE-TEST.log:862-866` records 2063 passed, 16 failed, and 3 unhandled errors. SHA-256: `d905f093fa1b4a1e8e8ef346df86e812b68420e124e0a3f7c932586e5739f865`. Four failed test files concern artifacts/plugins. The log directly shows npm cache EPERM at `:805-819`, repeated npm pack/log-directory failures at `:686-768` and `:798-803`, and EMFILE watcher errors at `:828-858`. The two builtin-plugin assertion failures coincide with watcher problems. Environmental causation is strongly supported, but no controlled baseline or clean-environment rerun establishes that every failure is exclusively environmental. The freeze's universal causal wording at `WG-INT-001-CANDIDATE-FREEZE.json:28` is stronger than this evidence. The package suite is not green.
- The prior terminal stop and subsequent dependency-preparation receipt were inspected. The latter records successful checkout-local native preparation with unchanged lock/source hashes. The parent identifies the current user message as the continuation authorization; that message was not supplied as a separate artifact to this no-owner-context critic, so historical authorization is not independently attested here. No native preparation was attempted by the critic.

No full suite, red run, source mutation, live server, provider, cloud, product database, deploy, installed app, or sealed evaluation was run by the critic. The only independent behavioral execution was the read-only in-process selector/schema probe. The concurrent-registration race remains unproven and outside this review. No remedy for it was proposed or implemented.

This verdict applies only to the exact frozen diff above. Per the commission, stop on this non-PASS verdict; any successor repair requires the lead/user's authorized continuation and a fresh freeze/review, not changes to this reviewed candidate.
