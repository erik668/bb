import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat as nodeLstat,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  realpath as nodeRealpath,
} from "node:fs/promises";
import { homedir as nodeHomedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  nativeMemoryHostContract,
  NATIVE_MEMORY_MAX_FILE_BYTES,
  NATIVE_MEMORY_MAX_FILES,
  NATIVE_MEMORY_MAX_TOTAL_BYTES,
  type NativeMemoryReadResult,
  type NativeMemoryScanResult,
  type NativeMemoryLayout,
  type NativeMemorySource,
} from "./native-memory-contract.js";

/** The layout this scanner implements: Claude Code's on-disk memory tree. */
const LAYOUT: NativeMemoryLayout = "claude-memory-dir";

const execFile = promisify(nodeExecFile);
const MAX_DIRECTORY_DEPTH = 4;
const SETTINGS_MAX_BYTES = 64 * 1024;

interface FileStat {
  readonly mtimeMs: number;
  readonly size: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface DirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface NativeMemoryHostDependencies {
  homedir(): string;
  lstat(filePath: string): Promise<FileStat>;
  readFile(filePath: string): Promise<Buffer>;
  readdir(filePath: string): Promise<DirectoryEntry[]>;
  realpath(filePath: string): Promise<string>;
  gitCommonDirectory(workspacePath: string): Promise<string | null>;
}

interface ResolvedClaudeMemory {
  readonly memoryRoot: string;
  readonly repositoryKey: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function claudeProjectKey(workspaceRoot: string): string {
  return workspaceRoot.replace(/[^a-zA-Z0-9]/gu, "-");
}

function expandHome(candidate: string, home: string): string | null {
  if (path.isAbsolute(candidate)) return candidate;
  if (candidate === "~") return home;
  if (candidate.startsWith("~/")) return path.join(home, candidate.slice(2));
  return null;
}

async function customMemoryDirectory(
  deps: NativeMemoryHostDependencies,
  home: string,
): Promise<string | null> {
  const settingsPath = path.join(home, ".claude", "settings.json");
  try {
    const stat = await deps.lstat(settingsPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > SETTINGS_MAX_BYTES
    ) {
      return null;
    }
    const parsed = JSON.parse(
      (await deps.readFile(settingsPath)).toString("utf8"),
    ) as {
      autoMemoryDirectory?: unknown;
    };
    return typeof parsed.autoMemoryDirectory === "string"
      ? expandHome(parsed.autoMemoryDirectory, home)
      : null;
  } catch {
    return null;
  }
}

async function canonicalWorkspaceRoot(
  deps: NativeMemoryHostDependencies,
  workspacePath: string,
): Promise<string> {
  const workspace = await deps.realpath(workspacePath);
  const commonDirectory = await deps.gitCommonDirectory(workspace);
  if (!commonDirectory) return workspace;
  const common = path.isAbsolute(commonDirectory)
    ? commonDirectory
    : path.resolve(workspace, commonDirectory);
  const resolvedCommon = await deps.realpath(common);
  return path.basename(resolvedCommon) === ".git"
    ? path.dirname(resolvedCommon)
    : workspace;
}

async function resolveClaudeMemory(
  deps: NativeMemoryHostDependencies,
  workspacePath: string,
): Promise<ResolvedClaudeMemory> {
  const home = deps.homedir();
  const workspaceRoot = await canonicalWorkspaceRoot(deps, workspacePath);
  const configured = await customMemoryDirectory(deps, home);
  const memoryRoot =
    configured ??
    path.join(
      home,
      ".claude",
      "projects",
      claudeProjectKey(workspaceRoot),
      "memory",
    );
  return {
    memoryRoot,
    repositoryKey: sha256(workspaceRoot).slice(0, 32),
  };
}

async function validatedRoot(
  deps: NativeMemoryHostDependencies,
  candidate: string,
): Promise<string | null> {
  try {
    const stat = await deps.lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return await deps.realpath(candidate);
  } catch {
    return null;
  }
}

async function collectMarkdownFiles(
  deps: NativeMemoryHostDependencies,
  root: string,
): Promise<Array<{ absolutePath: string; sourceKey: string; stat: FileStat }>> {
  const files: Array<{
    absolutePath: string;
    sourceKey: string;
    stat: FileStat;
  }> = [];
  const pending: Array<{ absolutePath: string; depth: number }> = [
    { absolutePath: root, depth: 0 },
  ];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const entries = await deps.readdir(current.absolutePath);
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(current.absolutePath, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < MAX_DIRECTORY_DEPTH) {
          pending.push({ absolutePath, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") {
        continue;
      }
      const stat = await deps.lstat(absolutePath);
      const resolved = await deps.realpath(absolutePath);
      if (stat.size > NATIVE_MEMORY_MAX_FILE_BYTES) {
        throw new Error(
          `native memory file "${entry.name}" exceeds the ${NATIVE_MEMORY_MAX_FILE_BYTES}-byte limit`,
        );
      }
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        !isWithin(root, resolved)
      ) {
        continue;
      }
      files.push({
        absolutePath: resolved,
        sourceKey: path.relative(root, resolved).split(path.sep).join("/"),
        stat,
      });
      if (files.length > NATIVE_MEMORY_MAX_FILES) {
        throw new Error(
          `native memory contains more than ${NATIVE_MEMORY_MAX_FILES} Markdown files`,
        );
      }
    }
  }
  return files.sort((left, right) =>
    left.sourceKey.localeCompare(right.sourceKey),
  );
}

export function createNativeMemoryHostEntry(
  deps: NativeMemoryHostDependencies,
) {
  return experimental_defineHostEntry({
    contract: nativeMemoryHostContract,
    handlers: {
      async scanNativeMemory(input): Promise<NativeMemoryScanResult> {
        let resolved: ResolvedClaudeMemory;
        try {
          resolved = await resolveClaudeMemory(deps, input.workspacePath);
        } catch (error) {
          return {
            kind: "unsupported",
            reason: `Could not resolve Claude memory: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        const root = await validatedRoot(deps, resolved.memoryRoot);
        if (!root) {
          return {
            kind: "not_found",
            layout: LAYOUT,
            repositoryKey: resolved.repositoryKey,
            reason: "Claude auto-memory directory was not found",
          };
        }
        try {
          let totalBytes = 0;
          const sources: NativeMemorySource[] = [];
          for (const file of await collectMarkdownFiles(deps, root)) {
            const content = await deps.readFile(file.absolutePath);
            if (content.byteLength > NATIVE_MEMORY_MAX_FILE_BYTES) {
              throw new Error(
                `native memory file "${file.sourceKey}" changed beyond the ${NATIVE_MEMORY_MAX_FILE_BYTES}-byte limit during scan`,
              );
            }
            totalBytes += content.byteLength;
            if (totalBytes > NATIVE_MEMORY_MAX_TOTAL_BYTES) {
              throw new Error(
                `native memory exceeds the ${NATIVE_MEMORY_MAX_TOTAL_BYTES}-byte scan limit`,
              );
            }
            sources.push({
              sourceKey: file.sourceKey,
              contentHash: sha256(content),
              byteLength: content.byteLength,
              modifiedAt: Math.trunc(file.stat.mtimeMs),
            });
          }
          return {
            kind: "ok",
            layout: LAYOUT,
            repositoryKey: resolved.repositoryKey,
            sources,
          };
        } catch (error) {
          return {
            kind: "unsupported",
            reason: `Could not scan Claude memory safely: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
      async readNativeMemory(input): Promise<NativeMemoryReadResult> {
        let resolved: ResolvedClaudeMemory;
        try {
          resolved = await resolveClaudeMemory(deps, input.workspacePath);
        } catch {
          return { kind: "not_found" };
        }
        if (resolved.repositoryKey !== input.repositoryKey) {
          return { kind: "not_found" };
        }
        const root = await validatedRoot(deps, resolved.memoryRoot);
        if (!root) return { kind: "not_found" };
        const candidate = path.resolve(root, ...input.sourceKey.split("/"));
        if (
          !isWithin(root, candidate) ||
          path.extname(candidate).toLowerCase() !== ".md"
        ) {
          return { kind: "not_found" };
        }
        try {
          const stat = await deps.lstat(candidate);
          const file = await deps.realpath(candidate);
          if (
            stat.isSymbolicLink() ||
            !stat.isFile() ||
            stat.size > NATIVE_MEMORY_MAX_FILE_BYTES ||
            !isWithin(root, file)
          ) {
            return { kind: "not_found" };
          }
          const content = await deps.readFile(file);
          const contentHash = sha256(content);
          if (contentHash !== input.expectedContentHash) {
            return { kind: "stale", contentHash };
          }
          return {
            kind: "ok",
            content: new TextDecoder("utf-8", { fatal: true }).decode(content),
            contentHash,
          };
        } catch {
          return { kind: "not_found" };
        }
      },
    },
  });
}

export const defaultNativeMemoryHostDependencies: NativeMemoryHostDependencies =
  {
    homedir: nodeHomedir,
    lstat: nodeLstat,
    readFile: nodeReadFile,
    async readdir(filePath) {
      return nodeReaddir(filePath, { withFileTypes: true });
    },
    realpath: nodeRealpath,
    async gitCommonDirectory(workspacePath) {
      try {
        const { stdout } = await execFile(
          "git",
          [
            "-C",
            workspacePath,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ],
          { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 },
        );
        return stdout.trim() || null;
      } catch {
        return null;
      }
    },
  };
