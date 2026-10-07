# WG-INT-012 source diagnosis

## Verdict

REPAIR_CONTRACT_READY

The repair is source-ready. The current managed-worktree path accepts `--project`,
the target host/environment selection, `--new-environment worktree`, and
`--base-branch` in `apps/cli/src/commands/thread/spawn.ts`; the public create
route is `POST /threads` in `apps/server/src/routes/threads/base.ts`.
`BaseBranchSpec` accepts a named Git ref string, which also admits a full raw
SHA under the current Git branch-name validation.

## Observed failure path

1. `createThreadFromRequest` resolves the selected managed source from the
   target project and host in `apps/server/src/services/threads/thread-create.ts`.
2. It creates a `direct-managed` intent containing only `sourcePath` and an
   unpinned `BaseBranchSpec`.
3. `createProvisioningThread` calls `createThreadRecord` before environment
   creation and before any base object is resolved.
4. Later, `thread-provisioning-environment.ts` creates the provisioning
   environment and emits `environment.provision`; the daemon converts this to
   `createWorktree` in `packages/host-workspace/src/provisioning.ts`.
5. `createWorktree` selects the target source checkout's Git object database,
   optionally fetches a remote-named base, then executes
   `git worktree add -B <generated branch> <target> <baseBranch>`.

Consequently the reported `fatal: invalid reference` is post-thread-record and
post-environment-record provisioning failure. It becomes
`thread_provisioning_failed`; the environment failure settlement records the
thread error and requests managed-environment cleanup. The orphan sweeps only
recover already-created `starting` threads/environments; they cannot provide
the required pre-creation refusal.

## Identity and resolution contract

Add one retryable, read-only host RPC, `host.resolve_worktree_base`, taking:

- `targetSourcePath` (absolute configured local source for the selected project
  and host);
- `base` (the existing `BaseBranchSpec`); and
- optional `sourcePath` only when the caller is carrying base provenance from
  another environment/worktree.

The handler belongs beside `inspectHostGitSource` in
`apps/host-daemon/src/command-handlers/host-branches.ts`, uses
`packages/host-workspace/src/git.ts`, and returns a strict typed union:

- `resolved`: target repository identity, optional source repository identity,
  requested ref kind/value, and a peeled full commit object ID;
- `target_base_missing`: target identity, sanitized requested-ref diagnostic,
  source identity when supplied, and allowed actions
  `reuse-compatible-environment` and `explicit-transfer-or-fetch`; or
- `repository_identity_mismatch` / `repository_identity_ambiguous`: sanitized
  source and target identities plus the same allowed actions.

Repository sameness is the canonical real filesystem identity of Git's common
directory (`git rev-parse --git-common-dir`, canonicalized with `realpath`),
not a caller path string and not the persisted `projects.gitRemoteUrl`. The
existing `getGitCommonDir` helper already identifies worktrees sharing one
object database; it should be strengthened to return a canonical filesystem
identity (real path plus platform file identity where available) and fail
closed on resolution ambiguity. `gitRemoteUrl` is a best-effort, mutable,
origin-only display anchor, so it is insufficient proof of repository identity.

Resolve `base` only in the target source object's database using an
end-of-options, commit-peeling verification (`<ref>^{commit}`). A branch, tag,
or raw SHA from another checkout is acceptable only when that exact commit is
already present and resolves in the target repository. Never read the other
checkout's object database as a fallback, and never add a fetch/transfer.
When provenance is absent, report the source identity as unavailable rather
than inventing one; target-object absence remains a typed refusal.

## Required source change radius

- `packages/host-workspace/src/git.ts` and its focused tests: canonical common
  repository identity and target-only ref-to-peeled-commit resolution.
- `packages/host-workspace/src/provisioning.ts` and tests: preserve the legacy
  remote-ref fetch behavior, then re-verify the pinned commit and invoke
  `git worktree add` with that commit ID. A changed or vanished result is the
  typed `base_object_race`, never a substitution.
- `packages/host-daemon-contract/src/commands.ts`: new RPC schema/result and a
  `resolvedBaseObjectId` on the managed `environment.provision` command.
  Increment `packages/host-daemon-contract/src/protocol.ts` from 174 and update
  its exact-version test because the daemon/server wire contract changes.
- `apps/host-daemon/src/command-handlers/host-branches.ts` and
  `apps/host-daemon/src/command-dispatch.ts`: dispatch the resolver and map
  expected Git failures to the typed result, without provider access.
