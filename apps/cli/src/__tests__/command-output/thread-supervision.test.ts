import { describe, expect, it, vi } from "vitest";
import {
  setupCommandOutputTestEnvironment,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { makeThread } from "../helpers/command-output-fixtures.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

describe("source and supervisor CLI contracts", () => {
  setupCommandOutputTestEnvironment();
  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");
  const credential = {
    managerThreadId: "manager",
    campaignId: "campaign",
    inboxId: "inbox",
    bindingToken: "a".repeat(64),
  };

  it("passes source pins and validated private task bindings through spawn without dropping fields", async () => {
    const pin = {
      projectId: "project",
      hostId: "host-test-001",
      repositoryPath: "/repo",
      repositoryIdentity: "/repo/.git",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      workflowPath: "workflow",
      workflowTree: "c".repeat(40),
      pathPolicy: { kind: "exact", path: "/repo" },
    };
    const binding = { ...credential, taskId: "owner" };
    const post = vi.fn(async () =>
      makeThread({ id: "worker", projectId: "project", providerId: "codex" }),
    );
    stubServerApi({ "v1.threads.$post": post });
    await runCommand(
      [
        "thread",
        "spawn",
        "--project",
        "project",
        "--environment",
        "/repo",
        "--parent-thread",
        "manager",
        "--source-pin",
        JSON.stringify(pin),
        "--supervisor",
        JSON.stringify(binding),
        "--prompt",
        "Work",
        "--json",
      ],
      register,
    );
    expect(post).toHaveBeenCalledWith({
      json: expect.objectContaining({
        experimental_sourcePin: pin,
        experimental_supervisor: binding,
        parentThreadId: "manager",
      }),
    });
  });

  it("registers a recoverable token and sends a stable decision through the native notice API", async () => {
    const registration = vi.fn(async () => credential);
    const notice = vi.fn(async () => ({
      key: "durable-key",
      delivery: "queued",
      queuedMessageId: "queue-1",
      requestSequence: null,
    }));
    stubServerApi({
      "v1.threads.supervisor-register.$post": registration,
      "v1.threads.supervisor-notify.$post": notice,
    });
    await runCommand(
      [
        "thread",
        "supervisor-register",
        "--thread",
        "manager",
        "--campaign",
        "campaign",
        "--inbox",
        "inbox",
        "--token",
        credential.bindingToken,
        "--json",
      ],
      register,
    );
    expect(registration).toHaveBeenCalledWith({ json: credential });
    await runCommand(
      [
        "thread",
        "supervisor-notify",
        "--binding",
        JSON.stringify(credential),
        "--key",
        "review-ready",
        "--kind",
        "decision",
        "--message",
        "Registry update complete",
        "--json",
      ],
      register,
    );
    expect(notice).toHaveBeenCalledWith({
      json: {
        ...credential,
        key: "review-ready",
        kind: "decision",
        message: "Registry update complete",
        taskId: null,
      },
    });
  });

  it("routes inspection to the selected machine and preserves durable inbox pagination", async () => {
    const inspection = vi.fn(async () => ({
      projectId: "project",
      hostId: "host-remote",
      repositoryPath: "/remote",
    }));
    const inbox = vi.fn(async () => ({ items: [], nextKey: null }));
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => [
        {
          id: "host-remote",
          name: "builder",
          type: "persistent",
          status: "connected",
          lastSeenAt: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      "v1.threads.source-inspect.$post": inspection,
      "v1.threads.supervisor-inbox.$post": inbox,
    });
    await runCommand(
      [
        "thread",
        "source-inspect",
        "--project",
        "project",
        "--machine",
        "builder",
        "--ref",
        "main",
        "--workflow-path",
        "workflow",
        "--json",
      ],
      register,
    );
    expect(inspection).toHaveBeenCalledWith({
      json: {
        projectId: "project",
        hostId: "host-remote",
        ref: "main",
        workflowPath: "workflow",
      },
    });
    await runCommand(
      [
        "thread",
        "supervisor-inbox",
        "--thread",
        "manager",
        "--campaign",
        "campaign",
        "--inbox",
        "inbox",
        "--after-key",
        "cursor",
        "--limit",
        "12",
        "--json",
      ],
      register,
    );
    expect(inbox).toHaveBeenCalledWith({
      json: {
        managerThreadId: "manager",
        campaignId: "campaign",
        inboxId: "inbox",
        afterKey: "cursor",
        limit: 12,
      },
    });
    await runCommand(
      [
        "thread",
        "supervisor-inbox",
        "--thread",
        "manager",
        "--campaign",
        "campaign",
        "--inbox",
        "inbox",
        "--notice-key",
        "registry-ready",
        "--json",
      ],
      register,
    );
    expect(inbox).toHaveBeenCalledWith({
      json: {
        managerThreadId: "manager",
        campaignId: "campaign",
        inboxId: "inbox",
        noticeKey: "registry-ready",
        limit: 100,
      },
    });
  });
});

describe("supervisor peek parser", () => {
  setupCommandOutputTestEnvironment();
  it("targets only the pure endpoint with the exact original key", async () => {
    const post = vi.fn(async () => ({
      registration: "missing",
      items: [],
      nextKey: null,
    }));
    stubServerApi({ "v1.threads.supervisor-peek.$post": post });
    await runCommand(
      [
        "thread",
        "supervisor-peek",
        "--thread",
        "manager",
        "--campaign",
        "campaign",
        "--inbox",
        "inbox",
        "--notice-key",
        "original",
        "--json",
      ],
      (program) => registerThreadCommands(program, () => "http://server"),
    );
    expect(post).toHaveBeenCalledWith({
      json: {
        managerThreadId: "manager",
        campaignId: "campaign",
        inboxId: "inbox",
        noticeKey: "original",
        limit: 100,
      },
    });
  });
});
