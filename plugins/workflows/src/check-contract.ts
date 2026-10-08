import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const MAX_CHECK_OUTPUT_BYTES = 1024 * 1024;
export const MAX_CHECK_TIMEOUT_MS = 15 * 60 * 1000;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const workflowCheckSuiteIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u);

export const workflowCheckInputPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.startsWith("/") &&
      !/^[a-z]:/iu.test(value) &&
      value
        .split("/")
        .every(
          (segment) => segment !== "" && segment !== "." && segment !== "..",
        ),
    "must be a normalized workspace-relative path using forward slashes",
  );

export const workflowCheckRequestSchema = z
  .object({
    suite: workflowCheckSuiteIdSchema,
    manifestSha256: digestSchema,
    contractSha256: digestSchema,
    candidateSha256: digestSchema,
  })
  .strict();

export const workflowCheckFindingSchema = z
  .object({
    checkId: z.string().min(1).max(128),
    code: z.string().min(1).max(128),
    path: z.string().min(1).max(4096).optional(),
    line: z.number().int().positive().optional(),
    message: z.string().min(1).max(16_384),
  })
  .strict();

export const workflowCheckReceiptSchema = z
  .object({
    suite: workflowCheckSuiteIdSchema,
    suiteVersion: z.number().int().positive(),
    manifestSha256: digestSchema,
    contractSha256: digestSchema,
    candidateSha256: digestSchema,
    selected: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    admitted: z.boolean(),
    findings: z.array(workflowCheckFindingSchema).max(4096),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.passed + receipt.failed + receipt.skipped !==
      receipt.selected
    ) {
      context.addIssue({
        code: "custom",
        path: ["selected"],
        message: "must equal passed + failed + skipped",
      });
    }
    const computedAdmission =
      receipt.selected > 0 && receipt.failed === 0 && receipt.skipped === 0;
    if (receipt.admitted !== computedAdmission) {
      context.addIssue({
        code: "custom",
        path: ["admitted"],
        message: "must match the fail-closed check counts",
      });
    }
  });

export type WorkflowCheckRequest = z.infer<typeof workflowCheckRequestSchema>;
export type WorkflowCheckReceipt = z.infer<typeof workflowCheckReceiptSchema>;

export const workflowCheckHostContract = defineRpcContract({
  run: {
    input: z
      .object({
        cwd: z.string().min(1).max(4096),
        executable: z.string().min(1).max(4096),
        args: z.array(z.string().max(8192)).max(128),
        stdin: z.string().max(MAX_CHECK_OUTPUT_BYTES),
        timeoutMs: z.number().int().positive().max(MAX_CHECK_TIMEOUT_MS),
      })
      .strict(),
    output: z
      .object({
        exitCode: z.number().int().nullable(),
        signal: z.string().nullable(),
        stdout: z.string().max(MAX_CHECK_OUTPUT_BYTES),
        stderr: z.string().max(MAX_CHECK_OUTPUT_BYTES),
        timedOut: z.boolean(),
        outputTruncated: z.boolean(),
      })
      .strict(),
  },
});
