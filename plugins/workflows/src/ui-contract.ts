import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { workflowCheckpointSchema } from "./workflow-checkpoint.js";

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
      .object({ checkpoints: z.array(workflowCheckpointViewSchema) })
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
});

export type WorkflowCallView = z.infer<typeof workflowCallViewSchema>;
export type WorkflowPhaseView = z.infer<typeof workflowPhaseViewSchema>;
export type WorkflowRunView = z.infer<typeof workflowRunViewSchema>;
export type WorkflowCheckpointView = z.infer<
  typeof workflowCheckpointViewSchema
>;
