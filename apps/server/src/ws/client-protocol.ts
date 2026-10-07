import { clientMessageSchema, type PongMessage } from "@bb/domain";
import {
  browserControllerClientMessageSchema,
  type BrowserControllerConnectMessage,
  type BrowserControllerServerMessage,
} from "@bb/server-contract";
import type { BrowserControlService } from "../services/browser/browser-control.js";
import { decodeSocketPayload } from "./decode-payload.js";
import type { NotificationHub } from "./hub.js";
import type { WatchInterestCoordinator } from "./watch-interests.js";

const PONG_MESSAGE: PongMessage = { type: "pong" };

interface ClientSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

interface BrowserControllerProtocolDeps {
  authorizeConnect(message: BrowserControllerConnectMessage): void;
  service: BrowserControlService;
}

function sendBrowserControllerMessage(
  socket: ClientSocket,
  message: BrowserControllerServerMessage,
): void {
  socket.send(JSON.stringify(message));
}

export function onClientSocketOpen(
  hub: NotificationHub,
  socket: ClientSocket,
): void {
  hub.registerClient(socket);
}

export function onClientSocketMessage(
  deps: {
    browserController?: BrowserControllerProtocolDeps;
    hub: NotificationHub;
    watchInterests: Pick<
      WatchInterestCoordinator,
      "subscribe" | "unsubscribe" | "releaseSocket"
    >;
  },
  socket: ClientSocket,
  raw: unknown,
): void {
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeSocketPayload(raw));
  } catch {
    socket.close(1008, "invalid-message");
    return;
  }

  const browserMessage =
    browserControllerClientMessageSchema.safeParse(decoded);
  if (browserMessage.success) {
    const browserController = deps.browserController;
    if (browserController === undefined) {
      socket.close(1008, "invalid-message");
      return;
    }
    const message = browserMessage.data;
    try {
      switch (message.type) {
        case "browser-controller-connect":
          browserController.authorizeConnect(message);
          browserController.service.grant({
            controller: socket,
            request: message,
          });
          return;
        case "browser-controller-disconnect":
          browserController.service.revoke({
            controller: socket,
            controllerId: message.controllerId,
          });
          return;
        case "browser-controller-complete":
          browserController.service.completeCommand({
            controller: socket,
            message,
          });
          return;
      }
    } catch (error) {
      browserController.service.revoke({
        controller: socket,
        controllerId: message.controllerId,
      });
      sendBrowserControllerMessage(socket, {
        controllerId: message.controllerId,
        message: error instanceof Error ? error.message : String(error),
        type: "browser-controller-disconnected",
      });
      return;
    }
  }

  const result = clientMessageSchema.safeParse(decoded);
  if (!result.success) {
    socket.close(1008, "invalid-message");
    return;
  }
  const parsed = result.data;

  switch (parsed.type) {
    case "subscribe":
      deps.hub.subscribe(socket, parsed.target);
      deps.watchInterests.subscribe(socket, parsed.target);
      break;
    case "unsubscribe":
      deps.hub.unsubscribe(socket, parsed.target);
      deps.watchInterests.unsubscribe(socket, parsed.target);
      break;
    case "ping":
      // Liveness probe (browsers cannot send WebSocket-level pings). Answered
      // on this socket only; nothing is broadcast and no state is touched.
      socket.send(JSON.stringify(PONG_MESSAGE));
      break;
    default: {
      const _exhaustive: never = parsed;
      throw new Error(`Unhandled client message: ${_exhaustive}`);
    }
  }
}

export function onClientSocketClose(
  deps: {
    browserControl?: BrowserControlService;
    hub: NotificationHub;
    watchInterests: Pick<WatchInterestCoordinator, "releaseSocket">;
  },
  socket: ClientSocket,
): void {
  deps.browserControl?.releaseController(socket);
  deps.watchInterests.releaseSocket(socket);
  deps.hub.unregisterClient(socket);
}
