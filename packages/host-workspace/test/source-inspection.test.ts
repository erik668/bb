import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGit } from "../src/git.js";
import { inspectImmutableSource } from "../src/source-inspection.js";

const roots: string[] = [];
async function repository(label: string) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "bb-source-v33-")),
  );
  roots.push(root);
  await runGit(["init", "-b", "main"], { cwd: root });
  await runGit(["config", "user.email", "test@example.com"], { cwd: root });
  await runGit(["config", "user.name", "Source tests"], { cwd: root });
  await mkdir(path.join(root, "workflow"));
  await writeFile(path.join(root, "workflow", "run.js"), label);
  await runGit(["add", "."], { cwd: root });
  await runGit(["commit", "-m", label], { cwd: root });
  return root;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("immutable source inspection", () => {
  it("ignores inherited Git routing and records raw objects without replacement refs", async () => {
    const root = await repository("raw-first");
    const foreign = await repository("foreign");
    const first = await inspectImmutableSource({
      path: root,
      ref: "HEAD",
      workflowPath: "workflow",
    });
    await writeFile(path.join(root, "workflow", "run.js"), "raw-second");
    await runGit(["commit", "-am", "second"], { cwd: root });
    if (!first.commit) throw new Error("Missing commit");
    await runGit(["replace", first.commit, "HEAD"], { cwd: root });
    vi.stubEnv("GIT_DIR", path.join(foreign, ".git"));
    vi.stubEnv("GIT_WORK_TREE", foreign);
    const raw = await inspectImmutableSource({
      path: root,
      ref: first.commit,
      workflowPath: "workflow",
    });
    expect(raw).toMatchObject({
      repositoryPath: root,
      repositoryIdentity: first.repositoryIdentity,
      commit: first.commit,
      tree: first.tree,
      workflowTree: first.workflowTree,
    });
  });
  it("resolves branches and raw commits only inside the owning repository", async () => {
    const owner = await repository("owner");
    const foreign = await repository("foreign");
    await runGit(["branch", "owner-only"], { cwd: owner });
    const observed = await inspectImmutableSource({
      path: owner,
      ref: "owner-only",
      workflowPath: "workflow",
    });
    expect(observed).toMatchObject({
      repositoryPath: owner,
      repositoryIdentity: path.join(owner, ".git"),
      clean: true,
    });
    expect(observed.commit).toMatch(/^[a-f0-9]{40}$/u);
    expect(observed.workflowTree).not.toBe(observed.tree);
    if (!observed.commit) throw new Error("Missing commit");
    expect(
      await inspectImmutableSource({
        path: owner,
        ref: observed.commit,
        workflowPath: "workflow",
      }),
    ).toEqual(observed);
    for (const ref of ["owner-only", observed.commit]) {
      expect(
        await inspectImmutableSource({
          path: foreign,
          ref,
          workflowPath: "workflow",
        }),
      ).toMatchObject({
        repositoryPath: foreign,
        repositoryIdentity: path.join(foreign, ".git"),
        commit: null,
        tree: null,
        workflowTree: null,
      });
    }
  });

  it("distinguishes moved branches, wrong workflow object, untracked dirt, and worktree identity", async () => {
    const root = await repository("first");
    const first = await inspectImmutableSource({
      path: root,
      ref: "main",
      workflowPath: "workflow",
    });
    const worktree = path.join(root, "..", `${path.basename(root)}-worker`);
    roots.push(worktree);
    await runGit(["worktree", "add", "--detach", worktree, "HEAD"], {
      cwd: root,
    });
    const worker = await inspectImmutableSource({
      path: worktree,
      ref: "HEAD",
      workflowPath: "workflow",
    });
    expect(worker.repositoryIdentity).toBe(first.repositoryIdentity);
    expect(worker.repositoryPath).toBe(worktree);
    await writeFile(path.join(root, "workflow", "run.js"), "second");
    await runGit(["commit", "-am", "second"], { cwd: root });
    const moved = await inspectImmutableSource({
      path: root,
      ref: "main",
      workflowPath: "workflow",
    });
    expect(moved.commit).not.toBe(first.commit);
    expect(moved.workflowTree).not.toBe(first.workflowTree);
    await writeFile(path.join(root, "unexpected.txt"), "dirty");
    expect(
      (
        await inspectImmutableSource({
          path: root,
          ref: "main",
          workflowPath: "workflow",
        })
      ).clean,
    ).toBe(false);
    expect(
      (
        await inspectImmutableSource({
          path: root,
          ref: "main",
          workflowPath: "workflow/run.js",
        })
      ).workflowTree,
    ).toBeNull();
    await expect(
      inspectImmutableSource({
        path: root,
        ref: "--help",
        workflowPath: "workflow",
      }),
    ).rejects.toThrow("ref must not be an option");
  });
});
