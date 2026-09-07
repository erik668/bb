import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  lstat,
  rm,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderHealthResult } from "@bb/host-daemon-contract";
import { DISPATCH_TEST_BRIDGE_LAUNCH } from "../test/command/dispatch-helpers.js";
import {
  probeCachedProvider,
  readCachedBridgeLaunch,
} from "./provider-cached-probe.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const health: ProviderHealthResult = {
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
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bb-probe-"));
  roots.push(root);
  const bytes = Buffer.from("export default 1;\n");
  const launch = {
    ...DISPATCH_TEST_BRIDGE_LAUNCH,
    pluginId: "provider-codex",
    source: {
      kind: "artifact" as const,
      digest: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.length,
    },
  };
  const directory = join(
    root,
    "plugin-host-artifacts",
    launch.pluginId,
    launch.source.digest,
  );
  await mkdir(directory, { recursive: true });
  await mkdir(join(root, "plugins", launch.pluginId, "bridge-data"), {
    recursive: true,
  });
  const artifact = join(directory, "host.mjs");
  await writeFile(artifact, bytes);
  await writeFile(join(directory, "host.js"), "legacy must remain");
  await mkdir(
    join(root, "plugin-host-artifacts", launch.pluginId, "old-digest"),
  );
  return { root, launch, artifact };
}
async function snapshot(root: string): Promise<object[]> {
  const rows: object[] = [];
  for (const name of await readdir(root, { recursive: true })) {
    const path = join(root, name),
      stat = await lstat(path);
    rows.push({
      name,
      mtime: stat.mtimeMs,
      size: stat.size,
      bytes: stat.isFile() ? (await readFile(path)).toString("hex") : null,
    });
  }
  return rows;
}
it.each(["hit", "missing", "corrupt", "symlink"])(
  "never mutates or repairs the cache on %s",
  async (kind) => {
    const f = await fixture();
    if (kind === "missing") await rm(f.artifact);
    if (kind === "corrupt")
      await writeFile(f.artifact, Buffer.alloc(f.launch.source.byteLength));
    if (kind === "symlink") {
      await rm(f.artifact);
      await symlink(join(f.root, "other"), f.artifact);
    }
    const before = await snapshot(f.root);
    if (kind === "hit")
      expect(
        (await readCachedBridgeLaunch(f.root, f.launch)).source.artifactPath,
      ).toBe(await realpath(f.artifact));
    else
      await expect(readCachedBridgeLaunch(f.root, f.launch)).rejects.toThrow();
    expect(await snapshot(f.root)).toEqual(before);
  },
);
it("does not retry maintenance failures and keeps raw health", async () => {
  const f = await fixture();
  const providerHealth = vi.fn(async () => health);
  const listModels = vi.fn(async () => {
    throw new Error("catalog unavailable");
  });
  const result = await probeCachedProvider(
    {
      type: "provider.probe_cached",
      providerId: "codex",
      bridgeLaunch: f.launch,
    },
    { dataDir: f.root, providerHealth, listModels },
  );
  expect(result).toEqual({
    health,
    models: null,
    blocker: { code: "provider_models_failed", detail: "catalog unavailable" },
  });
  expect(providerHealth).toHaveBeenCalledTimes(1);
  expect(listModels).toHaveBeenCalledTimes(1);
});
it("cache failure and unsupported health prevent later calls", async () => {
  const f = await fixture();
  const providerHealth = vi.fn(async (): Promise<ProviderHealthResult> => ({
    supported: false,
  }));
  const listModels = vi.fn(async () => ({
    models: [],
    selectedOnlyModels: [],
  }));
  const command = {
    type: "provider.probe_cached" as const,
    providerId: "codex",
    bridgeLaunch: f.launch,
  };
  const options = { dataDir: f.root, providerHealth, listModels };
  expect((await probeCachedProvider(command, options)).blocker?.code).toBe(
    "provider_not_ready",
  );
  expect(listModels).not.toHaveBeenCalled();
  await rm(f.artifact);
  expect((await probeCachedProvider(command, options)).blocker?.code).toBe(
    "bridge_cache_unavailable",
  );
  expect(providerHealth).toHaveBeenCalledTimes(1);
});
