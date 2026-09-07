import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  createQueuedThreadMessageInTransaction,
  getLatestThreadInterruptedEventData,
  getThread,
  getSupervisorTerminalEvent,
  getThreadSupervisor,
  getThreadSupervisorBinding,
  getThreadSupervisorInboxItem,
  getSupervisorNoticeRequestSequence,
  insertThreadSupervisor,
  insertThreadSupervisorBinding,
  insertThreadSupervisorInboxItem,
  listThreadSupervisorInbox,
  listSupervisorRecoveryChildren,
  markThreadSupervisorInboxQueued,
  type DbQueryConnection,
  type ThreadSupervisorInboxRow,
  type ThreadSupervisorRow,
} from "@bb/db";
import type { ThreadEventTurnStatus } from "@bb/domain";
import {
  supervisorBindingSchema,
  supervisorInboxItemSchema,
  type RegisterSupervisorRequest,
  type SupervisorAddress,
  type SupervisorBinding,
  type SupervisorCredential,
  type SupervisorInboxItem,
  type SupervisorInboxRequest,
  type SupervisorInboxResponse,
  type SupervisorPeekResponse,
  type SupervisorNotifyRequest,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { getLastThreadOutput } from "./thread-data.js";
import { buildExecutionOptions } from "./thread-commands.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";

type SupervisorDeps = LoggedPendingInteractionWorkSessionDeps;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const supervisorId = (address: SupervisorAddress) =>
  hash(
    JSON.stringify([
      address.managerThreadId,
      address.campaignId,
      address.inboxId,
    ]),
  );
const noticeId = (id: string, key: string) =>
  hash(JSON.stringify([id, "notice", key]));

function outputExcerpt(output: string | null): string | null {
  const suffix =
    "\n[Output excerpt truncated; read child history for full output.]";
  return output !== null && output.length > 16_000
    ? output.slice(0, 16_000 - suffix.length) + suffix
    : output;
}

function requireManager(db: DbQueryConnection, threadId: string) {
  const thread = getThread(db, threadId);
  if (
    !thread ||
    thread.deletedAt !== null ||
    thread.archivedAt !== null ||
    getThreadSupervisorBinding(db, threadId)
  ) {
    throw new ApiError(
      409,
      "supervisor_binding_invalid",
      "Supervisor must be a live manager thread that is not a supervised worker",
    );
  }
  return thread;
}

function validateCredential(
  db: DbQueryConnection,
  credential: SupervisorCredential,
): ThreadSupervisorRow {
  const supervisor = getThreadSupervisor(db, supervisorId(credential));
  if (
    !supervisor ||
    !/^[a-f0-9]{64}$/u.test(supervisor.tokenHash) ||
    !timingSafeEqual(
      Buffer.from(supervisor.tokenHash, "hex"),
      Buffer.from(hash(credential.bindingToken), "hex"),
    )
  ) {
    throw new ApiError(
      409,
      "supervisor_binding_invalid",
      "Supervisor registration or binding token does not match the manager, campaign and inbox",
    );
  }
  requireManager(db, supervisor.managerThreadId);
  return supervisor;
}

export function registerThreadSupervisor(
  deps: SupervisorDeps,
  args: RegisterSupervisorRequest,
): SupervisorCredential {
  requireManager(deps.db, args.managerThreadId);
  const id = supervisorId(args);
  const existing = getThreadSupervisor(deps.db, id);
  if (existing) {
    if (!args.bindingToken)
      throw new ApiError(
        409,
        "supervisor_already_registered",
        "Replay registration with the original private binding token",
      );
    const credential = { ...args, bindingToken: args.bindingToken };
    validateCredential(deps.db, credential);
    return credential;
  }
  const bindingToken = args.bindingToken ?? randomBytes(32).toString("hex");
  insertThreadSupervisor(deps.db, {
    id,
    managerThreadId: args.managerThreadId,
    campaignId: args.campaignId,
    inboxId: args.inboxId,
    tokenHash: hash(bindingToken),
    createdAt: Date.now(),
  });
  return {
    managerThreadId: args.managerThreadId,
    campaignId: args.campaignId,
    inboxId: args.inboxId,
    bindingToken,
  };
}

export function validateSupervisorSpawn(
  db: DbQueryConnection,
  args: {
    binding: SupervisorBinding;
    projectId: string;
    parentThreadId: string | undefined;
  },
): void {
  const binding = supervisorBindingSchema.parse(args.binding);
  validateCredential(db, binding);
  const manager = requireManager(db, binding.managerThreadId);
  if (
    manager.projectId !== args.projectId ||
    args.parentThreadId !== manager.id
  ) {
    throw new ApiError(
      409,
      "supervisor_binding_invalid",
      "Supervisor must be the intended parent in the same project",
    );
  }
}

export function bindSupervisorChild(
  db: DbQueryConnection,
  args: { childThreadId: string; binding: SupervisorBinding },
): void {
  const child = getThread(db, args.childThreadId);
  if (!child || child.status !== "pending")
    throw new ApiError(
      409,
      "supervisor_binding_invalid",
      "Ownership must bind before the child starts",
    );
  validateSupervisorSpawn(db, {
    binding: args.binding,
    projectId: child.projectId,
    parentThreadId: child.parentThreadId ?? undefined,
  });
  insertThreadSupervisorBinding(db, {
    childThreadId: child.id,
    supervisorId: supervisorId(args.binding),
    taskId: args.binding.taskId,
    createdAt: Date.now(),
  });
}

export function validatePersistedSupervisorChild(
  db: DbQueryConnection,
  childThreadId: string,
): void {
  const ownership = getThreadSupervisorBinding(db, childThreadId);
  if (!ownership) return;
  const child = getThread(db, childThreadId);
  const supervisor = ownership.supervisor;
  if (
    !supervisor ||
    !child ||
    child.parentThreadId !== supervisor.managerThreadId ||
    child.projectId !== requireManager(db, supervisor.managerThreadId).projectId
  ) {
    throw new ApiError(
      409,
      "supervisor_binding_invalid",
      "Persisted supervisor ownership no longer matches the intended manager and project",
    );
  }
}

function inboxItem(
  db: DbQueryConnection,
  supervisor: ThreadSupervisorRow,
  row: ThreadSupervisorInboxRow,
): SupervisorInboxItem {
  const requestSequence = getSupervisorNoticeRequestSequence(db, {
    managerThreadId: supervisor.managerThreadId,
    key: row.key,
  });
  return supervisorInboxItemSchema.parse({
    key: row.key,
    managerThreadId: supervisor.managerThreadId,
    campaignId: supervisor.campaignId,
    inboxId: supervisor.inboxId,
    childThreadId: row.childThreadId,
    taskId: row.taskId,
    turnId: row.turnId,
    kind: row.kind,
    output: row.output,
    createdAt: row.createdAt,
    queuedMessageId: row.queuedMessageId,
    requestSequence,
    delivery:
      requestSequence !== null
        ? "requested"
        : row.queuedMessageId !== null
          ? "queued"
          : "inbox",
  });
}

export function formatSupervisorInboxWake(
  supervisor: Pick<ThreadSupervisorRow, "campaignId">,
  current: Pick<ThreadSupervisorInboxRow, "kind" | "key" | "output">,
): string {
  return `[Supervisor ${supervisor.campaignId}; ${current.kind}; key ${current.key}]\n${current.output ?? "Inspect the supervised child and its durable inbox entry."}${current.kind === "manual-interruption" ? "\nThe user stopped this worker. Do not resume, retry, replace or continue it without explicit user authorization." : ""}`;
}

async function queueSupervisorInboxWake(
  deps: SupervisorDeps,
  supervisor: ThreadSupervisorRow,
  row: ThreadSupervisorInboxRow,
): Promise<void> {
  if (row.queuedMessageId !== null) return;
  const manager = requireManager(deps.db, supervisor.managerThreadId);
  const execution = await buildExecutionOptions(
    deps,
    {},
    { threadId: manager.id },
  );
  deps.db.transaction(
    (tx) => {
      requireManager(tx, manager.id);
      const current = getThreadSupervisorInboxItem(tx, row.key);
      if (!current || current.queuedMessageId !== null) return;
      const message = createQueuedThreadMessageInTransaction(tx, {
        threadId: manager.id,
        content: [
          {
            type: "text",
            mentions: [],
            text: formatSupervisorInboxWake(supervisor, current),
          },
        ],
        senderThreadId: null,
        ...execution,
        waitingOn: deps.pendingInteractions.hasPendingThreadInteraction(
          manager.id,
        )
          ? { kind: "interaction" }
          : null,
        sendAt: null,
        payload: { kind: "inline" },
        systemNotice: {
          kind:
            current.kind === "manual-interruption"
              ? "child-interrupted"
              : current.kind === "exception"
                ? "child-failed"
                : "unlabeled",
          subject:
            current.childThreadId === null
              ? null
              : {
                  kind: "thread",
                  threadId: current.childThreadId,
                  threadName: current.taskId ?? current.childThreadId,
                },
        },
      });
      markThreadSupervisorInboxQueued(tx, row.key, message.id);
    },
    { behavior: "immediate" },
  );
  deps.hub.notifyThread(manager.id, ["queue-changed"]);
  requestQueuedMessageDispatch(deps, {
    kind: "thread-ready",
    threadId: manager.id,
  });
}

export async function publishSupervisorChildOutcome(
  deps: SupervisorDeps,
  args: {
    childThreadId: string;
    parentThreadId: string;
    turnStatus: ThreadEventTurnStatus;
  },
): Promise<boolean> {
  const ownership = getThreadSupervisorBinding(deps.db, args.childThreadId);
  if (!ownership) return false;
  const { binding, supervisor } = ownership;
  if (!supervisor)
    throw new ApiError(
      409,
      "supervisor_binding_invalid",
      "The supervisor registration disappeared after this worker was bound",
    );
  const child = getThread(deps.db, args.childThreadId);
  if (
    !child ||
    child.parentThreadId !== supervisor.managerThreadId ||
    args.parentThreadId !== supervisor.managerThreadId ||
    child.projectId !==
      getThread(deps.db, supervisor.managerThreadId)?.projectId
  ) {
    throw new ApiError(
      409,
      "supervisor_binding_invalid",
      "Persisted ownership no longer matches the child and intended manager",
    );
  }
  const terminal = getSupervisorTerminalEvent(deps.db, child.id);
  if (!terminal)
    throw new ApiError(
      409,
      "supervisor_publication_pending",
      "No durable terminal event exists for the supervised child",
    );
  const interruption =
    args.turnStatus === "interrupted"
      ? getLatestThreadInterruptedEventData(deps.db, { threadId: child.id })
      : null;
  const kind =
    args.turnStatus === "completed" ||
    interruption?.reason === "workflow-result-cleanup"
      ? "completion"
      : interruption?.reason === "manual-stop"
        ? "manual-interruption"
        : "exception";
  const key = hash(
    JSON.stringify([
      supervisor.id,
      child.id,
      terminal.turnId ?? terminal.sequence,
      kind,
    ]),
  );
  const row: ThreadSupervisorInboxRow = {
    key,
    supervisorId: supervisor.id,
    childThreadId: child.id,
    taskId: binding.taskId,
    turnId: terminal.turnId,
    kind,
    output:
      kind === "completion"
        ? outputExcerpt(getLastThreadOutput(deps.db, child.id))
        : `${binding.taskId} ${args.turnStatus}${interruption ? ` (${interruption.reason})` : ""}.`,
    createdAt: Date.now(),
    queuedMessageId: null,
  };
  insertThreadSupervisorInboxItem(deps.db, row);
  const stored = getThreadSupervisorInboxItem(deps.db, key);
  if (
    !stored ||
    stored.supervisorId !== supervisor.id ||
    stored.childThreadId !== child.id ||
    stored.taskId !== binding.taskId
  )
    throw new ApiError(
      409,
      "supervisor_publication_failed",
      "Durable inbox publication could not be verified",
    );
  if (kind !== "completion") {
    try {
      await queueSupervisorInboxWake(deps, supervisor, stored);
    } catch (error) {
      deps.logger.error(
        { err: error, key },
        "Supervisor outcome is durable; manager wake remains pending recovery",
      );
    }
  }
  return true;
}

export async function notifyThreadSupervisor(
  deps: SupervisorDeps,
  args: SupervisorNotifyRequest,
): Promise<SupervisorInboxItem> {
  const supervisor = validateCredential(deps.db, args);
  const key = noticeId(supervisor.id, args.key);
  const previous = getThreadSupervisorInboxItem(deps.db, key);
  if (
    previous &&
    (previous.output !== args.message ||
      previous.kind !== args.kind ||
      previous.taskId !== args.taskId)
  )
    throw new ApiError(
      409,
      "supervisor_idempotency_conflict",
      "Stable notice key already names different content",
    );
  insertThreadSupervisorInboxItem(deps.db, {
    key,
    supervisorId: supervisor.id,
    childThreadId: null,
    taskId: args.taskId,
    turnId: null,
    kind: args.kind,
    output: args.message,
    createdAt: Date.now(),
    queuedMessageId: null,
  });
  const row = getThreadSupervisorInboxItem(deps.db, key);
  if (!row) throw new Error("Supervisor notice publication failed");
  await queueSupervisorInboxWake(deps, supervisor, row);
  return inboxItem(
    deps.db,
    supervisor,
    getThreadSupervisorInboxItem(deps.db, key) ?? row,
  );
}

export async function readThreadSupervisorInbox(
  deps: SupervisorDeps,
  args: SupervisorInboxRequest,
): Promise<SupervisorInboxResponse> {
  const supervisor = getThreadSupervisor(deps.db, supervisorId(args));
  if (!supervisor)
    throw new ApiError(
      404,
      "supervisor_not_found",
      "No supervisor is registered for this manager, campaign and inbox",
    );
  if (args.noticeKey !== undefined) {
    if (args.afterKey !== undefined)
      throw new ApiError(
        400,
        "invalid_supervisor_cursor",
        "noticeKey and afterKey cannot be combined",
      );
    const row = getThreadSupervisorInboxItem(
      deps.db,
      noticeId(supervisor.id, args.noticeKey),
    );
    if (!row) return { items: [], nextKey: null };
    if (row.queuedMessageId === null)
      await queueSupervisorInboxWake(deps, supervisor, row);
    return {
      items: [
        inboxItem(
          deps.db,
          supervisor,
          getThreadSupervisorInboxItem(deps.db, row.key) ?? row,
        ),
      ],
      nextKey: null,
    };
  }
  for (const child of listSupervisorRecoveryChildren(deps.db, supervisor.id)) {
    const terminal = getSupervisorTerminalEvent(deps.db, child.id);
    if (!terminal) continue;
    const parsed = z
      .object({
        status: z.enum(["completed", "failed", "interrupted"]).optional(),
      })
      .parse(JSON.parse(terminal.data));
    const turnStatus =
      terminal.type === "system/thread/interrupted"
        ? "interrupted"
        : (parsed.status ?? "failed");
    await publishSupervisorChildOutcome(deps, {
      childThreadId: child.id,
      parentThreadId: supervisor.managerThreadId,
      turnStatus,
    });
  }
  const after =
    args.afterKey === undefined
      ? null
      : (getThreadSupervisorInboxItem(deps.db, args.afterKey) ?? null);
  if (args.afterKey !== undefined && after?.supervisorId !== supervisor.id)
    throw new ApiError(
      400,
      "invalid_supervisor_cursor",
      "Inbox cursor must belong to this supervisor",
    );
  const rows = listThreadSupervisorInbox(deps.db, {
    supervisorId: supervisor.id,
    after,
    limit: args.limit + 1,
  });
  for (const row of rows) {
    if (row.kind !== "completion" && row.queuedMessageId === null)
      await queueSupervisorInboxWake(deps, supervisor, row);
  }
  const items = rows
    .slice(0, args.limit)
    .map((row) =>
      inboxItem(
        deps.db,
        supervisor,
        getThreadSupervisorInboxItem(deps.db, row.key) ?? row,
      ),
    );
  return {
    items,
    nextKey: rows.length > args.limit ? (items.at(-1)?.key ?? null) : null,
  };
}

export function peekThreadSupervisorInbox(
  deps: Pick<SupervisorDeps, "db">,
  args: SupervisorInboxRequest,
): SupervisorPeekResponse {
  const supervisor = getThreadSupervisor(deps.db, supervisorId(args));
  if (!supervisor) return { registration: "missing", items: [], nextKey: null };
  if (args.noticeKey !== undefined) {
    if (args.afterKey !== undefined)
      throw new ApiError(
        400,
        "invalid_supervisor_cursor",
        "noticeKey and afterKey cannot be combined",
      );
    const row = getThreadSupervisorInboxItem(
      deps.db,
      noticeId(supervisor.id, args.noticeKey),
    );
    return {
      registration: "present",
      items: row
        ? [
            {
              ...inboxItem(deps.db, supervisor, row),
              requestInputText: formatSupervisorInboxWake(supervisor, row),
            },
          ]
        : [],
      nextKey: null,
    };
  }
  const after =
    args.afterKey === undefined
      ? null
      : (getThreadSupervisorInboxItem(deps.db, args.afterKey) ?? null);
  if (args.afterKey !== undefined && after?.supervisorId !== supervisor.id)
    throw new ApiError(
      400,
      "invalid_supervisor_cursor",
      "Inbox cursor must belong to this supervisor",
    );
  const rows = listThreadSupervisorInbox(deps.db, {
    supervisorId: supervisor.id,
    after,
    limit: args.limit + 1,
  });
  const items = rows
    .slice(0, args.limit)
    .map((row) => ({
      ...inboxItem(deps.db, supervisor, row),
      requestInputText: formatSupervisorInboxWake(supervisor, row),
    }));
  return {
    registration: "present",
    items,
    nextKey: rows.length > args.limit ? (items.at(-1)?.key ?? null) : null,
  };
}
