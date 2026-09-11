import {
  applyThreadLifecycleEvent,
  getThread,
  isThreadQueueAutoSendPaused,
  listEvents,
  listQueuedThreadMessages,
} from "@bb/db";
import { threadScope, turnScope, type ThreadStatus } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  listQueuedCommands,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedQueuedMessage,
  seedStoredEvent,
  seedThreadFixture,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function seedTarget(
  harness: TestAppHarness,
  options: { status?: ThreadStatus; turnId?: string | null } = {},
) {
  const fixture = seedThreadFixture(harness, {
    thread: { status: options.status ?? "active", visibility: "hidden" },
  });
  const { thread, environment } = fixture;
  seedThreadRuntimeState(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId: "provider-conditional-stop",
  });
  const turnId =
    options.turnId === undefined ? "turn-original" : options.turnId;
  if (turnId !== null) {
    seedStoredEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      sequence: 3,
      type: "turn/started",
      scope: turnScope(turnId),
      data: {},
    });
  }
  seedQueuedMessage(harness.deps, {
    threadId: thread.id,
    content: [{ type: "text", text: "Queued work must survive", mentions: [] }],
  });
  return fixture;
}

function snapshot(harness: TestAppHarness, threadId: string) {
  return {
    thread: getThread(harness.db, threadId),
    events: listEvents(harness.db, { threadId }),
    queued: listQueuedThreadMessages(harness.db, threadId),
    paused: isThreadQueueAutoSendPaused(harness.db, threadId),
  };
}

function requestStop(harness: TestAppHarness, threadId: string) {
  return harness.app.request(
    `/api/v1/threads/${threadId}/stop-if-current?expectedTurnId=turn-original`,
    { method: "POST" },
  );
}

function seedCleanup(
  harness: TestAppHarness,
  threadId: string,
  sequence: number,
) {
  seedStoredEvent(harness.deps, {
    threadId,
    sequence,
    scope: threadScope(),
    type: "system/thread/interrupted",
    data: {
      reason: "workflow-result-cleanup",
      workflowResult: {
        acceptance: "accepted",
        callId: "call-conditional",
        childThreadId: threadId,
        pluginId: "workflows",
        resultSha256: "b".repeat(64),
        runId: "run-conditional",
      },
    },
  });
}

