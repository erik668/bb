import { describe, expect, it } from "vitest";
import { bridgeCapabilitiesSchema } from "@bb/provider-bridge-protocol";
import { createBridgeProtocolAdapter } from "./bridge-protocol-adapter.js";

function makeAdapter(capabilities: Record<string, unknown>) {
  const adapter = createBridgeProtocolAdapter({
    id: "conditional-test",
    capabilities: {
      supportsThreadArchive: false,
      supportsThreadRename: false,
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "checkpoint",
      permissionModes: ["full"],
    },
    process: { command: "node", args: ["conditional-test.mjs"] },
  });
  adapter.buildPostInitializeRequests()[0]?.onResult({
    protocolVersion: 2,
    capabilities: { grammarVersions: [3, 3], ...capabilities },
  });
  const [started] = adapter.translateEvent({
    jsonrpc: "2.0",
    method: "thread/delta",
    params: {
      threadId: "thread",
      deltas: [{ kind: "turn.open", providerTurnId: "native-original" }],
    },
  });
  if (started?.type !== "turn/started" || started.scope.kind !== "turn") {
    throw new Error("Native turn was not mapped");
  }
  return { adapter, expectedTurnId: started.scope.turnId };
}

describe("conditional stop provider capability", () => {
  it.each([{}, { experimental_conditionalThreadStop: false }])(
    "refuses an unsupported bridge before any provider request: %j",
    (capabilities) => {
      expect(
        bridgeCapabilitiesSchema.parse(capabilities)
          .experimental_conditionalThreadStop,
      ).toBe(false);
      const { adapter, expectedTurnId } = makeAdapter(capabilities);
      expect(
        adapter.buildCommandPlan({
          type: "thread/stop-if-current-turn",
          threadId: "thread",
          providerThreadId: "native-thread",
          expectedTurnId,
        }),
      ).toMatchObject({ kind: "noop" });
      expect(
        adapter.buildCommandPlan({
          type: "thread/stop",
          threadId: "thread",
          providerThreadId: "native-thread",
          activeTurnId: expectedTurnId,
        }),
      ).toMatchObject({ kind: "request", method: "thread/stop" });
    },
  );

  it("rejects a malformed capability instead of granting authority", () => {
    expect(() =>
      makeAdapter({ experimental_conditionalThreadStop: "true" }),
    ).toThrow();
  });

  it("sends only the distinct request with a proven native original turn", () => {
    const { adapter, expectedTurnId } = makeAdapter({
      experimental_conditionalThreadStop: true,
    });
    expect(
      adapter.buildCommandPlan({
        type: "thread/stop-if-current-turn",
        threadId: "thread",
        providerThreadId: "native-thread",
        expectedTurnId,
      }),
    ).toEqual({
      kind: "request",
      method: "thread/stop-if-current-turn",
      params: {
        threadId: "thread",
        providerThreadId: "native-thread",
        expectedTurnId: "native-original",
      },
    });
    expect(
      adapter.buildCommandPlan({
        type: "thread/stop-if-current-turn",
        threadId: "thread",
        providerThreadId: "native-thread",
        expectedTurnId: "unmapped-bb-turn",
      }),
    ).toMatchObject({ kind: "noop" });
  });
});
