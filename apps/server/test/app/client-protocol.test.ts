import { describe, expect, it, vi } from "vitest";
import {
  onClientSocketClose,
  onClientSocketMessage,
  onClientSocketOpen,
} from "../../src/ws/client-protocol.js";
import {
  createBrowserControlService,
  type BrowserControlService,
} from "../../src/services/browser/browser-control.js";
import { NotificationHub } from "../../src/ws/hub.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";

function createProtocolDeps(hub: NotificationHub) {
  return {
    hub,
    watchInterests: {
      releaseSocket: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    },
  };
}

function createBrowserControlMock(): BrowserControlService {
  return {
    completeCommand: vi.fn(),
    dispose: vi.fn(),
    grant: vi.fn(),
    releaseController: vi.fn(),
    revoke: vi.fn(),
    snapshot: vi.fn(),
  };
}

describe("client websocket protocol", () => {
  it("subscribes valid client messages parsed through the shared schema", () => {
    const hub = new NotificationHub();
    const deps = createProtocolDeps(hub);
    const socket = createMockHubSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        type: "subscribe",
        target: { kind: "thread-detail", threadId: "thread-1" },
      }),
    );
    hub.notifyThread("thread-1", ["events-appended"]);

    expect(socket.closed).toHaveLength(0);
    expect(socket.messages).toHaveLength(1);
    expect(JSON.parse(socket.messages[0])).toMatchObject({
      type: "changed",
      entity: "thread",
      id: "thread-1",
      changes: ["events-appended"],
    });
  });

  it("rejects subscribe messages whose target id is not a string", () => {
    const hub = new NotificationHub();
    const deps = createProtocolDeps(hub);
    const socket = createMockHubSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        type: "subscribe",
        target: { kind: "thread-detail", threadId: 123 },
      }),
    );
    hub.notifyThread("thread-1", ["events-appended"]);

    expect(socket.closed).toEqual([{ code: 1008, reason: "invalid-message" }]);
    expect(socket.messages).toHaveLength(0);
  });

  it("removes subscriptions after unsubscribe messages", () => {
    const hub = new NotificationHub();
    const deps = createProtocolDeps(hub);
    const socket = createMockHubSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        type: "subscribe",
        target: { kind: "thread-detail", threadId: "thread-1" },
      }),
    );
    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        type: "unsubscribe",
        target: { kind: "thread-detail", threadId: "thread-1" },
      }),
    );
    hub.notifyThread("thread-1", ["events-appended"]);

    expect(socket.closed).toHaveLength(0);
    expect(socket.messages).toHaveLength(0);
  });

  it("rejects subscribe messages for unknown targets", () => {
    const hub = new NotificationHub();
    const deps = createProtocolDeps(hub);
    const socket = createMockHubSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        type: "subscribe",
        target: { kind: "bogus" },
      }),
    );

    expect(socket.closed).toEqual([{ code: 1008, reason: "invalid-message" }]);
    expect(socket.messages).toHaveLength(0);
  });

  it("rejects client messages with missing required fields", () => {
    const hub = new NotificationHub();
    const deps = createProtocolDeps(hub);
    const socket = createMockHubSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        type: "subscribe",
      }),
    );

    expect(socket.closed).toEqual([{ code: 1008, reason: "invalid-message" }]);
    expect(socket.messages).toHaveLength(0);
  });

  it("closes the socket instead of throwing on malformed JSON", () => {
    const hub = new NotificationHub();
    const deps = createProtocolDeps(hub);
    const socket = createMockHubSocket();

    onClientSocketOpen(hub, socket);

    expect(() => onClientSocketMessage(deps, socket, "{")).not.toThrow();
    expect(socket.closed).toEqual([{ code: 1008, reason: "invalid-message" }]);
  });

  it("updates watch interests from subscribe and unsubscribe messages", () => {
    const hub = new NotificationHub();
    const deps = createProtocolDeps(hub);
    const socket = createMockHubSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        type: "subscribe",
        target: { kind: "environment-detail", environmentId: "env-1" },
      }),
    );
    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        type: "unsubscribe",
        target: { kind: "environment-detail", environmentId: "env-1" },
      }),
    );

    expect(deps.watchInterests.subscribe).toHaveBeenCalledWith(socket, {
      kind: "environment-detail",
      environmentId: "env-1",
    });
    expect(deps.watchInterests.unsubscribe).toHaveBeenCalledWith(socket, {
      kind: "environment-detail",
      environmentId: "env-1",
    });
  });

  it("answers a ping with a pong on the same socket only", () => {
    const hub = new NotificationHub();
    const deps = createProtocolDeps(hub);
    const socket = createMockHubSocket();
    const otherSocket = createMockHubSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketOpen(hub, otherSocket);
    onClientSocketMessage(deps, socket, JSON.stringify({ type: "ping" }));

    expect(socket.closed).toHaveLength(0);
    expect(socket.messages.map((message) => JSON.parse(message))).toEqual([
      { type: "pong" },
    ]);
    expect(otherSocket.messages).toHaveLength(0);
    expect(deps.watchInterests.subscribe).not.toHaveBeenCalled();
  });

  it("rejects direct watch messages", () => {
    const hub = new NotificationHub();
    const deps = createProtocolDeps(hub);
    const socket = createMockHubSocket();

    onClientSocketOpen(hub, socket);
    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        type: "watch.acquire",
        target: {
          kind: "environment-workspace",
          environmentId: "env-1",
        },
      }),
    );

    expect(socket.closed).toEqual([{ code: 1008, reason: "invalid-message" }]);
    expect(deps.watchInterests.subscribe).not.toHaveBeenCalled();
  });

  it("binds browser controller lifecycle messages to the exact app socket", () => {
    const hub = new NotificationHub();
    const baseDeps = createProtocolDeps(hub);
    const service = createBrowserControlMock();
    const authorizeConnect = vi.fn();
    const deps = {
      ...baseDeps,
      browserController: { authorizeConnect, service },
    };
    const socket = createMockHubSocket();
    const connect = {
      controllerId: "controller:test",
      tabId: "browser:test",
      threadId: "thread:test",
      type: "browser-controller-connect" as const,
    };

    onClientSocketMessage(deps, socket, JSON.stringify(connect));

    expect(authorizeConnect).toHaveBeenCalledWith(connect);
    expect(service.grant).toHaveBeenCalledWith({
      controller: socket,
      request: connect,
    });

    const complete = {
      commandId: "bcmd_test",
      controllerId: connect.controllerId,
      generation: 2,
      grantId: "bgr_test",
      outcome: {
        snapshot: {
          data: Buffer.from("jpeg").toString("base64"),
          height: 480,
          mimeType: "image/jpeg" as const,
          tabId: connect.tabId,
          threadId: connect.threadId,
          url: "https://example.com/current",
          width: 640,
        },
        status: "success" as const,
      },
      type: "browser-controller-complete" as const,
    };
    onClientSocketMessage(deps, socket, JSON.stringify(complete));
    expect(service.completeCommand).toHaveBeenCalledWith({
      controller: socket,
      message: complete,
    });

    onClientSocketClose({ ...baseDeps, browserControl: service }, socket);
    expect(service.releaseController).toHaveBeenCalledWith(socket);
  });

  it("rejects controller messages on a socket without the trusted browser protocol", () => {
    const hub = new NotificationHub();
    const deps = createProtocolDeps(hub);
    const socket = createMockHubSocket();

    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        controllerId: "controller:test",
        tabId: "browser:test",
        threadId: "thread:test",
        type: "browser-controller-connect",
      }),
    );

    expect(socket.closed).toEqual([{ code: 1008, reason: "invalid-message" }]);
  });

  it("revokes and reports an authorization failure without accepting the grant", () => {
    const hub = new NotificationHub();
    const baseDeps = createProtocolDeps(hub);
    const service = createBrowserControlMock();
    const deps = {
      ...baseDeps,
      browserController: {
        authorizeConnect: vi.fn(() => {
          throw new Error("Browser Control is disabled");
        }),
        service,
      },
    };
    const socket = createMockHubSocket();

    onClientSocketMessage(
      deps,
      socket,
      JSON.stringify({
        controllerId: "controller:test",
        tabId: "browser:test",
        threadId: "thread:test",
        type: "browser-controller-connect",
      }),
    );

    expect(service.grant).not.toHaveBeenCalled();
    expect(service.revoke).toHaveBeenCalledWith({
      controller: socket,
      controllerId: "controller:test",
    });
    expect(socket.messages.map((message) => JSON.parse(message))).toEqual([
      {
        controllerId: "controller:test",
        message: "Browser Control is disabled",
        type: "browser-controller-disconnected",
      },
    ]);
  });

  it("round-trips a snapshot only through the socket that owns the grant", async () => {
    const hub = new NotificationHub();
    const baseDeps = createProtocolDeps(hub);
    const service = createBrowserControlService();
    const deps = {
      ...baseDeps,
      browserController: { authorizeConnect: vi.fn(), service },
    };
    const owner = createMockHubSocket();
    const other = createMockHubSocket();
    const connect = {
      controllerId: "controller:owner",
      tabId: "browser:visible",
      threadId: "thread:test",
      type: "browser-controller-connect" as const,
    };
    onClientSocketMessage(deps, owner, JSON.stringify(connect));
    const connected = JSON.parse(owner.messages[0] ?? "null") as {
      grant: { generation: number; grantId: string };
    };

    const pending = service.snapshot({ threadId: connect.threadId });
    const command = JSON.parse(owner.messages[1] ?? "null") as {
      command: { commandId: string };
    };
    const snapshot = {
      data: Buffer.from("jpeg").toString("base64"),
      height: 480,
      mimeType: "image/jpeg" as const,
      tabId: connect.tabId,
      threadId: connect.threadId,
      url: "https://example.com/current",
      width: 640,
    };
    const completion = {
      commandId: command.command.commandId,
      controllerId: connect.controllerId,
      generation: connected.grant.generation,
      grantId: connected.grant.grantId,
      outcome: { snapshot, status: "success" as const },
      type: "browser-controller-complete" as const,
    };

    onClientSocketMessage(deps, other, JSON.stringify(completion));
    expect(JSON.parse(other.messages[0] ?? "null")).toMatchObject({
      controllerId: connect.controllerId,
      type: "browser-controller-disconnected",
    });

    onClientSocketMessage(deps, owner, JSON.stringify(completion));
    await expect(pending).resolves.toEqual(snapshot);
  });
});
