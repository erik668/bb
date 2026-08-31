import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  MAX_CHECK_TIMEOUT_MS,
  workflowCheckHostContract,
  workflowCheckInputPathSchema,
  workflowCheckReceiptSchema,
  workflowCheckSuiteIdSchema,
  type WorkflowCheckReceipt,
  type WorkflowCheckRequest,
} from "./check-contract.js";

export const CHECK_MANIFEST_PATH = ".bb/workflow-checks.json";
export const checkSuiteSchema = z
  .object({
    version: z.number().int().positive(),
    argv: z.array(z.string().min(1).max(8192)).min(1).max(128),
    inputs: z
      .array(
        z
          .object({
            path: workflowCheckInputPathSchema,
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
      )
      .min(1)
      .max(128),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_CHECK_TIMEOUT_MS)
      .default(120_000),
  })
  .strict();
export const checkManifestSchema = z
  .object({
    version: z.literal(1),
    suites: z.record(workflowCheckSuiteIdSchema, checkSuiteSchema),
  })
  .strict();

function describeProcessFailure(result: {
  exitCode: number | null;
  signal: string | null;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
}): string {
  if (result.timedOut) return "timed out";
  if (result.outputTruncated) return "exceeded the output limit";
  if (result.signal !== null) return `stopped with signal ${result.signal}`;
  const detail = result.stderr.trim();
  return `exited with code ${result.exitCode}${detail === "" ? "" : `: ${detail}`}`;
}

export function createWorkflowCheckRunner(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({
    contract: workflowCheckHostContract,
  });

  return async function runWorkflowCheck(args: {
    environmentId: string;
    projectId: string;
    permissionMode: string;
    request: WorkflowCheckRequest;
    signal: AbortSignal;
  }): Promise<WorkflowCheckReceipt> {
    if (args.permissionMode !== "full") {
      throw new Error(
        "Workflow checks require full permission because they execute project-owned code on the origin host",
      );
    }
    const environment = await bb.sdk.environments.get({
      environmentId: args.environmentId,
      signal: args.signal,
    });
    if (environment.path === null) {
      throw new Error("Workflow check environment has no workspace path");
    }
    const file = await bb.sdk.projects.fileContent({
      projectId: args.projectId,
      environmentId: args.environmentId,
      path: CHECK_MANIFEST_PATH,
      signal: args.signal,
    });
    if (file.contentEncoding !== "utf8") {
      throw new Error(`${CHECK_MANIFEST_PATH} must be UTF-8 JSON`);
    }
    const manifestSha256 = createHash("sha256")
      .update(file.content)
      .digest("hex");
    if (manifestSha256 !== args.request.manifestSha256) {
      throw new Error(
        `${CHECK_MANIFEST_PATH} sha256 ${manifestSha256} does not match pinned ${args.request.manifestSha256}`,
      );
    }
    const manifest = checkManifestSchema.parse(JSON.parse(file.content));
    const suite = manifest.suites[args.request.suite];
    if (suite === undefined) {
      throw new Error(
        `Unknown workflow check suite ${JSON.stringify(args.request.suite)}`,
      );
    }
    const verifySuiteInputs = async () => {
      for (const input of suite.inputs) {
        const implementation = await bb.sdk.projects.fileContent({
          projectId: args.projectId,
          environmentId: args.environmentId,
          path: input.path,
          signal: args.signal,
        });
        if (
          implementation.contentEncoding !== "utf8" &&
          implementation.contentEncoding !== "base64"
        ) {
          throw new Error(
            `Workflow check implementation ${JSON.stringify(input.path)} has unsupported encoding`,
          );
        }
        const bytes =
          implementation.contentEncoding === "utf8"
            ? Buffer.from(implementation.content, "utf8")
            : Buffer.from(implementation.content, "base64");
        const actualSha256 = createHash("sha256").update(bytes).digest("hex");
        if (actualSha256 !== input.sha256) {
          throw new Error(
            `Workflow check implementation ${JSON.stringify(input.path)} sha256 ${actualSha256} does not match pinned ${input.sha256}`,
          );
        }
      }
    };
    await verifySuiteInputs();
    const [executable, ...commandArgs] = suite.argv;
    const result = await host.call(
      "run",
      {
        cwd: environment.path,
        executable,
        args: commandArgs,
        stdin: JSON.stringify({
          suite: args.request.suite,
          manifestSha256: args.request.manifestSha256,
          contractSha256: args.request.contractSha256,
          candidateSha256: args.request.candidateSha256,
        }),
        timeoutMs: suite.timeoutMs,
      },
      { hostId: environment.hostId, signal: args.signal },
    );
    if (
      result.exitCode !== 0 ||
      result.signal !== null ||
      result.timedOut ||
      result.outputTruncated
    ) {
      throw new Error(
        `Workflow check ${JSON.stringify(args.request.suite)} ${describeProcessFailure(result)}`,
      );
    }
    await verifySuiteInputs();
    let decoded: unknown;
    try {
      decoded = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `Workflow check ${JSON.stringify(args.request.suite)} returned malformed JSON`,
      );
    }
    const receipt = workflowCheckReceiptSchema.parse(decoded);
    if (
      receipt.suite !== args.request.suite ||
      receipt.suiteVersion !== suite.version ||
      receipt.manifestSha256 !== args.request.manifestSha256 ||
      receipt.contractSha256 !== args.request.contractSha256 ||
      receipt.candidateSha256 !== args.request.candidateSha256
    ) {
      throw new Error(
        `Workflow check ${JSON.stringify(args.request.suite)} returned a receipt for different pinned inputs`,
      );
    }
    return receipt;
  };
}
