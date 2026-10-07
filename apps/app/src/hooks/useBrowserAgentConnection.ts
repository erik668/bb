import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BbDesktopBrowserApi,
  BbDesktopBrowserCapture,
} from "@bb/desktop-contract";
import type {
  BrowserControllerCommandMessage,
  BrowserControllerServerMessage,
  BrowserGrant,
} from "@bb/server-contract";
import { toast } from "sonner";
import { wsManager } from "@/lib/ws";

export type BrowserAgentConnectionState =
  | "disconnected"
  | "connecting"
  | "connected";

interface UseBrowserAgentConnectionArgs {
  desktopBrowser: BbDesktopBrowserApi | null;
  enabled: boolean;
  tabId: string;
  threadId: string;
}

interface BrowserAgentConnection {
  state: BrowserAgentConnectionState;
  toggle(): Promise<void>;
}

function browserSnapshot(args: {
  capture: BbDesktopBrowserCapture;
  tabId: string;
  threadId: string;
}) {
  return {
    ...args.capture,
    tabId: args.tabId,
    threadId: args.threadId,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The browser sharing connection was lost.";
}

export function useBrowserAgentConnection({
  desktopBrowser,
  enabled,
  tabId,
  threadId,
}: UseBrowserAgentConnectionArgs): BrowserAgentConnection {
  const [state, setState] =
    useState<BrowserAgentConnectionState>("disconnected");
  const controllerIdRef = useRef<string | null>(null);
  const grantRef = useRef<BrowserGrant | null>(null);
  const mountedRef = useRef(true);

  const disconnect = useCallback(async (updateState: boolean) => {
    const controllerId = controllerIdRef.current;
    controllerIdRef.current = null;
    grantRef.current = null;
    if (controllerId !== null) {
      wsManager.sendBrowserController({
        controllerId,
        type: "browser-controller-disconnect",
      });
    }
    if (updateState && mountedRef.current) setState("disconnected");
  }, []);

  const failConnection = useCallback(
    (message: string) => {
      void disconnect(true);
      if (mountedRef.current) {
        toast.error("Browser tab is no longer shared", {
          description: message,
        });
      }
    },
    [disconnect],
  );

  const completeCapture = useCallback(
    async (message: BrowserControllerCommandMessage) => {
      let outcome;
      try {
        if (desktopBrowser?.capturePage === undefined) {
          throw new Error("This desktop version cannot capture browser tabs");
        }
        const capture = await desktopBrowser.capturePage(tabId);
        outcome = {
          snapshot: browserSnapshot({ capture, tabId, threadId }),
          status: "success" as const,
        };
      } catch (error) {
        outcome = {
          message: errorMessage(error),
          status: "error" as const,
        };
      }
      if (
        controllerIdRef.current !== message.controllerId ||
        grantRef.current?.grantId !== message.grantId
      ) {
        return;
      }
      const sent = wsManager.sendBrowserController({
        commandId: message.command.commandId,
        controllerId: message.controllerId,
        generation: message.generation,
        grantId: message.grantId,
        outcome,
        type: "browser-controller-complete",
      });
      if (!sent) failConnection("The BB connection closed during capture.");
    },
    [desktopBrowser, failConnection, tabId, threadId],
  );

  useEffect(() => {
    return wsManager.onBrowserController(
      (message: BrowserControllerServerMessage) => {
        const controllerId = controllerIdRef.current;
        if (controllerId === null) return;
        const messageControllerId =
          message.type === "browser-controller-connected"
            ? message.grant.controllerId
            : message.controllerId;
        if (messageControllerId !== controllerId) return;

        if (message.type === "browser-controller-disconnected") {
          failConnection(message.message);
          return;
        }
        if (message.type === "browser-controller-connected") {
          if (
            message.grant.tabId !== tabId ||
            message.grant.threadId !== threadId
          ) {
            failConnection("The browser grant targeted a different tab.");
            return;
          }
          grantRef.current = message.grant;
          setState("connected");
          return;
        }
        const grant = grantRef.current;
        if (
          grant === null ||
          grant.grantId !== message.grantId ||
          grant.generation !== message.generation
        ) {
          failConnection("The browser command used a stale grant.");
          return;
        }
        void completeCapture(message);
      },
    );
  }, [completeCapture, failConnection, tabId, threadId]);

  useEffect(() => {
    return wsManager.onConnectionStateChange(() => {
      if (
        wsManager.getConnectionState() !== "connected" &&
        controllerIdRef.current !== null
      ) {
        failConnection("The BB connection closed. Share the tab again.");
      }
    });
  }, [failConnection]);

  const connect = useCallback(async () => {
    if (!enabled || desktopBrowser?.capturePage === undefined) return;
    const controllerId = crypto.randomUUID();
    controllerIdRef.current = controllerId;
    grantRef.current = null;
    setState("connecting");
    const sent = wsManager.sendBrowserController({
      controllerId,
      tabId,
      threadId,
      type: "browser-controller-connect",
    });
    if (!sent) {
      controllerIdRef.current = null;
      setState("disconnected");
      toast.error("Could not share this browser tab", {
        description: "BB is reconnecting. Try again in a moment.",
      });
    }
  }, [desktopBrowser, enabled, tabId, threadId]);

  const toggle = useCallback(async () => {
    if (state === "connected") {
      await disconnect(true);
      return;
    }
    if (state === "disconnected") await connect();
  }, [connect, disconnect, state]);

  useEffect(() => {
    if (!enabled) void disconnect(true);
  }, [disconnect, enabled]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void disconnect(false);
    };
  }, [disconnect, tabId, threadId]);

  return { state, toggle };
}
