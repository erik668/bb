import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./bridge.js";

const THREAD_ID = "thr_signature_1";

const fakeAppServerPath = fileURLToPath(
  new URL("./fake-codex-app-server.mjs", import.meta.url),
);

const sessionOptions = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} as const;

const autoAskSessionOptions = {
  permissionMode: "auto",
  permissionScope: "workspace",
  approvalReviewer: "automatic",
  permissionEscalation: "ask",
} as const;

const autoDenySessionOptions = {
  ...autoAskSessionOptions,
  permissionEscalation: "deny",
} as const;

let harness: ReturnType<typeof createBridgeJsonRpcTestHarness>;
let workspaceDir: string;
let requestLogPath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-signature-ws-"));
  requestLogPath = join(workspaceDir, "requests.jsonl");
  const scriptPath = join(workspaceDir, "script.json");
  writeFileSync(scriptPath, JSON.stringify({ requestLogPath }), "utf8");
  vi.stubEnv("BB_CODEX_BRIDGE_APP_SERVER_COMMAND", process.execPath);
  vi.stubEnv(
    "BB_CODEX_BRIDGE_APP_SERVER_ARGS",
    JSON.stringify([fakeAppServerPath, scriptPath]),
  );
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(async () => {
  const cleanupId = 991_001;
  harness.sendRequest(cleanupId, "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId: "signature-cleanup",
    intent: "release",
    activeTurnId: null,
  });
  await harness.waitForResponse(cleanupId).catch(() => undefined);
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

it("keeps the constructed session for a turn whose options carry no envVars", async () => {
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: { ...sessionOptions, envVars: { PATH: "/usr/bin:/bin" } },
  });
  const started = await harness.waitForResponse(1);
  const providerThreadId = (started.result as { providerThreadId: string })
    .providerThreadId;

  harness.sendRequest(2, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId,
    clientRequestId: "creq_signature2",
    input: [{ type: "text", text: "say hello", mentions: [] }],
    options: { ...sessionOptions },
  });
  const turn = await harness.waitForResponse(2);

  expect(turn.error).toBeUndefined();
  expect(
    harness.messages.filter((message) => message.method === "session/replaced"),
  ).toEqual([]);
}, 30_000);

it.each([
  {
    label: "ask to deny",
    initialOptions: autoAskSessionOptions,
    initialApprovalPolicy: "on-request",
    turnOptions: autoDenySessionOptions,
    turnApprovalPolicy: "never",
  },
  {
    label: "deny to ask",
    initialOptions: autoDenySessionOptions,
    initialApprovalPolicy: "never",
    turnOptions: autoAskSessionOptions,
    turnApprovalPolicy: "on-request",
  },
])(
  "rebuilds an auto-reviewed session when escalation changes from $label",
  async ({
    initialOptions,
    initialApprovalPolicy,
    turnOptions,
    turnApprovalPolicy,
  }) => {
    harness.sendRequest(1, "thread/start", {
      threadId: THREAD_ID,
      cwd: workspaceDir,
      instructionMode: "append",
      options: initialOptions,
    });
    const started = await harness.waitForResponse(1);
    expect(started.error).toBeUndefined();
    const providerThreadId = (started.result as { providerThreadId: string })
      .providerThreadId;

    harness.sendRequest(2, "turn/start", {
      threadId: THREAD_ID,
      providerThreadId,
      clientRequestId: "creq_signature3",
      input: [{ type: "text", text: "say hello", mentions: [] }],
      options: turnOptions,
    });
    const turn = await harness.waitForResponse(2);

    expect(turn.error).toBeUndefined();
    expect(
      harness.messages.filter(
        (message) => message.method === "session/replaced",
      ),
    ).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          threadId: THREAD_ID,
          providerThreadId,
          contextLost: false,
        }),
      }),
    ]);
    const requests = readFileSync(requestLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    expect(requests).toEqual(
      expect.arrayContaining([
        {
          method: "thread/start",
          params: expect.objectContaining({
            approvalPolicy: initialApprovalPolicy,
            approvalsReviewer: "auto_review",
            sandbox: "workspace-write",
          }),
        },
        {
          method: "thread/resume",
          params: expect.objectContaining({
            threadId: providerThreadId,
            approvalPolicy: turnApprovalPolicy,
            approvalsReviewer: "auto_review",
            sandbox: "workspace-write",
          }),
        },
        {
          method: "turn/start",
          params: expect.objectContaining({
            threadId: providerThreadId,
            approvalPolicy: turnApprovalPolicy,
            approvalsReviewer: "auto_review",
            sandboxPolicy: expect.objectContaining({
              type: "workspaceWrite",
            }),
          }),
        },
      ]),
    );
  },
  30_000,
);
