import { getEnvironment, getThreadSourcePin } from "@bb/db";
import { sourcePinSchema, type SourcePin } from "@bb/domain";
import type {
  InspectThreadSourceRequest,
  InspectThreadSourceResponse,
} from "@bb/server-contract";
import { sourceIdentityMismatchErrorDetailsSchema } from "@bb/server-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import { requireSourceForHost } from "./thread-create-helpers.js";
import type { ThreadProvisionEnvironmentIntent } from "./thread-provisioning-context.js";

type SourceDeps = LoggedPendingInteractionWorkSessionDeps;

async function inspectSource(
  deps: SourceDeps,
  args: {
    projectId: string;
    hostId: string;
    path: string;
    ref: string;
    workflowPath: string;
  },
): Promise<InspectThreadSourceResponse> {
  const result = await callHostRetryableOnlineRpc(deps, {
    hostId: args.hostId,
    timeoutMs: 30_000,
    command: {
      type: "host.resolve_source",
      path: args.path,
      ref: args.ref,
      workflowPath: args.workflowPath,
    },
  });
  return { ...result, projectId: args.projectId, hostId: args.hostId };
}

export async function inspectProjectThreadSource(
  deps: SourceDeps,
  args: InspectThreadSourceRequest,
): Promise<InspectThreadSourceResponse> {
  const source = requireSourceForHost(deps, args.projectId, args.hostId);
  return inspectSource(deps, { ...args, path: source.path });
}

function sourceRefusal(
  reason: string,
  expected: SourcePin | null,
  target: InspectThreadSourceResponse | null,
  targetPath: string,
  requestedRef: string | null = expected?.discoveryRef ??
    expected?.commit ??
    null,
): never {
  throw new ApiError(
    409,
    "source_identity_mismatch",
    `Source admission failed: ${reason}. Use an existing compatible environment with an explicit path policy, or explicitly transfer and admit the commit in the target repository.`,
    {
      details: sourceIdentityMismatchErrorDetailsSchema.parse({
        reason,
        source: expected,
        target,
        targetPath,
        requestedRef,
        action:
          "Select a compatible environment or explicitly transfer and re-inspect the source before retrying. This failed verification does not authorize a provider start.",
      }),
    },
  );
}

function requirePinAgreement(
  pin: SourcePin,
  source: InspectThreadSourceResponse,
  targetPath: string,
): void {
  if (
    source.repositoryIdentity !== pin.repositoryIdentity ||
    source.commit !== pin.commit ||
    source.tree !== pin.tree ||
    source.workflowPath !== pin.workflowPath ||
    source.workflowTree !== pin.workflowTree ||
    !source.clean
  ) {
    sourceRefusal(
      "repository, commit, tree, workflow subtree, or cleanliness differs",
      pin,
      source,
      targetPath,
    );
  }
}

