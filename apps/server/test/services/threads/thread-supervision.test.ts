import {
  createConnection,
  getSupervisorNoticeRequestSequence,
  getThreadSupervisorBinding,
  isThreadQueueAutoSendPaused,
  listQueuedThreadMessages,
  threads,
  threadSupervisors,
  threadSupervisorInbox,
} from "@bb/db";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
} from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindSupervisorChild,
  notifyThreadSupervisor,
  publishSupervisorChildOutcome,
  readThreadSupervisorInbox,
  peekThreadSupervisorInbox,
  registerThreadSupervisor,
  validatePersistedSupervisorChild,
  validateSupervisorSpawn,
} from "../../../src/services/threads/thread-supervision.js";
import { queueChildThreadTurnNotificationBestEffort } from "../../../src/services/threads/child-thread-notifications.js";
import { sendNextQueuedMessageIfPresent } from "../../../src/services/threads/queued-messages.js";
import { listQueuedCommands } from "../../helpers/commands.js";
import {
  seedQueuedMessage,
  seedStoredEvent,
  seedThread,
  seedThreadFixture,
  seedThreadRuntimeState,
} from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

function fixture(harness: TestAppHarness) {
  const { thread: manager, project, environment } = seedThreadFixture(harness);
  seedThreadRuntimeState(harness.deps, {
    threadId: manager.id,
    environmentId: environment.id,
    providerThreadId: "supervisor-manager",
  });
  const registration = registerThreadSupervisor(harness.deps, {
    managerThreadId: manager.id,
    campaignId: "campaign",
    inboxId: "results",
    bindingToken: "a".repeat(64),
  });
  const child = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    parentThreadId: manager.id,
    status: "pending",
  });
  const binding = { ...registration, taskId: "owner" };
  return { manager, project, environment, registration, child, binding };
}

