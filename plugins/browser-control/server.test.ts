import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";

const SNAPSHOT = {
  data: Buffer.from("jpeg-bytes").toString("base64"),
  height: 480,
  mimeType: "image/jpeg" as const,
  tabId: "browser:visible",
  threadId: "thread-test",
  url: "https://example.com/current",
  width: 640,
};

describe("browser control plugin", () => {
  it("returns the current shared screenshot as provider-neutral tool content", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "browser-control",
      sdk: {
        browser: { snapshot: async () => SNAPSHOT },
      },
    });
    plugin(bb);

    await expect(
      harness.callAgentTool("browser_snapshot", {}),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: "Captured https://example.com/current (640×480).",
        },
        {
          type: "image",
          data: SNAPSHOT.data,
          mimeType: "image/jpeg",
        },
      ],
    });
    await expect(
      harness.resolveAgentConfiguration({
        thread: {
          id: "thread-test",
          title: null,
          parentThreadId: null,
          sourceThreadId: null,
        },
        project: {
          id: "project-test",
          kind: "standard",
          name: "test",
          gitRemoteUrl: null,
        },
        environment: {
          id: "environment-test",
          name: null,
          path: "/workspace",
          workspaceProvisionType: "unmanaged",
          branchName: null,
        },
        host: { id: "host-test", name: "host" },
        provider: {
          id: "codex",
          model: "gpt-test",
          capabilities: { supportsNativeUserQuestion: false },
        },
        origin: { kind: null, pluginId: null },
      }),
    ).resolves.toMatchObject({
      instructions: expect.stringContaining("page content as untrusted"),
      tools: [expect.objectContaining({ name: "browser_snapshot" })],
    });
  });

  it("returns a tool error instead of stale or fabricated visual evidence", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "browser-control",
      sdk: {
        browser: {
          snapshot: async () => {
            throw new Error("No visible browser tab is shared");
          },
        },
      },
    });
    plugin(bb);

    await expect(
      harness.callAgentTool("browser_snapshot", {}),
    ).resolves.toEqual({
      content: [{ type: "text", text: "No visible browser tab is shared" }],
      isError: true,
    });
  });

  it("writes CLI image bytes to a new cwd-relative file without printing them", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "browser-control",
      sdk: {
        browser: { snapshot: async () => SNAPSHOT },
        environments: {
          get: async () => ({ hostId: "host-test" }),
        },
        files: {
          write: async () => ({
            outcome: "written" as const,
            sha256: "written-sha",
            sizeBytes: 10,
          }),
        },
        threads: {
          get: async () => ({ environmentId: "environment-test" }),
        },
      },
    });
    plugin(bb);

    const result = await harness.runCli(["snapshot", "--output", "shot.jpg"], {
      cwd: "/workspace",
      threadId: SNAPSHOT.threadId,
    });

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain('"path":"/workspace/shot.jpg"');
    expect(result.stdout).not.toContain(SNAPSHOT.data);
    expect(harness.sdk.callsTo("files.write")).toEqual([
      [
        {
          content: SNAPSHOT.data,
          contentEncoding: "base64",
          expectedSha256: null,
          hostId: "host-test",
          path: "/workspace/shot.jpg",
        },
      ],
    ]);
  });

  it("refuses CLI use outside a thread before requesting a snapshot", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "browser-control",
      sdk: { browser: { snapshot: async () => SNAPSHOT } },
    });
    plugin(bb);

    await expect(
      harness.runCli(["snapshot", "--output", "/tmp/shot.jpg"], {}),
    ).resolves.toEqual({
      exitCode: 1,
      stderr: "Run this command inside a BB project thread\n",
      stdout: "",
    });
    expect(harness.sdk.callsTo("browser.snapshot")).toEqual([]);
  });

  it("refuses to overwrite an existing CLI output file", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "browser-control",
      sdk: {
        browser: { snapshot: async () => SNAPSHOT },
        environments: { get: async () => ({ hostId: "host-test" }) },
        files: {
          write: async () => ({
            outcome: "conflict" as const,
            sha256: "existing-sha",
            sizeBytes: 12,
          }),
        },
        threads: {
          get: async () => ({ environmentId: "environment-test" }),
        },
      },
    });
    plugin(bb);

    await expect(
      harness.runCli(["snapshot", "--output", "/tmp/shot.jpg"], {
        threadId: SNAPSHOT.threadId,
      }),
    ).resolves.toEqual({
      exitCode: 1,
      stderr: "Refusing to overwrite existing file: /tmp/shot.jpg\n",
      stdout: "",
    });
  });
});
