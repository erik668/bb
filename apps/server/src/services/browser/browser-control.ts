import { randomUUID } from "node:crypto";
import type {
  BrowserControllerCompleteMessage,
  BrowserControllerServerMessage,
  BrowserGrant,
  BrowserGrantRequest,
  BrowserSnapshot,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";

export const BROWSER_SNAPSHOT_TIMEOUT_MS = 20_000;

export interface BrowserControllerConnection {
  send(data: string): void;
}

interface BrowserCommandState {
  abortCleanup: (() => void) | null;
  commandId: string;
  reject: (error: unknown) => void;
  resolve: (snapshot: BrowserSnapshot) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface BrowserGrantState extends BrowserGrant {
  command: BrowserCommandState | null;
  controller: BrowserControllerConnection;
}

interface BrowserControlServiceOptions {
  snapshotTimeoutMs?: number;
}

export interface BrowserControlService {
  completeCommand(args: {
    controller: BrowserControllerConnection;
    message: BrowserControllerCompleteMessage;
  }): void;
  dispose(): void;
  grant(args: {
    controller: BrowserControllerConnection;
    request: BrowserGrantRequest;
  }): BrowserGrant;
  releaseController(controller: BrowserControllerConnection): void;
  revoke(args: {
    controller: BrowserControllerConnection;
    controllerId: string;
  }): void;
  snapshot(args: {
    signal?: AbortSignal;
    threadId: string;
  }): Promise<BrowserSnapshot>;
}

function abortError(): DOMException {
  return new DOMException(
    "The browser control request was aborted",
    "AbortError",
  );
}

export function createBrowserControlService(
  options: BrowserControlServiceOptions = {},
): BrowserControlService {
  const snapshotTimeoutMs =
    options.snapshotTimeoutMs ?? BROWSER_SNAPSHOT_TIMEOUT_MS;
  const grantsById = new Map<string, BrowserGrantState>();
  const grantIdByThread = new Map<string, string>();
  const generationByThread = new Map<string, number>();

  function sendControllerMessage(
    controller: BrowserControllerConnection,
    message: BrowserControllerServerMessage,
  ): void {
    controller.send(JSON.stringify(message));
  }

  function clearCommand(grant: BrowserGrantState): BrowserCommandState | null {
    const command = grant.command;
    if (command === null) return null;
    grant.command = null;
    clearTimeout(command.timeout);
    command.abortCleanup?.();
    return command;
  }

  function revokeState(
    grant: BrowserGrantState,
    message: string,
    notifyController: boolean,
  ): void {
    if (grantsById.get(grant.grantId) !== grant) return;
    grantsById.delete(grant.grantId);
    if (grantIdByThread.get(grant.threadId) === grant.grantId) {
      grantIdByThread.delete(grant.threadId);
    }
    clearCommand(grant)?.reject(
      new ApiError(409, "browser_connection_lost", message),
    );
    if (!notifyController) return;
    try {
      sendControllerMessage(grant.controller, {
        controllerId: grant.controllerId,
        message,
        type: "browser-controller-disconnected",
      });
    } catch {
      // The socket is already unusable; server state is nevertheless revoked.
    }
  }

  function requireOwnedGrant(
    controller: BrowserControllerConnection,
    message: BrowserControllerCompleteMessage,
  ): BrowserGrantState {
    const grant = grantsById.get(message.grantId);
    if (
      grant === undefined ||
      grant.controller !== controller ||
      grant.controllerId !== message.controllerId ||
      grant.generation !== message.generation
    ) {
      throw new ApiError(
        403,
        "browser_controller_forbidden",
        "This browser controller grant is no longer valid",
      );
    }
    return grant;
  }

  return {
    grant({ controller, request }) {
      for (const grant of [...grantsById.values()]) {
        if (
          grant.controller === controller &&
          grant.controllerId === request.controllerId
        ) {
          revokeState(grant, "This browser connection was replaced", false);
        }
      }
      const previousGrantId = grantIdByThread.get(request.threadId);
      if (previousGrantId !== undefined) {
        const previous = grantsById.get(previousGrantId);
        if (previous !== undefined) {
          revokeState(
            previous,
            "Another browser tab replaced this connection",
            true,
          );
        }
      }
      const generation = (generationByThread.get(request.threadId) ?? 0) + 1;
      generationByThread.set(request.threadId, generation);
      const grant: BrowserGrantState = {
        command: null,
        controller,
        controllerId: request.controllerId,
        generation,
        grantId: `bgr_${randomUUID()}`,
        tabId: request.tabId,
        threadId: request.threadId,
      };
      grantsById.set(grant.grantId, grant);
      grantIdByThread.set(grant.threadId, grant.grantId);
      const publicGrant: BrowserGrant = {
        controllerId: grant.controllerId,
        generation: grant.generation,
        grantId: grant.grantId,
        tabId: grant.tabId,
        threadId: grant.threadId,
      };
      try {
        sendControllerMessage(controller, {
          grant: publicGrant,
          type: "browser-controller-connected",
        });
      } catch (error) {
        revokeState(grant, "The browser controller disconnected", false);
        throw error;
      }
      return publicGrant;
    },

    revoke({ controller, controllerId }) {
      for (const grant of [...grantsById.values()]) {
        if (
          grant.controller === controller &&
          grant.controllerId === controllerId
        ) {
          revokeState(grant, "Browser tab sharing was revoked", false);
        }
      }
    },

    releaseController(controller) {
      for (const grant of [...grantsById.values()]) {
        if (grant.controller === controller) {
          revokeState(grant, "The browser controller disconnected", false);
        }
      }
    },

    async snapshot({ signal, threadId }) {
      const grantId = grantIdByThread.get(threadId);
      const grant = grantId === undefined ? undefined : grantsById.get(grantId);
      if (grant === undefined) {
        throw new ApiError(
          409,
          "browser_not_connected",
          "No visible browser tab is shared with agents for this thread",
        );
      }
      if (grant.command !== null) {
        throw new ApiError(
          409,
          "browser_busy",
          "The shared browser tab is already handling a request",
        );
      }
      if (signal?.aborted) throw abortError();
      return new Promise<BrowserSnapshot>((resolve, reject) => {
        const commandState: BrowserCommandState = {
          abortCleanup: null,
          commandId: `bcmd_${randomUUID()}`,
          reject,
          resolve,
          timeout: setTimeout(() => {
            if (grant.command !== commandState) return;
            clearCommand(grant);
            reject(
              new ApiError(
                504,
                "browser_snapshot_timeout",
                "The shared browser tab did not return a screenshot in time",
                { retryable: true },
              ),
            );
          }, snapshotTimeoutMs),
        };
        if (signal !== undefined) {
          const onAbort = () => {
            if (grant.command !== commandState) return;
            clearCommand(grant);
            reject(abortError());
          };
          signal.addEventListener("abort", onAbort, { once: true });
          commandState.abortCleanup = () =>
            signal.removeEventListener("abort", onAbort);
        }
        grant.command = commandState;
        try {
          sendControllerMessage(grant.controller, {
            command: { commandId: commandState.commandId, type: "snapshot" },
            controllerId: grant.controllerId,
            generation: grant.generation,
            grantId: grant.grantId,
            type: "browser-controller-command",
          });
        } catch {
          revokeState(grant, "The browser controller disconnected", false);
        }
      });
    },

    completeCommand({ controller, message }) {
      const grant = requireOwnedGrant(controller, message);
      const command = grant.command;
      if (command === null || command.commandId !== message.commandId) {
        throw new ApiError(
          409,
          "browser_command_stale",
          "This browser command is no longer pending",
        );
      }
      if (
        message.outcome.status === "success" &&
        (message.outcome.snapshot.threadId !== grant.threadId ||
          message.outcome.snapshot.tabId !== grant.tabId)
      ) {
        throw new ApiError(
          409,
          "browser_command_target_mismatch",
          "The screenshot does not match the granted browser tab",
        );
      }
      const completed = clearCommand(grant);
      if (message.outcome.status === "error") {
        completed?.reject(
          new ApiError(502, "browser_capture_failed", message.outcome.message, {
            retryable: true,
          }),
        );
        return;
      }
      completed?.resolve(message.outcome.snapshot);
    },

    dispose() {
      for (const grant of [...grantsById.values()]) {
        revokeState(grant, "The BB server stopped", true);
      }
    },
  };
}
