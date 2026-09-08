import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPluginApp } from "./build-plugin-app.js";
import {
  PLUGIN_TOOLCHAIN_PINS,
  pluginBuildCacheContract,
  inspectCachedPluginBuildToolchain,
  resolvePluginBuildToolchain,
  toolchainCacheDir,
} from "./toolchain.js";

describe("plugin build toolchain", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "bb-toolchain-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("keys the cache directory on the pinned versions", () => {
    const dir = toolchainCacheDir("/data");
    for (const version of Object.values(PLUGIN_TOOLCHAIN_PINS)) {
      expect(basename(dir)).toContain(version);
    }
    expect(dir.startsWith("/data/")).toBe(true);
  });

  it("exports the resolver-owned cache contract and refuses missing or malformed cache without creating it", async () => {
    const contract = pluginBuildCacheContract(baseDir);
    expect(contract.cacheDir).toBe(toolchainCacheDir(baseDir));
    expect(contract.pins).toEqual(PLUGIN_TOOLCHAIN_PINS);
    expect(contract.marker.pins).toBe(
      Object.entries(contract.pins)
        .map(([name, version]) => `${name}@${version}`)
        .sort()
        .join(","),
    );
    await expect(
      inspectCachedPluginBuildToolchain(baseDir),
    ).resolves.toBeNull();
    await expect(readFile(contract.cacheDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await mkdir(contract.cacheDir, { recursive: true });
    const marker = join(contract.cacheDir, ".bb-toolchain.json");
    await writeFile(marker, "{bad");
    await expect(
      inspectCachedPluginBuildToolchain(baseDir),
    ).resolves.toBeNull();
    expect(await readFile(marker, "utf8")).toBe("{bad");
  });

  it("prefers a locally resolvable toolchain over fetching", async () => {
    const toolchain = await resolvePluginBuildToolchain(baseDir, {
      onFetchStart: () => {
        throw new Error("fetched despite a locally resolvable toolchain");
      },
    });

    expect(toolchain.esbuild).toMatch(/^file:\/\//);
    expect(toolchain.esbuild).toContain("esbuild");
    expect(toolchain.tailwindNode).toContain("@tailwindcss/node");
    expect(toolchain.tailwindOxide).toContain("@tailwindcss/oxide");
    expect(
      await rm(toolchainCacheDir(baseDir), { recursive: true }).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it("does not mistake ancestor dependencies for a populated cache and accepts the same files inside the cache", async () => {
    const modules = join(baseDir, "node_modules");
    for (const [name, version] of Object.entries(PLUGIN_TOOLCHAIN_PINS)) {
      const directory = join(modules, name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ name, version, main: "index.cjs" }),
      );
      await writeFile(join(directory, "index.cjs"), "module.exports = {};\n");
    }
    const cacheBase = join(baseDir, "caches"),
      contract = pluginBuildCacheContract(cacheBase);
    await mkdir(contract.cacheDir, { recursive: true });
    await writeFile(
      join(contract.cacheDir, ".bb-toolchain.json"),
      JSON.stringify(contract.marker),
    );
    await expect(
      inspectCachedPluginBuildToolchain(cacheBase),
    ).resolves.toBeNull();
    await rename(modules, join(contract.cacheDir, "node_modules"));
    await expect(
      inspectCachedPluginBuildToolchain(cacheBase),
    ).resolves.toMatchObject({
      tailwindCssDir: await realpath(
        join(contract.cacheDir, "node_modules/tailwindcss"),
      ),
    });
  });

  it("returns importable module specifiers", async () => {
    const toolchain = await resolvePluginBuildToolchain(baseDir);
    const esbuild = (await import(
      toolchain.esbuild
    )) as typeof import("esbuild");
    const result = await esbuild.transform("const x: number = 1", {
      loader: "ts",
    });

    expect(result.code.trim()).toBe("const x = 1;");
  });

  describe("fetched toolchain", () => {
    it.runIf(process.env.BB_TEST_TOOLCHAIN_FETCH === "1")(
      "builds a plugin frontend with nothing resolvable locally",
      async () => {
        const fetchEvents: string[] = [];
        const toolchain = await resolvePluginBuildToolchain(baseDir, {
          ignoreLocal: true,
          onFetchStart: () => fetchEvents.push("start"),
          onFetchDone: (ms) => fetchEvents.push(`done:${ms > 0}`),
        });

        expect(fetchEvents).toEqual(["start", "done:true"]);

        expect(toolchain.esbuild).toContain("toolchain-");
        expect(toolchain.tailwindCssDir).toContain("toolchain-");

        const pluginDir = join(baseDir, "plugin");
        await mkdir(pluginDir, { recursive: true });
        await writeFile(
          join(pluginDir, "package.json"),
          JSON.stringify({
            name: "bb-plugin-fetched",
            version: "0.1.0",
            bb: {
              name: "Fetched",
              description: "Fetched toolchain fixture.",
              branding: { icon: "Zap" },
              server: "./server.ts",
              app: "./app.tsx",
            },
          }),
        );
        await writeFile(
          join(pluginDir, "server.ts"),
          "export default function plugin() {}",
        );
        await writeFile(
          join(pluginDir, "app.tsx"),
          `import { definePluginApp } from "@get-bb/plugin-sdk/app";\n` +
            `export default definePluginApp({});\n`,
        );

        const result = await buildPluginApp(pluginDir, "0.9.0-test", toolchain);
        const css = await readFile(result.cssPath, "utf8");

        expect(css.length).toBeGreaterThan(0);
        expect(css).toContain("--");
      },
      600_000,
    );

    it.skipIf(process.platform === "win32")(
      "keeps script-policy npm config out of the fetch",
      async () => {
        const binDir = join(baseDir, "bin");
        const envDump = join(baseDir, "npm-env.txt");
        await mkdir(binDir, { recursive: true });
        const fakeNpm = join(binDir, "npm");
        await writeFile(fakeNpm, `#!/bin/sh\nenv > "${envDump}"\nexit 0\n`);
        await chmod(fakeNpm, 0o755);

        const overrides: Record<string, string> = {
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          npm_config_allow_scripts: "@github/keytar,node-pty",
          NPM_CONFIG_IGNORE_SCRIPTS: "false",
          npm_config_registry: "https://registry.example.invalid/",
        };
        const previous = new Map<string, string | undefined>();
        for (const [key, value] of Object.entries(overrides)) {
          previous.set(key, process.env[key]);
          process.env[key] = value;
        }
        try {
          await expect(
            resolvePluginBuildToolchain(baseDir, { ignoreLocal: true }),
          ).rejects.toThrow(/incomplete or misversioned/);
        } finally {
          for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }

        const seen = new Map(
          (await readFile(envDump, "utf8"))
            .split("\n")
            .filter((line) => line.includes("="))
            .map((line) => {
              const at = line.indexOf("=");
              return [line.slice(0, at), line.slice(at + 1)] as const;
            }),
        );
        expect(seen.has("npm_config_allow_scripts")).toBe(false);
        expect(seen.has("NPM_CONFIG_IGNORE_SCRIPTS")).toBe(false);
        expect(seen.get("npm_config_registry")).toBe(
          "https://registry.example.invalid/",
        );
      },
    );

    it("reuses an already-fetched toolchain without reinstalling", async () => {
      const local = await resolvePluginBuildToolchain(baseDir);
      expect(local.tailwindCssDir.length).toBeGreaterThan(0);
    });
  });
});