export async function admitThreadSource(
  deps: SourceDeps,
  args: {
    projectId: string;
    intent: ThreadProvisionEnvironmentIntent;
    pin: SourcePin | undefined;
  },
): Promise<{
  intent: ThreadProvisionEnvironmentIntent;
  pin: SourcePin | null;
}> {
  const intent = args.intent;
  if (intent.type === "direct-personal") {
    if (args.pin !== undefined)
      sourceRefusal(
        "personal workspace cannot satisfy a repository pin",
        args.pin,
        null,
        "personal",
      );
    return { intent, pin: null };
  }
  const existing =
    intent.type === "reuse"
      ? getEnvironment(deps.db, intent.environmentId)
      : null;
  const hostId = intent.type === "reuse" ? existing?.hostId : intent.hostId;
  const targetPath =
    intent.type === "reuse"
      ? existing?.path
      : intent.type === "direct-managed"
        ? intent.sourcePath
        : intent.path;
  if (args.pin === undefined && intent.type !== "direct-managed")
    return { intent, pin: null };
  if (!hostId || !targetPath)
    sourceRefusal(
      "target environment has no ready source path",
      args.pin ?? null,
      null,
      "unresolved",
    );
  const source = requireSourceForHost(deps, args.projectId, hostId);
  if (
    args.pin !== undefined &&
    (args.pin.projectId !== args.projectId || args.pin.hostId !== hostId)
  ) {
    throw new ApiError(
      409,
      "source_identity_mismatch",
      "Source pin addresses a different project or execution host",
      {
        details: sourceIdentityMismatchErrorDetailsSchema.parse({
          reason: "target-address-mismatch",
          source: args.pin,
          target: {
            projectId: args.projectId,
            hostId,
            repositoryPath: source.path,
          },
          targetPath,
          requestedRef: args.pin.commit,
          action:
            "Inspect and explicitly admit the source in the actual target project and host",
        }),
      },
    );
  }
  const ref =
    args.pin?.commit ??
    (intent.type === "direct-managed" && intent.baseBranch.kind === "named"
      ? intent.baseBranch.name
      : "HEAD");
  const workflowPath = args.pin?.workflowPath ?? ".";
  const inspected = await inspectSource(deps, {
    projectId: args.projectId,
    hostId,
    path: source.path,
    ref,
    workflowPath,
  });
  if (
    inspected.commit === null ||
    inspected.tree === null ||
    inspected.workflowTree === null ||
    !inspected.clean
  ) {
    sourceRefusal(
      "requested source is missing or dirty in the exact target project repository",
      args.pin ?? null,
      inspected,
      source.path,
      ref,
    );
  }
  const pin =
    args.pin ??
    sourcePinSchema.parse({
      projectId: args.projectId,
      hostId,
      repositoryPath: inspected.repositoryPath,
      repositoryIdentity: inspected.repositoryIdentity,
      commit: inspected.commit,
      tree: inspected.tree,
      workflowPath,
      workflowTree: inspected.workflowTree,
      pathPolicy: { kind: "new-worktree" },
    });
  requirePinAgreement(pin, inspected, source.path);
  if (pin.repositoryPath !== inspected.repositoryPath)
    sourceRefusal(
      "canonical project repository path differs",
      pin,
      inspected,
      source.path,
    );
  if (pin.discoveryRef !== undefined) {
    const discovery = await inspectSource(deps, {
      projectId: args.projectId,
      hostId,
      path: source.path,
      ref: pin.discoveryRef,
      workflowPath,
    });
    if (discovery.commit !== pin.commit)
      sourceRefusal(
        "discovery ref moved since source was pinned",
        pin,
        discovery,
        source.path,
      );
  }
  if (intent.type === "direct-managed") {
    if (pin.pathPolicy.kind !== "new-worktree" || targetPath !== source.path)
      sourceRefusal(
        "managed worktree requires new-worktree path policy in the project source",
        pin,
        inspected,
        targetPath,
      );
    return {
      intent: { ...intent, baseBranch: { kind: "named", name: pin.commit } },
      pin,
    };
  }
  if (
    pin.pathPolicy.kind !== "exact" ||
    pin.pathPolicy.path !== targetPath ||
    intent.type === "checkout-unmanaged" ||
    (intent.type === "direct-unmanaged" && intent.branch !== undefined)
  ) {
    sourceRefusal(
      "reuse requires exact path policy without checkout mutation",
      pin,
      inspected,
      targetPath,
    );
  }
  const target =
    targetPath === source.path
      ? inspected
      : await inspectSource(deps, {
          projectId: args.projectId,
          hostId,
          path: targetPath,
          ref: pin.commit,
          workflowPath,
        });
  requirePinAgreement(pin, target, targetPath);
  if (
    target.repositoryPath !== pin.pathPolicy.path ||
    target.head !== pin.commit
  )
    sourceRefusal(
      "reused checkout path or HEAD differs",
      pin,
      target,
      targetPath,
    );
  return { intent, pin };
}

export async function revalidateThreadSource(
  deps: SourceDeps,
  args: {
    threadId: string;
    projectId: string;
    intent: ThreadProvisionEnvironmentIntent;
  },
): Promise<void> {
  const pin = getThreadSourcePin(deps.db, args.threadId);
  if (pin !== null)
    await admitThreadSource(deps, {
      projectId: args.projectId,
      intent: args.intent,
      pin,
    });
}

export async function validateProvisionedThreadSource(
  deps: SourceDeps,
  args: { threadId: string; projectId: string; environmentId: string },
): Promise<void> {
  const pin = getThreadSourcePin(deps.db, args.threadId);
  if (pin === null) return;
  const environment = getEnvironment(deps.db, args.environmentId);
  if (!environment?.path)
    sourceRefusal(
      "provisioned environment has no path",
      pin,
      null,
      "unresolved",
    );
  await admitThreadSource(deps, {
    projectId: args.projectId,
    intent: { type: "reuse", environmentId: args.environmentId },
    pin: { ...pin, pathPolicy: { kind: "exact", path: environment.path } },
  });
}
