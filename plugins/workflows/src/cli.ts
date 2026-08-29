import { randomUUID } from "node:crypto";
import type {
  BbPluginApi,
  PluginCliContext,
  PluginCliResult,
} from "@get-bb/plugin-sdk";
import {
  defaultWorkflowArtifactDocuments,
  type WorkflowArtifactScope,
  type WorkflowArtifactSemanticClass,
  type WorkflowArtifactService,
} from "./artifact-storage.js";
import type { JsonValue } from "./types.js";
import type {
  WorkflowCallInspection,
  WorkflowRunInspectionPage,
  WorkflowService,
} from "./service.js";
import type { WorkflowRunRow } from "./data.js";
import type { WorkflowSourceInput } from "./source-resolution.js";
import {
  parseStoredWorkflowSettings,
  workflowRunSettingsSnapshot,
} from "./settings.js";
import { prepareWorkflowSource } from "./workflow-input.js";
import { buildWorkflowRunView } from "./ui-view.js";
import { WORKFLOW_RUNS_REALTIME_CHANNEL } from "./realtime-channel.js";

const STATUS_INLINE_RESULT_MAX_BYTES = 8 * 1024;
const STATUS_DISPLAY_TEXT_MAX_BYTES = 1_024;
const STATUS_ERROR_MAX_BYTES = 4 * 1_024;
const LIST_DISPLAY_TEXT_MAX_BYTES = 128;
const LIST_ERROR_MAX_BYTES = 256;
const DEFAULT_HISTORY_LIMIT = 10;
const MAX_HISTORY_LIMIT = 100;
const MAX_LIST_LIMIT = 50;

function success(value: unknown): PluginCliResult {
  return { exitCode: 0, stdout: `${JSON.stringify(value)}\n` };
}

