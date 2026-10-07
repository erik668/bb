PASS

Fresh independent corrected-oracle review; prior critic admission credit: zero. This verdict qualifies only the frozen WG-INT-001 local source candidate.

Exact identities, independently rehashed:
- Base commit: 7cdd77ba9cd23f71f7833bd989d63565128c6fea
- Candidate binary diff SHA-256: 4ca0ddb7927a364865579f8a6ed5671ec147822f02fa84fdd45541533a0acbe8
- Corrected oracle SHA-256: 16cabc18200dfc5f5744a8c5ba6edcfb71991b937bdf642648d173c0c535e8d0
- Corrected review freeze SHA-256: 23c9e4940134dfaa9a04c0787587d06902c2f7c95fe7380eec32bce47774ed53
- Base freeze SHA-256: ee618378bf020d0c09fd55f569d318110218d806a3ed2dcab5d02247348fd5d3
- Clean-base control receipt SHA-256: 6c6c6e38ee97b75a2287000e2a544b20d23d63617ede45523a480fa1354548bc

All frozen source, test, eligibility, and lockfile hashes match. The candidate remains confined to the four frozen changed paths. No blocking correctness finding under the corrected predicate.

Parent-selection review:
- Ready empty and null paths fail the reusable-parent predicate through Boolean(environment.path), preserving the original personal host request, including hostId. The table-driven regressions directly cover both cases (thread-default-policy.test.ts:349).
- Ready nonempty personal parents reuse their environment; an omitted host permits parent-host inheritance, and an explicit differing host prevents it. The ready-positive and host-mismatch controls cover these branches.
- Provisioning remains reusable without a path. Retiring remains reusable, and the unchanged creation branch cancels retirement. The focused integration test at thread-create-seed-without-run.test.ts:881 verifies the same environment is restored to ready.
- Unmanaged, managed-worktree, other-project, and unavailable parents do not synthesize personal reuse. Missing parent/environment records fail closed to the original request. The unmanaged and explicit-host integration tests additionally assert the persisted child environment.
- Explicit reuse passes through. The source environment exception is preserved: forkSourceEnvironmentId still suppresses parent synthesis and is forwarded unchanged to request eligibility. Tests at lines 942 and 996 cover the allowed switched-source unmanaged environment and rejection of a different unmanaged environment.
- Standard-project managed-worktree defaults and explicit unmanaged paths retain their existing branches. The eligibility module is unchanged and continues to reject personal workspaces for standard projects and unauthorized unmanaged personal reuse.

Watcher attribution:
The transitive runtime path is real and was independently read:
thread-create-seed-without-run.test.ts -> helpers/test-app.ts:296 withTestHarness -> createTestAppHarness -> test-app.ts:272 createApp -> server.ts:540 createPluginService; finally at test-app.ts:311-315 invokes cleanup -> test-app.ts:283 pluginService.stop -> plugin-service.ts:1427 closes stored watchers and disposes plugins.

This is the corrected oracle's allowed pre-existing harness path. Two added test cases add ordinary harness invocations; each retains one service construction and one finally cleanup, with unchanged ordering and no service.start call. They do not change construction/cleanup multiplicity inside an invocation or introduce an additional retained service. The shared createApp wiring reads the existing hot-reload environment flag, but the candidate neither changes that wiring nor mutates watcher-test environment, cwd, or globals. The plugin runtime initializes an empty watcher array; watcher creation remains behind start() and watchBuiltinPluginSources. The new tests do not invoke that start path.

No changed source creates, starts, configures, retains, delays, races, or fails to close a watcher. The harness, server construction/wiring, plugin lifecycle sources, plugin-build sources, watcher tests, and test worker configuration have zero diff from HEAD in this candidate. A supplementary read-only TypeScript AST traversal from plugin-service resolved 320 paths and reached neither changed production module. Its limits are static literal imports and exclusion of node_modules traversal; the verdict rests on the inspected lifecycle and candidate diff, not a blanket claim that every runtime import is unreachable.

Existing validation evidence, verified by hash and log contents:
- Focused: Tests  65 passed (65); SHA-256 1d6f828beb7cee9f66cfa034d52950391ab82e7877a25df929aae1ba344243dc.
- Typecheck: Tasks:    4 successful, 4 total; SHA-256 8a9d399d2137869e14f570200077a7be18b2135024bddc078835ffcd535ca784.
No tests, builds, typechecks, or installs were rerun by this critic.

WG-INT-007 remains a separate unresolved baseline defect. The pinned clean-base log records Tests  2 failed | 25 passed (27) and 4 EMFILE errors; SHA-256 6fc201677bde044e8062b798aebeef978e981152f106b186e7929385562f13da. Its two failing assertion names and error text match the candidate suite log. The frozen base Git test blob hashes to f2230af43a4d4e37bcf89658c879a9c05822d6dd2ec89b09a48a1b4025abb735, matching the clean-base receipt. Thus the receipt's exact-base test identity and its recorded independent reproduction are corroborated.

The control checkout has subsequently acquired WG-INT-007 edits and its current test bytes differ; it is not currently clean. Historical execution cleanliness is supported by the pinned receipt, not inferred from that now-changing checkout. This review did not observe the original run or independently rerun it.

The full server suite is non-green: Tests  2 failed | 2078 passed (2080), with 4 EMFILE errors in the existing suite log (SHA-256 a164ee19b75a6dbdb6a890d9109d514708bbd3d39c908efe2d8f799fcc97cb03). PASS proves neither the unobserved registration race nor installed/live behavior, deployment, full-suite correctness, or sealed-eval admission.

Only the in-progress marker, this report, and the final critic receipt were written. Source, tests, lockfile, oracle, candidate freezes, and historical evidence were not changed. No registration-race, live, sealed-eval, install, or commit action was performed.