function complete(
  harness: TestAppHarness,
  childId: string,
  status: "completed" | "failed" | "interrupted" = "completed",
) {
  harness.db
    .update(threads)
    .set({ status: status === "failed" ? "error" : "idle" })
    .where(eq(threads.id, childId))
    .run();
  seedStoredEvent(harness.deps, {
    threadId: childId,
    scope: turnScope("turn-owner"),
    sequence: 1,
    type: "turn/started",
    data: {},
  });
  seedStoredEvent(harness.deps, {
    threadId: childId,
    scope: turnScope("turn-owner"),
    sequence: 2,
    type: "turn/completed",
    data: { status },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("durable supervisor ownership", () => {
  it("retains ownership and refuses admission if a queued worker loses its manager registration", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      bindSupervisorChild(harness.db, {
        childThreadId: f.child.id,
        binding: f.binding,
      });
      expect(() =>
        validatePersistedSupervisorChild(harness.db, f.child.id),
      ).not.toThrow();
      harness.db
        .update(threads)
        .set({ parentThreadId: null })
        .where(eq(threads.id, f.child.id))
        .run();
      expect(() =>
        validatePersistedSupervisorChild(harness.db, f.child.id),
      ).toThrow("intended manager");
      harness.db
        .update(threads)
        .set({ parentThreadId: f.manager.id })
        .where(eq(threads.id, f.child.id))
        .run();
      harness.db
        .delete(threadSupervisors)
        .where(eq(threadSupervisors.managerThreadId, f.manager.id))
        .run();
      expect(
        getThreadSupervisorBinding(harness.db, f.child.id)?.binding.taskId,
      ).toBe("owner");
      expect(() =>
        validatePersistedSupervisorChild(harness.db, f.child.id),
      ).toThrow("intended manager");
    });
  });

  it("recovers the exact caller notification key without depending on inbox pagination or exposing credentials", async () => {
    vi.useFakeTimers();
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      const args = {
        ...f.registration,
        key: "registry-ready",
        taskId: null,
        kind: "decision" as const,
        message: "Registry update complete",
      };
      const notice = await notifyThreadSupervisor(harness.deps, args);
      const address = {
        managerThreadId: f.manager.id,
        campaignId: "campaign",
        inboxId: "results",
        limit: 1,
      };
      expect(
        await readThreadSupervisorInbox(harness.deps, {
          ...address,
          noticeKey: args.key,
        }),
      ).toEqual({ items: [notice], nextKey: null });
      expect(
        await readThreadSupervisorInbox(harness.deps, {
          ...address,
          noticeKey: "missing",
        }),
      ).toEqual({ items: [], nextKey: null });
      registerThreadSupervisor(harness.deps, {
        ...f.registration,
        campaignId: "other",
      });
      expect(
        await readThreadSupervisorInbox(harness.deps, {
          ...address,
          campaignId: "other",
          noticeKey: args.key,
        }),
      ).toEqual({ items: [], nextKey: null });
      await expect(
        readThreadSupervisorInbox(harness.deps, {
          ...address,
          noticeKey: args.key,
          afterKey: notice.key,
        }),
      ).rejects.toThrow("cannot be combined");
      expect(listQueuedThreadMessages(harness.db, f.manager.id)).toHaveLength(
        1,
      );
    });
  });

  it("requests steering for a live manager while leaving an explicit ordinary queue intact", async () => {
    vi.useFakeTimers();
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      harness.db
        .update(threads)
        .set({ status: "active" })
        .where(eq(threads.id, f.manager.id))
        .run();
      seedStoredEvent(harness.deps, {
        threadId: f.manager.id,
        scope: turnScope("live-manager"),
        sequence: 100,
        type: "turn/started",
        data: {},
      });
      const ordinary = seedQueuedMessage(harness.deps, {
        threadId: f.manager.id,
        content: [
          { type: "text", text: "Wait for this turn to finish", mentions: [] },
        ],
        waitingOn: { kind: "thread-busy" },
      });
      const args = {
        ...f.registration,
        key: "registry-ready",
        taskId: null,
        kind: "decision" as const,
        message: "Registry update complete",
      };
      const admitted = await notifyThreadSupervisor(harness.deps, args);
      expect(admitted.delivery).toBe("queued");
      await sendNextQueuedMessageIfPresent(harness.deps, {
        threadId: f.manager.id,
      });
      const commands = listQueuedCommands(harness, "turn.submit");
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        target: { mode: "auto", expectedTurnId: "live-manager" },
      });
      expect(
        listQueuedThreadMessages(harness.db, f.manager.id).map((row) => row.id),
      ).toEqual([ordinary.id]);
      const replay = await notifyThreadSupervisor(harness.deps, args);
      expect(replay).toMatchObject({
        key: admitted.key,
        queuedMessageId: admitted.queuedMessageId,
        delivery: "requested",
      });
      expect(replay.requestSequence).toBeGreaterThan(100);
      expect(listQueuedCommands(harness, "turn.submit")).toHaveLength(1);
    });
  });
  it("recovers owned completion from terminal history and suppresses the ordinary wake across replay", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      bindSupervisorChild(harness.db, {
        childThreadId: f.child.id,
        binding: f.binding,
      });
      complete(harness, f.child.id);
      const args = {
        managerThreadId: f.manager.id,
        campaignId: "campaign",
        inboxId: "results",
        limit: 100,
      };
      const recovered = await readThreadSupervisorInbox(harness.deps, args);
      expect(recovered.items).toHaveLength(1);
      expect(recovered.items[0]).toMatchObject({
        childThreadId: f.child.id,
        taskId: "owner",
        turnId: "turn-owner",
        kind: "completion",
        queuedMessageId: null,
        delivery: "inbox",
      });
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: f.child,
        parentThreadId: f.manager.id,
        turnStatus: "completed",
      });
      const replay = await readThreadSupervisorInbox(harness.deps, args);
      expect(replay).toEqual(recovered);
      const restoredDb = createConnection(harness.db.$client.serialize());
      try {
        expect(
          await readThreadSupervisorInbox(
            { ...harness.deps, db: restoredDb },
            args,
          ),
        ).toEqual(recovered);
      } finally {
        restoredDb.$client.close();
      }
      expect(listQueuedThreadMessages(harness.db, f.manager.id)).toEqual([]);
    });
  });

  it("rejects forged tokens, wrong manager/campaign/inbox/project and binding after start", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      for (const altered of [
        { bindingToken: "f".repeat(64) },
        { campaignId: "other" },
        { inboxId: "other" },
        { managerThreadId: f.child.id },
      ]) {
        expect(() =>
          validateSupervisorSpawn(harness.db, {
            binding: { ...f.binding, ...altered },
            projectId: f.project.id,
            parentThreadId: f.manager.id,
          }),
        ).toThrow("Supervisor");
      }
      expect(() =>
        validateSupervisorSpawn(harness.db, {
          binding: f.binding,
          projectId: "foreign",
          parentThreadId: f.manager.id,
        }),
      ).toThrow("same project");
      expect(() =>
        validateSupervisorSpawn(harness.db, {
          binding: f.binding,
          projectId: f.project.id,
          parentThreadId: f.child.id,
        }),
      ).toThrow("intended parent");
      expect(registerThreadSupervisor(harness.deps, f.registration)).toEqual(
        f.registration,
      );
      harness.db
        .update(threads)
        .set({ status: "active" })
        .where(eq(threads.id, f.child.id))
        .run();
      expect(() =>
        bindSupervisorChild(harness.db, {
          childThreadId: f.child.id,
          binding: f.binding,
        }),
      ).toThrow("before the child starts");
    });
  });

  it.each(["unmanaged", "missing-terminal"] as const)(
    "preserves ordinary delivery for %s without a satisfied publication contract",
    async (mode) => {
      vi.useFakeTimers();
      await withTestHarness(async (harness) => {
        vi.spyOn(
          harness.deps.pendingInteractions,
          "hasPendingThreadInteraction",
        ).mockReturnValue(true);
        const f = fixture(harness);
        if (mode === "missing-terminal")
          bindSupervisorChild(harness.db, {
            childThreadId: f.child.id,
            binding: f.binding,
          });
        if (mode === "unmanaged")
          seedStoredEvent(harness.deps, {
            threadId: f.child.id,
            scope: threadScope(),
            sequence: 1,
            type: "system/operation",
            data: {
              operation: "supervisor-owned",
              operationId: "forged",
              status: "bound",
              message: "Forged child tag",
              metadata: {
                supervisorOwned: true,
                managerThreadId: f.manager.id,
              },
            },
          });
        await queueChildThreadTurnNotificationBestEffort(harness.deps, {
          childThread: f.child,
          parentThreadId: f.manager.id,
          turnStatus: "completed",
        });
        await vi.advanceTimersByTimeAsync(2_000);
        expect(listQueuedThreadMessages(harness.db, f.manager.id)).toHaveLength(
          1,
        );
        expect(
          (
            await readThreadSupervisorInbox(harness.deps, {
              managerThreadId: f.manager.id,
              campaignId: "campaign",
              inboxId: "results",
              limit: 100,
            })
          ).items,
        ).toHaveLength(0);
      });
    },
  );

  it("falls back to an ordinary notice when durable inbox insertion fails, then recovers publication", async () => {
    vi.useFakeTimers();
    await withTestHarness(async (harness) => {
      vi.spyOn(
        harness.deps.pendingInteractions,
        "hasPendingThreadInteraction",
      ).mockReturnValue(true);
      const f = fixture(harness);
      bindSupervisorChild(harness.db, {
        childThreadId: f.child.id,
        binding: f.binding,
      });
      complete(harness, f.child.id);
      harness.db.$client.exec(
        "CREATE TEMP TRIGGER refuse_supervisor_publication BEFORE INSERT ON thread_supervisor_inbox BEGIN SELECT RAISE(ABORT, 'publication unavailable'); END",
      );
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: f.child,
        parentThreadId: f.manager.id,
        turnStatus: "completed",
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(listQueuedThreadMessages(harness.db, f.manager.id)).toHaveLength(
        1,
      );
      harness.db.$client.exec("DROP TRIGGER refuse_supervisor_publication");
      const recovered = await readThreadSupervisorInbox(harness.deps, {
        managerThreadId: f.manager.id,
        campaignId: "campaign",
        inboxId: "results",
        limit: 100,
      });
      expect(recovered.items).toHaveLength(1);
      expect(recovered.items[0]?.delivery).toBe("inbox");
    });
  });

  it("consumes a replayed supervisor queue row after durable request readback without a second provider wake", async () => {
    vi.useFakeTimers();
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      const notice = await notifyThreadSupervisor(harness.deps, {
        ...f.registration,
        key: "ready",
        taskId: null,
        kind: "decision",
        message: "Registry update complete",
      });
      const [queued] = listQueuedThreadMessages(harness.db, f.manager.id);
      if (!queued) throw new Error("Missing durable queue row");
      seedStoredEvent(harness.deps, {
        threadId: f.manager.id,
        scope: threadScope(),
        sequence: 100,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
          source: "tell",
          initiator: "system",
          senderThreadId: null,
          input: JSON.parse(queued.content),
          target: { kind: "new-turn" },
          request: { method: "turn/start", params: {} },
          execution: {
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "default",
            source: "client/turn/requested",
          },
        },
      });
      expect(
        getSupervisorNoticeRequestSequence(harness.db, {
          managerThreadId: f.manager.id,
          key: notice.key,
        }),
      ).toBe(100);
      const restoredDb = createConnection(harness.db.$client.serialize());
      try {
        const restoredDeps = { ...harness.deps, db: restoredDb };
        await sendNextQueuedMessageIfPresent(restoredDeps, {
          threadId: f.manager.id,
        });
        expect(listQueuedThreadMessages(restoredDb, f.manager.id)).toHaveLength(
          0,
        );
        const inbox = await readThreadSupervisorInbox(restoredDeps, {
          managerThreadId: f.manager.id,
          campaignId: "campaign",
          inboxId: "results",
          limit: 100,
        });
        expect(inbox.items[0]).toMatchObject({
          key: notice.key,
          delivery: "requested",
          requestSequence: 100,
        });
        expect(listQueuedCommands(harness, "turn.submit")).toHaveLength(0);
      } finally {
        restoredDb.$client.close();
      }
    });
  });

  it("keeps a supervisor wake queued when the manager was manually stopped", async () => {
    vi.useFakeTimers();
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      seedStoredEvent(harness.deps, {
        threadId: f.manager.id,
        scope: threadScope(),
        sequence: 100,
        type: "system/thread/interrupted",
        data: { reason: "manual-stop" },
      });
      expect(isThreadQueueAutoSendPaused(harness.db, f.manager.id)).toBe(true);
      await notifyThreadSupervisor(harness.deps, {
        ...f.registration,
        key: "stopped",
        taskId: null,
        kind: "exception",
        message: "Worker needs a decision",
      });
      await sendNextQueuedMessageIfPresent(harness.deps, {
        threadId: f.manager.id,
      });
      expect(listQueuedThreadMessages(harness.db, f.manager.id)).toHaveLength(
        1,
      );
      expect(
        listQueuedThreadMessages(harness.db, f.manager.id)[0]?.claimToken,
      ).toBeNull();
      expect(listQueuedCommands(harness, "turn.submit")).toHaveLength(0);
      expect(listQueuedCommands(harness, "thread.start")).toHaveLength(0);
    });
  });

  it("admits decision and exception notices once, rejects conflicting key reuse, and retains manual-stop guidance", async () => {
    vi.useFakeTimers();
    await withTestHarness(async (harness) => {
      vi.spyOn(
        harness.deps.pendingInteractions,
        "hasPendingThreadInteraction",
      ).mockReturnValue(true);
      const f = fixture(harness);
      bindSupervisorChild(harness.db, {
        childThreadId: f.child.id,
        binding: f.binding,
      });
      complete(harness, f.child.id, "interrupted");
      seedStoredEvent(harness.deps, {
        threadId: f.child.id,
        scope: turnScope("turn-owner"),
        sequence: 3,
        type: "system/thread/interrupted",
        data: { reason: "manual-stop" },
      });
      for (let i = 0; i < 2; i++)
        await publishSupervisorChildOutcome(harness.deps, {
          childThreadId: f.child.id,
          parentThreadId: f.manager.id,
          turnStatus: "interrupted",
        });
      const decision = {
        ...f.registration,
        taskId: null,
        key: "review-ready",
        kind: "decision" as const,
        message: "Review the owner result",
      };
      const first = await notifyThreadSupervisor(harness.deps, decision);
      const replay = await notifyThreadSupervisor(harness.deps, decision);
      expect(replay).toEqual(first);
      expect(first.delivery).toBe("queued");
      await expect(
        notifyThreadSupervisor(harness.deps, {
          ...decision,
          message: "different",
        }),
      ).rejects.toThrow("different content");
      const rows = listQueuedThreadMessages(harness.db, f.manager.id);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.content).join()).toContain(
        "Do not resume, retry, replace or continue",
      );
      const inbox = await readThreadSupervisorInbox(harness.deps, {
        managerThreadId: f.manager.id,
        campaignId: "campaign",
        inboxId: "results",
        limit: 100,
      });
      expect(inbox.items.map((item) => item.kind).sort()).toEqual([
        "decision",
        "manual-interruption",
      ]);
      expect(inbox.items.every((item) => item.queuedMessageId !== null)).toBe(
        true,
      );
      expect(JSON.stringify(inbox)).not.toContain(f.registration.bindingToken);
    });
  });
});

