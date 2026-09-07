import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { safePluginSegment } from "@bb/process-utils";
import {
  HOST_ARTIFACT_MAX_BYTES,
  type HostDaemonBridgeLaunch,
  type ProviderProbeResult,
} from "@bb/host-daemon-contract";
import type { AgentRuntimeBridgeLaunch } from "@bb/agent-runtime";
import type {
  CommandDispatchOptions,
  CommandOf,
} from "./command-dispatch-support.js";

export async function readCachedBridgeLaunch(
  dataRoot: string,
  launch: HostDaemonBridgeLaunch,
): Promise<AgentRuntimeBridgeLaunch> {
  const root = await realpath(dataRoot);
  const plugin = safePluginSegment(launch.pluginId);
  const artifactDirectory = join(
    root,
    "plugin-host-artifacts",
    plugin,
    launch.source.digest,
  );
  const dataDir = join(root, "plugins", plugin, "bridge-data");
  for (const segments of [
    ["plugin-host-artifacts", plugin, launch.source.digest],
    ["plugins", plugin, "bridge-data"],
  ]) {
    let directory = root;
    for (const segment of segments) {
      directory = join(directory, segment);
      if (!(await lstat(directory)).isDirectory())
        throw new Error("Cached bridge directory is not a real directory");
    }
  }
  const artifactPath = join(artifactDirectory, "host.mjs");
  const file = await open(
    artifactPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.size !== launch.source.byteLength ||
      metadata.size > HOST_ARTIFACT_MAX_BYTES
    )
      throw new Error("Cached bridge artifact size or type mismatch");
    const bytes = await file.readFile();
    if (
      bytes.length !== launch.source.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== launch.source.digest
    )
      throw new Error("Cached bridge artifact digest mismatch");
  } finally {
    await file.close();
  }
  return {
    pluginId: launch.pluginId,
    dataDir,
    source: { kind: "artifact", digest: launch.source.digest, artifactPath },
    capabilities: {
      ...launch.capabilities,
      permissionModes: [...launch.capabilities.permissionModes],
    },
    providerOptions: { ...launch.providerOptions },
    envPassthrough: [...launch.envPassthrough],
  };
}

export async function probeCachedProvider(
  command: CommandOf<"provider.probe_cached">,
  options: Pick<
    CommandDispatchOptions,
    "dataDir" | "providerHealth" | "listModels"
  >,
): Promise<ProviderProbeResult> {
  const result: ProviderProbeResult = {
    health: null,
    models: null,
    blocker: null,
  };
  if (
    command.providerId !== "codex" ||
    command.bridgeLaunch.pluginId !== "provider-codex"
  ) {
    return {
      ...result,
      blocker: {
        code: "provider_probe_unsupported",
        detail: "Cached probe supports only the native Codex provider",
      },
    };
  }
  let stage = "bridge_cache_unavailable";
  try {
    const bridgeLaunch = await readCachedBridgeLaunch(
      options.dataDir,
      command.bridgeLaunch,
    );
    const args = {
      providerId: command.providerId,
      bridgeLaunch,
      ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
    };
    stage = "provider_health_failed";
    result.health = await options.providerHealth(args);
    if (!result.health.supported || result.health.health.status !== "ready") {
      result.blocker = {
        code: "provider_not_ready",
        detail: "Raw provider health did not report ready",
      };
      return result;
    }
    stage = "provider_models_failed";
    result.models = await options.listModels(args);
    if (
      result.models.models.length > 500 ||
      result.models.selectedOnlyModels.length > 500
    ) {
      result.models = null;
      result.blocker = {
        code: "provider_models_limit",
        detail: "Provider returned more than 500 catalog entries",
      };
    }
  } catch (error) {
    result.blocker = {
      code: stage,
      detail:
        error instanceof Error
          ? error.message.slice(0, 2000)
          : "Provider probe failed",
    };
  }
  return result;
}
