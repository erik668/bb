import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createAgentRuntime } from "./runtime.js";
import type { AgentRuntime, AgentRuntimeBridgeLaunch } from "./types.js";

const commandRecordSchema = z.strictObject({
  command: z.enum(["codex", "npm"]),
  operation: z.string(),
  policy: z.string().nullable(),
  phase: z.string().nullable(),
  undeclared: z.boolean(),
});

const codexHostPath = fileURLToPath(
  new URL("../../../plugins/provider-codex/src/host.ts", import.meta.url),
);
const codexPluginUrl = new URL(
  "../../../plugins/provider-codex/server.ts",
  import.meta.url,
).href;
const pluginModuleSchema = z.object({
  default: z.custom<(bb: BbPluginApi) => void>(
    (value) => typeof value === "function",
  ),
});

describe("Codex declaration through the runtime maintenance bridge", () => {
  let workspacePath: string;
  let recordPath: string;
  let runtime: AgentRuntime;
  let host: ReturnType<typeof createFakePluginHost>;
  let bridgeLaunch: AgentRuntimeBridgeLaunch;

  function records() {
    return readFileSync(recordPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => commandRecordSchema.parse(JSON.parse(line)));
  }

  beforeEach(async () => {
    workspacePath = mkdtempSync(
      join(tmpdir(), "bb-codex-declared-maintenance-"),
    );
    recordPath = join(workspacePath, "commands.jsonl");
    writeFileSync(recordPath, "");
    const binPath = join(workspacePath, "bin");
    mkdirSync(binPath);
    for (const command of ["codex", "npm"] as const) {
      writeFileSync(
        join(binPath, command),
        `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const command = ${JSON.stringify(command)};
const operation = process.argv[2] ?? "";
appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
  command, operation,
  policy: process.env.BB_CODEX_MAINTENANCE_POLICY ?? null,
  phase: process.env.BB_BOOTSTRAP_PHASE ?? null,
  undeclared: process.env.BB_MAINTENANCE_UNDECLARED !== undefined,
}) + "\\n");
if (command === "codex" && operation === "--version") console.log("codex-cli 0.150.0");
else if (command === "npm" && operation === "view") console.log("0.151.0");
else if (command === "npm" && operation === "prefix") console.log("/fixture/npm");
else if (command === "npm" && operation === "list") console.log(JSON.stringify({ dependencies: { "@openai/codex": { version: "0.150.0" } } }));
else process.exitCode = 91;
`,
        { mode: 0o755 },
      );
    }
    vi.stubEnv("PATH", `${binPath}${delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("CODEX_HOME", join(workspacePath, "codex-home"));
    vi.stubEnv("BB_CODEX_MAINTENANCE_POLICY", "cache-only");
    vi.stubEnv("BB_BOOTSTRAP_PHASE", "daemon-startup");
    vi.stubEnv("BB_MAINTENANCE_UNDECLARED", "must-not-cross");
    host = createFakePluginHost({ pluginId: "provider-codex" });
    const imported: unknown = await import(codexPluginUrl);
    const { default: codexPlugin } = pluginModuleSchema.parse(imported);
    codexPlugin(host.bb);
    const declaration = host.harness.registrations.providerRegistrations.find(
      (provider) => provider.id === "codex",
    );
    if (declaration === undefined) throw new Error("Codex was not registered");
    const capabilities = declaration.capabilities;
    bridgeLaunch = {
      pluginId: "provider-codex",
      dataDir: join(workspacePath, "bridge-data"),
      source: {
        kind: "artifact",
        artifactPath: codexHostPath,
        digest: "codex-source-maintenance-test",
      },
      providerOptions: {},
      envPassthrough: declaration.env?.passthrough ?? [],
      capabilities: {
        providerInstallation: declaration.maintenance.installation,
        supportsServiceTier: capabilities.supportsServiceTier,
        supportsThreadArchive: capabilities.supportsThreadArchive,
        supportsThreadRename: capabilities.supportsThreadRename,
        permissionModes: [...capabilities.permissionModes],
        fork: capabilities.fork,
      },
    };
    runtime = createAgentRuntime({
      workspacePath,
      onEvent: () => undefined,
      onToolCall: async () => ({ contentItems: [], success: true }),
    });
  });

  afterEach(async () => {
    await runtime.shutdown();
    await host.harness.lifecycle.dispose();
    vi.unstubAllEnvs();
    rmSync(workspacePath, { recursive: true, force: true });
  });

  const providerId = "codex";

  it("keeps cache-only policy and the launch phase through real runtime filtering", async () => {
    expect(bridgeLaunch.envPassthrough).toEqual([
      "BB_CODEX_MAINTENANCE_POLICY",
      "BB_BOOTSTRAP_PHASE",
    ]);
    await expect(
      runtime.providerInstallationStatus({ providerId, bridgeLaunch }),
    ).resolves.toMatchObject({
      installed: true,
      currentVersion: "0.150.0",
      latestVersion: null,
      installAction: null,
    });
    await expect(
      runtime.providerHealth({ providerId, bridgeLaunch }),
    ).resolves.toMatchObject({
      health: {
        status: "unauthenticated",
        canInstall: false,
        canUpdate: false,
      },
    });
    await expect(
      runtime.providerUsage({ providerId, bridgeLaunch }),
    ).resolves.toEqual({ supported: false });
    await expect(
      runtime.providerInstallationRun({
        providerId,
        bridgeLaunch,
        action: "install",
      }),
    ).resolves.toMatchObject({ available: false });
    vi.stubEnv("BB_BOOTSTRAP_PHASE", "readiness-smoke");
    await runtime.providerInstallationStatus({ providerId, bridgeLaunch });
    expect(records().length).toBeGreaterThan(0);
    expect(
      records().every(
        (record) =>
          record.command === "codex" &&
          record.operation === "--version" &&
          record.policy === "cache-only" &&
          record.phase === "daemon-startup" &&
          !record.undeclared,
      ),
    ).toBe(true);
  });

  it("preserves standard maintenance when the policy is absent and forwards explicit phase", async () => {
    vi.stubEnv("BB_CODEX_MAINTENANCE_POLICY", undefined);
    vi.stubEnv("BB_BOOTSTRAP_PHASE", "provider-probe");
    await expect(
      runtime.providerInstallationStatus({ providerId, bridgeLaunch }),
    ).resolves.toMatchObject({
      latestVersion: "0.151.0",
      needsUpdate: true,
      installAction: { kind: "update" },
    });
    expect(
      records()
        .filter((record) => record.command === "npm")
        .map((record) => record.operation)
        .sort(),
    ).toEqual(["list", "prefix", "view"]);
    expect(
      records().every(
        (record) =>
          record.policy === null &&
          record.phase === "provider-probe" &&
          !record.undeclared,
      ),
    ).toBe(true);
  });

  it("rejects a malformed declared policy before local commands or package metadata", async () => {
    vi.stubEnv("BB_CODEX_MAINTENANCE_POLICY", "cache-onyl");
    await expect(
      runtime.providerInstallationStatus({ providerId, bridgeLaunch }),
    ).rejects.toThrow();
    expect(records()).toEqual([]);
  });

  it("reproduces lost policy and phase when the old declaration omits both names", async () => {
    bridgeLaunch = { ...bridgeLaunch, envPassthrough: [] };
    await expect(
      runtime.providerInstallationStatus({ providerId, bridgeLaunch }),
    ).resolves.toMatchObject({ latestVersion: "0.151.0", needsUpdate: true });
    expect(
      records()
        .filter((record) => record.command === "npm")
        .map((record) => record.operation)
        .sort(),
    ).toEqual(["list", "prefix", "view"]);
    expect(
      records().every(
        (record) =>
          record.policy === null && record.phase === null && !record.undeclared,
      ),
    ).toBe(true);
  });
});