function jsonLines(records: readonly unknown[]): PluginCliResult {
  return {
    exitCode: 0,
    stdout: `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  };
}

function failure(message: string): PluginCliResult {
  return { exitCode: 1, stderr: `${message}\n` };
}

function requireContext(ctx: PluginCliContext): {
  projectId: string;
  threadId: string;
} {
  if (ctx.projectId === undefined || ctx.threadId === undefined) {
    throw new Error("This command must run inside a BB project thread");
  }
  return { projectId: ctx.projectId, threadId: ctx.threadId };
}

interface ParsedArguments {
  options: ReadonlyMap<string, string>;
  positionals: readonly string[];
}

function parseArguments(
  argv: readonly string[],
  allowedOptions: readonly string[],
  positionalDescription: string | null = null,
): ParsedArguments {
  const allowed = new Set(allowedOptions);
  const options = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (!allowed.has(argument)) {
      throw new Error(`Unknown option ${argument}`);
    }
    if (options.has(argument)) {
      throw new Error(`${argument} may be provided only once`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    options.set(argument, value);
    index += 1;
  }
  if (positionalDescription === null && positionals.length > 0) {
    throw new Error(`Unexpected positional argument ${positionals[0]}`);
  }
  if (positionalDescription !== null && positionals.length !== 1) {
    throw new Error(
      positionals.length === 0
        ? `${positionalDescription} requires a run ID`
        : `${positionalDescription} accepts exactly one run ID`,
    );
  }
  return { options, positionals };
}

function sourceInput(
  options: ReadonlyMap<string, string>,
  cwd: string | undefined,
): WorkflowSourceInput {
  return {
    script: options.get("--script"),
    source: options.get("--source"),
    scriptPath: options.get("--file"),
    scriptPathBase: cwd,
    name: options.get("--name"),
  };
}

function parseJsonOption(value: string | undefined): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw new Error(
      `--args must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseIntegerOption(
  options: ReadonlyMap<string, string>,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = options.get(name);
  if (raw !== undefined && !/^(0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  const value = raw === undefined ? defaultValue : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function requiredOption(
  options: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = options.get(name)?.trim();
  if (value === undefined || value === "")
    throw new Error(`${name} is required`);
  return value;
}

function mutationId(options: ReadonlyMap<string, string>): string {
  return options.get("--mutation")?.trim() || `cli-${randomUUID()}`;
}

function parseStoredJson(value: string, description: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw new Error(
      `Persisted ${description} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function utf8CodePointBytes(value: string): number {
  const codePoint = value.codePointAt(0)!;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function boundedText(
  value: string | null,
  maximumBytes: number,
): {
  value: string | null;
  truncated: boolean;
} {
  if (value === null) return { value, truncated: false };
  const characters: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8CodePointBytes(character);
    if (bytes + characterBytes > maximumBytes) {
      const prefixBudget = maximumBytes - utf8CodePointBytes("…");
      while (bytes > prefixBudget) {
        bytes -= utf8CodePointBytes(characters.pop()!);
      }
      return { value: `${characters.join("")}…`, truncated: true };
    }
    characters.push(character);
    bytes += characterBytes;
  }
  return { value, truncated: false };
}

function inlineRunResult(run: WorkflowRunRow): {
  available: boolean;
  omitted: boolean;
  value: JsonValue;
} {
  if (run.resultJson === null) {
    return { available: false, omitted: false, value: null };
  }
  if (
    new TextEncoder().encode(run.resultJson).byteLength >
    STATUS_INLINE_RESULT_MAX_BYTES
  ) {
    return { available: true, omitted: true, value: null };
  }
  return {
    available: true,
    omitted: false,
    value: parseStoredJson(run.resultJson, "workflow result"),
  };
}

function statusSummary(page: WorkflowRunInspectionPage) {
  const { run, callCounts } = page;
  const result = inlineRunResult(run);
  const name = boundedText(run.name, STATUS_DISPLAY_TEXT_MAX_BYTES);
  const phase = boundedText(run.phase, STATUS_DISPLAY_TEXT_MAX_BYTES);
  const originProvider = boundedText(
    run.originProvider,
    STATUS_DISPLAY_TEXT_MAX_BYTES,
  );
  const originModel = boundedText(
    run.originModel,
    STATUS_DISPLAY_TEXT_MAX_BYTES,
  );
  const originReasoningLevel = boundedText(
    run.originReasoningLevel,
    STATUS_DISPLAY_TEXT_MAX_BYTES,
  );
  const originPermissionMode = boundedText(
    run.originPermissionMode,
    STATUS_DISPLAY_TEXT_MAX_BYTES,
  );
  const error = boundedText(run.error, STATUS_ERROR_MAX_BYTES);
  const notificationError = boundedText(
    run.notificationError,
    STATUS_ERROR_MAX_BYTES,
  );
  return {
    id: run.id,
    projectId: run.projectId,
    originThreadId: run.originThreadId,
    presentationThreadId: run.presentationThreadId,
    parentRunId: run.parentRunId,
    rootRunId: run.rootRunId,
    campaignId: run.campaignId,
    environmentId: run.environmentId,
    originProvider: originProvider.value,
    originProviderTruncated: originProvider.truncated,
    originModel: originModel.value,
    originModelTruncated: originModel.truncated,
    originReasoningLevel: originReasoningLevel.value,
    originReasoningLevelTruncated: originReasoningLevel.truncated,
    originPermissionMode: originPermissionMode.value,
    originPermissionModeTruncated: originPermissionMode.truncated,
    name: name.value,
    nameTruncated: name.truncated,
    sourceHash: run.sourceHash,
    sourceBytes: new TextEncoder().encode(run.source).byteLength,
    settings: workflowRunSettingsSnapshot(
      parseStoredWorkflowSettings(
        parseStoredJson(run.settingsJson, "workflow settings"),
      ),
    ),
    status: run.status,
    phase: phase.value,
    phaseTruncated: phase.truncated,
    resumedFromRunId: run.resumedFromRunId,
    result: result.value,
    resultAvailable: result.available,
    resultOmitted: result.omitted,
    error: error.value,
    errorTruncated: error.truncated,
    calls: callCounts,
    notification: {
      outcome: run.notificationOutcome,
      attemptCount: run.notificationAttemptCount,
      nextAttemptAt: run.notificationNextAttemptAt,
      error: notificationError.value,
      errorTruncated: notificationError.truncated,
    },
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    history: {
      format: "jsonl",
      pageUsage: `bb workflows history ${run.id} --cursor 0 --limit ${DEFAULT_HISTORY_LIMIT}`,
      fileUsage: `mkdir -p "$BB_THREAD_STORAGE/workflows" && bb workflows history ${run.id} --cursor 0 --limit ${DEFAULT_HISTORY_LIMIT} > "$BB_THREAD_STORAGE/workflows/${run.id}.jsonl"`,
    },
  };
}

function listRunSummary(run: WorkflowRunRow) {
  const name = boundedText(run.name, LIST_DISPLAY_TEXT_MAX_BYTES);
  const phase = boundedText(run.phase, LIST_DISPLAY_TEXT_MAX_BYTES);
  const error = boundedText(run.error, LIST_ERROR_MAX_BYTES);
  return {
    id: run.id,
    originThreadId: run.originThreadId,
    presentationThreadId: run.presentationThreadId,
    parentRunId: run.parentRunId,
    rootRunId: run.rootRunId,
    campaignId: run.campaignId,
    environmentId: run.environmentId,
    name: name.value,
    nameTruncated: name.truncated,
    status: run.status,
    phase: phase.value,
    phaseTruncated: phase.truncated,
    resumedFromRunId: run.resumedFromRunId,
    resultAvailable: run.resultJson !== null,
    error: error.value,
    errorTruncated: error.truncated,
    notificationOutcome: run.notificationOutcome,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

function runLogRecord(run: WorkflowRunRow, exportedAt: number) {
  const { argsJson, settingsJson, resultJson, ...fields } = run;
  return {
    type: "run",
    logVersion: 1,
    exportedAt,
    ...fields,
    args: parseStoredJson(argsJson, "workflow args"),
    settings: workflowRunSettingsSnapshot(
      parseStoredWorkflowSettings(
        parseStoredJson(settingsJson, "workflow settings"),
      ),
    ),
    resultAvailable: resultJson !== null,
    result:
      resultJson === null
        ? null
        : parseStoredJson(resultJson, "workflow result"),
  };
}

function runReferenceLogRecord(run: WorkflowRunRow, exportedAt: number) {
  return {
    type: "run-reference",
    logVersion: 1,
    exportedAt,
    id: run.id,
    originThreadId: run.originThreadId,
    presentationThreadId: run.presentationThreadId,
    parentRunId: run.parentRunId,
    rootRunId: run.rootRunId,
    campaignId: run.campaignId,
    name: run.name,
    status: run.status,
    phase: run.phase,
  };
}

function callLogRecord(call: WorkflowCallInspection, exportedAt: number) {
  const { optionsJson, resultJson, ...fields } = call;
  void optionsJson;
  return {
    type: "call",
    logVersion: 1,
    exportedAt,
    ...fields,
    label: call.options.title,
    phase: call.options.phase,
    resultAvailable: resultJson !== null,
    result:
      resultJson === null
        ? null
        : parseStoredJson(resultJson, "workflow call result"),
  };
}

export function registerWorkflowCli(
  bb: BbPluginApi,
  service: WorkflowService,
  artifactService: WorkflowArtifactService,
): void {
  bb.cli.register({
    name: "workflows",
    summary: "Run and inspect durable BB workflows",
    commands: [
      {
        name: "run",
        summary: "Start a workflow and return immediately",
        usage:
          "bb workflows run (--script '<javascript>'|--file <path>|--name <name>) [--args '<json>'] [--resume <run-id>] [--present-in <thread-id>] [--campaign <campaign-id>]",
      },
      {
        name: "validate",
        summary: "Validate workflow source and literal model selections",
        usage:
          "bb workflows validate (--script '<javascript>'|--file <path>|--name <name>)",
      },
      {
        name: "status",
        summary: "Show a compact workflow run summary",
        usage: "bb workflows status <run-id>",
      },
      {
        name: "details",
        summary: "Show structured plan, implementation, and verification state",
        usage: "bb workflows details <run-id>",
      },
      {
        name: "history",
        summary: "Read one JSONL page of workflow run and call history",
        usage:
          "bb workflows history <run-id> [--cursor <call-index>] [--limit <1-100>]",
      },
      {
        name: "list",
        summary: "List recent project workflow runs",
        usage: "bb workflows list [--limit <1-50>]",
      },
      {
        name: "stop",
        summary: "Cancel a workflow run",
        usage: "bb workflows stop <run-id>",
      },
      {
        name: "approve-amendment",
        summary: "Approve a declared change to a campaign acceptance contract",
        usage:
          "bb workflows approve-amendment <run-id> --acceptance <acceptance-checkpoint-id>",
      },
      {
        name: "artifact",
        summary: "Review durable workflow campaign artifacts",
        usage:
          "bb workflows artifact <list|seed|show|revise|comment|reply|decide|assess|confirm|steward> <run-id> [options]",
      },
    ],
    async run(argv, ctx) {
      try {
        const command = argv[0];
        if (command === "run") {
          const { options } = parseArguments(argv.slice(1), [
            "--script",
            "--source",
            "--file",
            "--name",
            "--args",
            "--resume",
            "--present-in",
            "--campaign",
          ]);
          const context = requireContext(ctx);
          const prepared = await prepareWorkflowSource(
            bb,
            context,
            sourceInput(options, ctx.cwd),
          );
          const run = await service.start({
            projectId: context.projectId,
            originThreadId: context.threadId,
            presentationThreadId: options.get("--present-in") ?? null,
            campaignId: options.get("--campaign") ?? null,
            source: prepared.source,
            args: parseJsonOption(options.get("--args")),
            resumedFromRunId: options.get("--resume") ?? null,
          });
          return success({
            runId: run.id,
            campaignId: run.campaignId,
            name: run.name,
            status: run.status,
          });
        }
        if (command === "validate") {
          const { options } = parseArguments(argv.slice(1), [
            "--script",
            "--source",
            "--file",
            "--name",
          ]);
          const context = requireContext(ctx);
          const prepared = await prepareWorkflowSource(
            bb,
            context,
            sourceInput(options, ctx.cwd),
          );
          return success({
            ...prepared.validation,
            origin: prepared.origin,
          });
        }
        if (command === "status") {
          const { positionals } = parseArguments(argv.slice(1), [], "status");
          const context = requireContext(ctx);
          const runId = positionals[0]!;
          const page = service.inspectPage(runId, -1, 1);
          if (page === null || page.run.projectId !== context.projectId) {
            throw new Error(`Unknown workflow run ${runId}`);
          }
          return success(statusSummary(page));
        }
        if (command === "details") {
          const { positionals } = parseArguments(argv.slice(1), [], "details");
          const context = requireContext(ctx);
          const runId = positionals[0]!;
          const run = service.get(runId);
          if (run === null || run.projectId !== context.projectId) {
            throw new Error(`Unknown workflow run ${runId}`);
          }
          const campaign = service.inspectCampaign(runId);
          return success({
            runId,
            campaignId: run.campaignId,
            // The campaign's own outcome ledger, so an orchestrator resuming
            // work can read what it has actually closed instead of restating
            // its plan back to itself.
            acceptanceCoverage: campaign?.coverage ?? null,
            acceptanceCoverageTruncated: campaign?.coverageTruncated ?? false,
            checkpoints: service.inspectCheckpoints(runId).map((entry) => ({
              id: entry.id,
              checkpoint: entry.checkpoint,
              phase: entry.phase,
              childThreadId: entry.childThreadId,
              createdAt: entry.createdAt,
              updatedAt: entry.updatedAt,
            })),
            campaignRuns:
              campaign?.runs.map((entry) => ({
                runId: entry.run.id,
                name: entry.run.name,
                status: entry.run.status,
                checkpointsOmitted: entry.checkpointsOmitted,
                checkpoints: entry.checkpoints.map((checkpoint) => ({
                  id: checkpoint.id,
                  checkpoint: checkpoint.checkpoint,
                  phase: checkpoint.phase,
                  childThreadId: checkpoint.childThreadId,
                  createdAt: checkpoint.createdAt,
                  updatedAt: checkpoint.updatedAt,
                })),
              })) ?? [],
          });
        }
        if (command === "history") {
          const { options, positionals } = parseArguments(
            argv.slice(1),
            ["--cursor", "--limit"],
            "history",
          );
          const runId = positionals[0]!;
          const cursor = parseIntegerOption(
            options,
            "--cursor",
            0,
            0,
            Number.MAX_SAFE_INTEGER,
          );
          const limit = parseIntegerOption(
            options,
            "--limit",
            DEFAULT_HISTORY_LIMIT,
            1,
            MAX_HISTORY_LIMIT,
          );
          const context = requireContext(ctx);
          const page = service.inspectPage(runId, cursor - 1, limit + 1);
          if (page === null || page.run.projectId !== context.projectId) {
            throw new Error(`Unknown workflow run ${runId}`);
          }
          const exportedAt = Date.now();
          const calls = page.calls.slice(0, limit);
          const hasMore = page.calls.length > limit;
          const nextCursor = hasMore ? calls.at(-1)!.callIndex + 1 : null;
          return jsonLines([
            cursor === 0
              ? runLogRecord(page.run, exportedAt)
              : runReferenceLogRecord(page.run, exportedAt),
            ...calls.map((call) => callLogRecord(call, exportedAt)),
            {
              type: "page",
              logVersion: 1,
              runId,
              cursor,
              limit,
              returned: calls.length,
              totalCalls: page.callCounts.total,
              hasMore,
              nextCursor,
              exportedAt,
            },
          ]);
        }
        if (command === "list") {
          const { options } = parseArguments(argv.slice(1), ["--limit"]);
          const limit = parseIntegerOption(
            options,
            "--limit",
            20,
            1,
            MAX_LIST_LIMIT,
          );
          const context = requireContext(ctx);
          return success(
            service.list(context.projectId, limit).map(listRunSummary),
          );
        }
        if (command === "stop") {
          const { positionals } = parseArguments(argv.slice(1), [], "stop");
          const context = requireContext(ctx);
          const runId = positionals[0]!;
          const run = service.get(runId);
          if (run === null || run.projectId !== context.projectId) {
            throw new Error(`Unknown workflow run ${runId}`);
          }
          return success({ runId, stopped: await service.stop(runId) });
        }
        if (command === "approve-amendment") {
          const { options, positionals } = parseArguments(
            argv.slice(1),
            ["--acceptance"],
            "approve-amendment",
          );
          const acceptanceId = options.get("--acceptance");
          if (acceptanceId === undefined) {
            throw new Error("approve-amendment requires --acceptance");
          }
          const context = requireContext(ctx);
          const runId = positionals[0]!;
          const run = service.get(runId);
          if (run === null || run.projectId !== context.projectId) {
            throw new Error(`Unknown workflow run ${runId}`);
          }
          // The approving thread is recorded, not asserted by the caller: this
          // is the provenance that replaces a self-attested amendment reason.
          return success(
            service.approveAmendment({
              runId,
              acceptanceId,
              approvedByThreadId: context.threadId,
              surface: "cli",
            }),
          );
        }
        if (command === "artifact") {
          const action = argv[1];
          const allowedActions = new Set([
            "list",
            "seed",
            "show",
            "revise",
            "comment",
            "reply",
            "decide",
            "assess",
            "confirm",
            "steward",
          ]);
          if (action === undefined || !allowedActions.has(action)) {
            throw new Error(
              "Usage: bb workflows artifact <list|seed|show|revise|comment|reply|decide|assess|confirm|steward> <run-id> [options]",
            );
          }
          const allowedOptionsByAction: Record<string, readonly string[]> = {
            list: [],
            seed: ["--mutation"],
            show: ["--id", "--revision"],
            revise: ["--id", "--content", "--expected-revision", "--mutation"],
            comment: [
              "--id",
              "--revision",
              "--quote",
              "--start",
              "--body",
              "--mutation",
            ],
            reply: ["--annotation", "--body", "--mutation"],
            decide: [
              "--annotation",
              "--outcome",
              "--class",
              "--rationale",
              "--mutation",
            ],
            assess: ["--change", "--verdict", "--summary", "--mutation"],
            confirm: ["--change", "--mutation"],
            steward: [],
          };
          const { options, positionals } = parseArguments(
            argv.slice(2),
            allowedOptionsByAction[action]!,
            `artifact ${action}`,
          );
          const context = requireContext(ctx);
          const runId = positionals[0]!;
          const run = service.inspect(runId);
          if (
            run === null ||
            run.projectId !== context.projectId ||
            (run.originThreadId !== context.threadId &&
              run.presentationThreadId !== context.threadId)
          ) {
            throw new Error(`Unknown workflow run ${runId}`);
          }
          const scope: WorkflowArtifactScope = {
            campaignId: run.campaignId,
            projectId: run.projectId,
            environmentId: run.environmentId,
            presentationThreadId: run.presentationThreadId,
            originRunId: run.rootRunId,
          };
          const publishChanged = () =>
            bb.realtime.publish(WORKFLOW_RUNS_REALTIME_CHANNEL, {
              threadId: run.presentationThreadId,
            });
          if (action === "list") return success(artifactService.list(scope));
          if (action === "seed") {
            const runView = buildWorkflowRunView(run);
            const result = artifactService.seed(
              scope,
              defaultWorkflowArtifactDocuments({
                campaignName: run.name,
                description: runView.description,
                campaignId: run.campaignId,
              }),
              mutationId(options),
            );
            publishChanged();
            return success(result);
          }
          if (action === "show") {
            const revisionRaw = options.get("--revision");
            const revision =
              revisionRaw === undefined
                ? undefined
                : parseIntegerOption(
                    options,
                    "--revision",
                    1,
                    1,
                    Number.MAX_SAFE_INTEGER,
                  );
            return success(
              artifactService.read(
                scope,
                requiredOption(options, "--id"),
                revision,
              ),
            );
          }
          if (action === "revise") {
            const artifactId = requiredOption(options, "--id");
            const current = artifactService.read(scope, artifactId);
            const expectedRevision = parseIntegerOption(
              options,
              "--expected-revision",
              0,
              1,
              Number.MAX_SAFE_INTEGER,
            );
            const result = artifactService.seed(
              scope,
              [
                {
                  kind: current.artifact.kind,
                  title: current.artifact.title,
                  content: requiredOption(options, "--content"),
                  expectedRevision,
                },
              ],
              mutationId(options),
            );
            publishChanged();
            return success(result);
          }
          if (action === "comment") {
            const artifactId = requiredOption(options, "--id");
            const revision = parseIntegerOption(
              options,
              "--revision",
              artifactService.read(scope, artifactId).artifact.currentRevision,
              1,
              Number.MAX_SAFE_INTEGER,
            );
            const detail = artifactService.read(scope, artifactId, revision);
            const quote = requiredOption(options, "--quote");
            const startRaw = options.get("--start");
            const start =
              startRaw === undefined
                ? detail.content.indexOf(quote)
                : parseIntegerOption(
                    options,
                    "--start",
                    0,
                    0,
                    detail.content.length,
                  );
            if (
              start < 0 ||
              detail.content.slice(start, start + quote.length) !== quote
            ) {
              throw new Error(
                "--quote was not found at the requested artifact position",
              );
            }
            if (
              startRaw === undefined &&
              detail.content.indexOf(quote, start + 1) !== -1
            ) {
              throw new Error(
                "--quote occurs more than once; pass --start to disambiguate",
              );
            }
            const result = artifactService.addAnnotation(scope, {
              artifactId,
              revision,
              kind: "comment",
              anchor: {
                blockId: `cli-${start}`,
                start,
                end: start + quote.length,
                exactQuote: quote,
                prefix: detail.content.slice(Math.max(0, start - 64), start),
                suffix: detail.content.slice(
                  start + quote.length,
                  start + quote.length + 64,
                ),
              },
              body: requiredOption(options, "--body"),
              clientMutationId: mutationId(options),
            });
            publishChanged();
            return success(result);
          }
          if (action === "reply") {
            const result = artifactService.reply(scope, {
              annotationId: requiredOption(options, "--annotation"),
              body: requiredOption(options, "--body"),
              clientMutationId: mutationId(options),
            });
            publishChanged();
            return success(result);
          }
          if (action === "decide") {
            const outcome = requiredOption(options, "--outcome");
            if (outcome !== "accepted" && outcome !== "declined") {
              throw new Error("--outcome must be accepted or declined");
            }
            const semanticClassInput = requiredOption(options, "--class");
            let semanticClass: WorkflowArtifactSemanticClass;
            switch (semanticClassInput) {
              case "editorial":
              case "refinement":
              case "contract":
              case "architecture":
                semanticClass = semanticClassInput;
                break;
              default:
                throw new Error(
                  "--class must be editorial, refinement, contract, or architecture",
                );
            }
            const result = artifactService.decide(scope, {
              annotationId: requiredOption(options, "--annotation"),
              outcome,
              semanticClass,
              rationale: options.get("--rationale") ?? "",
              clientMutationId: mutationId(options),
            });
            publishChanged();
            return success(result);
          }
          if (action === "assess") {
            const verdict = requiredOption(options, "--verdict");
            if (
              verdict !== "no-design-impact" &&
              verdict !== "bounded-design-delta" &&
              verdict !== "redesign-required"
            ) {
              throw new Error(
                "--verdict must be no-design-impact, bounded-design-delta, or redesign-required",
              );
            }
            const result = artifactService.assessChange(scope, {
              changeId: requiredOption(options, "--change"),
              verdict,
              summary: requiredOption(options, "--summary"),
              clientMutationId: mutationId(options),
            });
            publishChanged();
            return success(result);
          }
          if (action === "confirm") {
            const result = artifactService.confirmChange(scope, {
              changeId: requiredOption(options, "--change"),
              clientMutationId: mutationId(options),
            });
            publishChanged();
            return success(result);
          }
          const result = await artifactService.ensureSteward(scope, run.name);
          publishChanged();
          return success(result);
        }
        return failure(
          "Usage: bb workflows <run|validate|status|details|history|list|stop|approve-amendment|artifact> [options]",
        );
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
