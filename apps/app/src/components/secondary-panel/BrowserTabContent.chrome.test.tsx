// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  BbDesktopBrowserApi,
  BbDesktopBrowserState,
} from "@bb/desktop-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBbDesktopApi,
  createNoopDesktopBrowserApi,
} from "@/test/bb-desktop-test-utils";
import { BrowserTabContent } from "./BrowserTabContent";

const browserControlMock = vi.hoisted(() => ({
  callbacks: new Set<(message: unknown) => void>(),
  connectionCallbacks: new Set<() => void>(),
  connectionState: "connected",
  send: vi.fn((_message: unknown) => true),
}));

vi.mock("@/lib/ws", () => ({
  wsManager: {
    onBrowserController(callback: (message: unknown) => void) {
      browserControlMock.callbacks.add(callback);
      return () => browserControlMock.callbacks.delete(callback);
    },
    onConnectionStateChange(callback: () => void) {
      browserControlMock.connectionCallbacks.add(callback);
      return () => browserControlMock.connectionCallbacks.delete(callback);
    },
    getConnectionState() {
      return browserControlMock.connectionState;
    },
    sendBrowserController: browserControlMock.send,
  },
}));

function emitBrowserController(message: unknown): void {
  for (const callback of browserControlMock.callbacks) callback(message);
}

function emitServerConnectionState(
  state: "connected" | "connecting" | "reconnecting",
): void {
  browserControlMock.connectionState = state;
  for (const callback of browserControlMock.connectionCallbacks) callback();
}

const desktopInfo = {
  lastCheckedAt: null,
  latestVersion: null,
  pendingVersion: null,
  platform: "macos" as const,
  updateAvailable: false,
  updateDownloaded: false,
  version: "0.0.0-test",
};

