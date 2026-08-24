import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MAX_WORKFLOW_RUNS_PER_CAMPAIGN } from "./workflow-campaign.js";
import { workflowCheckpointSchema } from "./workflow-checkpoint.js";
import { workflowAcceptanceCoverageSchema } from "./workflow-coverage.js";

const workflowRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

const workflowCallViewSchema = z
  .object({
    id: z.string(),
    index: z.number().int().nonnegative(),
    label: z.string(),
    phase: z.string().nullable(),
    status: workflowRunStatusSchema,
    provider: z.string(),
    model: z.string(),
    reasoningLevel: z.string(),
    cached: z.boolean(),
    childThreadId: z.string().nullable(),
    promptBytes: z.number().int().nonnegative(),
    contextMinimumTokens: z.number().int().positive().nullable(),
    contextFit: z.enum(["untracked", "unknown", "fit", "undersized"]),
    observedContextUsedTokens: z.number().int().nonnegative().nullable(),
    observedModelContextWindow: z.number().int().positive().nullable(),
    contextUsageEstimated: z.boolean().nullable(),
    providerRetryAttempts: z.number().int().nonnegative(),
    repairAttempts: z.number().int().nonnegative(),
    error: z.string().nullable(),
    createdAt: z.number(),
    startedAt: z.number().nullable(),
    finishedAt: z.number().nullable(),
  })
  .strict();

const workflowPhaseViewSchema = z
  .object({
    title: z.string(),
    detail: z.string().nullable(),
    calls: z.array(workflowCallViewSchema),
  })
  .strict();

const workflowRunViewSchema = z
  .object({
    id: z.string(),
    originThreadId: z.string(),
    presentationThreadId: z.string(),
    parentRunId: z.string().nullable(),
    rootRunId: z.string(),
    campaignId: z.string(),
    name: z.string(),
    description: z.string(),
    status: workflowRunStatusSchema,
    currentPhase: z.string().nullable(),
    phases: z.array(workflowPhaseViewSchema),
    unphasedCalls: z.array(workflowCallViewSchema),
    resultAvailable: z.boolean(),
    error: z.string().nullable(),
    createdAt: z.number(),
    startedAt: z.number().nullable(),
    finishedAt: z.number().nullable(),
  })
  .strict();

const workflowCheckpointViewSchema = z
  .object({
    id: z.string(),
    checkpoint: workflowCheckpointSchema,
    phase: z.string().nullable(),
    childThreadId: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();

const workflowCampaignRunSummarySchema = z
  .object({
    id: z.string(),
    campaignId: z.string(),
    name: z.string(),
    status: workflowRunStatusSchema,
    createdAt: z.number(),
    startedAt: z.number().nullable(),
    finishedAt: z.number().nullable(),
  })
  .strict();

const workflowCampaignViewSchema = z
  .object({
    id: z.string(),
    detailedRunLimit: z.number().int().positive(),
    omittedCheckpointRunCount: z.number().int().nonnegative(),
    /** Null when the campaign declared no acceptance contract to measure. */
    coverage: workflowAcceptanceCoverageSchema.nullable(),
    /** True when the campaign ledger outgrew the coverage read's row cap. */
    coverageTruncated: z.boolean(),
    runs: z
      .array(
        z
          .object({
            run: workflowCampaignRunSummarySchema,
            checkpoints: z.array(workflowCheckpointViewSchema),
            checkpointsOmitted: z.boolean(),
          })
          .strict(),
      )
      .max(MAX_WORKFLOW_RUNS_PER_CAMPAIGN),
  })
  .strict();

const runLookupInputSchema = z
  .object({
    threadId: z.string().trim().min(1),
    runId: z.string().trim().min(1).nullable(),
  })
  .strict();

const threadLookupInputSchema = z
  .object({ threadId: z.string().trim().min(1) })
  .strict();

export const workflowUiRpcContract = defineRpcContract({
  workflowActiveRuns: {
    input: threadLookupInputSchema,
    output: z.object({ runs: z.array(workflowRunViewSchema) }).strict(),
  },
  workflowRunView: {
    input: runLookupInputSchema,
    output: z.object({ run: workflowRunViewSchema.nullable() }).strict(),
  },
  workflowRunDetails: {
    input: runLookupInputSchema,
    output: z
      .object({
        checkpoints: z.array(workflowCheckpointViewSchema),
        campaign: workflowCampaignViewSchema.nullable().optional(),
      })
      .strict(),
  },
  workflowStopRun: {
    input: z
      .object({
        threadId: z.string().trim().min(1),
        runId: z.string().trim().min(1),
      })
      .strict(),
    output: z
      .object({ stopped: z.boolean(), run: workflowRunViewSchema })
      .strict(),
  },
  // The approval a workflow cannot mint: the worker's tool list is exactly the
  // checkpoint and result tools, so an amendment only takes effect once it
  // arrives through this route or the CLI.
  workflowApproveAmendment: {
    input: z
      .object({
        threadId: z.string().trim().min(1),
        runId: z.string().trim().min(1),
        acceptanceId: z.string().trim().min(1),
      })
      .strict(),
    output: z
      .object({
        acceptanceId: z.string(),
        supersedes: z.string(),
        newlyApproved: z.boolean(),
      })
      .strict(),
  },
});

export type WorkflowCallView = z.infer<typeof workflowCallViewSchema>;
export type WorkflowPhaseView = z.infer<typeof workflowPhaseViewSchema>;
export type WorkflowRunView = z.infer<typeof workflowRunViewSchema>;
export type WorkflowCheckpointView = z.infer<
  typeof workflowCheckpointViewSchema
>;
export type WorkflowCampaignView = z.infer<typeof workflowCampaignViewSchema>;
