import { describe, expect, it, vi } from "vitest";
import {
  browserControllerServerMessageSchema,
  type BrowserControllerCommandMessage,
  type BrowserControllerServerMessage,
  type BrowserSnapshot,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import {
  createBrowserControlService,
  type BrowserControllerConnection,
} from "./browser-control.js";

const SNAPSHOT = {
  data: Buffer.from("jpeg-bytes").toString("base64"),
  height: 480,
  mimeType: "image/jpeg",
  tabId: "browser:visible",
  threadId: "thr_browser",
  url: "https://example.com/current",
  width: 640,
} satisfies BrowserSnapshot;

function expectApiError(code: string) {
  return expect.objectContaining({
    body: expect.objectContaining({ code }),
  }) as unknown as ApiError;
}

class FakeController implements BrowserControllerConnection {
  readonly messages: BrowserControllerServerMessage[] = [];

  send(data: string): void {
    this.messages.push(
      browserControllerServerMessageSchema.parse(JSON.parse(data)),
    );
  }

  command(): BrowserControllerCommandMessage {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message?.type === "browser-controller-command") return message;
    }
    throw new Error("Expected a browser command");
  }
}

function grantController(
  service: ReturnType<typeof createBrowserControlService>,
  controller = new FakeController(),
) {
  const grant = service.grant({
    controller,
    request: {
      controllerId: "controller:a",
      tabId: SNAPSHOT.tabId,
      threadId: SNAPSHOT.threadId,
    },
  });
  return { controller, grant };
}

