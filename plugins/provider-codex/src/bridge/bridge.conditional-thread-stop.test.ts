import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { experimental_threadStopIfCurrentTurnResultSchema } from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_assembleCapturedThreadEvents as assembleEvents,
  experimental_createBridgeJsonRpcTestHarness as createHarness,
  type BridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./bridge.js";

const threadId = "conditional-native-thread";
const options = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} as const;
let harness: BridgeJsonRpcTestHarness;
let workspaceDir: string;
let requestId = 0;

async function request(
  method: string,
  params: Parameters<BridgeJsonRpcTestHarness["sendRequest"]>[2],
) {
  requestId += 1;
  harness.sendRequest(requestId, method, params);
  const response = await harness.waitForResponse(requestId);
  expect(response.error).toBeUndefined();
  return response.result;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-conditional-ws-"));
  vi.stubEnv("BB_CODEX_BRIDGE_APP_SERVER_COMMAND", process.execPath);
  vi.stubEnv(
    "BB_CODEX_BRIDGE_APP_SERVER_ARGS",
    JSON.stringify([
      fileURLToPath(new URL("./fake-codex-app-server.mjs", import.meta.url)),
    ]),
  );
  harness = createHarness(handleLine);
});

afterEach(async () => {
  await request("thread/stop", {
    threadId,
    providerThreadId: "cleanup",
    intent: "release",
    activeTurnId: null,
  });
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

it("retains the same native session after conditional success and refuses the stale original on its successor", async () => {
  const started = await request("thread/start", {
    threadId,
    cwd: workspaceDir,
    instructionMode: "append",
    options,
  });
  const { providerThreadId } = z
    .object({ providerThreadId: z.string() })
    .parse(started);
  const startTurn = () =>
    request("turn/start", {
      threadId,
      providerThreadId,
      input: [{ type: "text", text: "/wait-for-interrupt", mentions: [] }],
      clientRequestId: "creq_22c3c4d5e6",
      options,
    });
  await startTurn();
  const stop = experimental_threadStopIfCurrentTurnResultSchema.parse(
    await request("thread/stop-if-current-turn", {
      threadId,
      providerThreadId,
      expectedTurnId: "turn-fx-1",
    }),
  );
  expect(stop.condition).toEqual({
    status: "stopped",
    expectedTurnId: "turn-fx-1",
  });
  expect(assembleEvents(harness.messages, "codex")).toContainEqual(
    expect.objectContaining({
      type: "turn/completed",
      status: "interrupted",
      providerCheckpointId: "turn-fx-1",
    }),
  );
  await startTurn();
  const eventsBefore = harness.messages.filter(
    (message) => message.method === "thread/delta",
  );
  const stale = experimental_threadStopIfCurrentTurnResultSchema.parse(
    await request("thread/stop-if-current-turn", {
      threadId,
      providerThreadId,
      expectedTurnId: "turn-fx-1",
    }),
  );
  expect(stale.condition).toEqual({
    status: "refused",
    expectedTurnId: "turn-fx-1",
    reason: "turn-mismatch",
    activeTurnId: "turn-fx-2",
  });
  expect(
    harness.messages.filter((message) => message.method === "thread/delta"),
  ).toEqual(eventsBefore);
  await request("thread/stop", {
    threadId,
    providerThreadId,
    intent: "interrupt",
    activeTurnId: "turn-fx-2",
  });
  expect(assembleEvents(harness.messages, "codex")).toContainEqual(
    expect.objectContaining({
      type: "turn/completed",
      status: "interrupted",
      providerCheckpointId: "turn-fx-2",
    }),
  );
}, 20_000);
