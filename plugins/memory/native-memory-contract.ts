import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * On-disk memory layouts the host scanner knows how to read. A layout names a
 * filesystem convention this plugin implements — `claude-memory-dir` is the
 * `~/.claude/settings.json` + `~/.claude/projects/<key>/memory/` tree — not a
 * bb provider id. Nothing routes on it: bb never maps a thread's provider onto
 * a layout, and no provider declares one. Adding an agent's memory tree means
 * adding a scanner and an entry here, with no change to the idle path.
 */
export const NATIVE_MEMORY_LAYOUTS = ["claude-memory-dir"] as const;
export type NativeMemoryLayout = (typeof NATIVE_MEMORY_LAYOUTS)[number];
export const NATIVE_MEMORY_MAX_FILE_BYTES = 64 * 1024;
export const NATIVE_MEMORY_MAX_FILES = 128;
export const NATIVE_MEMORY_MAX_TOTAL_BYTES = 1024 * 1024;

const workspacePathSchema = z.string().min(1).max(4_096);
const repositoryKeySchema = z.string().regex(/^[a-f0-9]{32}$/u);
const sourceKeySchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.split("/").some((part) => part === ".." || part === ""),
    "source key must be a safe relative path",
  );
const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const nativeMemoryLayoutSchema = z.enum(NATIVE_MEMORY_LAYOUTS);

export const nativeMemorySourceSchema = z
  .object({
    sourceKey: sourceKeySchema,
    contentHash: contentHashSchema,
    byteLength: z.number().int().min(0).max(NATIVE_MEMORY_MAX_FILE_BYTES),
    modifiedAt: z.number().int().nonnegative(),
  })
  .strict();

export type NativeMemorySource = z.infer<typeof nativeMemorySourceSchema>;

export const nativeMemoryScanResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ok"),
      layout: nativeMemoryLayoutSchema,
      repositoryKey: repositoryKeySchema,
      sources: z.array(nativeMemorySourceSchema).max(NATIVE_MEMORY_MAX_FILES),
    })
    .strict(),
  z
    .object({
      kind: z.literal("not_found"),
      layout: nativeMemoryLayoutSchema,
      repositoryKey: repositoryKeySchema,
      reason: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unsupported"),
      reason: z.string().min(1).max(500),
    })
    .strict(),
]);

export type NativeMemoryScanResult = z.infer<
  typeof nativeMemoryScanResultSchema
>;

export const nativeMemoryReadResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ok"),
      content: z.string().max(NATIVE_MEMORY_MAX_FILE_BYTES),
      contentHash: contentHashSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("stale"),
      contentHash: contentHashSchema,
    })
    .strict(),
  z.object({ kind: z.literal("not_found") }).strict(),
]);

export type NativeMemoryReadResult = z.infer<
  typeof nativeMemoryReadResultSchema
>;

export const nativeMemoryHostContract = defineRpcContract({
  scanNativeMemory: {
    input: z.object({ workspacePath: workspacePathSchema }).strict(),
    output: nativeMemoryScanResultSchema,
  },
  readNativeMemory: {
    input: z
      .object({
        workspacePath: workspacePathSchema,
        repositoryKey: repositoryKeySchema,
        sourceKey: sourceKeySchema,
        expectedContentHash: contentHashSchema,
      })
      .strict(),
    output: nativeMemoryReadResultSchema,
  },
});
