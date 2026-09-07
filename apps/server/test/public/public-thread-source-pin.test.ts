import { getThreadSourcePin, threads } from "@bb/db";
import type { SourceInspection, SourcePin } from "@bb/domain";
import { describe, expect, it, vi } from "vitest";
import {
  admitThreadSource,
  revalidateThreadSource,
  validateProvisionedThreadSource,
} from "../../src/services/threads/source-provisioning.js";
import {
  listQueuedCommands,
  registerTestHostRpcCapture,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function fixture(harness: TestAppHarness) {
  const { host, session } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/target",
  });
  const observed: SourceInspection = {
    repositoryPath: "/target",
    repositoryIdentity: "/target/.git",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    workflowPath: "workflow",
    workflowTree: "c".repeat(40),
    head: "a".repeat(40),
    clean: true,
  };
  const resolve = vi.fn();
  registerTestHostRpcCapture(harness, {
    hostId: host.id,
    sessionId: session.id,
    sourceInspectionResult: observed,
    onResolveSource: resolve,
  });
  const pin: SourcePin = {
    projectId: project.id,
    hostId: host.id,
    repositoryPath: "/target",
    repositoryIdentity: "/target/.git",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    workflowPath: "workflow",
    workflowTree: "c".repeat(40),
    pathPolicy: { kind: "new-worktree" },
  };
  const payload = {
    origin: "sdk",
    projectId: project.id,
    providerId: "codex",
    model: "gpt-5",
    input: [{ type: "text", text: "Inspect source" }],
    sendAt: Date.now() + 60_000,
    experimental_sourcePin: pin,
    environment: {
      type: "host",
      hostId: host.id,
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "named", name: "owner-only" },
      },
    },
  };
  return { host, session, project, observed, resolve, pin, payload };
}

