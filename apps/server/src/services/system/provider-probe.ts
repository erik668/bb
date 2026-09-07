import type {
  ProviderProbeRequest,
  ProviderProbeResponse,
} from "@bb/server-contract";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { callHostOnlineRpc } from "../hosts/online-rpc.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import { requireEnvironment } from "../lib/entity-lookup.js";
import { resolveSystemLookupHostId } from "./host-lookup.js";
import { resolveBridgeLaunchForProviderId } from "./provider-bridge-launch.js";

export async function probeSystemProvider(
  deps: AppDeps,
  args: ProviderProbeRequest,
): Promise<ProviderProbeResponse> {
  const result: ProviderProbeResponse = {
    version: 1,
    mode: "cached-only-no-retry",
    providerId: args.providerId,
    hostId: args.hostId ?? null,
    environmentId: args.environmentId ?? null,
    model: args.model,
    reasoningLevel: args.reasoningLevel,
    bridge: null,
    health: null,
    models: null,
    blocker: null,
    hostRpcAttempts: 0,
    modelCalls: 0,
    workerCalls: 0,
    execution: "unproven",
  };
  try {
    result.hostId = resolveSystemLookupHostId(deps, args);
    const registration = deps.providerRegistry.get(args.providerId);
    if (!registration || !registration.info.available) {
      result.blocker = {
        code: "provider_unavailable",
        detail: "Requested provider is not registered and available",
      };
      return result;
    }
    if (
      args.providerId !== "codex" ||
      registration.pluginId !== "provider-codex"
    ) {
      result.blocker = {
        code: "provider_probe_unsupported",
        detail: "Cached probe supports only the native Codex provider",
      };
      return result;
    }
    if (!registration.info.maintenance.health) {
      result.blocker = {
        code: "provider_health_unsupported",
        detail: "Requested provider does not support health inspection",
      };
      return result;
    }
    const bridgeLaunch = resolveBridgeLaunchForProviderId(
      deps,
      args.providerId,
    );
    if (!bridgeLaunch) {
      result.blocker = {
        code: "provider_bridge_unavailable",
        detail: "Requested provider has no registered bridge artifact",
      };
      return result;
    }
    result.bridge = {
      pluginId: bridgeLaunch.pluginId,
      digest: bridgeLaunch.source.digest,
      byteLength: bridgeLaunch.source.byteLength,
    };
    await ensureHostSessionReadyForWork(deps, { hostId: result.hostId });
    const cwd =
      args.environmentId === undefined
        ? undefined
        : (requireEnvironment(deps.db, args.environmentId).path ?? undefined);
    result.hostRpcAttempts = 1;
    const probe = await callHostOnlineRpc(deps, {
      hostId: result.hostId,
      timeoutMs: 30_000,
      command: {
        type: "provider.probe_cached",
        providerId: args.providerId,
        bridgeLaunch,
        ...(cwd === undefined ? {} : { cwd }),
      },
    });
    Object.assign(result, probe);
    if (result.blocker !== null) return result;
    if (
      !result.health?.supported ||
      result.health.health.status !== "ready" ||
      result.models === null
    ) {
      result.blocker = {
        code: "provider_evidence_incomplete",
        detail: "Probe did not return ready health and a model catalog",
      };
      return result;
    }
    const matches = [
      ...(result.models?.models ?? []),
      ...(result.models?.selectedOnlyModels ?? []),
    ].filter((model) => model.model === args.model);
    if (matches.length !== 1)
      result.blocker = {
        code: "model_unavailable",
        detail:
          "Requested launch model is absent or ambiguous in the raw provider catalog",
      };
    else if (
      matches[0]?.routeProviderId !== undefined &&
      matches[0].routeProviderId !== args.providerId
    )
      result.blocker = {
        code: "model_route_unsupported",
        detail: "Requested model routes through another provider",
      };
    else if (
      !matches[0]?.supportedReasoningEfforts.some(
        (effort) => effort.reasoningEffort === args.reasoningLevel,
      )
    )
      result.blocker = {
        code: "reasoning_unavailable",
        detail:
          "Requested reasoning level is absent from the raw model catalog",
      };
  } catch (error) {
    result.blocker = {
      code: error instanceof ApiError ? error.body.code : "probe_failed",
      detail:
        error instanceof Error
          ? error.message.slice(0, 2000)
          : "Provider probe failed",
    };
  }
  return result;
}
