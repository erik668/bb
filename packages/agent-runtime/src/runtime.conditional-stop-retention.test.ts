import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import type { AgentRuntimeProviderRecoveryHint } from "./types.js";
import {
  createScriptedEchoProcessLog,
  createScriptedEchoRequestRecord,
  createScriptedEchoRuntime,
  fullRuntimeOptions,
  scriptedEchoProcessEnv,
  waitForThreadTurnCompleted,
  waitForThreadTurnStarted,
} from "./test/runtime-test-harness.js";
import { promptTextInput } from "./test/prompt-input.js";

const cleanups: Array<() => Promise<void>> = [];

function createHarness(
  mode: "supported" | "unsupported" | "refused" = "supported",
) {
  const workspacePath = mkdtempSync(
    join(tmpdir(), "bb-conditional-retention-"),
  );
  const record = createScriptedEchoRequestRecord();
  const processLog = createScriptedEchoProcessLog();
  const events: ThreadEvent[] = [];
  const hints: AgentRuntimeProviderRecoveryHint[] = [];
  const runtime = createScriptedEchoRuntime({
    runtime: {
      workspacePath,
      env: {
        ...record.env,
        ...processLog.env,
        ...scriptedEchoProcessEnv({
          sessionRestorable: true,
          ...(mode === "unsupported"
            ? { unsupportedMethods: ["thread/stop-if-current-turn"] }
            : {}),
          ...(mode === "refused"
            ? { failStopForThreadIds: ["original-thread"] }
            : {}),
        }),
      },
      onEvent: (event) => events.push(event),
      onProviderRecovery: (hint) => hints.push(hint),
    },
  });
  cleanups.push(async () => {
    await runtime.shutdown();
    rmSync(workspacePath, { recursive: true, force: true });
  });
  return {
    runtime,
    events,
    hints,
    processLog,
    record,
    start: (threadId = "original-thread") =>
      runtime.startThread({
        environmentId: "env-conditional",
        projectId: "project-conditional",
        threadId,
        providerId: "fake",
        options: fullRuntimeOptions,
      }),
    turn: (threadId: string, text: string) =>
      runtime.runTurn({
        threadId,
        clientRequestId: "creq_22222222rq",
        input: [promptTextInput({ text })],
        options: fullRuntimeOptions,
      }),
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("conditional stop session retention", () => {
  it.each(["unsupported", "refused"] as const)(
    "retains runtime identity and active work when the provider is %s",
    async (mode) => {
      const harness = createHarness(mode);
      await harness.start();
      await harness.turn("original-thread", "delay:60000");
      const { turnId } = await waitForThreadTurnStarted({
        events: harness.events,
        threadId: "original-thread",
      });
      const before = harness.record.read();
      expect(
        await harness.runtime.stopThread({
          threadId: "original-thread",
          expectedTurnId: turnId,
        }),
      ).toEqual({
        providerCheckpointId: null,
        condition: {
          status: "refused",
          expectedTurnId: turnId,
          reason: "unproven",
          activeTurnId: turnId,
        },
      });
      expect(harness.runtime.hasThread("original-thread")).toBe(true);
      expect(harness.runtime.getActiveTurnId("original-thread")).toBe(turnId);
      expect(
        harness.processLog.read().filter((line) => line.startsWith("exit:")),
      ).toHaveLength(0);
      expect(
        harness.record
          .read()
          .slice(before.length)
          .map((entry) => entry.method),
      ).toEqual(mode === "unsupported" ? [] : ["thread/stop-if-current-turn"]);
    },
  );

  it("excludes retained sessions from idle release and shared-process restart until explicit Stop", async () => {
    const harness = createHarness();
    await harness.start();
    await harness.start("sibling");
    await harness.turn("original-thread", "delay:60000");
    const { turnId } = await waitForThreadTurnStarted({
      events: harness.events,
      threadId: "original-thread",
    });
    expect(
      await harness.runtime.stopThread({
        threadId: "original-thread",
        expectedTurnId: turnId,
      }),
    ).toMatchObject({ condition: { status: "stopped" } });
    expect(harness.runtime.hasThread("original-thread")).toBe(true);
    await harness.turn("sibling", "delay:60000");
    await waitForThreadTurnStarted({
      events: harness.events,
      threadId: "sibling",
    });
    expect(
      await harness.runtime.reapIdleProviderSessions({
        idleForMs: 0,
        nowMs: Date.now() + 3_600_000,
        runThreadExclusive: async (_threadId, work) => {
          await Promise.resolve();
          return work();
        },
      }),
    ).toEqual({ reapedSessions: [] });
    expect(harness.runtime.hasThread("sibling")).toBe(true);
    await harness.runtime.stopThread({ threadId: "sibling" });
    for (const threadId of ["original-thread", "sibling"]) {
      if (threadId === "sibling") await harness.start(threadId);
      harness.events.length = 0;
      await harness.turn(threadId, "recover:restartRecommended");
      await waitForThreadTurnCompleted({ events: harness.events, threadId });
      expect(harness.hints).toContainEqual(
        expect.objectContaining({ kind: "restartRecommended", threadId }),
      );
      expect(harness.runtime.hasThread("original-thread")).toBe(true);
      expect(
        harness.processLog.read().filter((line) => line.startsWith("spawn:")),
      ).toHaveLength(1);
      expect(
        harness.processLog.read().filter((line) => line.startsWith("exit:")),
      ).toHaveLength(0);
      expect(
        harness.record
          .read()
          .filter((entry) => entry.method === "thread/resume"),
      ).toEqual([]);
    }
    await harness.runtime.stopThread({ threadId: "original-thread" });
    expect(harness.runtime.hasThread("original-thread")).toBe(false);
    const reaped = await harness.runtime.reapIdleProviderSessions({
      idleForMs: 0,
      nowMs: Date.now() + 3_600_000,
    });
    expect(reaped.reapedSessions.map((session) => session.threadId)).toEqual([
      "sibling",
    ]);
    expect(harness.runtime.hasThread("sibling")).toBe(false);
    expect(
      harness.processLog.read().filter((line) => line.startsWith("exit:")),
    ).toHaveLength(1);
  });
});