describe("browser control service", () => {
  it("fails closed when no live tab is shared", async () => {
    const service = createBrowserControlService();

    await expect(
      service.snapshot({ threadId: SNAPSHOT.threadId }),
    ).rejects.toEqual(expectApiError("browser_not_connected"));
  });

  it("round-trips one snapshot through the owning socket and exact generation", async () => {
    const service = createBrowserControlService();
    const { controller, grant } = grantController(service);
    const snapshot = service.snapshot({ threadId: SNAPSHOT.threadId });
    const delivered = controller.command();

    service.completeCommand({
      controller,
      message: {
        commandId: delivered.command.commandId,
        controllerId: grant.controllerId,
        generation: grant.generation,
        grantId: grant.grantId,
        outcome: { snapshot: SNAPSHOT, status: "success" },
        type: "browser-controller-complete",
      },
    });

    await expect(snapshot).resolves.toEqual(SNAPSHOT);
  });

  it("rejects a different socket and stale generation without consuming the command", async () => {
    const service = createBrowserControlService();
    const { controller, grant } = grantController(service);
    const snapshot = service.snapshot({ threadId: SNAPSHOT.threadId });
    const delivered = controller.command();
    const completion = {
      commandId: delivered.command.commandId,
      controllerId: grant.controllerId,
      generation: grant.generation,
      grantId: grant.grantId,
      outcome: { snapshot: SNAPSHOT, status: "success" as const },
      type: "browser-controller-complete" as const,
    };

    expect(() =>
      service.completeCommand({
        controller: new FakeController(),
        message: completion,
      }),
    ).toThrowError(expectApiError("browser_controller_forbidden"));
    expect(() =>
      service.completeCommand({
        controller,
        message: { ...completion, generation: grant.generation + 1 },
      }),
    ).toThrowError(expectApiError("browser_controller_forbidden"));

    service.completeCommand({ controller, message: completion });
    await expect(snapshot).resolves.toEqual(SNAPSHOT);
    expect(() =>
      service.completeCommand({ controller, message: completion }),
    ).toThrowError(expectApiError("browser_command_stale"));
  });

  it("keeps the command pending after a mismatched tab tries to complete it", async () => {
    const service = createBrowserControlService();
    const { controller, grant } = grantController(service);
    const snapshot = service.snapshot({ threadId: SNAPSHOT.threadId });
    const delivered = controller.command();
    const base = {
      commandId: delivered.command.commandId,
      controllerId: grant.controllerId,
      generation: grant.generation,
      grantId: grant.grantId,
      type: "browser-controller-complete" as const,
    };

    expect(() =>
      service.completeCommand({
        controller,
        message: {
          ...base,
          outcome: {
            snapshot: { ...SNAPSHOT, tabId: "browser:hidden" },
            status: "success",
          },
        },
      }),
    ).toThrowError(expectApiError("browser_command_target_mismatch"));

    service.completeCommand({
      controller,
      message: {
        ...base,
        outcome: { snapshot: SNAPSHOT, status: "success" },
      },
    });
    await expect(snapshot).resolves.toEqual(SNAPSHOT);
  });

  it("invalidates a replaced controller and rejects its pending request", async () => {
    const service = createBrowserControlService();
    const first = grantController(service);
    const pending = service.snapshot({ threadId: SNAPSHOT.threadId });
    const replacementController = new FakeController();
    const replacement = service.grant({
      controller: replacementController,
      request: {
        controllerId: "controller:b",
        tabId: "browser:replacement",
        threadId: SNAPSHOT.threadId,
      },
    });

    await expect(pending).rejects.toEqual(
      expectApiError("browser_connection_lost"),
    );
    expect(first.controller.messages.at(-1)).toMatchObject({
      type: "browser-controller-disconnected",
    });
    expect(replacement.generation).toBe(first.grant.generation + 1);
  });

  it("revokes pending work on explicit disconnect and socket close", async () => {
    const service = createBrowserControlService();
    const first = grantController(service);
    const revoked = service.snapshot({ threadId: SNAPSHOT.threadId });
    service.revoke({
      controller: first.controller,
      controllerId: first.grant.controllerId,
    });
    await expect(revoked).rejects.toEqual(
      expectApiError("browser_connection_lost"),
    );

    const second = grantController(service);
    const released = service.snapshot({ threadId: SNAPSHOT.threadId });
    service.releaseController(second.controller);
    await expect(released).rejects.toEqual(
      expectApiError("browser_connection_lost"),
    );
  });

  it("cleans up timed-out and aborted commands so a later snapshot can run", async () => {
    vi.useFakeTimers();
    try {
      const service = createBrowserControlService({ snapshotTimeoutMs: 50 });
      const { controller } = grantController(service);
      const timedOut = service.snapshot({ threadId: SNAPSHOT.threadId });
      const timedOutExpectation = expect(timedOut).rejects.toEqual(
        expectApiError("browser_snapshot_timeout"),
      );
      await vi.advanceTimersByTimeAsync(50);
      await timedOutExpectation;

      const abortController = new AbortController();
      const aborted = service.snapshot({
        signal: abortController.signal,
        threadId: SNAPSHOT.threadId,
      });
      abortController.abort();
      await expect(aborted).rejects.toMatchObject({ name: "AbortError" });

      const next = service.snapshot({ threadId: SNAPSHOT.threadId });
      expect(controller.command().command.commandId).toBeDefined();
      service.releaseController(controller);
      await expect(next).rejects.toEqual(
        expectApiError("browser_connection_lost"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps a controller capture error and dispose to fail-closed errors", async () => {
    const service = createBrowserControlService();
    const { controller, grant } = grantController(service);
    const failed = service.snapshot({ threadId: SNAPSHOT.threadId });
    const command = controller.command();
    service.completeCommand({
      controller,
      message: {
        commandId: command.command.commandId,
        controllerId: grant.controllerId,
        generation: grant.generation,
        grantId: grant.grantId,
        outcome: { message: "capture failed", status: "error" },
        type: "browser-controller-complete",
      },
    });
    await expect(failed).rejects.toEqual(
      expectApiError("browser_capture_failed"),
    );

    const pending = service.snapshot({ threadId: SNAPSHOT.threadId });
    service.dispose();
    await expect(pending).rejects.toEqual(
      expectApiError("browser_connection_lost"),
    );
  });
});