describe("public conditional thread stop", () => {
  it.each([
    {
      status: "active" as const,
      turnId: "turn-replacement",
      reason: "turn-mismatch",
    },
    { status: "active" as const, turnId: null, reason: "no-active-turn" },
    { status: "idle" as const, turnId: null, reason: "thread-not-active" },
    {
      status: "error" as const,
      turnId: "turn-original",
      reason: "thread-not-active",
    },
  ])(
    "refuses $reason for $status with turn $turnId before any host call or mutation",
    async (testCase) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedTarget(harness, testCase);
        seedCleanup(harness, thread.id, 4);
        const before = snapshot(harness, thread.id);
        const response = await requestStop(harness, thread.id);
        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toEqual({
          ok: true,
          condition: {
            status: "refused",
            expectedTurnId: "turn-original",
            reason: testCase.reason,
            activeTurnId: testCase.turnId,
          },
        });
        expect(snapshot(harness, thread.id)).toEqual(before);
        expect(listQueuedCommands(harness, "thread.stop")).toHaveLength(0);
      });
    },
  );

  it.each([undefined, "", " ", " turn-original"])(
    "rejects malformed turn ID %j without mutation",
    async (expectedTurnId) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedTarget(harness);
        const before = snapshot(harness, thread.id);
        const response = await harness.app.request(
          `/api/v1/threads/${thread.id}/stop-if-current${expectedTurnId === undefined ? "" : `?expectedTurnId=${encodeURIComponent(expectedTurnId)}`}`,
          { method: "POST" },
        );
        expect(response.status).toBe(400);
        expect(snapshot(harness, thread.id)).toEqual(before);
        expect(listQueuedCommands(harness, "thread.stop")).toHaveLength(0);
      });
    },
  );

  it.each(["plain", "steer", "accepted-auto"])(
    "waits for matching proof before manual stop authority with %s input",
    async (input) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedTarget(harness);
        seedCleanup(harness, thread.id, 4);
        if (input !== "plain") {
          const request = listEvents(harness.db, { threadId: thread.id }).find(
            (event) => event.type === "client/turn/requested",
          );
          if (!request) throw new Error("Missing original request fixture");
          seedStoredEvent(harness.deps, {
            threadId: thread.id,
            sequence: 5,
            scope: threadScope(),
            type: "client/turn/requested",
            data: {
              ...JSON.parse(request.data),
              requestId: "creq_222222222v",
              target: {
                kind: input === "steer" ? "steer" : "auto",
                expectedTurnId: "turn-original",
              },
            },
          });
          if (input === "accepted-auto") {
            seedStoredEvent(harness.deps, {
              threadId: thread.id,
              sequence: 6,
              scope: turnScope("turn-original"),
              type: "turn/input/accepted",
              data: {
                clientRequestId: "creq_222222222v",
                providerThreadId: "provider-conditional-stop",
              },
            });
          }
        }
        const before = snapshot(harness, thread.id);
        const responsePromise = requestStop(harness, thread.id);
        const stop = await waitForQueuedCommand(
          harness,
          ({ command }) => command.type === "thread.stop",
        );
        expect(stop.command).toMatchObject({
          intent: "interrupt",
          expectedTurnId: "turn-original",
        });
        expect(snapshot(harness, thread.id)).toEqual(before);
        const condition = {
          status: "stopped" as const,
          expectedTurnId: "turn-original",
        };
        await reportQueuedCommandSuccess(harness, stop, {
          providerCheckpointId: null,
          condition,
        });
        await expect(readJson(await responsePromise)).resolves.toEqual({
          ok: true,
          condition,
        });
        expect(getThread(harness.db, thread.id)?.status).toBe("idle");
        expect(isThreadQueueAutoSendPaused(harness.db, thread.id)).toBe(true);
        expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual(
          before.queued,
        );
        expect(
          listEvents(harness.db, { threadId: thread.id })
            .filter((event) => event.type === "system/thread/interrupted")
            .map((event) => JSON.parse(event.data).reason),
        ).toEqual(["workflow-result-cleanup", "manual-stop"]);
      });
    },
  );

  it.each(["refused", "missing-proof", "wrong-proof", "transport-error"])(
    "keeps state and cleanup reason unchanged for host %s",
    async (mode) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedTarget(harness);
        seedCleanup(harness, thread.id, 4);
        const before = snapshot(harness, thread.id);
        const responsePromise = requestStop(harness, thread.id);
        const stop = await waitForQueuedCommand(
          harness,
          ({ command }) => command.type === "thread.stop",
        );
        if (mode === "transport-error") {
          await reportQueuedCommandError(harness, stop, {
            errorCode: "unknown_environment",
            errorMessage: "Environment disappeared in transport",
          });
        } else if (mode === "refused") {
          await reportQueuedCommandSuccess(harness, stop, {
            providerCheckpointId: null,
            condition: {
              status: "refused",
              expectedTurnId: "turn-original",
              reason: "turn-mismatch",
              activeTurnId: "turn-replacement",
            },
          });
        } else {
          await reportQueuedCommandSuccess(harness, stop, {
            providerCheckpointId: null,
            ...(mode === "wrong-proof"
              ? {
                  condition: {
                    status: "stopped" as const,
                    expectedTurnId: "turn-other",
                  },
                }
              : {}),
          });
        }
        await expect(readJson(await responsePromise)).resolves.toMatchObject({
          ok: true,
          condition: {
            status: "refused",
            expectedTurnId: "turn-original",
            reason: mode === "refused" ? "turn-mismatch" : "unproven",
          },
        });
        expect(snapshot(harness, thread.id)).toEqual(before);
      });
    },
  );

  it("preserves a replacement request that has not emitted turn/started", async () => {
    await withTestHarness(async (harness) => {
      const { thread, environment } = seedTarget(harness);
      const responsePromise = requestStop(harness, thread.id);
      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "thread.stop",
      );
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        sequence: 4,
        scope: turnScope("turn-original"),
        type: "turn/completed",
        data: { status: "completed" },
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-replacement",
        sequenceStart: 5,
      });
      const pending = snapshot(harness, thread.id);
      await reportQueuedCommandSuccess(harness, stop, {
        providerCheckpointId: null,
        condition: { status: "stopped", expectedTurnId: "turn-original" },
      });
      await expect(readJson(await responsePromise)).resolves.toMatchObject({
        condition: {
          status: "refused",
          reason: "turn-mismatch",
          activeTurnId: null,
        },
      });
      expect(snapshot(harness, thread.id)).toEqual(pending);
    });
  });

  it.each([false, true])(
    "preserves a replacement turn during transport, completed=%s",
    async (completed) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedTarget(harness);
        const responsePromise = requestStop(harness, thread.id);
        const stop = await waitForQueuedCommand(
          harness,
          ({ command }) => command.type === "thread.stop",
        );
        seedStoredEvent(harness.deps, {
          threadId: thread.id,
          sequence: 4,
          scope: turnScope("turn-original"),
          type: "turn/completed",
          data: { status: "completed" },
        });
        seedStoredEvent(harness.deps, {
          threadId: thread.id,
          sequence: 5,
          scope: turnScope("turn-replacement"),
          type: "turn/started",
          data: {},
        });
        if (completed) {
          seedStoredEvent(harness.deps, {
            threadId: thread.id,
            sequence: 6,
            scope: turnScope("turn-replacement"),
            type: "turn/completed",
            data: { status: "completed" },
          });
          expect(
            applyThreadLifecycleEvent(harness.db, {
              threadId: thread.id,
              event: { type: "run.succeeded" },
            }),
          ).toMatchObject({ applied: true, thread: { status: "idle" } });
        }
        seedCleanup(harness, thread.id, 7);
        const replacement = snapshot(harness, thread.id);
        await reportQueuedCommandSuccess(harness, stop, {
          providerCheckpointId: "checkpoint-original",
          condition: { status: "stopped", expectedTurnId: "turn-original" },
        });
        await expect(readJson(await responsePromise)).resolves.toEqual({
          ok: true,
          condition: {
            status: "refused",
            expectedTurnId: "turn-original",
            reason: "turn-mismatch",
            activeTurnId: completed ? null : "turn-replacement",
          },
        });
        expect(snapshot(harness, thread.id)).toEqual(replacement);
      });
    },
  );
});
