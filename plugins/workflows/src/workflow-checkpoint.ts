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
const uniqueCheckpointIdsSchema = (label: string) =>
  z
    .array(checkpointIdSchema)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: `${label} must be unique`,
    });
const checkpointDependencyIdsSchema =
  uniqueCheckpointIdsSchema("Dependency IDs");
/**
 * Acceptance criterion IDs are declared in the campaign's acceptance ledger,
 * which lives in a different run than most plans that reference it, so they
 * cannot be resolved structurally here. Coverage derivation reports references
 * that match no declared criterion.
 */
const checkpointAcceptanceIdsSchema = uniqueCheckpointIdsSchema(
  "Acceptance criterion IDs",
);
const checkpointNodeTypeSchema = z.enum(["work", "gate"]);
export const workflowAcceptanceProvenBySchema = z.enum([
  "command",
  "artifact",
  "human",
]);

function addDuplicateIdIssues(options: {
  entries: readonly { id: string }[];
  context: z.RefinementCtx;
  field: string;
  message: string;
}): void {
  const seen = new Set<string>();
  for (let index = 0; index < options.entries.length; index += 1) {
    const id = options.entries[index]!.id;
    if (seen.has(id)) {
      options.context.addIssue({
        code: "custom",
        message: options.message,
        path: [options.field, index, "id"],
      });
    }
    seen.add(id);
  }
}

export const WORKFLOW_CHECKPOINT_LIMITS = {
  bytes: 64 * 1024,
  nodes: 8_192,
  depth: 32,
} as const;
export const MAX_WORKFLOW_CHECKPOINTS_PER_RUN = 512;
export const MAX_WORKFLOW_CHECKPOINT_BYTES_PER_RUN = 4 * 1024 * 1024;

/**
 * The campaign's acceptance contract: the outcomes that define done, published
 * separately from the plans that pursue them. A plan is re-authored every run;
 * acceptance is the fixed reference those plans are measured against, so a
 * campaign whose every work item succeeded can still be shown to have built
 * something other than what it committed to.
 */
const acceptanceCheckpointSchema = z
  .object({
    kind: z.literal("acceptance"),
    id: checkpointIdSchema,
    title: checkpointTitleSchema,
    status: checkpointStatusSchema,
    summary: checkpointSummarySchema,
    criteria: z
      .array(
        z
          .object({
            id: checkpointIdSchema,
            statement: z.string().min(1).max(8_192),
            provenBy: workflowAcceptanceProvenBySchema,
            detail: z.string().min(1).max(16_384).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    addDuplicateIdIssues({
      entries: checkpoint.criteria,
      context,
      field: "criteria",
      message: "Acceptance criterion IDs must be unique",
    });
  });

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
            dependsOn: checkpointDependencyIdsSchema.optional(),
            nodeType: checkpointNodeTypeSchema.optional(),
            satisfies: checkpointAcceptanceIdsSchema.optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    addDuplicateIdIssues({
      entries: checkpoint.items,
      context,
      field: "items",
      message: "Plan item IDs must be unique",
    });
    const itemsById = new Map(checkpoint.items.map((item) => [item.id, item]));
    for (let index = 0; index < checkpoint.items.length; index += 1) {
      const item = checkpoint.items[index]!;
      const dependencies = item.dependsOn ?? [];
      for (
        let dependencyIndex = 0;
        dependencyIndex < dependencies.length;
        dependencyIndex += 1
      ) {
        const dependencyId = dependencies[dependencyIndex]!;
        if (dependencyId === item.id || !itemsById.has(dependencyId)) {
          context.addIssue({
            code: "custom",
            message:
              dependencyId === item.id
                ? "Plan items cannot depend on themselves"
                : `Unknown plan dependency ${dependencyId}`,
            path: ["items", index, "dependsOn", dependencyIndex],
          });
        }
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      const item = itemsById.get(id);
      const cyclic =
        item?.dependsOn?.some((dependencyId) => visit(dependencyId)) ?? false;
      visiting.delete(id);
      visited.add(id);
      return cyclic;
    };
    if (checkpoint.items.some((item) => visit(item.id))) {
      context.addIssue({
        code: "custom",
        message: "Plan dependencies must be acyclic",
        path: ["items"],
      });
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
    dependsOn: checkpointDependencyIdsSchema.optional(),
    nodeType: checkpointNodeTypeSchema.optional(),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    if (checkpoint.dependsOn?.includes(checkpoint.id)) {
      context.addIssue({
        code: "custom",
        message: "Work items cannot depend on themselves",
        path: ["dependsOn"],
      });
    }
  });

const transitionCheckpointSchema = z
  .object({
    kind: z.literal("transition"),
    id: checkpointIdSchema,
    title: checkpointTitleSchema,
    status: checkpointStatusSchema,
    summary: checkpointSummarySchema,
    actor: z.enum(["orchestrator", "synthesizer", "critic", "human", "system"]),
    fromState: z.string().min(1).max(128).nullable(),
    toState: z.string().min(1).max(128),
    workItemIds: checkpointDependencyIdsSchema,
    rationale: z.string().min(1).max(8_192),
    evidenceRefs: z.array(z.string().min(1).max(1_024)).max(100),
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
    acceptanceId: checkpointIdSchema.optional(),
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
  acceptanceCheckpointSchema,
  planCheckpointSchema,
  workItemCheckpointSchema,
  verificationCheckpointSchema,
  transitionCheckpointSchema,
]);

export const checkpointToolInputSchema = z
  .object({ checkpoint: workflowCheckpointSchema })
  .strict();

export type WorkflowCheckpoint = z.infer<typeof workflowCheckpointSchema>;
export type WorkflowAcceptanceCheckpoint = z.infer<
  typeof acceptanceCheckpointSchema
>;
export type WorkflowAcceptanceCriterion =
  WorkflowAcceptanceCheckpoint["criteria"][number];
export type WorkflowPlanCheckpoint = z.infer<typeof planCheckpointSchema>;
