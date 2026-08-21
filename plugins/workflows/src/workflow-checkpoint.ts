import { z } from "zod";

const checkpointIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const checkpointTitleSchema = z.string().min(1).max(256);
const checkpointSummarySchema = z.string().max(4_096).nullable();
const checkpointStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "skipped",
  "interrupted",
]);

export const WORKFLOW_CHECKPOINT_LIMITS = {
  bytes: 64 * 1024,
  nodes: 8_192,
  depth: 32,
} as const;
export const MAX_WORKFLOW_CHECKPOINTS_PER_RUN = 512;
export const MAX_WORKFLOW_CHECKPOINT_BYTES_PER_RUN = 4 * 1024 * 1024;

const planCheckpointSchema = z
  .object({
    kind: z.literal("plan"),
    id: checkpointIdSchema,
    title: checkpointTitleSchema,
    status: checkpointStatusSchema,
    summary: checkpointSummarySchema,
    detail: z.string().min(1).max(32_768).nullable(),
    items: z
      .array(
        z
          .object({
            id: checkpointIdSchema,
            title: checkpointTitleSchema,
            objective: z.string().min(1).max(8_192),
            detail: z.string().min(1).max(16_384).nullable(),
            ticketRef: z.string().min(1).max(128).nullable(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    const seen = new Set<string>();
    for (let index = 0; index < checkpoint.items.length; index += 1) {
      const id = checkpoint.items[index]!.id;
      if (seen.has(id)) {
        context.addIssue({
          code: "custom",
          message: "Plan item IDs must be unique",
          path: ["items", index, "id"],
        });
      }
      seen.add(id);
    }
  });

const workItemCheckpointSchema = z
  .object({
    kind: z.literal("work-item"),
    id: checkpointIdSchema,
    title: checkpointTitleSchema,
    status: checkpointStatusSchema,
    summary: checkpointSummarySchema,
    ticketRef: z.string().min(1).max(128).nullable(),
    changedFiles: z.array(z.string().min(1).max(4_096)).max(500),
    blocker: z.string().min(1).max(4_096).nullable(),
  })
  .strict();

const verificationCheckpointSchema = z
  .object({
    kind: z.literal("verification"),
    id: checkpointIdSchema,
    title: checkpointTitleSchema,
    status: checkpointStatusSchema,
    summary: checkpointSummarySchema,
    workItemId: checkpointIdSchema.nullable(),
    command: z.string().min(1).max(8_192).nullable(),
    counts: z
      .object({
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    if (
      checkpoint.status === "succeeded" &&
      checkpoint.counts !== null &&
      checkpoint.counts.failed > 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Succeeded verification cannot report failed tests",
        path: ["counts", "failed"],
      });
    }
  });

export const workflowCheckpointSchema = z.discriminatedUnion("kind", [
  planCheckpointSchema,
  workItemCheckpointSchema,
  verificationCheckpointSchema,
]);

export const checkpointToolInputSchema = z
  .object({ checkpoint: workflowCheckpointSchema })
  .strict();

export type WorkflowCheckpoint = z.infer<typeof workflowCheckpointSchema>;