describe("pure supervisor peek", () => {
  it("preserves absent registration, empty and lost-recovery states without writes", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      bindSupervisorChild(harness.db, {
        childThreadId: f.child.id,
        binding: f.binding,
      });
      complete(harness, f.child.id, "failed");
      const args = {
        managerThreadId: f.manager.id,
        campaignId: "campaign",
        inboxId: "results",
        limit: 100,
      };
      const before = harness.db.get(sql`select total_changes() as writes`);
      expect(
        peekThreadSupervisorInbox(harness.deps, {
          ...args,
          campaignId: "missing",
        }),
      ).toEqual({ registration: "missing", items: [], nextKey: null });
      expect(peekThreadSupervisorInbox(harness.deps, args)).toEqual({
        registration: "present",
        items: [],
        nextKey: null,
      });
      expect(
        peekThreadSupervisorInbox(harness.deps, {
          ...args,
          noticeKey: "missing",
        }).items,
      ).toEqual([]);
      expect(harness.db.get(sql`select total_changes() as writes`)).toEqual(
        before,
      );
      expect(listQueuedThreadMessages(harness.db, f.manager.id)).toEqual([]);
    });
  });
  it.each([null, "queue-1"])(
    "does not queue or change a persisted notice with queue %s",
    async (queuedMessageId) => {
      await withTestHarness(async (harness) => {
        const f = fixture(harness);
        const supervisor = harness.db.select().from(threadSupervisors).all()[0];
        if (!supervisor) throw new Error("Missing fixture registration");
        const key = createHash("sha256")
          .update(JSON.stringify([supervisor.id, "notice", "original-key"]))
          .digest("hex");
        harness.db
          .insert(threadSupervisorInbox)
          .values({
            key,
            supervisorId: supervisor.id,
            childThreadId: null,
            taskId: null,
            turnId: null,
            kind: "decision",
            output: "original notice",
            createdAt: 1,
            queuedMessageId,
          })
          .run();
        const args = {
          managerThreadId: f.manager.id,
          campaignId: "campaign",
          inboxId: "results",
          limit: 1,
        };
        const before = harness.db.get(sql`select total_changes() as writes`);
        const peek = peekThreadSupervisorInbox(harness.deps, {
          ...args,
          noticeKey: "original-key",
        });
        expect(peek.items[0]).toMatchObject({
          key,
          queuedMessageId,
          delivery: queuedMessageId ? "queued" : "inbox",
          requestSequence: null,
        });
        expect(peekThreadSupervisorInbox(harness.deps, args)).toEqual(peek);
        expect(harness.db.get(sql`select total_changes() as writes`)).toEqual(
          before,
        );
        expect(listQueuedThreadMessages(harness.db, f.manager.id)).toEqual([]);
      });
    },
  );
});

