import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  workflowCheckReceiptSchema,
  type WorkflowCheckReceipt,
  type WorkflowCheckRequest,
} from "./check-contract.js";
import { createWorkflowCheckRunner } from "./check-runner.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const PINNED_IMPLEMENTATION = "export const version = 1;\n";

function request(manifestSha256: string): WorkflowCheckRequest {
  return {
    suite: "terraform-hcl",
    manifestSha256,
    contractSha256: digest("contract"),
    candidateSha256: digest("candidate"),
  };
}

function receipt(input: WorkflowCheckRequest): WorkflowCheckReceipt {
  return workflowCheckReceiptSchema.parse({
    suite: input.suite,
    suiteVersion: 1,
    manifestSha256: input.manifestSha256,
    contractSha256: input.contractSha256,
    candidateSha256: input.candidateSha256,
    selected: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    admitted: true,
    findings: [],
  });
}

function setup(args?: {
  manifest?: string;
  implementationContent?: string;
  implementationContents?: string[];
  processResult?: (input: WorkflowCheckRequest) => {
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    outputTruncated: boolean;
  };
}) {
  const implementationPath = "checks/terraform-hcl.mjs";
  const manifest =
    args?.manifest ??
    JSON.stringify({
      version: 1,
      suites: {
        "terraform-hcl": {
          version: 1,
          argv: ["workflow-gates", "check", "terraform-hcl"],
          inputs: [
            {
              path: implementationPath,
              sha256: digest(PINNED_IMPLEMENTATION),
            },
          ],
          timeoutMs: 30_000,
        },
      },
    });
  const manifestSha256 = digest(manifest);
  const checkRequest = request(manifestSha256);
  let implementationRead = 0;
  const host = createFakePluginHost({
    pluginId: "workflows",
    experimental_callHostRpc: () =>
      args?.processResult?.(checkRequest) ?? {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify(receipt(checkRequest)),
        stderr: "",
        timedOut: false,
        outputTruncated: false,
      },
    sdk: {
      environments: {
        get: async () => ({
          id: "environment-1",
          name: null,
          projectId: "project-1",
          hostId: "host-1",
          path: "/workspace",
          managed: true,
          isGitRepo: true,
          isWorktree: true,
          workspaceProvisionType: "worktree",
          branchName: "feature",
          baseBranch: "main",
          defaultBranch: "main",
          mergeBaseBranch: null,
          status: "ready",
          createdAt: 1,
          updatedAt: 1,
        }),
      },
      projects: {
        fileContent: async ({ path }) => {
          const implementationContent =
            args?.implementationContents?.[
              Math.min(
                implementationRead,
                args.implementationContents.length - 1,
              )
            ] ??
            args?.implementationContent ??
            PINNED_IMPLEMENTATION;
          if (path !== ".bb/workflow-checks.json") implementationRead += 1;
          const content =
            path === ".bb/workflow-checks.json"
              ? manifest
              : implementationContent;
          return {
            content,
            contentEncoding: "utf8",
            mimeType: "application/json",
            sizeBytes: Buffer.byteLength(content),
          };
        },
      },
    },
  });
  return {
    checkRequest,
    host,
    run: createWorkflowCheckRunner(host.bb),
  };
}

describe("workflow check runner", () => {
  it("returns a fail-closed receipt from a pinned named suite", async () => {
    const test = setup();

    await expect(
      test.run({
        environmentId: "environment-1",
        projectId: "project-1",
        permissionMode: "full",
        request: test.checkRequest,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual(receipt(test.checkRequest));
    await test.host.harness.dispose();
  });

  it("refuses untrusted permissions, manifest drift, and unknown suites before execution", async () => {
    const test = setup();
    const signal = new AbortController().signal;

    await expect(
      test.run({
        environmentId: "environment-1",
        projectId: "project-1",
        permissionMode: "auto",
        request: test.checkRequest,
        signal,
      }),
    ).rejects.toThrow("require full permission");
    await expect(
      test.run({
        environmentId: "environment-1",
        projectId: "project-1",
        permissionMode: "full",
        request: { ...test.checkRequest, manifestSha256: digest("drift") },
        signal,
      }),
    ).rejects.toThrow("does not match pinned");
    await expect(
      test.run({
        environmentId: "environment-1",
        projectId: "project-1",
        permissionMode: "full",
        request: { ...test.checkRequest, suite: "unknown" },
        signal,
      }),
    ).rejects.toThrow("Unknown workflow check suite");
    expect(test.host.harness.experimental_hostRpcCalls).toHaveLength(0);
    await test.host.harness.dispose();

    const changedImplementation = setup({
      implementationContent: "export const version = 2;\n",
    });
    await expect(
      changedImplementation.run({
        environmentId: "environment-1",
        projectId: "project-1",
        permissionMode: "full",
        request: changedImplementation.checkRequest,
        signal,
      }),
    ).rejects.toThrow("implementation");
    expect(
      changedImplementation.host.harness.experimental_hostRpcCalls,
    ).toHaveLength(0);
    await changedImplementation.host.harness.dispose();

    const changedDuringExecution = setup({
      implementationContents: [
        PINNED_IMPLEMENTATION,
        "export const version = 2;\n",
      ],
    });
    await expect(
      changedDuringExecution.run({
        environmentId: "environment-1",
        projectId: "project-1",
        permissionMode: "full",
        request: changedDuringExecution.checkRequest,
        signal,
      }),
    ).rejects.toThrow("implementation");
    expect(
      changedDuringExecution.host.harness.experimental_hostRpcCalls,
    ).toHaveLength(1);
    await changedDuringExecution.host.harness.dispose();
  });

  it("rejects infrastructure failures and receipts that contradict their counts or pins", async () => {
    const timedOut = setup({
      processResult: () => ({
        exitCode: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
        timedOut: true,
        outputTruncated: false,
      }),
    });
    await expect(
      timedOut.run({
        environmentId: "environment-1",
        projectId: "project-1",
        permissionMode: "full",
        request: timedOut.checkRequest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("timed out");
    await timedOut.host.harness.dispose();

    const contradictory = setup({
      processResult: (input) => ({
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({
          ...receipt(input),
          admitted: true,
          passed: 0,
          failed: 1,
        }),
        stderr: "",
        timedOut: false,
        outputTruncated: false,
      }),
    });
    await expect(
      contradictory.run({
        environmentId: "environment-1",
        projectId: "project-1",
        permissionMode: "full",
        request: contradictory.checkRequest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("fail-closed check counts");
    await contradictory.host.harness.dispose();

    const wrongPin = setup({
      processResult: (input) => ({
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({
          ...receipt(input),
          candidateSha256: digest("other-candidate"),
        }),
        stderr: "",
        timedOut: false,
        outputTruncated: false,
      }),
    });
    await expect(
      wrongPin.run({
        environmentId: "environment-1",
        projectId: "project-1",
        permissionMode: "full",
        request: wrongPin.checkRequest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("different pinned inputs");
    await wrongPin.host.harness.dispose();

    const wrongVersion = setup({
      processResult: (input) => ({
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({ ...receipt(input), suiteVersion: 2 }),
        stderr: "",
        timedOut: false,
        outputTruncated: false,
      }),
    });
    await expect(
      wrongVersion.run({
        environmentId: "environment-1",
        projectId: "project-1",
        permissionMode: "full",
        request: wrongVersion.checkRequest,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("different pinned inputs");
    await wrongVersion.host.harness.dispose();
  });
});
