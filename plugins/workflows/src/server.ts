import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  assertWorkflowArtifactIntegrity,
  createWorkflowArtifactService,
  defaultWorkflowArtifactDocuments,
  initializeWorkflowArtifactStorage,
  type WorkflowArtifactScope,
} from "./artifact-storage.js";
import { registerWorkflowCli } from "./cli.js";
import { migrations } from "./data.js";
import { toJsonValue } from "./json-value.js";
import { createWorkflowService } from "./service.js";
import { WORKFLOW_RUNS_REALTIME_CHANNEL } from "./realtime-channel.js";
import {
  DEFAULT_WORKFLOW_SETTINGS,
  registerWorkflowSettings,
} from "./settings.js";
import type { JsonValue } from "./types.js";
import { prepareWorkflowSource } from "./workflow-input.js";
import { checkpointToolInputSchema } from "./workflow-checkpoint.js";
import { workflowCampaignIdSchema } from "./workflow-campaign.js";
import { workflowUiRpcContract } from "./ui-contract.js";
import {
  buildWorkflowCheckpointView,
  buildWorkflowRunView,
} from "./ui-view.js";

const sourceInputFields = {
  script: z
    .string()
    .min(1)
    .describe(
      "Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().",
    )
    .optional(),
  source: z
    .string()
    .min(1)
    .describe("Alias for `script`. Do not provide both `source` and `script`.")
    .optional(),
  scriptPath: z
    .string()
    .min(1)
    .describe(
      "Path to a workflow script file on the origin environment's host. Relative paths start at the workspace root and all paths must remain inside that workspace.",
    )
    .optional(),
  name: z
    .string()
    .min(1)
    .describe(
      "Name of a saved workflow from the current workspace's .bb/workflows/ directory. Resolves to a self-contained script.",
    )
    .optional(),
} as const;
// zod 4's `z.json()` compiles to a self-referential `$defs` entry, and some
// model providers reject an entire tool list that contains a recursive `$ref`
// before the turn starts. Declare freeform JSON as `unknown` so the wire schema
// stays flat, then narrow with `toJsonValue` at each call site.
const freeformJson = z.unknown();

const runInputSchema = z
  .object({
    ...sourceInputFields,
    args: freeformJson
      .describe(
        "Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string — a stringified list breaks `args.filter`/`args.map` in the script. Use for parameterized named workflows (e.g. a research question).",
      )
      .default(null),
    resumeRunId: z
      .string()
      .min(1)
      .nullable()
      .describe(
        "Run ID of a prior BB workflow to resume from. Calls in the causally safe, longest unchanged prefix return cached results; the first edited, new, or concurrent call and everything after it run live. The prior run must be terminal and from the same project and environment.",
      )
      .default(null),
    campaignId: workflowCampaignIdSchema
      .nullable()
      .describe(
        "Stable build-campaign ID. Reuse it when a later top-level run continues the same human-visible build story. Child and resumed runs inherit it and reject conflicts.",
      )
      .default(null),
  })
  .strict();
const resultInputSchema = z
  .object({
    value: freeformJson.describe(
      "The final value matching the requested JSON Schema.",
    ),
  })
  .strict();

function jsonResult(value: unknown): PluginAgentToolResult {
  return JSON.stringify(value, null, 2);
}