- `apps/server/src/services/threads/thread-create.ts`: after stable target
  environment/source selection but before provider-catalog resolution,
  `createThreadRecord`, `requestThreadProvision`, or telemetry, call the new
  preflight. Convert a non-resolved result to a 409 typed API error.
- `apps/server/src/services/threads/thread-provisioning-context.ts`,
  `thread-provisioning-environment.ts`, and `thread-create-helpers.ts`: carry
  the resolved identity/object through the managed intent and command.
- `packages/db/src/schema.ts`, generated Drizzle migration/snapshot, and
  environment data mapping: persist the resolved commit ID on a managed
  provisioning environment. This is necessary for restart/reprovision and
  prevents a lost in-memory context from re-resolving a mutable ref. Do not
  hand-edit a Drizzle snapshot.
- `apps/server/src/services/environments/environment-provisioning-internal.ts`:
  use that persisted pin for managed reprovision; retain existing failure event,
  lifecycle, and cleanup handling for a post-preflight `base_object_race`.

No source/target transfer mechanism is part of this repair. The explicitly
allowed recovery is selecting a compatible existing environment or a separately
authorized fetch/content-transfer workflow, followed by a new create request.

## Ordering invariant

`validate request -> resolve target source -> resolve target repository identity
and peeled base object -> persist thread -> persist environment -> create
worktree -> start provider`.

For a valid legacy request, preserve its current ref-fetch policy and branch
name/output. Immediately before `worktree add`, resolve the same target ref
after the legacy fetch and require equality with the preflight commit ID; then
pass the pinned ID. Equality gives the legacy result. Inequality or a missing
object yields `base_object_race` before a worktree/provider start.

## Deterministic executable controls

Use real temporary Git repositories only in `packages/host-workspace` and the
existing server host-RPC capture; no provider process, sleep, or live probe is
needed.

| Control | Single changed property | Required assertions |
| --- | --- | --- |
| owning branch | target repository contains the named branch | resolved full commit; managed command carries that pin; one worktree is created; provider-call spy remains unused until the normal later start path |
| owning raw SHA | only base input changes from branch to its exact commit | same pinned commit and successful worktree creation |
| non-owning branch | target source is an independent repository lacking the branch | `target_base_missing`/409; zero thread rows, zero environment rows, zero queued `environment.provision`, zero provider-registry/catalog/start calls |
| non-owning raw SHA | only base input changes to the exact SHA present solely in the other repository | same typed refusal and zero-side-effect assertions |
| same physical repository worktree | source path changes from main checkout to a sibling worktree | equal canonical common-directory identities and accepted target-local resolution; no path-string comparison is used |
| identity mismatch | supplied provenance points at an independent repository | `repository_identity_mismatch` with sanitized source/target identities and only the two allowed actions |
| ambiguous identity | realpath/file-identity resolution is forced to fail | `repository_identity_ambiguous`; no database/provider effects |
| post-preflight race | mutate the target ref after resolver result and before worktree invocation | `base_object_race`, no worktree path, no provider start; normal provisioning failure/cleanup remains exercised |
| legacy restoration | restore the exact owning branch fixture | existing fetch/branch behavior and result match the baseline; no added transfer/fetch on a preflight refusal |

Place the host-level controls near `packages/host-workspace/test/provisioning.test.ts`.
Place the no-record/no-provider controls in a focused new server thread-create
test using `apps/server/test/helpers/commands.ts`; that helper already captures
online RPCs and can be extended with one deterministic resolver response.
Add the command-schema/handler control beside the existing host Git-source
inspection tests. The environment provisioning tests must assert that the
persisted pin, rather than `baseBranch`, is used after recovery.

## Compatibility and error reuse

Use `ApiError` for the server 409 refusal and `WorkspaceError`/
`ExpectedCommandDispatchError` at the host boundary, adding dedicated stable
error codes rather than parsing Git stderr. Reuse the existing lifecycle
failure/cleanup machinery only for a post-preflight race. Existing
`thread_provisioning_failed` is not an acceptable representation for a missing
target base because it occurs too late and leaves durable records.

Source inspection was limited to BB thread/worktree/provisioning, host-daemon
contract/handler, database environment carriers, and their tests. No sealed-eval
material was opened and no product source was changed.
