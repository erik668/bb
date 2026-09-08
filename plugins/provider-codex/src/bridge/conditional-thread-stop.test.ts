import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CodexAppServerConnection } from "./app-server-connection.js";
import { CodexConditionalTurnState } from "./conditional-thread-stop.js";

const nativeInterruptSchema = z.strictObject({
  threadId: z.string(),
  turnId: z.string(),
});

function createHarness() {
  const state = new CodexConditionalTurnState();
  const requests: Array<z.infer<typeof nativeInterruptSchema>> = [];
  let onInterrupt = async (): Promise<void> => undefined;
  let current = true;
  const connection: CodexAppServerConnection = {
    request: async (args) => {
      expect(args.method).toBe("turn/interrupt");
      requests.push(nativeInterruptSchema.parse(args.params));
      await onInterrupt();
      return args.resultSchema.parse({});
    },
    notify: vi.fn(),
    kill: vi.fn(async () => undefined),
    exited: false,
  };
  const observe = (
    method: "turn/started" | "turn/completed",
    turnId = "original",
    threadId = "native-thread",
  ): void =>
    state.observe({
      method,
      params: {
        threadId,
        turn: {
          id: turnId,
          status: method === "turn/started" ? "inProgress" : "interrupted",
        },
      },
      providerThreadId: "native-thread",
    });
  return {
    state,
    requests,
    connection,
    observe,
    interruptWith: (work: () => Promise<void>) => {
      onInterrupt = work;
    },
    replaceSession: () => {
      current = false;
    },
    stop: (expectedTurnId = "original") =>
      state.stop({
        providerThreadId: "native-thread",
        expectedTurnId,
        connection,
        isCurrent: () => current,
        requestTimeoutMs: 50,
        settlementTimeoutMs: 50,
      }),
  };
}

afterEach(() => vi.useRealTimers());

describe("Codex native conditional turn stop", () => {
  it("interrupts the exact original and proves native settlement without releasing the session", async () => {
    const harness = createHarness();
    harness.observe("turn/started");
    harness.interruptWith(async () => harness.observe("turn/completed"));
    expect(await harness.stop()).toEqual({
      condition: { status: "stopped", expectedTurnId: "original" },
    });
    expect(harness.requests).toEqual([
      { threadId: "native-thread", turnId: "original" },
    ]);
    expect(harness.connection.kill).not.toHaveBeenCalled();
    harness.observe("turn/started", "successor");
    harness.interruptWith(async () =>
      harness.observe("turn/completed", "successor"),
    );
    expect(await harness.stop("successor")).toEqual({
      condition: { status: "stopped", expectedTurnId: "successor" },
    });
  });

  it.each(["active", "completed", "same-id-reopened"])(
    "refuses a %s replacement that starts while the native reply is pending",
    async (replacement) => {
      const harness = createHarness();
      let releaseReply!: () => void;
      const reply = new Promise<void>((resolve) => {
        releaseReply = resolve;
      });
      harness.observe("turn/started");
      harness.interruptWith(() => reply);
      const stop = harness.stop();
      harness.observe("turn/completed");
      const nextId =
        replacement === "same-id-reopened" ? "original" : "successor";
      harness.observe("turn/started", nextId);
      if (replacement === "completed")
        harness.observe("turn/completed", nextId);
      releaseReply();
      expect(await stop).toEqual({
        condition: {
          status: "refused",
          expectedTurnId: "original",
          reason: "turn-mismatch",
          activeTurnId: replacement === "completed" ? null : nextId,
        },
      });
      expect(harness.requests).toEqual([
        { threadId: "native-thread", turnId: "original" },
      ]);
      expect(harness.connection.kill).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "refuses a replacement during settlement (completed=%s)",
    async (completed) => {
      const harness = createHarness();
      harness.observe("turn/started");
      const stop = harness.stop();
      await Promise.resolve();
      await Promise.resolve();
      harness.observe("turn/completed");
      harness.observe("turn/started", "successor");
      if (completed) harness.observe("turn/completed", "successor");
      expect(await stop).toMatchObject({
        condition: { status: "refused", reason: "turn-mismatch" },
      });
      expect(harness.connection.kill).not.toHaveBeenCalled();
    },
  );

  it("refuses timeout without inventing completion, and still recognizes the original turn", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.observe("turn/started");
    harness.observe("turn/completed", "original", "native-subagent");
    const stop = harness.stop();
    await vi.advanceTimersByTimeAsync(51);
    expect(await stop).toEqual({
      condition: {
        status: "refused",
        expectedTurnId: "original",
        reason: "unproven",
        activeTurnId: "original",
      },
    });
    expect(harness.connection.kill).not.toHaveBeenCalled();
    harness.interruptWith(async () => harness.observe("turn/completed"));
    expect(await harness.stop()).toMatchObject({
      condition: { status: "stopped" },
    });
  });

  it.each(["missing", "wrong-turn", "overlapping-turns"])(
    "refuses %s before sending any native request",
    async (failure) => {
      const harness = createHarness();
      harness.observe("turn/started");
      if (failure === "missing") harness.replaceSession();
      if (failure === "overlapping-turns") {
        harness.observe("turn/started", "other");
        harness.observe("turn/started");
      }
      expect(
        await harness.stop(failure === "wrong-turn" ? "wrong" : "original"),
      ).toMatchObject({ condition: { status: "refused" } });
      expect(harness.requests).toEqual([]);
      expect(harness.connection.kill).not.toHaveBeenCalled();
    },
  );

  it("refuses a replaced connection after native completion", async () => {
    const harness = createHarness();
    harness.observe("turn/started");
    harness.interruptWith(async () => {
      harness.observe("turn/completed");
      harness.replaceSession();
    });
    expect(await harness.stop()).toMatchObject({
      condition: { status: "refused", reason: "runtime-missing" },
    });
    expect(harness.connection.kill).not.toHaveBeenCalled();
  });

  it("refuses a rejected native interrupt and retains the active turn", async () => {
    const harness = createHarness();
    harness.observe("turn/started");
    harness.interruptWith(async () => {
      throw new Error("native request failed");
    });
    expect(await harness.stop()).toMatchObject({
      condition: {
        status: "refused",
        reason: "unproven",
        activeTurnId: "original",
      },
    });
    expect(harness.connection.kill).not.toHaveBeenCalled();
  });
});