interface BrowserChromeHarness {
  api: BbDesktopBrowserApi;
  capturePage: ReturnType<typeof vi.fn>;
  emitState: (state: BbDesktopBrowserState) => void;
  emitNativeFocus: (tabId: string) => void;
  focus: ReturnType<typeof vi.fn>;
  goBack: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function createBrowserChromeHarness(): BrowserChromeHarness {
  const stateListeners = new Set<(state: BbDesktopBrowserState) => void>();
  const focusListeners = new Set<(tabId: string) => void>();
  const focus = vi.fn();
  const goBack = vi.fn();
  const stop = vi.fn();
  const capturePage = vi.fn(async () => ({
    data: Buffer.from("jpeg-bytes").toString("base64"),
    height: 480,
    mimeType: "image/jpeg" as const,
    url: "https://example.com/docs",
    width: 640,
  }));
  const api: BbDesktopBrowserApi = {
    ...createNoopDesktopBrowserApi(),
    capturePage,
    goBack,
    focus,
    stop,
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onFocus(listener) {
      focusListeners.add(listener);
      return () => focusListeners.delete(listener);
    },
  };
  return {
    api,
    capturePage,
    emitState(state) {
      for (const listener of stateListeners) listener(state);
    },
    emitNativeFocus(tabId) {
      for (const listener of focusListeners) listener(tabId);
    },
    focus,
    goBack,
    stop,
  };
}

function browserState(
  overrides: Partial<BbDesktopBrowserState> = {},
): BbDesktopBrowserState {
  return {
    tabId: "browser:test",
    url: "https://example.com/docs",
    title: "Example docs",
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    errorText: null,
    ...overrides,
  };
}

function renderBrowserChrome(
  harness: BrowserChromeHarness,
  initialUrl = "",
  options: {
    canHandleBrowserCommands?: boolean;
    canShowNativeBrowserView?: boolean;
    browserAgentControlEnabled?: boolean;
    onNativeFocus?: () => void;
  } = {},
) {
  window.bbDesktop = createBbDesktopApi(desktopInfo, harness.api);
  return render(
    <>
      <BrowserTabContent
        browserAgentControlEnabled={options.browserAgentControlEnabled ?? true}
        tabId="browser:test"
        initialUrl={initialUrl}
        addressFocusRequest={null}
        canHandleBrowserCommands={options.canHandleBrowserCommands}
        canShowNativeBrowserView={options.canShowNativeBrowserView ?? false}
        onNativeFocus={options.onNativeFocus}
        visibilityCoordinator={null}
        environmentId={null}
        threadId="thread-1"
        onUpdate={() => {}}
      />
      <button type="button">Outside browser</button>
    </>,
  );
}

function expectChromeVisible(): HTMLElement {
  const chrome = screen.getByTestId("browser-tab-nav-bar");
  expect(chrome.dataset.state).toBe("expanded");
  return chrome;
}

describe("BrowserTabContent persistent navigation", () => {
  beforeEach(() => {
    browserControlMock.callbacks.clear();
    browserControlMock.connectionCallbacks.clear();
    browserControlMock.connectionState = "connected";
    browserControlMock.send.mockReset();
    browserControlMock.send.mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
    delete window.bbDesktop;
  });

  it("keeps the top navigation visible through pointer and focus changes", () => {
    const harness = createBrowserChromeHarness();
    renderBrowserChrome(harness, "https://example.com/docs");
    const chrome = expectChromeVisible();

    fireEvent.pointerLeave(chrome);
    act(() => screen.getByRole("button", { name: "Outside browser" }).focus());
    expectChromeVisible();
    expect(screen.getByLabelText("Address and search bar")).not.toBeNull();
  });

  it("keeps navigation visible while loading and preserves the stop action", () => {
    const harness = createBrowserChromeHarness();
    renderBrowserChrome(harness, "https://example.com/docs");

    act(() => harness.emitState(browserState({ isLoading: true })));
    expectChromeVisible();

    const stopButton = screen.getByRole("button", { name: "Stop loading" });
    fireEvent.click(stopButton);
    expect(harness.stop).toHaveBeenCalledWith("browser:test");
  });

  it("preserves browser navigation actions", () => {
    const harness = createBrowserChromeHarness();
    renderBrowserChrome(harness, "https://example.com/docs");
    expectChromeVisible();

    act(() => harness.emitState(browserState({ canGoBack: true })));
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(harness.goBack).toHaveBeenCalledWith("browser:test");
  });

  it("restores native focus to the logical pane and reports page focus", async () => {
    const harness = createBrowserChromeHarness();
    const onNativeFocus = vi.fn();
    renderBrowserChrome(harness, "https://example.com/docs", {
      canHandleBrowserCommands: true,
      canShowNativeBrowserView: true,
      onNativeFocus,
    });

    await waitFor(() =>
      expect(harness.focus).toHaveBeenCalledWith("browser:test"),
    );
    act(() => harness.emitNativeFocus("browser:other"));
    expect(onNativeFocus).not.toHaveBeenCalled();
    act(() => harness.emitNativeFocus("browser:test"));
    expect(onNativeFocus).toHaveBeenCalledTimes(1);
  });

  it("shares only after an explicit toolbar grant and revokes from the same control", async () => {
    const harness = createBrowserChromeHarness();
    renderBrowserChrome(harness, "https://example.com/docs", {
      canShowNativeBrowserView: true,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Share this tab with agents" }),
    );

    const connectMessage = browserControlMock.send.mock.calls[0]?.[0];
    expect(connectMessage).toMatchObject({
      controllerId: expect.any(String),
      tabId: "browser:test",
      threadId: "thread-1",
      type: "browser-controller-connect",
    });
    if (
      typeof connectMessage !== "object" ||
      connectMessage === null ||
      !("controllerId" in connectMessage) ||
      typeof connectMessage.controllerId !== "string"
    ) {
      throw new Error("Expected controller identity");
    }
    const grant = {
      controllerId: connectMessage.controllerId,
      generation: 1,
      grantId: "bgr_test",
      tabId: "browser:test",
      threadId: "thread-1",
    };
    act(() =>
      emitBrowserController({
        grant,
        type: "browser-controller-connected",
      }),
    );

    await waitFor(() => {
      expect(
        screen
          .getByRole("button", {
            name: "Stop sharing this tab with agents",
          })
          .getAttribute("aria-pressed"),
      ).toBe("true");
    });
    act(() =>
      emitBrowserController({
        command: { commandId: "bcmd_test", type: "snapshot" },
        controllerId: grant.controllerId,
        generation: grant.generation,
        grantId: grant.grantId,
        type: "browser-controller-command",
      }),
    );
    await waitFor(() => expect(harness.capturePage).toHaveBeenCalledTimes(1));
    expect(browserControlMock.send).toHaveBeenCalledWith({
      commandId: "bcmd_test",
      controllerId: grant.controllerId,
      generation: 1,
      grantId: "bgr_test",
      outcome: {
        snapshot: {
          data: Buffer.from("jpeg-bytes").toString("base64"),
          height: 480,
          mimeType: "image/jpeg",
          tabId: "browser:test",
          threadId: "thread-1",
          url: "https://example.com/docs",
          width: 640,
        },
        status: "success",
      },
      type: "browser-controller-complete",
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Stop sharing this tab with agents",
      }),
    );
    await waitFor(() =>
      expect(browserControlMock.send).toHaveBeenCalledWith({
        controllerId: grant.controllerId,
        type: "browser-controller-disconnect",
      }),
    );
    expect(
      screen
        .getByRole("button", { name: "Share this tab with agents" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("keeps the rollout surface absent while the browser-control plugin is disabled", () => {
    const harness = createBrowserChromeHarness();
    renderBrowserChrome(harness, "https://example.com/docs", {
      browserAgentControlEnabled: false,
      canShowNativeBrowserView: true,
    });

    expect(
      screen.queryByRole("button", { name: "Share this tab with agents" }),
    ).toBeNull();
  });

  it("keeps sharing disabled until a visible tab has a page", () => {
    const harness = createBrowserChromeHarness();
    renderBrowserChrome(harness, "", { canShowNativeBrowserView: true });

    expect(
      screen
        .getByRole("button", { name: "Share this tab with agents" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("returns capture failures through the owning controller message", async () => {
    const harness = createBrowserChromeHarness();
    harness.capturePage.mockRejectedValueOnce(new Error("capture unavailable"));
    renderBrowserChrome(harness, "https://example.com/docs", {
      canShowNativeBrowserView: true,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Share this tab with agents" }),
    );
    const connect = browserControlMock.send.mock.calls[0]?.[0] as {
      controllerId: string;
    };
    const grant = {
      controllerId: connect.controllerId,
      generation: 1,
      grantId: "bgr_test",
      tabId: "browser:test",
      threadId: "thread-1",
    };
    act(() =>
      emitBrowserController({
        grant,
        type: "browser-controller-connected",
      }),
    );
    act(() =>
      emitBrowserController({
        command: { commandId: "bcmd_failure", type: "snapshot" },
        controllerId: grant.controllerId,
        generation: grant.generation,
        grantId: grant.grantId,
        type: "browser-controller-command",
      }),
    );

    await waitFor(() =>
      expect(browserControlMock.send).toHaveBeenCalledWith({
        commandId: "bcmd_failure",
        controllerId: grant.controllerId,
        generation: grant.generation,
        grantId: grant.grantId,
        outcome: { message: "capture unavailable", status: "error" },
        type: "browser-controller-complete",
      }),
    );
  });

  it("revokes a connected grant when the browser tab unmounts", async () => {
    const harness = createBrowserChromeHarness();
    const rendered = renderBrowserChrome(harness, "https://example.com/docs", {
      canShowNativeBrowserView: true,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Share this tab with agents" }),
    );
    const connect = browserControlMock.send.mock.calls[0]?.[0] as {
      controllerId: string;
    };
    act(() =>
      emitBrowserController({
        grant: {
          controllerId: connect.controllerId,
          generation: 1,
          grantId: "bgr_test",
          tabId: "browser:test",
          threadId: "thread-1",
        },
        type: "browser-controller-connected",
      }),
    );

    rendered.unmount();

    expect(browserControlMock.send).toHaveBeenCalledWith({
      controllerId: connect.controllerId,
      type: "browser-controller-disconnect",
    });
  });

  it("fails closed when the owning WebSocket disconnects and does not regrant on reconnect", async () => {
    const harness = createBrowserChromeHarness();
    renderBrowserChrome(harness, "https://example.com/docs", {
      canShowNativeBrowserView: true,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Share this tab with agents" }),
    );
    const connect = browserControlMock.send.mock.calls[0]?.[0] as {
      controllerId: string;
    };
    act(() =>
      emitBrowserController({
        grant: {
          controllerId: connect.controllerId,
          generation: 1,
          grantId: "bgr_test",
          tabId: "browser:test",
          threadId: "thread-1",
        },
        type: "browser-controller-connected",
      }),
    );
    expect(
      screen.getByRole("button", {
        name: "Stop sharing this tab with agents",
      }),
    ).not.toBeNull();

    act(() => emitServerConnectionState("reconnecting"));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Share this tab with agents" }),
      ).not.toBeNull(),
    );
    expect(browserControlMock.send).toHaveBeenCalledWith({
      controllerId: connect.controllerId,
      type: "browser-controller-disconnect",
    });

    act(() => emitServerConnectionState("connected"));
    expect(
      screen.getByRole("button", { name: "Share this tab with agents" }),
    ).not.toBeNull();
    expect(
      browserControlMock.send.mock.calls.filter(
        ([message]) =>
          (message as { type?: string }).type === "browser-controller-connect",
      ),
    ).toHaveLength(1);
  });
});