async function spawn(harness: TestAppHarness, payload: object) {
  return harness.app.request("/api/v1/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("source admission before thread creation", () => {
  it("returns actual project and host identities during read-only inspection and rejects forged supervision before creation", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      const response = await harness.app.request(
        "/api/v1/threads/source-inspect",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: f.project.id,
            hostId: f.host.id,
            ref: "main",
            workflowPath: "workflow",
          }),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ...f.observed,
        projectId: f.project.id,
        hostId: f.host.id,
      });
      expect(harness.db.select().from(threads).all()).toHaveLength(0);
      const environment = seedEnvironment(harness.deps, {
        projectId: f.project.id,
        hostId: f.host.id,
        path: "/target",
      });
      const manager = seedThread(harness.deps, {
        projectId: f.project.id,
        environmentId: environment.id,
      });
      const forged = await spawn(harness, {
        ...f.payload,
        parentThreadId: manager.id,
        experimental_supervisor: {
          managerThreadId: manager.id,
          campaignId: "forged",
          inboxId: "inbox",
          taskId: "owner",
          bindingToken: "f".repeat(64),
        },
      });
      expect(forged.status).toBe(409);
      expect(await forged.json()).toMatchObject({
        code: "supervisor_binding_invalid",
      });
      expect(harness.db.select().from(threads).all()).toHaveLength(1);
      expect(listQueuedCommands(harness, "thread.start")).toEqual([]);
    });
  });
  it("records an immutable raw pin before a queued branch launch and rechecks drift before admission", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      const { experimental_sourcePin: _pin, ...payload } = f.payload;
      f.observed.workflowPath = ".";
      f.observed.workflowTree = f.observed.tree;
      const response = await spawn(harness, payload);
      expect(response.status).toBe(201);
      const [thread] = harness.db.select().from(threads).all();
      if (!thread) throw new Error("Thread was not created");
      const stored = getThreadSourcePin(harness.db, thread.id);
      expect(stored).toMatchObject({
        projectId: f.project.id,
        hostId: f.host.id,
        commit: f.observed.commit,
        tree: f.observed.tree,
        repositoryIdentity: "/target/.git",
      });
      expect(f.resolve).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/target", ref: "owner-only" }),
      );
      expect(listQueuedCommands(harness, "environment.provision")).toEqual([]);
      const intent = {
        type: "direct-managed" as const,
        hostId: f.host.id,
        sourcePath: "/target",
        baseBranch: { kind: "named" as const, name: "a".repeat(40) },
        workspaceProvisionType: "managed-worktree" as const,
      };
      f.observed.clean = false;
      await expect(
        revalidateThreadSource(harness.deps, {
          threadId: thread.id,
          projectId: f.project.id,
          intent,
        }),
      ).rejects.toMatchObject({ body: { code: "source_identity_mismatch" } });
      expect(listQueuedCommands(harness, "thread.start")).toEqual([]);
    });
  });

  it.each([
    "foreign-object",
    "repository",
    "tree",
    "subtree",
    "dirty",
    "path",
    "host",
    "project",
    "moved-branch",
  ] as const)(
    "rejects %s with exact routing facts and no thread, worktree or provider",
    async (failure) => {
      await withTestHarness(async (harness) => {
        const f = fixture(harness);
        if (failure === "foreign-object") f.observed.commit = null;
        if (failure === "repository")
          f.pin.repositoryIdentity = "/foreign/.git";
        if (failure === "tree") f.pin.tree = "f".repeat(40);
        if (failure === "subtree") f.pin.workflowTree = "f".repeat(40);
        if (failure === "dirty") f.observed.clean = false;
        if (failure === "path")
          f.pin.pathPolicy = { kind: "exact", path: "/wrong" };
        if (failure === "host") f.pin.hostId = "foreign-host";
        if (failure === "project") f.pin.projectId = "foreign-project";
        if (failure === "moved-branch") {
          f.pin.discoveryRef = "main";
          f.resolve.mockImplementation((command: { ref: string }) => {
            if (command.ref === "main") f.observed.commit = "f".repeat(40);
          });
        }
        const response = await spawn(harness, f.payload);
        expect(response.status).toBe(409);
        const error = await response.json();
        expect(error).toMatchObject({
          code: "source_identity_mismatch",
          details: { source: f.pin, targetPath: "/target" },
        });
        expect(harness.db.select().from(threads).all()).toHaveLength(0);
        expect(listQueuedCommands(harness, "environment.provision")).toEqual(
          [],
        );
        expect(listQueuedCommands(harness, "thread.start")).toEqual([]);
      });
    },
  );

  it("requires exact clean checkout reuse and rejects source changes introduced during provisioning", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      const environment = seedEnvironment(harness.deps, {
        projectId: f.project.id,
        hostId: f.host.id,
        path: "/target",
      });
      const pin = {
        ...f.pin,
        pathPolicy: { kind: "exact" as const, path: "/target" },
      };
      const intent = { type: "reuse" as const, environmentId: environment.id };
      expect(
        await admitThreadSource(harness.deps, {
          projectId: f.project.id,
          intent,
          pin,
        }),
      ).toEqual({ intent, pin });
      const response = await spawn(harness, {
        ...f.payload,
        experimental_sourcePin: pin,
        environment: { type: "reuse", environmentId: environment.id },
      });
      expect(response.status).toBe(201);
      const [thread] = harness.db.select().from(threads).all();
      if (!thread) throw new Error("Missing thread");
      f.observed.head = "f".repeat(40);
      await expect(
        validateProvisionedThreadSource(harness.deps, {
          projectId: f.project.id,
          threadId: thread.id,
          environmentId: environment.id,
        }),
      ).rejects.toMatchObject({ body: { code: "source_identity_mismatch" } });
      f.observed.head = f.pin.commit;
      f.observed.clean = false;
      await expect(
        admitThreadSource(harness.deps, {
          projectId: f.project.id,
          intent,
          pin,
        }),
      ).rejects.toThrow("dirty");
    });
  });
});