function errorResult(error: string): PluginAgentToolResult {
  return { content: [{ type: "text", text: error }], isError: true };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = registerWorkflowSettings(bb);
  const db = bb.storage.database();
  initializeWorkflowArtifactStorage(db);
  bb.storage.migrate(db, migrations);
  assertWorkflowArtifactIntegrity(db);
  let initialSettings = DEFAULT_WORKFLOW_SETTINGS;
  try {
    initialSettings = await settings.get();
  } catch (error) {
    bb.status.needsConfiguration(
      `Workflow settings are invalid; defaults are active until the settings are corrected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const service = createWorkflowService(bb, db, initialSettings);
  const artifactService = createWorkflowArtifactService(bb, db);
  settings.onChange(
    (next) => service.updateSettings(next),
    (error) =>
      bb.status.needsConfiguration(
        `Workflow settings are invalid; the last valid values remain active: ${error.message}`,
      ),
  );
  registerWorkflowCli(bb, service, artifactService);

  function workflowForThread(threadId: string, runId: string | null) {
    const run =
      runId === null
        ? service.inspectLatestForThread(threadId)
        : service.inspect(runId);
    if (run === null) return null;
    if (
      run.originThreadId !== threadId &&
      run.presentationThreadId !== threadId
    ) {
      throw new Error("This workflow run is not available in this thread");
    }
    return run;
  }

  function campaignRepresentative(
    run: ReturnType<typeof workflowForThread>,
    threadId: string,
  ) {
    if (run === null) return null;
    if (run.presentationThreadId !== threadId) return run;
    const campaign = service.inspectCampaign(run.id);
    if (campaign === null) return run;
    const active = campaign.runs.filter(
      (entry) =>
        entry.run.status === "queued" || entry.run.status === "running",
    );
    const representative = (active.at(-1) ?? campaign.runs.at(-1))?.run;
    return representative === undefined
      ? run
      : (service.inspect(representative.id) ?? run);
  }

  function artifactScope(
    run: NonNullable<ReturnType<typeof workflowForThread>>,
  ): WorkflowArtifactScope {
    return {
      campaignId: run.campaignId,
      projectId: run.projectId,
      environmentId: run.environmentId,
      presentationThreadId: run.presentationThreadId,
      originRunId: run.rootRunId,
    };
  }

  function requireArtifactRun(threadId: string, runId: string | null) {
    const run = workflowForThread(threadId, runId);
    if (run === null)
      throw new Error("No workflow run is available for artifact review");
    return run;
  }

  function publishArtifactsChanged(threadId: string): void {
    bb.realtime.publish(WORKFLOW_RUNS_REALTIME_CHANNEL, { threadId });
  }

  bb.rpc.register(workflowUiRpcContract, {
    workflowActiveRuns({ threadId }) {
      const seenCampaigns = new Set<string>();
      return {
        runs: service
          .inspectActiveForThread(threadId)
          .filter((run) => {
            if (seenCampaigns.has(run.campaignId)) return false;
            seenCampaigns.add(run.campaignId);
            return true;
          })
          .map(buildWorkflowRunView),
      };
    },
    workflowRunView({ threadId, runId }) {
      const run = campaignRepresentative(
        workflowForThread(threadId, runId),
        threadId,
      );
      return { run: run === null ? null : buildWorkflowRunView(run) };
    },
    workflowRunDetails({ threadId, runId }) {
      const run = workflowForThread(threadId, runId);
      const campaign =
        run !== null && run.presentationThreadId === threadId
          ? service.inspectCampaign(run.id)
          : null;
      return {
        checkpoints:
          run === null
            ? []
            : service
                .inspectCheckpoints(run.id)
                .map(buildWorkflowCheckpointView),
        campaign:
          campaign === null
            ? null
            : {
                id: campaign.campaignId,
                detailedRunLimit: campaign.detailedRunLimit,
                omittedCheckpointRunCount: campaign.omittedCheckpointRunCount,
                coverage: campaign.coverage,
                coverageTruncated: campaign.coverageTruncated,
                runs: campaign.runs.map((entry) => ({
                  run: entry.run,
                  checkpoints: entry.checkpoints.map(
                    buildWorkflowCheckpointView,
                  ),
                  checkpointsOmitted: entry.checkpointsOmitted,
                })),
              },
      };
    },
    async workflowStopRun({ threadId, runId }) {
      const run = workflowForThread(threadId, runId);
      if (run === null) throw new Error(`Unknown workflow run ${runId}`);
      if (run.originThreadId !== threadId) {
        throw new Error(
          "Only the workflow origin thread can stop this workflow run",
        );
      }
      const stopped = await service.stop(run.id);
      const latest = workflowForThread(threadId, run.id);
      if (latest === null) throw new Error(`Unknown workflow run ${runId}`);
      return { stopped, run: buildWorkflowRunView(latest) };
    },
    workflowApproveAmendment({ threadId, runId, acceptanceId }) {
      const run = workflowForThread(threadId, runId);
      if (run === null) throw new Error(`Unknown workflow run ${runId}`);
      // Same boundary as stopping: the run's own thread is the human side of
      // this campaign, and the panel only offers the control there.
      if (run.originThreadId !== threadId) {
        throw new Error(
          "Only the workflow origin thread can approve this amendment",
        );
      }
      // Projected, not spread: the service also returns the canonical body it
      // bound to, and this contract's output is strict. The panel reads the
      // body from the coverage it refetches.
      const approval = service.approveAmendment({
        runId: run.id,
        acceptanceId,
        approvedByThreadId: threadId,
        surface: "panel",
      });
      return {
        acceptanceId: approval.acceptanceId,
        supersedes: approval.supersedes,
        newlyApproved: approval.newlyApproved,
      };
    },
    workflowArtifactList({ threadId, runId }) {
      const run = workflowForThread(threadId, runId);
      return {
        artifacts: run === null ? [] : artifactService.list(artifactScope(run)),
      };
    },
    workflowArtifactSeed({ threadId, runId, documents, clientMutationId }) {
      const run = requireArtifactRun(threadId, runId);
      const runView = buildWorkflowRunView(run);
      const result = artifactService.seed(
        artifactScope(run),
        documents ??
          defaultWorkflowArtifactDocuments({
            campaignName: run.name,
            description: runView.description,
            campaignId: run.campaignId,
          }),
        clientMutationId,
      );
      publishArtifactsChanged(run.presentationThreadId);
      return result;
    },
    workflowArtifactRead({ threadId, runId, artifactId, revision }) {
      const run = requireArtifactRun(threadId, runId);
      const scope = artifactScope(run);
      const detail = artifactService.read(
        scope,
        artifactId,
        revision ?? undefined,
      );
      for (const annotation of detail.annotations) {
        if (annotation.assistance?.status === "pending") {
          void artifactService
            .draftDecision(scope, run.name, annotation.id)
            .then(() => publishArtifactsChanged(run.presentationThreadId))
            .catch((error) =>
              bb.log.warn(
                `Artifact decision assistance recovery failed: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
        }
        const change = annotation.decision?.change;
        if (change?.assistance?.status === "pending") {
          void artifactService
            .draftArchitecture(scope, run.name, change.id)
            .then(() => publishArtifactsChanged(run.presentationThreadId))
            .catch((error) =>
              bb.log.warn(
                `Artifact architecture assistance recovery failed: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
        }
      }
      return detail;
    },
    workflowArtifactAnnotate({ threadId, runId, ...input }) {
      const run = requireArtifactRun(threadId, runId);
      const result = artifactService.addAnnotation(artifactScope(run), input);
      publishArtifactsChanged(run.presentationThreadId);
      void artifactService
        .draftDecision(artifactScope(run), run.name, result.annotationId)
        .then(() => publishArtifactsChanged(run.presentationThreadId))
        .catch((error) =>
          bb.log.warn(
            `Artifact decision assistance failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      return result;
    },
    workflowArtifactReply({ threadId, runId, ...input }) {
      const run = requireArtifactRun(threadId, runId);
      const result = artifactService.reply(artifactScope(run), input);
      publishArtifactsChanged(run.presentationThreadId);
      return result;
    },
    workflowArtifactDecide({ threadId, runId, ...input }) {
      const run = requireArtifactRun(threadId, runId);
      const result = artifactService.decide(artifactScope(run), input);
      publishArtifactsChanged(run.presentationThreadId);
      if (
        input.outcome === "accepted" &&
        input.semanticClass !== "editorial" &&
        result.changeId !== null
      ) {
        void artifactService
          .draftArchitecture(artifactScope(run), run.name, result.changeId)
          .then(() => publishArtifactsChanged(run.presentationThreadId))
          .catch((error) =>
            bb.log.warn(
              `Artifact architecture assistance failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
      }
      return result;
    },
    workflowArtifactAssessChange({ threadId, runId, ...input }) {
      const run = requireArtifactRun(threadId, runId);
      const result = artifactService.assessChange(artifactScope(run), input);
      publishArtifactsChanged(run.presentationThreadId);
      return result;
    },
    workflowArtifactConfirmChange({ threadId, runId, ...input }) {
      const run = requireArtifactRun(threadId, runId);
      const result = artifactService.confirmChange(artifactScope(run), input);
      publishArtifactsChanged(run.presentationThreadId);
      return result;
    },
    async workflowArtifactEnsureSteward({ threadId, runId }) {
      const run = requireArtifactRun(threadId, runId);
      const result = await artifactService.ensureSteward(
        artifactScope(run),
        run.name,
      );
      publishArtifactsChanged(run.presentationThreadId);
      return result;
    },
  });

  bb.agents.registerTool({
    name: "bb_workflow_run",
    experimental_presentation: {
      label: { pending: "Starting workflow", completed: "Started workflow" },
      icon: { glyph: "Workflow" },
    },
    description:
      "Execute a workflow script that orchestrates multiple subagents deterministically. Workflows run in the background — this tool returns immediately with a run ID and a `previewDirective`. After a successful call, emit that directive exactly once on its own line (not in a code fence) so BB renders live progress in chat. A completion notification is sent to the origin thread. Use `bb workflows status <run-id>` for a compact summary. For detailed history, redirect a bounded JSONL page from `bb workflows history <run-id> --cursor <call-index> --limit <1-100>` into `$BB_THREAD_STORAGE`, then inspect the file with normal filesystem tools.",
    parameters: runInputSchema,
    async execute(input, ctx) {
      try {
        const prepared = await prepareWorkflowSource(bb, ctx, input);
        const run = await service.start({
          projectId: ctx.projectId,
          originThreadId: ctx.threadId,
          source: prepared.source,
          args: toJsonValue(input.args, "args"),
          resumedFromRunId: input.resumeRunId,
          campaignId: input.campaignId,
        });
        const previewDirective = `::workflow-preview{run="${run.id}"}`;
        return jsonResult({
          runId: run.id,
          status: run.status,
          name: run.name,
          campaignId: run.campaignId,
          previewDirective,
        });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });

  bb.agents.registerTool({
    name: "bb_workflow_checkpoint",
    description:
      "Report durable structured progress for the active workflow call. Use stable checkpoint IDs so later calls update the same plan, work item, verification, or transition row. Report only state the worker actually knows; do not infer test results or changed files.",
    parameters: checkpointToolInputSchema,
    execute({ checkpoint }, ctx) {
      const result = service.submitCheckpoint(ctx.threadId, checkpoint);
      if (result.ok) return jsonResult({ accepted: true });
      return errorResult(result.error);
    },
  });

  bb.agents.registerTool({
    name: "bb_workflow_result",
    // The structured result is the turn's deliverable; its tool row is
    // bookkeeping beside it, so clients collapse the row by default.
    experimental_presentation: {
      label: {
        pending: "Returning structured result",
        completed: "Returned structured result",
      },
      icon: { glyph: "Workflow" },
      suppress: true,
    },
    description:
      'Use this tool to return your final response in the requested structured format. You MUST call this tool exactly once at the end of your response with {"value": ...} to provide the structured output.',
    parameters: resultInputSchema,
    async execute({ value }, ctx) {
      let parsed: JsonValue;
      try {
        parsed = toJsonValue(value, "value");
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
        );
      }
      const result = await service.submitStructuredResult(ctx.threadId, parsed);
      if (result.ok) return jsonResult({ accepted: true });
      return errorResult(result.error);
    },
  });

  bb.agents.configure((context) => {
    const worker = service.agentConfiguration(context.thread.id);
    if (worker !== null) {
      return {
        tools: worker.terminal
          ? []
          : [
              "bb_workflow_checkpoint",
              ...(worker.resultParameters === null
                ? []
                : [
                    {
                      name: "bb_workflow_result",
                      parameters: worker.resultParameters,
                    },
                  ]),
            ],
        skills: [],
        ...(worker.instructions === null
          ? {}
          : { instructions: worker.instructions }),
      };
    }
    if (context.origin.pluginId === bb.pluginId) {
      return {
        tools: ["bb_workflow_checkpoint", "bb_workflow_result"],
        skills: [],
        instructions:
          "You are starting as a BB workflow worker. Follow the workflow prompt. When the prompt assigns stable plan, work-item, verification, or transition IDs, report truthful progress with bb_workflow_checkpoint. Your final text IS the return value, not a human-facing message. If the prompt requests structured output, call bb_workflow_result exactly once at the end of your response.",
      };
    }
    return {
      tools: ["bb_workflow_run"],
      skills: ["workflows"],
      instructions:
        "When bb_workflow_run succeeds, copy its previewDirective into your response exactly once as a standalone line. Do not wrap it in backticks or a code fence, and do not invent or edit the run ID. The directive renders live workflow progress in BB chat. `bb workflows status <run-id>` returns a compact summary. For detailed history, redirect `bb workflows history <run-id> --cursor <call-index> --limit <1-100>` into a file under `$BB_THREAD_STORAGE`, then inspect that JSONL file with normal filesystem tools. Use each page record's `nextCursor` to continue.",
    };
  });

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    service.onThreadIdle(thread.id, lastAssistantText);
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    service.onThreadFailed(thread.id, error);
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    service.onThreadDeleted(thread.id);
  });

  bb.background.service("workflow-worker", {
    start(signal) {
      return service.runWorker(signal);
    },
  });
}
