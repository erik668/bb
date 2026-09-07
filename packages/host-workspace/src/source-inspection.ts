import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  sourceInspectionSchema,
  workflowSourcePathSchema,
  type SourceInspection,
} from "@bb/domain";
import { runGit, type GitProcessOptions, WorkspaceError } from "./git.js";

export async function inspectImmutableSource(
  args: GitProcessOptions & {
    path: string;
    ref: string;
    workflowPath: string;
  },
): Promise<SourceInspection> {
  workflowSourcePathSchema.parse(args.workflowPath);
  if (!path.isAbsolute(args.path) || args.ref.startsWith("-")) {
    throw new WorkspaceError(
      "invalid_source",
      "Source path must be absolute and ref must not be an option",
    );
  }
  const cwd = await realpath(args.path);
  const gitEnvironment: NodeJS.ProcessEnv = Object.fromEntries(
    Object.keys(process.env)
      .filter((name) => name.startsWith("GIT_"))
      .map((name) => [name, undefined]),
  );
  gitEnvironment.GIT_NO_REPLACE_OBJECTS = "1";
  gitEnvironment.GIT_OPTIONAL_LOCKS = "0";
  const options = {
    cwd,
    shellPath: args.shellPath,
    timeoutMs: 10_000,
    env: gitEnvironment,
  };
  const root = await runGit(["rev-parse", "--show-toplevel"], options);
  const repositoryPath = await realpath(root.stdout.trim());
  if (repositoryPath !== cwd) {
    throw new WorkspaceError(
      "invalid_source",
      "Source must name the repository root",
    );
  }
  const common = await runGit(["rev-parse", "--git-common-dir"], options);
  const repositoryIdentity = await realpath(
    path.resolve(cwd, common.stdout.trim()),
  );
  const resolve = async (ref: string) => {
    const result = await runGit(
      ["rev-parse", "--verify", "--end-of-options", ref],
      { ...options, allowFailure: true },
    );
    return result.exitCode === 0 ? result.stdout.trim() : null;
  };
  const commit = await resolve(`${args.ref}^{commit}`);
  const head = await resolve("HEAD^{commit}");
  const tree = commit === null ? null : await resolve(`${commit}^{tree}`);
  const workflowObject =
    commit === null
      ? null
      : await resolve(
          args.workflowPath === "."
            ? `${commit}^{tree}`
            : `${commit}:${args.workflowPath}`,
        );
  const objectType =
    workflowObject === null
      ? null
      : await runGit(["cat-file", "-t", workflowObject], options);
  const status = await runGit(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    options,
  );
  return sourceInspectionSchema.parse({
    repositoryPath,
    repositoryIdentity,
    commit,
    tree,
    workflowPath: args.workflowPath,
    workflowTree: objectType?.stdout.trim() === "tree" ? workflowObject : null,
    head,
    clean: status.stdout.length === 0,
  });
}
