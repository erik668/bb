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

const acceptanceCriterionSchema = z
  .object({
    id: checkpointIdSchema,
    statement: z.string().min(1).max(8_192),
    provenBy: workflowAcceptanceProvenBySchema,
    detail: z.string().min(1).max(16_384).nullable(),
  })
  .strict();

/**
 * Declares that this acceptance checkpoint deliberately replaces an earlier
 * one. Absence means "this is the campaign's original contract", so it is
 * optional rather than nullable: the omission is the common case and carries
 * meaning, and the write path refuses a changed contract that omits it.
 *
 * This records an amendment; it does not authorize one. The reason is written
 * by the same agent the contract constrains, so its value is that the change
 * becomes attributable and visible rather than silent — the original body
 * survives in its own row and stays readable.
 */
const acceptanceAmendmentSchema = z
  .object({
    supersedes: checkpointIdSchema,
    reason: z.string().min(1).max(8_192),
  })
  .strict();

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
    criteria: z.array(acceptanceCriterionSchema).min(1).max(100),
    amends: acceptanceAmendmentSchema.optional(),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    addDuplicateIdIssues({
      entries: checkpoint.criteria,
      context,
      field: "criteria",
      message: "Acceptance criterion IDs must be unique",
    });
    if (checkpoint.amends?.supersedes === checkpoint.id) {
      context.addIssue({
        code: "custom",
        message:
          "An acceptance checkpoint cannot supersede itself; an amendment needs a new checkpoint ID so the superseded contract survives",
        path: ["amends", "supersedes"],
      });
    }
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
export type WorkflowAcceptanceAmendment = z.infer<
  typeof acceptanceAmendmentSchema
>;

/**
 * The single definition of "the same acceptance contract", shared by the write
 * guard that refuses a rewrite and the derivation that reports one. Two
 * canonicalizers would be two different answers to that question.
 *
 * Criterion order is not part of the contract, so criteria are sorted by ID
 * before comparison and reordering is not a rewrite. `detail` IS part of it: a
 * quietly deleted qualifier ("must also pass in the EU region") narrows what
 * done means, which is the drift shape this exists to catch. `title` and
 * `summary` are presentation and are excluded, so retitling stays free.
 */
export function canonicalizeAcceptanceCriteria(
  criteria: readonly WorkflowAcceptanceCriterion[],
): string {
  return JSON.stringify(
    [...criteria]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((criterion) => [
        criterion.id,
        criterion.statement,
        criterion.provenBy,
        criterion.detail,
      ]),
  );
}

const storedAcceptanceSchema = z
  .object({
    criteria: z.array(acceptanceCriterionSchema),
    amends: acceptanceAmendmentSchema.optional(),
  })
  .passthrough();

/**
 * Reads an acceptance body out of a stored checkpoint row for the write guard.
 *
 * The data layer holds raw JSON rather than a parsed checkpoint, so the parse
 * happens here, at that boundary, instead of casting there. Returns null when
 * the row carries no readable acceptance body: malformed JSON and rows written
 * outside the tool path cannot be compared, and the guard treats an
 * uncomparable row as absent rather than as a match.
 */
export function readStoredAcceptance(
  json: string,
): { canonical: string; supersedes: string | null } | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = storedAcceptanceSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    canonical: canonicalizeAcceptanceCriteria(parsed.data.criteria),
    supersedes: parsed.data.amends?.supersedes ?? null,
  };
}
