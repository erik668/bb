import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { WORKFLOW_ARTIFACT_KINDS } from "./artifact-storage.js";
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

const workflowArtifactKindSchema = z.enum(WORKFLOW_ARTIFACT_KINDS);
const workflowArtifactStatusSchema = z.enum([
  "draft",
  "accepted-pending-impact",
  "admitted",
  "superseded",
]);
const workflowArtifactSemanticClassSchema = z.enum([
  "editorial",
  "refinement",
  "contract",
  "architecture",
]);
const workflowArtifactSummarySchema = z
  .object({
    id: z.string(),
    kind: workflowArtifactKindSchema,
    title: z.string(),
    currentRevision: z.number().int().positive(),
    status: workflowArtifactStatusSchema,
    blobSha256: z.string().regex(/^[0-9a-f]{64}$/),
    openAnnotationCount: z.number().int().nonnegative(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
const workflowArtifactRevisionSchema = z
  .object({
    revision: z.number().int().positive(),
    status: workflowArtifactStatusSchema,
    blobSha256: z.string().regex(/^[0-9a-f]{64}$/),
    createdBy: z.string(),
    createdAt: z.number(),
  })
  .strict();
const workflowArtifactAnchorSchema = z
  .object({
    blockId: z.string().trim().min(1).max(256),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    exactQuote: z.string().min(1).max(32_768),
    prefix: z.string().max(256),
    suffix: z.string().max(256),
  })
  .strict()
  .refine((anchor) => anchor.end > anchor.start, {
    message: "Annotation end must be after start",
    path: ["end"],
  });
const workflowArtifactDecisionAssistanceSchema = z
  .object({
    status: z.enum(["pending", "ready", "error"]),
    semanticClass: workflowArtifactSemanticClassSchema.nullable(),
    rationale: z.string().nullable(),
    error: z.string().nullable(),
    generatedBy: z.literal("campaign-steward"),
  })
  .strict();
const workflowArtifactArchitectureAssistanceSchema = z
  .object({
    status: z.enum(["pending", "ready", "error"]),
    verdict: z
      .enum(["no-design-impact", "bounded-design-delta", "redesign-required"])
      .nullable(),
    summary: z.string().nullable(),
    error: z.string().nullable(),
    generatedBy: z.literal("architecting-agents"),
  })
  .strict();
const workflowArtifactChangeSchema = z
  .object({
    id: z.string(),
    semanticClass: workflowArtifactSemanticClassSchema,
    status: z.enum([
      "accepted-pending-impact",
      "awaiting-confirmation",
      "admitted",
    ]),
    architectureVerdict: z
      .enum(["no-design-impact", "bounded-design-delta", "redesign-required"])
      .nullable(),
    architectureSummary: z.string().nullable(),
    assistance: workflowArtifactArchitectureAssistanceSchema.nullable(),
    workerPropagation: z.literal("disabled"),
    createdAt: z.number(),
    admittedAt: z.number().nullable(),
  })
  .strict();
const workflowArtifactDecisionSchema = z
  .object({
    id: z.string(),
    outcome: z.enum(["accepted", "declined"]),
    semanticClass: workflowArtifactSemanticClassSchema,
    rationale: z.string(),
    decidedBy: z.string(),
    createdAt: z.number(),
    change: workflowArtifactChangeSchema.nullable(),
  })
  .strict();
const workflowArtifactCommentSchema = z
  .object({
    id: z.string(),
    body: z.string(),
    author: z.string(),
    createdAt: z.number(),
  })
  .strict();
const workflowArtifactAnnotationSchema = z
  .object({
    id: z.string(),
    artifactRevision: z.number().int().positive(),
    kind: z.enum(["highlight", "comment"]),
    anchor: workflowArtifactAnchorSchema,
    status: z.enum(["open", "resolved", "orphaned"]),
    createdBy: z.string(),
    createdAt: z.number(),
    comments: z.array(workflowArtifactCommentSchema),
    assistance: workflowArtifactDecisionAssistanceSchema.nullable(),
    decision: workflowArtifactDecisionSchema.nullable(),
  })
  .strict();
const workflowArtifactDetailSchema = z
  .object({
    artifact: workflowArtifactSummarySchema,
    selectedRevision: workflowArtifactRevisionSchema,
    content: z.string(),
    history: z.array(workflowArtifactRevisionSchema),
    annotations: z.array(workflowArtifactAnnotationSchema),
    stewardThreadId: z.string().nullable(),
  })
  .strict();
const artifactLookupInputSchema = runLookupInputSchema.extend({
  artifactId: z.string().trim().min(1),
  revision: z.number().int().positive().nullable(),
});
const artifactMutationBaseSchema = runLookupInputSchema.extend({
  clientMutationId: z.string().trim().min(1).max(200),
});

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
  workflowArtifactList: {
    input: runLookupInputSchema,
    output: z
      .object({ artifacts: z.array(workflowArtifactSummarySchema) })
      .strict(),
  },
  workflowArtifactSeed: {
    input: artifactMutationBaseSchema.extend({
      documents: z
        .array(
          z
            .object({
              kind: workflowArtifactKindSchema,
              title: z.string().trim().min(1).max(256),
              content: z
                .string()
                .min(1)
                .max(512 * 1024),
              expectedRevision: z.number().int().positive().optional(),
            })
            .strict(),
        )
        .max(3)
        .nullable(),
    }),
    output: z
      .object({ artifacts: z.array(workflowArtifactSummarySchema) })
      .strict(),
  },
  workflowArtifactRead: {
    input: artifactLookupInputSchema,
    output: workflowArtifactDetailSchema,
  },
  workflowArtifactAnnotate: {
    input: artifactMutationBaseSchema.extend({
      artifactId: z.string().trim().min(1),
      revision: z.number().int().positive(),
      kind: z.enum(["highlight", "comment"]),
      anchor: workflowArtifactAnchorSchema,
      body: z
        .string()
        .max(32 * 1024)
        .nullable(),
    }),
    output: z.object({ annotationId: z.string() }).strict(),
  },
  workflowArtifactReply: {
    input: artifactMutationBaseSchema.extend({
      annotationId: z.string().trim().min(1),
      body: z
        .string()
        .trim()
        .min(1)
        .max(32 * 1024),
    }),
    output: z.object({ commentId: z.string() }).strict(),
  },
  workflowArtifactDecide: {
    input: artifactMutationBaseSchema.extend({
      annotationId: z.string().trim().min(1),
      outcome: z.enum(["accepted", "declined"]),
      semanticClass: workflowArtifactSemanticClassSchema,
      rationale: z.string().max(32 * 1024),
    }),
    output: z
      .object({ decisionId: z.string(), changeId: z.string().nullable() })
      .strict(),
  },
  workflowArtifactAssessChange: {
    input: artifactMutationBaseSchema.extend({
      changeId: z.string().trim().min(1),
      verdict: z.enum([
        "no-design-impact",
        "bounded-design-delta",
        "redesign-required",
      ]),
      summary: z
        .string()
        .trim()
        .min(1)
        .max(32 * 1024),
    }),
    output: z
      .object({
        changeId: z.string(),
        status: z.literal("awaiting-confirmation"),
      })
      .strict(),
  },
  workflowArtifactConfirmChange: {
    input: artifactMutationBaseSchema.extend({
      changeId: z.string().trim().min(1),
    }),
    output: z
      .object({
        changeId: z.string(),
        status: z.literal("admitted"),
        workerPropagation: z.literal("disabled"),
      })
      .strict(),
  },
  workflowArtifactEnsureSteward: {
    input: runLookupInputSchema,
    output: z.object({ threadId: z.string() }).strict(),
  },
});

export type WorkflowCallView = z.infer<typeof workflowCallViewSchema>;
export type WorkflowPhaseView = z.infer<typeof workflowPhaseViewSchema>;
export type WorkflowRunView = z.infer<typeof workflowRunViewSchema>;
export type WorkflowCheckpointView = z.infer<
  typeof workflowCheckpointViewSchema
>;
export type WorkflowCampaignView = z.infer<typeof workflowCampaignViewSchema>;
export type WorkflowArtifactSummaryView = z.infer<
  typeof workflowArtifactSummarySchema
>;
export type WorkflowArtifactDetailView = z.infer<
  typeof workflowArtifactDetailSchema
>;
export type WorkflowArtifactAnchorView = z.infer<
  typeof workflowArtifactAnchorSchema
>;
