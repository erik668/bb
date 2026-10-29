// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function rpcResult(body: unknown, init: ResponseInit = { status: 200 }) {
  return new Response(JSON.stringify(body), init);
}

describe("SideChatPanel", () => {
  const params = {
    threadId: "thr_fork",
    sourceThreadId: "thr_src",
    sourceMessageText: "the **anchor** message",
    sourceSeqEnd: 7,
  };

  it("send-to-main sends the message text to the source thread, queueing it if that thread is busy", async () => {
    const send = vi.fn(async () => ({ ok: true, delivery: "sent" }) as never);
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_src", environment: null, params },
      { rpc: {}, sdk: { threads: { send } } },
    );

    fireEvent.click(slot.getByTestId("bb-thread-chat-action-send-to-main"));

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith({
        threadId: "thr_src",
        mode: "queue-if-active",
        input: [{ type: "text", text: "test message text", mentions: [] }],
        senderThreadId: "thr_fork",
      });
    });
    expect(slot.rpcCalls).toEqual([]);
  });

  it("promotes the existing conversation and opens it as a primary chat", async () => {
    let resolvePromotion!: (response: Response) => void;
    const fetchMock = vi.fn(
      (_url: string, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          resolvePromotion = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_src", environment: null, params },
      { rpc: {} },
    );
    fireEvent.click(
      slot.getByRole("button", { name: "Promote to primary chat" }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/plugins/side-chat/rpc/promoteSideChat",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      threadId: "thr_fork",
    });
    expect(
      slot.getByRole("button", { name: "Promoting…" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(slot.inspection.navigateCalls).toEqual([]);
    resolvePromotion(rpcResult({ ok: true, result: { threadId: "thr_fork" } }));
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toEqual([
        { method: "toThread", threadId: "thr_fork" },
      ]),
    );
  });

  it("keeps the side chat usable and allows retry when promotion fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        rpcResult(
          { ok: false, error: { message: "Connection lost" } },
          { status: 500 },
        ),
      )
      .mockResolvedValue(
        rpcResult({ ok: true, result: { threadId: "thr_fork" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_src", environment: null, params },
      { rpc: {} },
    );
    fireEvent.click(
      slot.getByRole("button", { name: "Promote to primary chat" }),
    );
    expect((await slot.findByRole("alert")).textContent).toContain(
      "Connection lost",
    );
    expect(slot.inspection.navigateCalls).toEqual([]);
    expect(
      slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id"),
    ).toBe("thr_fork");
    fireEvent.click(
      slot.getByRole("button", { name: "Promote to primary chat" }),
    );
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toEqual([
        { method: "toThread", threadId: "thr_fork" },
      ]),
    );
  });

  it("reports a missing thread reference for malformed params", () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_src", environment: null, params: { bogus: true } },
      { rpc: {} },
    );
    expect(slot.getByRole("alert").textContent).toContain(
      "missing its thread reference",
    );
  });
});
