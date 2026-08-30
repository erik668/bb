import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";
import { NATIVE_MEMORY_MAX_FILE_BYTES } from "./native-memory-contract.js";
import {
  createNativeMemoryHostEntry,
  defaultNativeMemoryHostDependencies,
} from "./native-memory-host.js";

const temporaryDirectories: string[] = [];

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "bb-native-memory-"));
  temporaryDirectories.push(root);
  const home = path.join(root, "home");
  const repository = path.join(root, "repository");
  const workspace = path.join(repository, "worktree");
  await mkdir(path.join(repository, ".git"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  const canonicalRepository = await realpath(repository);
  const memoryRoot = path.join(
    home,
    ".claude",
    "projects",
    canonicalRepository.replace(/[^a-zA-Z0-9]/gu, "-"),
    "memory",
  );
  const entry = createNativeMemoryHostEntry({
    ...defaultNativeMemoryHostDependencies,
    homedir: () => home,
    gitCommonDirectory: async () => path.join(repository, ".git"),
  });
  return {
    home,
    memoryRoot,
    workspace,
    harness: experimental_createHostEntryHarness(entry),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("provider-native memory host boundary", () => {
  it("reports a missing store and handles an empty store without inventing observations", async () => {
    const missing = await fixture();
    const missingResult = await missing.harness.experimental_call(
      "scanNativeMemory",
      { workspacePath: missing.workspace },
    );
    expect(missingResult).toMatchObject({
      kind: "not_found",
      layout: "claude-memory-dir",
      reason: "Claude auto-memory directory was not found",
    });

    const empty = await fixture();
    await mkdir(empty.memoryRoot, { recursive: true });
    await expect(
      empty.harness.experimental_call("scanNativeMemory", {
        workspacePath: empty.workspace,
      }),
    ).resolves.toMatchObject({ kind: "ok", sources: [] });
  });

  it("indexes only confined Markdown, reads by hash, and detects later source changes", async () => {
    const { harness, memoryRoot, workspace } = await fixture();
    await mkdir(path.join(memoryRoot, "topics"), { recursive: true });
    await writeFile(path.join(memoryRoot, "MEMORY.md"), "# Durable overview\n");
    await writeFile(
      path.join(memoryRoot, "topics", "build.md"),
      "Use Turbo.\n",
    );
    await writeFile(path.join(memoryRoot, "ignored.txt"), "not memory\n");
    const outside = path.join(path.dirname(memoryRoot), "outside.md");
    await writeFile(outside, "outside\n");
    await symlink(outside, path.join(memoryRoot, "linked.md"));

    const scanned = await harness.experimental_call("scanNativeMemory", {
      workspacePath: workspace,
    });
    expect(scanned).toMatchObject({
      kind: "ok",
      // The host names the layout it matched; the server never assumes one.
      layout: "claude-memory-dir",
      sources: [
        {
          sourceKey: "MEMORY.md",
          contentHash: hash("# Durable overview\n"),
        },
        {
          sourceKey: "topics/build.md",
          contentHash: hash("Use Turbo.\n"),
        },
      ],
    });
    if (scanned.kind !== "ok") throw new Error("expected an indexed store");
    const source = scanned.sources[1];
    if (!source) throw new Error("expected the topic source");

    await expect(
      harness.experimental_call("readNativeMemory", {
        workspacePath: workspace,
        repositoryKey: scanned.repositoryKey,
        sourceKey: source.sourceKey,
        expectedContentHash: source.contentHash,
      }),
    ).resolves.toEqual({
      kind: "ok",
      content: "Use Turbo.\n",
      contentHash: source.contentHash,
    });

    await expect(
      harness.experimental_call("readNativeMemory", {
        workspacePath: workspace,
        repositoryKey: "f".repeat(32),
        sourceKey: source.sourceKey,
        expectedContentHash: source.contentHash,
      }),
    ).resolves.toEqual({ kind: "not_found" });

    await writeFile(
      path.join(memoryRoot, "topics", "build.md"),
      "Use Turbo safely.\n",
    );
    await expect(
      harness.experimental_call("readNativeMemory", {
        workspacePath: workspace,
        repositoryKey: scanned.repositoryKey,
        sourceKey: source.sourceKey,
        expectedContentHash: source.contentHash,
      }),
    ).resolves.toEqual({
      kind: "stale",
      contentHash: hash("Use Turbo safely.\n"),
    });
  });

  it("honors Claude's custom directory and fails closed on oversized content", async () => {
    const { harness, home, workspace } = await fixture();
    const custom = path.join(home, "custom-memory");
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await mkdir(custom, { recursive: true });
    await writeFile(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({ autoMemoryDirectory: custom }),
    );
    await writeFile(
      path.join(custom, "too-large.md"),
      Buffer.alloc(NATIVE_MEMORY_MAX_FILE_BYTES + 1, "x"),
    );

    await expect(
      harness.experimental_call("scanNativeMemory", {
        workspacePath: workspace,
      }),
    ).resolves.toMatchObject({
      kind: "unsupported",
      reason: expect.stringContaining("exceeds"),
    });
  });

  it("rejects traversal before it reaches the filesystem boundary", async () => {
    const { harness, workspace } = await fixture();
    await expect(
      harness.experimental_call("readNativeMemory", {
        workspacePath: workspace,
        repositoryKey: "a".repeat(32),
        sourceKey: "../outside.md",
        expectedContentHash: "b".repeat(64),
      }),
    ).rejects.toThrow("source key must be a safe relative path");
  });
});