it.each([true, false])(
  "pure peek retains requested evidence for supervisor-managed=%s without recovery",
  async (managed) => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      if (managed)
        bindSupervisorChild(harness.db, {
          childThreadId: f.child.id,
          binding: f.binding,
        });
      complete(harness, f.child.id, "failed");
      const supervisor = harness.db.select().from(threadSupervisors).all()[0];
      if (!supervisor) throw new Error("Missing supervisor");
      const key = createHash("sha256")
        .update(JSON.stringify([supervisor.id, "notice", "accepted-key"]))
        .digest("hex");
      harness.db
        .insert(threadSupervisorInbox)
        .values({
          key,
          supervisorId: supervisor.id,
          childThreadId: null,
          taskId: null,
          turnId: null,
          kind: "exception",
          output: "exact notice",
          createdAt: 1,
          queuedMessageId: "original-queue",
        })
        .run();
      seedStoredEvent(harness.deps, {
        threadId: f.manager.id,
        scope: threadScope(),
        sequence: 100,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
          source: "tell",
          initiator: "system",
          senderThreadId: null,
          input: [
            {
              type: "text",
              text: `[Supervisor campaign; exception; key ${key}]\nexact notice`,
              mentions: [],
            },
          ],
          target: { kind: "new-turn" },
          request: { method: "turn/start", params: {} },
          execution: {
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "default",
            source: "client/turn/requested",
          },
        },
      });
      const before = harness.db.get(sql`select total_changes() as writes`);
      const response = peekThreadSupervisorInbox(harness.deps, {
        managerThreadId: f.manager.id,
        campaignId: "campaign",
        inboxId: "results",
        noticeKey: "accepted-key",
        limit: 1,
      });
      expect(response.items).toHaveLength(1);
      expect(response.items[0]).toMatchObject({
        key,
        delivery: "requested",
        requestSequence: 100,
        queuedMessageId: "original-queue",
      });
      expect(harness.db.get(sql`select total_changes() as writes`)).toEqual(
        before,
      );
      expect(listQueuedThreadMessages(harness.db, f.manager.id)).toEqual([]);
    });
  },
);

it("peek projects the exact delivery formatter without admitting another wake", async () => {
  vi.useFakeTimers();
  await withTestHarness(async (harness) => {
    const f = fixture(harness);
    await notifyThreadSupervisor(harness.deps, {
      ...f.registration,
      key: "format-key",
      taskId: null,
      kind: "decision",
      message: "multiline\nnotice",
    });
    const queued = listQueuedThreadMessages(harness.db, f.manager.id);
    const before = harness.db.get(sql`select total_changes() as writes`);
    const peek = peekThreadSupervisorInbox(harness.deps, {
      managerThreadId: f.manager.id,
      campaignId: "campaign",
      inboxId: "results",
      noticeKey: "format-key",
      limit: 1,
    });
    expect(queued).toHaveLength(1);
    expect(JSON.parse(queued[0]?.content ?? "null")).toEqual([
      { type: "text", mentions: [], text: peek.items[0]?.requestInputText },
    ]);
    expect(harness.db.get(sql`select total_changes() as writes`)).toEqual(
      before,
    );
  });
});
