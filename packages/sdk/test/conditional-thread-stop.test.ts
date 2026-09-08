import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { publicApiRoutes, typedRoutes } from "@bb/server-contract";
import { createBbSdk } from "../src/core.js";
import { createHttpTransport } from "../src/transport-http.js";
import type { FetchImplementation } from "../src/response.js";

describe("conditional thread stop transport", () => {
  it.each([
    { status: "stopped", expectedTurnId: "turn/original" },
    {
      status: "refused",
      expectedTurnId: "turn/original",
      reason: "turn-mismatch",
      activeTurnId: "turn-replacement",
    },
  ])("preserves the server result: $status", async (condition) => {
    const fetch = vi.fn<FetchImplementation>(async () =>
      Response.json({ ok: true, condition }),
    );
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch,
        runtime: "node",
      }),
    });
    await expect(
      sdk.threads.stop({ threadId: "thr_1", expectedTurnId: "turn/original" }),
    ).resolves.toEqual({ ok: true, condition });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe(
      "/api/v1/threads/thr_1/stop-if-current",
    );
    expect(new URL(String(url)).searchParams.get("expectedTurnId")).toBe(
      "turn/original",
    );
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
  });

  it.each([
    { ok: true },
    {
      ok: true,
      condition: { status: "stopped", expectedTurnId: "turn-other" },
    },
  ])("does not promote absent or mismatched proof to stopped", async (body) => {
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        runtime: "node",
        fetch: async () => Response.json(body),
      }),
    });
    await expect(
      sdk.threads.stop({ threadId: "thr_1", expectedTurnId: "turn-original" }),
    ).resolves.toEqual({
      ok: true,
      condition: {
        status: "refused",
        expectedTurnId: "turn-original",
        reason: "unproven",
        activeTurnId: null,
      },
    });
  });

  it("refuses an older server without invoking its unconditional stop handler", async () => {
    const app = new Hono().basePath("/api/v1");
    let activeTurnId: string | null = "turn-replacement";
    const legacyStop = vi.fn();
    typedRoutes(app).post(publicApiRoutes.threads.stop, (context) => {
      legacyStop(context.req.param("id"));
      activeTurnId = null;
      return context.json({ ok: true });
    });
    const fetch = vi.fn<FetchImplementation>(async (input, init) =>
      app.fetch(new Request(input, init)),
    );
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch,
        runtime: "node",
      }),
    });

    await expect(
      sdk.threads.stop({ threadId: "thr_1", expectedTurnId: "turn-original" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(legacyStop).not.toHaveBeenCalled();
    expect(activeTurnId).toBe("turn-replacement");

    await expect(sdk.threads.stop({ threadId: "thr_1" })).resolves.toEqual({
      ok: true,
    });
    expect(legacyStop).toHaveBeenCalledExactlyOnceWith("thr_1");
    expect(activeTurnId).toBeNull();
  });

  it("rejects malformed proof and preserves the bodyless legacy stop", async () => {
    const fetch = vi
      .fn<FetchImplementation>()
      .mockResolvedValueOnce(
        Response.json({ ok: true, condition: { status: "stopped" } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const sdk = createBbSdk({
      transport: createHttpTransport({
        baseUrl: "http://bb.test",
        fetch,
        runtime: "node",
      }),
    });
    await expect(
      sdk.threads.stop({ threadId: "thr_1", expectedTurnId: "turn-original" }),
    ).rejects.toThrow();
    await expect(sdk.threads.stop({ threadId: "thr_1" })).resolves.toEqual({
      ok: true,
    });
    const [url, init] = fetch.mock.calls[1]!;
    expect(new URL(String(url)).pathname).toBe("/api/v1/threads/thr_1/stop");
    expect(new URL(String(url)).search).toBe("");
    expect(init?.body).toBeUndefined();
  });
});
