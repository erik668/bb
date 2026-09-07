import { describe, expect, it } from "vitest";
import type { ProviderProbeResult } from "@bb/host-daemon-contract";
import { providerProbeRequestSchema } from "@bb/server-contract";
import { probeSystemProvider } from "../../src/services/system/provider-probe.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { seedHost, seedHostSession } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const request = {
  providerId: "codex",
  model: "gpt-6-astra",
  reasoningLevel: "high" as const,
};
const raw: ProviderProbeResult = {
  health: {
    supported: true,
    health: {
      status: "ready",
      statusMessage: null,
      accountEmail: null,
      planLabel: null,
      installedVersion: "1",
      minimumSupportedVersion: null,
      canInstall: false,
      canUpdate: false,
      loginCommand: null,
    },
  },
  models: {
    models: [
      {
        id: "display-id",
        model: "gpt-6-astra",
        displayName: "Astra",
        description: "",
        supportedReasoningEfforts: [
          { reasoningEffort: "high", description: "" },
        ],
        defaultReasoningEffort: "high",
        isDefault: false,
      },
    ],
    selectedOnlyModels: [],
  },
  blocker: null,
};
describe("bounded provider probe", () => {
  it("requires one exact routing selector and rejects extra fields", () => {
    expect(providerProbeRequestSchema.safeParse(request).success).toBe(false);
    expect(
      providerProbeRequestSchema.safeParse({
        ...request,
        hostId: "host",
        environmentId: "env",
      }).success,
    ).toBe(false);
    expect(
      providerProbeRequestSchema.safeParse({
        ...request,
        hostId: "host",
        retry: true,
      }).success,
    ).toBe(false);
  });
  it("uses one requested-provider RPC, no discovery or memo, and the launch model field", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (rpc) => {
          expect(rpc.command.type).toBe("provider.probe_cached");
          return { ok: true, result: raw };
        },
      });
      const result = await probeSystemProvider(harness.deps, {
        ...request,
        hostId: host.id,
      });
      expect(result).toMatchObject({
        ...raw,
        hostId: host.id,
        hostRpcAttempts: 1,
        modelCalls: 0,
        workerCalls: 0,
        execution: "unproven",
      });
      expect(responder.requests).toHaveLength(1);
      const absent = await probeSystemProvider(harness.deps, {
        ...request,
        model: "display-id",
        hostId: host.id,
      });
      expect(absent.blocker?.code).toBe("model_unavailable");
      expect(responder.requests).toHaveLength(2);
    });
  });
  it("preserves raw failure and makes no fallback/retry request", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const failure = {
        ...raw,
        models: null,
        blocker: {
          code: "provider_models_failed",
          detail: "TLS verification failed",
        },
      };
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: () => ({ ok: true, result: failure }),
      });
      expect(
        await probeSystemProvider(harness.deps, {
          ...request,
          hostId: host.id,
        }),
      ).toMatchObject(failure);
      expect(responder.requests).toHaveLength(1);
    });
  });
  it("does not retry transport errors", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: () => ({
          ok: false,
          errorCode: "host_unavailable",
          errorMessage: "transport failed",
        }),
      });
      const result = await probeSystemProvider(harness.deps, {
        ...request,
        hostId: host.id,
      });
      expect(result.blocker).not.toBeNull();
      expect(result.hostRpcAttempts).toBe(1);
      expect(responder.requests).toHaveLength(1);
    });
  });
  it("blocks missing, offline and unsupported providers before an RPC", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps);
      for (const providerId of ["missing", "claude-code", "codex"]) {
        const result = await probeSystemProvider(harness.deps, {
          ...request,
          providerId,
          hostId: host.id,
        });
        expect(result.blocker).not.toBeNull();
        expect(result.hostRpcAttempts).toBe(0);
      }
    });
  });
});
