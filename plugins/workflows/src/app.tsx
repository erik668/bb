import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  activityIconClass,
  activityMetaClass,
  activityRowClass,
  activityTextClass,
  type ActivityRowState,
} from "@bb/shared-ui/activity-row-styles";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { Skeleton } from "@bb/shared-ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import {
  WorkflowPhaseStrip,
  WorkflowProgress,
  WorkflowStatusPill,
  type WorkflowProgressAgent,
  type WorkflowProgressAgentState,
  type WorkflowProgressSnapshot,
  type WorkflowStatusPillState,
} from "@bb/shared-ui/workflow-progress";
import {
  experimental_ArtifactReview as ArtifactReview,
  definePluginApp,
  ThreadChat,
  useBbNavigate,
  useComposerView,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginComposerThreadRowStatus,
  type PluginMessageDirectiveProps,
  type PluginThreadHeaderActionProps,
  type PluginThreadPanelProps,
  type ExperimentalArtifactReviewFeedbackRequest,
  type ExperimentalArtifactReviewSelection,
} from "@get-bb/plugin-sdk/app";
import {
  WORKFLOW_RUNS_REALTIME_CHANNEL,
  workflowRunsSignalThreadId,
} from "./realtime-channel.js";
import type { workflowUiRpcContract } from "./ui-contract.js";
import type {
  WorkflowCallView,
  WorkflowArtifactDetailView,
  WorkflowArtifactSummaryView,
  WorkflowCampaignView,
  WorkflowCheckpointView,
  WorkflowRunView,
  WorkflowThreadStatusView,
} from "./ui-contract.js";
import { workflowThreadStatusesOutputSchema } from "./ui-contract.js";

type ArtifactListLoadState =
  | { status: "loading" }
  | {
      status: "ready";
      artifacts: WorkflowArtifactSummaryView[];
      error: string | null;
    }
  | { status: "error"; message: string };

type ArtifactDetailLoadState =
  | { status: "loading" }
  | {
      status: "ready";
      detail: WorkflowArtifactDetailView;
      error: string | null;
    }
  | { status: "error"; message: string };

type RunLoadState =
  | { status: "loading" }
  | {
      status: "ready";
      run: WorkflowRunView | null;
      refreshError: string | null;
    }
  | { status: "error"; message: string };

// Derived from the RPC contract rather than re-declared, so the panel cannot
// drift from the coverage the service actually computes.
type AcceptanceCoverageView = NonNullable<WorkflowCampaignView["coverage"]>;
type AcceptanceCriterionView = AcceptanceCoverageView["criteria"][number];

type ActiveRunsLoadState =
  | { status: "loading" }
  | { status: "ready"; runs: WorkflowRunView[] }
  | { status: "error" };

type RunDetailsLoadState =
  | { status: "loading" }
  | {
      status: "ready";
      runId: string | null;
      checkpoints: WorkflowCheckpointView[];
      campaignRuns: WorkflowCampaignView["runs"];
      omittedCheckpointRunCount: number;
      coverage: AcceptanceCoverageView | null;
      coverageTruncated: boolean;
      refreshError: string | null;
    }
  | { status: "error"; runId: string | null; message: string };

// Who may approve, and where the approval goes. Null when this thread only
// observes the run, so the control is absent rather than present-and-failing.
interface AmendmentApprovalTarget {
  threadId: string;
  runId: string;
  onApproved: () => Promise<void>;
}

type ThreadStatusesLoadState =
  | { status: "loading" }
  | { status: "ready"; statuses: WorkflowThreadStatusView[] }
  | { status: "error" };

interface SharedWorkflowView {
  callsById: ReadonlyMap<string, WorkflowCallView>;
  currentPhaseIndex?: number;
  progress: WorkflowProgressSnapshot;
}

const ACTIVE_POLL_INTERVAL_MS = 1_000;
const IDLE_POLL_INTERVAL_MS = 5_000;
const MAX_SIDEBAR_REFRESH_FAILURES = 3;
const WORKFLOW_PANEL_ACTION_ID = "workflow-run";
const WORKFLOW_CARD_ROW_HEIGHT = 32;
const WORKFLOW_HEADER_GROUP_CLASS = activityRowClass(
  "active",
  "flex w-full items-stretch rounded-none px-0 py-0",
);
const WORKFLOW_HEADER_BUTTON_CLASS =
  "flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-none bg-transparent px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-background/80";
const WORKFLOW_OPEN_BUTTON_CLASS =
  "flex min-h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-none border-l border-border/35 bg-transparent text-muted-foreground transition-colors hover:text-foreground";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRunId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const runId = value.trim();
  return /^wfr_[0-9a-f-]+$/i.test(runId) ? runId : null;
}

function directiveRunId(
  attributes: Readonly<Record<string, string>>,
): string | null {
  if (Object.keys(attributes).some((key) => key !== "run")) return null;
  return requireRunId(attributes.run);
}

function panelRunId(params: unknown): string | null | undefined {
  if (params === null) return null;
  if (!isRecord(params) || Object.keys(params).some((key) => key !== "runId")) {
    return undefined;
  }
  return requireRunId(params.runId) ?? undefined;
}

function isRunActive(run: WorkflowRunView): boolean {
  return run.status === "queued" || run.status === "running";
}

function callsForRun(run: WorkflowRunView): WorkflowCallView[] {
  return [...run.phases.flatMap((phase) => phase.calls), ...run.unphasedCalls];
}

function callStatusLabel(status: WorkflowCallView["status"]): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "succeeded":
      return "Complete";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

interface WorkflowThreadSummary {
  runId: string;
  runName: string;
  label: string;
  accessibleLabel: string;
  canOpenPanel: boolean;
}

function phaseLabel(phase: string | null): string {
  return phase ?? "Other work";
}

function originPhaseLabel(
  status: Extract<WorkflowThreadStatusView, { role: "origin" }>,
): string {
  const phases = status.activePhases.map(phaseLabel);
  return phases.length > 0
    ? phases.join(" + ")
    : status.runStatus === "queued"
      ? "Queued"
      : "Running";
}

function originStatusSummary(
  statuses: ReadonlyArray<
    Extract<WorkflowThreadStatusView, { role: "origin" }>
  >,
): string {
  return [
    ...new Set(
      statuses.flatMap((status) =>
        status.activePhases.length > 0
          ? status.activePhases.map(phaseLabel)
          : [status.runStatus === "queued" ? "Queued" : "Running"],
      ),
    ),
  ].join(" + ");
}

function summarizeThreadStatuses(
  statuses: readonly WorkflowThreadStatusView[],
): WorkflowThreadSummary | null {
  const worker = statuses.find((status) => status.role === "worker");
  const origins = statuses.filter((status) => status.role === "origin");
  const primaryOrigin = origins[0];

  if (worker !== undefined && primaryOrigin !== undefined) {
    const workerPhase = phaseLabel(worker.phase);
    const localLabel =
      origins.length === 1
        ? originPhaseLabel(primaryOrigin)
        : `${origins.length} local workflows · ${originStatusSummary(origins)}`;
    const localAccessibleLabel = origins
      .map(
        (status) =>
          `workflow ${status.runName} started here: ${originPhaseLabel(status)}`,
      )
      .join("; ");
    return {
      runId: primaryOrigin.runId,
      runName: primaryOrigin.runName,
      label: `${workerPhase} · Local: ${localLabel}`,
      accessibleLabel: `Parent workflow ${worker.runName}: ${workerPhase}, ${callStatusLabel(worker.callStatus)}; ${localAccessibleLabel}`,
      canOpenPanel: true,
    };
  }

  if (worker !== undefined) {
    const workerPhase = phaseLabel(worker.phase);
    return {
      runId: worker.runId,
      runName: worker.runName,
      label: `${workerPhase} · ${callStatusLabel(worker.callStatus)}`,
      accessibleLabel: `Workflow ${worker.runName}: ${workerPhase}, ${callStatusLabel(worker.callStatus)}`,
      canOpenPanel: false,
    };
  }

  if (primaryOrigin === undefined) return null;
  if (origins.length > 1) {
    const phaseSummary = originStatusSummary(origins);
    return {
      runId: primaryOrigin.runId,
      runName: primaryOrigin.runName,
      label: `${origins.length} workflows · ${phaseSummary}`,
      accessibleLabel: origins
        .map(
          (status) => `Workflow ${status.runName}: ${originPhaseLabel(status)}`,
        )
        .join("; "),
      canOpenPanel: true,
    };
  }
  return {
    runId: primaryOrigin.runId,
    runName: primaryOrigin.runName,
    label: originPhaseLabel(primaryOrigin),
    accessibleLabel: `Workflow ${primaryOrigin.runName}: ${originPhaseLabel(primaryOrigin)}`,
    canOpenPanel: true,
  };
}

function runTerminalState(
  run: WorkflowRunView,
): "completed" | "failed" | "cancelled" | undefined {
  switch (run.status) {
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "queued":
    case "running":
      return undefined;
  }
}

function settledAgentCount(agents: readonly WorkflowProgressAgent[]): number {
  return agents.filter(
    (agent) =>
      agent.state === "done" ||
      agent.state === "failed" ||
      agent.state === "skipped" ||
      agent.state === "cancelled",
  ).length;
}

function runPillState(
  status: WorkflowRunView["status"],
): WorkflowStatusPillState | null {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return null;
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function runActivityState(run: WorkflowRunView): ActivityRowState {
  switch (run.status) {
    case "queued":
    case "running":
      return "active";
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "muted";
  }
}

function formatDuration(startedAt: number | null, finishedAt: number | null) {
  if (startedAt === null) return null;
  const durationMs = Math.max(0, (finishedAt ?? Date.now()) - startedAt);
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [
    hours > 0 ? `${hours}h` : null,
    minutes > 0 ? `${minutes}m` : null,
    seconds > 0 ? `${seconds}s` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
}

function WorkflowDuration({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt);
  useEffect(() => {
    setElapsed(Date.now() - startedAt);
    const interval = window.setInterval(() => {
      setElapsed(Date.now() - startedAt);
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [startedAt]);
  if (elapsed <= 1_000) return null;
  return <>{formatDuration(0, elapsed)}</>;
}

function WorkflowDetailScroll({
  currentPhaseIndex,
  progress,
}: {
  currentPhaseIndex?: number;
  progress: WorkflowProgressSnapshot;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ above: false, below: false });
  const contentKey = progress.agents
    .map((agent) => `${agent.index}:${agent.state}:${agent.lastProgressAt}`)
    .join("|");
  const updateOverflow = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const nextOverflow = {
      above: element.scrollTop > 1,
      below:
        element.scrollTop + element.clientHeight < element.scrollHeight - 1,
    };
    setOverflow((currentOverflow) =>
      currentOverflow.above === nextOverflow.above &&
      currentOverflow.below === nextOverflow.below
        ? currentOverflow
        : nextOverflow,
    );
  }, []);

  useEffect(() => {
    updateOverflow();
    const element = scrollRef.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(element);
    return () => observer.disconnect();
  }, [contentKey, updateOverflow]);

  return (
    <div className="relative isolate min-w-0" data-detail-scroll="base">
      <div
        ref={scrollRef}
        onScroll={updateOverflow}
        data-detail-scroll-area="base"
        className="max-h-[288px] min-w-0 overflow-x-auto overflow-y-auto px-2.5 py-2"
      >
        <div aria-hidden className="-mb-px h-px w-full" />
        <WorkflowProgress
          progress={progress}
          settled={false}
          collapsiblePhases
          currentPhaseIndex={currentPhaseIndex}
        />
        <div aria-hidden className="h-px w-full" />
      </div>
      {overflow.above ? (
        <div
          aria-hidden
          data-detail-scroll-fade="above"
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-background to-transparent"
        />
      ) : null}
      {overflow.below ? (
        <div
          aria-hidden
          data-detail-scroll-fade="below"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-background to-transparent"
        />
      ) : null}
    </div>
  );
}

function shortModelName(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

function contextMetadata(call: WorkflowCallView): string | null {
  if (call.contextFit === "untracked" || call.contextMinimumTokens === null)
    return null;
  const requirement = compactTokens(call.contextMinimumTokens);
  if (call.contextFit === "unknown") return `context ≥${requirement} · unknown`;
  if (call.observedModelContextWindow === null)
    return `context ≥${requirement} · unknown`;
  const capacity = compactTokens(call.observedModelContextWindow);
  const used =
    call.observedContextUsedTokens === null
      ? null
      : compactTokens(call.observedContextUsedTokens);
  const observation = used === null ? capacity : `${used}/${capacity}`;
  return `context ${observation} · ${call.contextFit} ≥${requirement}`;
}

function workflowAgentState(
  status: WorkflowCallView["status"],
): WorkflowProgressAgentState {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function buildSharedWorkflowView(run: WorkflowRunView): SharedWorkflowView {
  const phases = run.phases.map((phase, index) => ({
    index: index + 1,
    title: phase.title,
  }));
  const otherWorkIndex =
    run.unphasedCalls.length === 0 ? null : phases.length + 1;
  const phaseIndexByTitle = new Map(
    phases.map((phase) => [phase.title, phase.index] as const),
  );
  if (otherWorkIndex !== null) {
    phases.push({ index: otherWorkIndex, title: "Other work" });
  }
  const calls = callsForRun(run).sort(
    (left, right) => left.index - right.index,
  );
  const callsById = new Map(calls.map((call) => [call.id, call] as const));
  const agents: WorkflowProgressAgent[] = calls.map((call) => {
    const context = contextMetadata(call);
    return {
      id: call.id,
      actionable: call.childThreadId !== null,
      index: call.index + 1,
      label: call.label,
      state: workflowAgentState(call.status),
      model: call.model,
      attempt: call.providerRetryAttempts + call.repairAttempts + 1,
      cached: call.cached,
      lastProgressAt: call.finishedAt ?? call.startedAt ?? call.createdAt,
      phaseIndex:
        call.phase === null
          ? (otherWorkIndex ?? undefined)
          : phaseIndexByTitle.get(call.phase),
      error: call.error ?? undefined,
      durationMs:
        call.startedAt !== null && call.finishedAt !== null
          ? Math.max(0, call.finishedAt - call.startedAt)
          : undefined,
      metadata: [
        call.provider,
        shortModelName(call.model),
        call.reasoningLevel,
        ...(context === null ? [] : [context]),
      ],
    };
  });
  return {
    callsById,
    currentPhaseIndex:
      run.currentPhase === null
        ? undefined
        : phaseIndexByTitle.get(run.currentPhase),
    progress: { phases, agents },
  };
}

function useWorkflowRun(
  threadId: string,
  runId: string | null,
): { state: RunLoadState; refresh: () => Promise<void> } {
  const rpc = useRpc<typeof workflowUiRpcContract>();
  const [state, setState] = useState<RunLoadState>({ status: "loading" });
  const requestSequence = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const result = await rpc.call("workflowRunView", { threadId, runId });
      if (sequence === requestSequence.current) {
        setState({ status: "ready", run: result.run, refreshError: null });
      }
    } catch (error) {
      if (sequence === requestSequence.current) {
        const message = error instanceof Error ? error.message : String(error);
        setState((current) =>
          current.status === "ready" && current.run !== null
            ? { ...current, refreshError: message }
            : { status: "error", message },
        );
      }
    }
  }, [rpc, runId, threadId]);

  useEffect(() => {
    setState({ status: "loading" });
    void refresh();
    return () => {
      requestSequence.current += 1;
    };
  }, [refresh]);

  useRealtime(WORKFLOW_RUNS_REALTIME_CHANNEL, (payload) => {
    if (workflowRunsSignalThreadId(payload) === threadId) void refresh();
  });

  const shouldPoll =
    state.status === "error" ||
    (state.status === "ready" && state.run !== null && isRunActive(state.run));
  useVisibleActivePolling(refresh, shouldPoll);

  return { state, refresh };
}

function useWorkflowRunDetails(
  threadId: string,
  runId: string | null,
  active: boolean,
  enabled = true,
): { state: RunDetailsLoadState; refresh: () => Promise<void> } {
  const rpc = useRpc<typeof workflowUiRpcContract>();
  const [state, setState] = useState<RunDetailsLoadState>({
    status: "loading",
  });
  const requestSequence = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const sequence = ++requestSequence.current;
    try {
      const result = await rpc.call("workflowRunDetails", { threadId, runId });
      if (sequence === requestSequence.current) {
        setState({
          status: "ready",
          runId,
          checkpoints: [
            ...result.checkpoints,
            ...(result.campaign?.runs.flatMap((entry) => entry.checkpoints) ??
              []),
          ],
          campaignRuns: result.campaign?.runs ?? [],
          omittedCheckpointRunCount:
            result.campaign?.omittedCheckpointRunCount ?? 0,
          coverage: result.campaign?.coverage ?? null,
          coverageTruncated: result.campaign?.coverageTruncated ?? false,
          refreshError: null,
        });
      }
    } catch (error) {
      if (sequence === requestSequence.current) {
        const message = error instanceof Error ? error.message : String(error);
        setState((current) =>
          current.status === "ready"
            ? { ...current, refreshError: message }
            : { status: "error", runId, message },
        );
      }
    }
  }, [enabled, rpc, runId, threadId]);

  useEffect(() => {
    setState({ status: "loading" });
    if (enabled) void refresh();
    return () => {
      requestSequence.current += 1;
    };
  }, [enabled, refresh]);

  useRealtime(WORKFLOW_RUNS_REALTIME_CHANNEL, (payload) => {
    if (enabled && workflowRunsSignalThreadId(payload) === threadId)
      void refresh();
  });
  useVisibleActivePolling(refresh, active);
  return { state, refresh };
}

function useWorkflowArtifacts(
  threadId: string,
  runId: string,
): {
  state: ArtifactListLoadState;
  refresh: () => Promise<void>;
} {
  const rpc = useRpc<typeof workflowUiRpcContract>();
  const [state, setState] = useState<ArtifactListLoadState>({
    status: "loading",
  });
  const requestSequence = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const result = await rpc.call("workflowArtifactList", {
        threadId,
        runId,
      });
      if (sequence === requestSequence.current) {
        setState({ status: "ready", artifacts: result.artifacts, error: null });
      }
    } catch (error) {
      if (sequence === requestSequence.current) {
        const message = error instanceof Error ? error.message : String(error);
        setState((current) =>
          current.status === "ready"
            ? { ...current, error: message }
            : { status: "error", message },
        );
      }
    }
  }, [rpc, runId, threadId]);
  useEffect(() => {
    void refresh();
    return () => {
      requestSequence.current += 1;
    };
  }, [refresh]);
  useRealtime(WORKFLOW_RUNS_REALTIME_CHANNEL, (payload) => {
    if (workflowRunsSignalThreadId(payload) === threadId) void refresh();
  });
  return { state, refresh };
}

function useWorkflowArtifact(
  threadId: string,
  runId: string,
  artifactId: string,
  revision: number | null,
): {
  state: ArtifactDetailLoadState;
  refresh: () => Promise<void>;
} {
  const rpc = useRpc<typeof workflowUiRpcContract>();
  const [state, setState] = useState<ArtifactDetailLoadState>({
    status: "loading",
  });
  const requestSequence = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const detail = await rpc.call("workflowArtifactRead", {
        threadId,
        runId,
        artifactId,
        revision,
      });
      if (sequence === requestSequence.current) {
        setState({ status: "ready", detail, error: null });
      }
    } catch (error) {
      if (sequence === requestSequence.current) {
        const message = error instanceof Error ? error.message : String(error);
        setState((current) =>
          current.status === "ready"
            ? { ...current, error: message }
            : { status: "error", message },
        );
      }
    }
  }, [artifactId, revision, rpc, runId, threadId]);
  useEffect(() => {
    setState({ status: "loading" });
    void refresh();
    return () => {
      requestSequence.current += 1;
    };
  }, [refresh]);
  useRealtime(WORKFLOW_RUNS_REALTIME_CHANNEL, (payload) => {
    if (workflowRunsSignalThreadId(payload) === threadId) void refresh();
  });
  return { state, refresh };
}

function nextClientMutationId(): string {
  return globalThis.crypto.randomUUID();
}

function subscribeDocumentVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function readDocumentVisible(): boolean {
  return document.visibilityState !== "hidden";
}

function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeDocumentVisibility,
    readDocumentVisible,
    () => true,
  );
}

function useVisibleActivePolling(
  refresh: () => Promise<void>,
  active: boolean,
): void {
  const visible = useDocumentVisible();
  const connection = useRealtimeConnectionState();
  const wasHidden = useRef(false);
  const wasDisconnected = useRef(false);

  useEffect(() => {
    if (!visible) {
      wasHidden.current = true;
      return;
    }
    if (!wasHidden.current) return;
    wasHidden.current = false;
    void refresh();
  }, [refresh, visible]);

  useEffect(() => {
    if (connection !== "connected") {
      wasDisconnected.current = true;
      return;
    }
    if (!wasDisconnected.current) return;
    wasDisconnected.current = false;
    void refresh();
  }, [connection, refresh]);

  const enabled = active && visible;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timeout: number | null = null;
    const schedule = () => {
      timeout = window.setTimeout(() => {
        void refresh().finally(() => {
          if (!cancelled) schedule();
        });
      }, ACTIVE_POLL_INTERVAL_MS);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [enabled, refresh]);
}

function useActiveWorkflowRuns(threadId: string): {
  state: ActiveRunsLoadState;
  setRuns: (update: (runs: WorkflowRunView[]) => WorkflowRunView[]) => void;
} {
  const rpc = useRpc<typeof workflowUiRpcContract>();
  const [state, setState] = useState<ActiveRunsLoadState>({
    status: "loading",
  });
  const requestSequence = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const result = await rpc.call("workflowActiveRuns", { threadId });
      if (sequence === requestSequence.current) {
        setState({ status: "ready", runs: result.runs });
      }
    } catch {
      if (sequence === requestSequence.current) setState({ status: "error" });
    }
  }, [rpc, threadId]);

  useEffect(() => {
    setState({ status: "loading" });
    void refresh();
    return () => {
      requestSequence.current += 1;
    };
  }, [refresh]);

  useRealtime(WORKFLOW_RUNS_REALTIME_CHANNEL, (payload) => {
    if (workflowRunsSignalThreadId(payload) === threadId) void refresh();
  });

  const shouldPoll =
    state.status === "error" ||
    (state.status === "ready" && state.runs.some(isRunActive));
  useVisibleActivePolling(refresh, shouldPoll);

  const setRuns = useCallback(
    (update: (runs: WorkflowRunView[]) => WorkflowRunView[]) => {
      setState((current) =>
        current.status === "ready"
          ? { status: "ready", runs: update(current.runs) }
          : current,
      );
    },
    [],
  );

  return { state, setRuns };
}

function useWorkflowThreadStatuses(threadId: string): ThreadStatusesLoadState {
  const rpc = useRpc<typeof workflowUiRpcContract>();
  const [state, setState] = useState<ThreadStatusesLoadState>({
    status: "loading",
  });
  const requestSequence = useRef(0);

  const refresh = useCallback(async (): Promise<boolean> => {
    const sequence = ++requestSequence.current;
    try {
      const result = await rpc.call("workflowThreadStatuses", { threadId });
      if (sequence === requestSequence.current) {
        setState({ status: "ready", statuses: result.statuses });
      }
      return result.statuses.length > 0;
    } catch {
      if (sequence === requestSequence.current) setState({ status: "error" });
      return false;
    }
  }, [rpc, threadId]);

  useEffect(() => {
    let cancelled = false;
    let timeout: number | null = null;
    void Promise.resolve().then(() => {
      if (!cancelled) setState({ status: "loading" });
    });
    const poll = async () => {
      const active = await refresh();
      if (cancelled) return;
      timeout = window.setTimeout(
        () => void poll(),
        active ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS,
      );
    };
    void poll();
    return () => {
      cancelled = true;
      requestSequence.current += 1;
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [refresh]);

  return state;
}

interface WorkflowThreadRowStatusProjection {
  threadId: string;
  status: PluginComposerThreadRowStatus;
}

function buildWorkflowThreadRowStatuses(
  statuses: readonly WorkflowThreadStatusView[],
): WorkflowThreadRowStatusProjection[] {
  const byThread = new Map<string, WorkflowThreadStatusView[]>();
  for (const status of statuses) {
    const threadStatuses = byThread.get(status.threadId);
    if (threadStatuses === undefined) byThread.set(status.threadId, [status]);
    else threadStatuses.push(status);
  }

  const projections: WorkflowThreadRowStatusProjection[] = [];
  for (const [threadId, threadStatuses] of byThread) {
    const summary = summarizeThreadStatuses(threadStatuses);
    if (summary !== null) {
      projections.push({
        threadId,
        status: {
          icon: "Workflow",
          label: summary.accessibleLabel,
          tone: "running",
        },
      });
    }
  }
  return projections;
}

function workflowStatusesFromRpcEnvelope(
  value: unknown,
): WorkflowThreadStatusView[] {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.result)) {
    throw new Error("Invalid workflow status response");
  }
  return workflowThreadStatusesOutputSchema.parse(value.result).statuses;
}

async function fetchAllActiveWorkflowThreadStatuses(
  pluginId: string,
  signal: AbortSignal,
): Promise<WorkflowThreadStatusView[]> {
  const response = await fetch(
    `/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/workflowAllActiveThreadStatuses`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
      signal,
    },
  );
  const payload: unknown = await response.json();
  if (!response.ok) throw new Error("Could not load workflow statuses");
  return workflowStatusesFromRpcEnvelope(payload);
}

function threadRowStatusesEqual(
  left: PluginComposerThreadRowStatus,
  right: PluginComposerThreadRowStatus,
): boolean {
  return (
    left.icon === right.icon &&
    left.label === right.label &&
    left.tone === right.tone
  );
}

function mountWorkflowThreadRowStatuses({
  pluginId,
  signal,
  setThreadRowStatus,
}: {
  pluginId: string;
  signal: AbortSignal;
  setThreadRowStatus:
    | ((threadId: string, status: PluginComposerThreadRowStatus | null) => void)
    | undefined;
}): () => void {
  if (setThreadRowStatus === undefined) return () => undefined;
  let timeout: number | null = null;
  let refreshFailures = 0;
  let knownStatuses = new Map<string, PluginComposerThreadRowStatus>();

  const applyProjections = (
    projections: readonly WorkflowThreadRowStatusProjection[],
  ) => {
    const nextStatuses = new Map(
      projections.map((projection) => [projection.threadId, projection.status]),
    );
    for (const threadId of knownStatuses.keys()) {
      if (!nextStatuses.has(threadId)) setThreadRowStatus(threadId, null);
    }
    for (const [threadId, status] of nextStatuses) {
      const previous = knownStatuses.get(threadId);
      if (previous === undefined || !threadRowStatusesEqual(previous, status)) {
        setThreadRowStatus(threadId, status);
      }
    }
    knownStatuses = nextStatuses;
  };

  const refresh = async (): Promise<number> => {
    try {
      const statuses = await fetchAllActiveWorkflowThreadStatuses(
        pluginId,
        signal,
      );
      if (signal.aborted) return IDLE_POLL_INTERVAL_MS;
      refreshFailures = 0;
      applyProjections(buildWorkflowThreadRowStatuses(statuses));
      return statuses.length > 0
        ? ACTIVE_POLL_INTERVAL_MS
        : IDLE_POLL_INTERVAL_MS;
    } catch {
      if (signal.aborted) return IDLE_POLL_INTERVAL_MS;
      refreshFailures += 1;
      if (refreshFailures >= MAX_SIDEBAR_REFRESH_FAILURES) {
        applyProjections([]);
      }
      return refreshFailures < MAX_SIDEBAR_REFRESH_FAILURES
        ? ACTIVE_POLL_INTERVAL_MS
        : IDLE_POLL_INTERVAL_MS;
    }
  };

  const schedule = (delay: number) => {
    timeout = window.setTimeout(() => {
      void refresh().then((nextDelay) => {
        if (!signal.aborted) schedule(nextDelay);
      });
    }, delay);
  };
  void refresh().then((delay) => {
    if (!signal.aborted) schedule(delay);
  });

  return () => {
    if (timeout !== null) window.clearTimeout(timeout);
  };
}

export function EmptyOrError({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export function LoadingPreview() {
  return (
    <div className="space-y-2" aria-busy="true">
      <Skeleton className="h-3.5 w-44 rounded-sm" />
      <Skeleton className="h-3 w-2/3 rounded-sm" />
      <Skeleton className="h-3 w-1/2 rounded-sm" />
    </div>
  );
}

export function WorkflowRunPanelState({ children }: { children: ReactNode }) {
  return <div className="p-4">{children}</div>;
}

function RefreshWarning({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="rounded-md border border-warning/20 bg-warning/5 px-2.5 py-1.5 text-xs text-warning-text"
    >
      Could not refresh: {message}. Retrying…
    </div>
  );
}

function WorkflowStatusBanner() {
  const view = useComposerView();
  if (view.scope.kind !== "thread") return null;
  return <WorkflowStatusBannerLoaded threadId={view.scope.threadId} />;
}

function WorkflowThreadHeaderAction({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  const state = useWorkflowThreadStatuses(threadId);
  const summary =
    state.status === "ready" ? summarizeThreadStatuses(state.statuses) : null;
  if (summary === null) return null;

  const className = cn(
    "h-7 max-w-64 gap-1.5 px-2 text-xs",
    isCompactViewport && "w-7 px-0",
  );
  const content = (
    <>
      <Icon
        name="Workflow"
        className="size-3.5 shrink-0 animate-shine-icon text-success"
        aria-hidden
      />
      <span
        aria-live="polite"
        aria-atomic="true"
        className={isCompactViewport ? "sr-only" : "min-w-0 truncate"}
      >
        Workflow · {summary.label}
      </span>
    </>
  );

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {summary.canOpenPanel ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={className}
              aria-label={summary.accessibleLabel}
              onClick={() =>
                navigate.openThreadPanel({
                  actionId: WORKFLOW_PANEL_ACTION_ID,
                  title: summary.runName,
                  params: { runId: summary.runId },
                })
              }
            >
              {content}
            </Button>
          ) : (
            <div
              role="status"
              className={cn(
                className,
                "inline-flex items-center rounded-md border border-border bg-background",
              )}
              aria-label={summary.accessibleLabel}
            >
              {content}
            </div>
          )}
        </TooltipTrigger>
        <TooltipContent>{summary.accessibleLabel}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function WorkflowComposerCard({
  run,
  threadId,
}: {
  run: WorkflowRunView;
  threadId: string;
}) {
  const navigate = useBbNavigate();
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const toggleId = useId();
  const shared = buildSharedWorkflowView(run);
  const settledAgents = settledAgentCount(shared.progress.agents);
  const agentCount = shared.progress.agents.length;

  return (
    <section
      aria-label="Workflow"
      className="overflow-hidden rounded-lg border border-border bg-surface-raised-solid"
      style={{ minHeight: WORKFLOW_CARD_ROW_HEIGHT }}
    >
      <div
        role="group"
        aria-label={`Workflow controls: ${run.name}`}
        className={WORKFLOW_HEADER_GROUP_CLASS}
      >
        <button
          type="button"
          id={toggleId}
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={`Workflow: ${run.name}`}
          onClick={() => setExpanded((value) => !value)}
          className={WORKFLOW_HEADER_BUTTON_CLASS}
        >
          <Icon
            name="Workflow"
            className={activityIconClass("active", "size-3.5 shrink-0")}
            aria-hidden
          />
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            <span
              className={activityTextClass("active", "min-w-0 truncate")}
              title={run.name}
            >
              {run.name}
            </span>
            {run.originThreadId === threadId ? null : (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                Related
              </span>
            )}
            {agentCount === 0 ? null : (
              <span
                className={activityMetaClass(
                  "active",
                  "shrink-0 text-2xs tabular-nums",
                )}
              >
                {settledAgents}/{agentCount} agents
              </span>
            )}
            {run.startedAt === null ? null : (
              <span
                className={activityMetaClass(
                  "active",
                  "shrink-0 text-2xs tabular-nums",
                )}
              >
                <WorkflowDuration startedAt={run.startedAt} />
              </span>
            )}
          </span>
          <Icon
            name="ChevronDown"
            className={cn(
              activityIconClass("active"),
              "size-3.5 shrink-0 transition-transform duration-200",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        </button>
        <button
          type="button"
          aria-label={`Open workflow ${run.name} in side panel`}
          onClick={() =>
            navigate.openThreadPanel({
              actionId: WORKFLOW_PANEL_ACTION_ID,
              title: run.name,
              params: { runId: run.id },
            })
          }
          className={WORKFLOW_OPEN_BUTTON_CLASS}
        >
          <Icon name="ArrowRight" className="size-3.5" aria-hidden />
        </button>
      </div>
      <WorkflowPhaseStrip
        progress={shared.progress}
        currentPhaseIndex={shared.currentPhaseIndex}
        settled={false}
        className="px-3 pb-2"
      />
      <section
        id={bodyId}
        role="region"
        aria-labelledby={toggleId}
        aria-hidden={!expanded}
        className={cn(
          "grid overflow-hidden transition-[grid-template-rows,opacity,border-color] duration-200 ease-out",
          expanded
            ? "grid-rows-[1fr] border-t border-border opacity-100"
            : "pointer-events-none grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden bg-popover">
          <WorkflowDetailScroll
            progress={shared.progress}
            currentPhaseIndex={shared.currentPhaseIndex}
          />
        </div>
      </section>
    </section>
  );
}

function WorkflowStatusBannerLoaded({ threadId }: { threadId: string }) {
  const { state } = useActiveWorkflowRuns(threadId);

  if (state.status !== "ready" || state.runs.length === 0) return null;
  const relatedCount = state.runs.filter(
    (run) => run.originThreadId !== threadId,
  ).length;

  return (
    <section aria-label="Active workflows" className="space-y-2">
      <div className="flex items-center justify-between px-0.5 text-2xs font-medium text-subtle-foreground">
        <span>
          {relatedCount > 0 ? "Related workflows" : "Active workflows"}
        </span>
        <span className="tabular-nums">{state.runs.length} active</span>
      </div>
      {state.runs.map((run) => (
        <WorkflowComposerCard key={run.id} run={run} threadId={threadId} />
      ))}
    </section>
  );
}

function WorkflowPreviewDirective({
  attributes,
  source,
  message,
}: PluginMessageDirectiveProps) {
  const runId = directiveRunId(attributes);
  if (runId === null) {
    return (
      <EmptyOrError>
        workflow-preview requires exactly one valid run attribute, e.g.{" "}
        <code>::workflow-preview{'{run="wfr_…"}'}</code>
      </EmptyOrError>
    );
  }
  return (
    <WorkflowPreviewLoaded
      runId={runId}
      threadId={message.threadId}
      source={source}
    />
  );
}

function WorkflowPreviewLoaded({
  runId,
  threadId,
  source,
}: {
  runId: string;
  threadId: string;
  source: string;
}) {
  const navigate = useBbNavigate();
  const { state } = useWorkflowRun(threadId, runId);
  const [expanded, setExpanded] = useState(true);
  const bodyId = useId();
  const toggleId = useId();
  if (state.status === "loading") return <LoadingPreview />;
  if (state.status === "error") {
    return <EmptyOrError>{state.message}</EmptyOrError>;
  }
  if (state.run === null) {
    return <EmptyOrError>Workflow run not found.</EmptyOrError>;
  }
  const run = state.run;
  const shared = buildSharedWorkflowView(run);
  const activityState = runActivityState(run);
  const pillState = runPillState(run.status);
  const duration = formatDuration(run.startedAt, run.finishedAt);
  const settledAgents = settledAgentCount(shared.progress.agents);
  return (
    <section
      className="my-2 overflow-hidden rounded-lg border border-border bg-surface-recessed"
      title={source}
      aria-label="Workflow"
    >
      <button
        type="button"
        id={toggleId}
        aria-expanded={expanded}
        aria-controls={bodyId}
        aria-label={`Workflow: ${run.name}`}
        onClick={() => setExpanded((value) => !value)}
        className={activityRowClass(
          activityState,
          "flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-none px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-background/80",
        )}
      >
        <Icon
          name="Workflow"
          className={activityIconClass(activityState, "size-3.5 shrink-0")}
          aria-hidden
        />
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <span
            className={activityTextClass(
              activityState,
              "min-w-0 truncate no-underline",
            )}
            title={run.name}
          >
            {run.name}
          </span>
          {shared.progress.agents.length > 0 ? (
            <span
              className={activityMetaClass(
                activityState,
                "shrink-0 text-2xs tabular-nums",
              )}
            >
              {settledAgents}/{shared.progress.agents.length} agents
            </span>
          ) : null}
          {duration === null ? null : (
            <span
              className={activityMetaClass(
                activityState,
                "shrink-0 text-2xs tabular-nums",
              )}
            >
              {duration}
            </span>
          )}
        </span>
        {pillState === null ? null : <WorkflowStatusPill state={pillState} />}
        <Icon
          name="ChevronDown"
          className={cn(
            activityIconClass(activityState),
            "size-3.5 shrink-0 transition-transform duration-200",
            expanded && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      <WorkflowPhaseStrip
        progress={shared.progress}
        currentPhaseIndex={shared.currentPhaseIndex}
        settled={!isRunActive(run)}
        className="px-3 pb-2"
      />
      <section
        id={bodyId}
        role="region"
        aria-labelledby={toggleId}
        aria-hidden={!expanded}
        inert={!expanded}
        className={cn(
          "grid overflow-hidden transition-[grid-template-rows,opacity,border-color] duration-200 ease-out",
          expanded
            ? "grid-rows-[1fr] border-t border-border opacity-100"
            : "pointer-events-none grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden bg-popover">
          <div
            data-detail-scroll-area="base"
            className="max-h-[288px] overflow-y-auto px-2.5 py-2"
          >
            <WorkflowProgress
              progress={shared.progress}
              settled={!isRunActive(run)}
              error={run.error}
              collapsiblePhases
              currentPhaseIndex={shared.currentPhaseIndex}
              terminalState={runTerminalState(run)}
            />
          </div>
        </div>
      </section>
      {state.refreshError === null ? null : (
        <div className="border-t border-border-seam bg-popover px-3 py-2">
          <RefreshWarning message={state.refreshError} />
        </div>
      )}
      <div className="flex min-h-9 items-center border-t border-border-seam bg-popover px-2">
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() =>
            navigate.openThreadPanel({
              actionId: WORKFLOW_PANEL_ACTION_ID,
              title: run.name,
              params: { runId: run.id },
            })
          }
        >
          Open in right panel
          <Icon name="ArrowRight" className="size-3" aria-hidden />
        </Button>
      </div>
    </section>
  );
}

function WorkflowRunPanel({ threadId, params }: PluginThreadPanelProps) {
  const runId = panelRunId(params);
  return (
    <div className="h-full min-h-0 flex-1 bg-border">
      {runId === undefined ? (
        <WorkflowRunPanelState>
          <EmptyOrError>
            This workflow panel has invalid run parameters.
          </EmptyOrError>
        </WorkflowRunPanelState>
      ) : (
        <WorkflowRunPanelLoaded threadId={threadId} runId={runId} />
      )}
    </div>
  );
}

type CheckpointStatus = WorkflowCheckpointView["checkpoint"]["status"];
type CheckpointByKind<
  Kind extends WorkflowCheckpointView["checkpoint"]["kind"],
> = WorkflowCheckpointView & {
  checkpoint: Extract<WorkflowCheckpointView["checkpoint"], { kind: Kind }>;
};

function isCheckpointKind<
  Kind extends WorkflowCheckpointView["checkpoint"]["kind"],
>(entry: WorkflowCheckpointView, kind: Kind): entry is CheckpointByKind<Kind> {
  return entry.checkpoint.kind === kind;
}

function checkpointStatusLabel(status: CheckpointStatus): string {
  return status === "succeeded"
    ? "Complete"
    : `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
}

function CheckpointStatus({ status }: { status: CheckpointStatus }) {
  const className = cn(
    "inline-flex shrink-0 items-center gap-1 text-2xs font-medium",
    status === "succeeded" && "text-success",
    status === "failed" && "text-destructive-text",
    (status === "blocked" || status === "interrupted") && "text-warning-text",
    (status === "pending" || status === "skipped") && "text-subtle-foreground",
    status === "running" && "text-foreground",
  );
  return (
    <span className={className}>
      {status === "succeeded" ? (
        <Icon name="Check" className="size-3" aria-hidden />
      ) : status === "failed" ? (
        <Icon name="CircleX" className="size-3" aria-hidden />
      ) : status === "blocked" || status === "interrupted" ? (
        <Icon name="AlertTriangle" className="size-3" aria-hidden />
      ) : status === "skipped" ? (
        <Icon name="Pause" className="size-3" aria-hidden />
      ) : (
        <Icon
          name={status === "running" ? "Circle" : "Clock"}
          className={cn("size-3", status === "running" && "animate-pulse")}
          aria-hidden
        />
      )}
      {checkpointStatusLabel(status)}
    </span>
  );
}

function CheckpointDisclosure({
  title,
  status,
  meta,
  defaultOpen = false,
  children,
}: {
  title: string;
  status: CheckpointStatus;
  meta?: string | null;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return (
    <div className="overflow-hidden rounded-md border border-border bg-muted/20">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon
          name="ChevronDown"
          className={cn(
            "size-3.5 shrink-0 text-subtle-foreground transition-transform",
            open ? "rotate-180" : "-rotate-90",
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-foreground">
            {title}
          </span>
          {meta === null || meta === undefined ? null : (
            <span className="mt-0.5 block truncate text-2xs text-subtle-foreground">
              {meta}
            </span>
          )}
        </span>
        <CheckpointStatus status={status} />
      </button>
      {open ? (
        <div id={contentId} className="border-t border-border-seam px-3 py-2.5">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function OpenWorkerButton({ childThreadId }: { childThreadId: string | null }) {
  const navigate = useBbNavigate();
  if (childThreadId === null) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="mt-2 h-7 px-2 text-2xs"
      onClick={() => navigate.toThread(childThreadId)}
    >
      Open worker thread
      <Icon name="ArrowRight" className="size-3" aria-hidden />
    </Button>
  );
}

interface BuildDagNode {
  id: string;
  title: string;
  status: CheckpointStatus;
  dependsOn: string[];
  nodeType: "work" | "gate";
}

interface BuildDagView {
  layers: BuildDagNode[][];
  diagnostics: string[];
  diagnosticTitle: string;
}

function buildDagLayers(
  checkpoints: WorkflowCheckpointView[],
  checkpointDetailsOmitted = false,
): BuildDagView {
  const nodes = new Map<string, BuildDagNode>();
  for (const entry of checkpoints) {
    if (isCheckpointKind(entry, "plan")) {
      for (const item of entry.checkpoint.items) {
        nodes.set(item.id, {
          id: item.id,
          title: item.title,
          status: "pending",
          dependsOn: item.dependsOn ?? [],
          nodeType: item.nodeType ?? "work",
        });
      }
    }
    if (isCheckpointKind(entry, "work-item")) {
      const item = entry.checkpoint;
      const planned = nodes.get(item.id);
      nodes.set(item.id, {
        id: item.id,
        title: item.title,
        status: item.status,
        dependsOn:
          item.dependsOn === undefined
            ? (planned?.dependsOn ?? [])
            : item.dependsOn,
        nodeType:
          item.nodeType === undefined
            ? (planned?.nodeType ?? "work")
            : item.nodeType,
      });
    }
  }
  const unknownDependencies = [...nodes.values()].flatMap((node) =>
    node.dependsOn
      .filter((dependencyId) => !nodes.has(dependencyId))
      .map((dependencyId) =>
        checkpointDetailsOmitted
          ? `Dependency ${dependencyId} referenced by ${node.id} may be in an omitted older ledger.`
          : `Unknown dependency ${dependencyId} referenced by ${node.id}.`,
      ),
  );
  const diagnostics = [...unknownDependencies];
  const levels = new Map<string, number>();
  for (let pass = 0; pass < nodes.size; pass += 1) {
    let changed = false;
    for (const node of nodes.values()) {
      if (levels.has(node.id)) continue;
      const dependencyLevels = node.dependsOn
        .filter((id) => nodes.has(id))
        .map((id) => levels.get(id))
        .filter((level): level is number => level !== undefined);
      const knownDependencyCount = node.dependsOn.filter((id) =>
        nodes.has(id),
      ).length;
      if (dependencyLevels.length === knownDependencyCount) {
        levels.set(
          node.id,
          dependencyLevels.length === 0 ? 0 : Math.max(...dependencyLevels) + 1,
        );
        changed = true;
      }
    }
    if (!changed) break;
  }
  const cyclicOrBlocked = [...nodes.keys()].filter((id) => !levels.has(id));
  if (cyclicOrBlocked.length > 0) {
    diagnostics.push(
      `Cyclic or cycle-blocked dependencies affect: ${cyclicOrBlocked.join(", ")}.`,
    );
  }
  const fallbackLevel = Math.max(-1, ...levels.values()) + 1;
  const layers: BuildDagNode[][] = [];
  for (const node of nodes.values()) {
    const level = levels.get(node.id) ?? fallbackLevel;
    (layers[level] ??= []).push(node);
  }
  const hasIncompleteDiagnostics =
    checkpointDetailsOmitted && unknownDependencies.length > 0;
  const hasInvalidDiagnostics =
    (!checkpointDetailsOmitted && unknownDependencies.length > 0) ||
    cyclicOrBlocked.length > 0;
  return {
    layers,
    diagnostics,
    diagnosticTitle:
      hasIncompleteDiagnostics && hasInvalidDiagnostics
        ? "Invalid or incomplete build graph"
        : hasIncompleteDiagnostics
          ? "Incomplete build graph"
          : "Invalid build graph",
  };
}

function CampaignRunList({ runs }: { runs: WorkflowCampaignView["runs"] }) {
  if (runs.length <= 1) return null;
  return (
    <ol className="space-y-1" aria-label="Campaign runs">
      {runs.map(({ run }, index) => (
        <li
          key={run.id}
          className="flex items-center gap-2 rounded border border-border-seam px-2 py-1.5"
        >
          <span className="font-mono text-2xs text-subtle-foreground">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-foreground">
            {run.name}
          </span>
          <CheckpointStatus
            status={
              run.status === "cancelled"
                ? "interrupted"
                : run.status === "queued"
                  ? "pending"
                  : run.status
            }
          />
        </li>
      ))}
    </ol>
  );
}

function WorkflowDag({ graph }: { graph: BuildDagView }) {
  if (graph.layers.length === 0) return null;
  const labels = new Map(
    graph.layers.flat().map((node) => [node.id, node.title]),
  );
  return (
    <div aria-label="Build dependency graph" className="space-y-1.5">
      <p className="text-2xs font-medium text-subtle-foreground">Build DAG</p>
      {graph.diagnostics.length === 0 ? null : (
        <div
          role="alert"
          className="rounded border border-warning/20 bg-warning/5 px-2 py-1.5 text-2xs text-warning-text"
        >
          <p className="font-medium">{graph.diagnosticTitle}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {graph.diagnostics.map((diagnostic) => (
              <li key={diagnostic}>{diagnostic}</li>
            ))}
          </ul>
        </div>
      )}
      {graph.layers.map((layer, index) => (
        <div key={layer.map((node) => node.id).join(":")}>
          {index === 0 ? null : (
            <div
              className="flex justify-center py-0.5 text-subtle-foreground"
              aria-hidden
            >
              <Icon name="ArrowDown" className="size-3" />
            </div>
          )}
          <div
            className="grid gap-1.5"
            style={{
              gridTemplateColumns: `repeat(${Math.min(layer.length, 3)}, minmax(0, 1fr))`,
            }}
          >
            {layer.map((node) => (
              <div
                key={node.id}
                className="min-w-0 rounded border border-border-seam bg-muted/30 px-2 py-1.5"
              >
                <div className="flex items-start gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                    {node.title}
                  </span>
                  {node.nodeType === "gate" ? (
                    <span className="rounded bg-muted px-1 py-0.5 text-2xs text-subtle-foreground">
                      Gate
                    </span>
                  ) : null}
                </div>
                <CheckpointStatus status={node.status} />
                {node.dependsOn.length === 0 ? null : (
                  <p className="mt-1 truncate text-2xs text-subtle-foreground">
                    After:{" "}
                    {node.dependsOn
                      .map((id) => labels.get(id) ?? id)
                      .join(", ")}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function TransitionNotes({
  checkpoints,
}: {
  checkpoints: WorkflowCheckpointView[];
}) {
  const transitions = checkpoints.filter((entry) =>
    isCheckpointKind(entry, "transition"),
  );
  if (transitions.length === 0) return null;
  return (
    <div>
      <p className="mb-1.5 text-2xs font-medium text-subtle-foreground">
        Transition notes
      </p>
      <ol className="space-y-1.5">
        {transitions.map((entry) => {
          const transition = entry.checkpoint;
          return (
            <li
              key={entry.id}
              className="rounded border border-border-seam px-2 py-1.5"
            >
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 text-xs font-medium text-foreground">
                  {transition.title}
                </span>
                <span className="text-2xs text-subtle-foreground">
                  {transition.actor}
                </span>
              </div>
              <p className="mt-1 text-2xs text-subtle-foreground">
                {transition.fromState ?? "start"} → {transition.toState}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                {transition.rationale}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const ACCEPTANCE_STATE_LABEL: Record<AcceptanceCriterionView["state"], string> =
  {
    closed: "Closed",
    "in-flight": "In flight",
    uncovered: "Uncovered",
  };

function AcceptanceStateChip({
  state,
}: {
  state: AcceptanceCriterionView["state"];
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-2xs font-medium",
        state === "closed" && "text-success",
        state === "in-flight" && "text-foreground",
        state === "uncovered" && "text-subtle-foreground",
      )}
    >
      <Icon
        name={
          state === "closed"
            ? "Check"
            : state === "in-flight"
              ? "Circle"
              : "Clock"
        }
        className="size-3"
        aria-hidden
      />
      {ACCEPTANCE_STATE_LABEL[state]}
    </span>
  );
}

// Coverage is the one number on this panel the workflow did not author about
// itself: it is derived from the campaign ledger, so a run of green work items
// that closed no stated outcome cannot read as progress here.
function AcceptanceCoverageNotes({
  coverage,
  truncated,
}: {
  coverage: AcceptanceCoverageView;
  truncated: boolean;
}) {
  const amendment = coverage.amendments.at(-1);
  const pending = coverage.pendingAmendments.at(-1);
  const onlyOpenGate =
    coverage.openGates.length === 1 ? coverage.openGates[0] : undefined;
  const notes: { text: string; alert: boolean }[] = [
    // Loudest first. The write path refuses an undeclared contract change, so
    // seeing one means the ledger was written some other way and every count
    // below it is measured against a contract nobody declared.
    coverage.unauthorizedAcceptanceIds.length === 0
      ? null
      : {
          alert: true,
          text: `${coverage.unauthorizedAcceptanceIds.length === 1 ? "An acceptance checkpoint" : `${coverage.unauthorizedAcceptanceIds.length} acceptance checkpoints`} changed this contract without declaring an amendment (${coverage.unauthorizedAcceptanceIds.join(", ")}). Coverage still measures the declared contract; treat the change as unreviewed.`,
        },
    // Above the open-gate note: a pending amendment is the one thing here that
    // is waiting on a person rather than on work.
    pending === undefined
      ? null
      : {
          alert: false,
          text: `${coverage.pendingAmendments.length === 1 ? "An amendment is" : `${coverage.pendingAmendments.length} amendments are`} waiting for approval, most recently ${pending.acceptanceId} replacing ${pending.supersedes} (${pending.reason}). Coverage is measured against the approved contract until then.`,
        },
    coverage.unanchoredProgress
      ? {
          alert: true,
          text: `${coverage.orphanWorkItemIds.length} work ${coverage.orphanWorkItemIds.length === 1 ? "item has" : "items have"} succeeded and no stated outcome has closed yet.`,
        }
      : null,
    // Not an alarm: a gate held open is the guard working. It is placed above
    // the amendment note because it is the thing a reader can act on now.
    coverage.openGates.length === 0
      ? null
      : {
          alert: false,
          text:
            onlyOpenGate === undefined
              ? `${coverage.openGates.length} gates cannot pass until the criteria they require close: ${coverage.openGates.map((gate) => `${gate.gateId} (${gate.openCriterionIds.join(", ")})`).join("; ")}.`
              : `Gate ${onlyOpenGate.gateId} cannot pass until ${onlyOpenGate.openCriterionIds.join(", ")} ${onlyOpenGate.openCriterionIds.length === 1 ? "closes" : "close"}.`,
        },
    amendment === undefined
      ? null
      : {
          alert: false,
          text: `Contract amended ${coverage.amendments.length === 1 ? "once" : `${coverage.amendments.length} times`}, most recently by ${amendment.acceptanceId} replacing ${amendment.supersedes}: ${amendment.reason}`,
        },
    coverage.unknownReferences.length === 0
      ? null
      : {
          alert: false,
          text: `${coverage.unknownReferences.length} link${coverage.unknownReferences.length === 1 ? "" : "s"} name no declared criterion: ${coverage.unknownReferences.join(", ")}.`,
        },
    truncated
      ? {
          alert: false,
          text: "This campaign outgrew the coverage read, so these counts cover only its earlier checkpoints.",
        }
      : null,
  ].filter((note): note is { text: string; alert: boolean } => note !== null);
  if (notes.length === 0) return null;
  return (
    <div
      role="status"
      className="mt-2 space-y-1 rounded border border-border-seam bg-muted/30 px-2 py-1.5 text-2xs text-subtle-foreground"
    >
      {notes.map((note) => (
        <p
          key={note.text}
          // An amendment reason is author-supplied and can be long. Clamping is
          // visual only, so the full text stays selectable and copyable.
          className={
            note.alert
              ? "line-clamp-3 break-words text-warning-text"
              : "line-clamp-3 break-words"
          }
        >
          {note.text}
        </p>
      ))}
    </div>
  );
}

function AcceptanceCoverage({
  coverage,
  truncated,
  approval,
}: {
  coverage: AcceptanceCoverageView;
  truncated: boolean;
  approval: AmendmentApprovalTarget | null;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <p className="text-2xs font-medium text-subtle-foreground">
          Acceptance
        </p>
        <p className="text-2xs text-subtle-foreground">
          {coverage.closedCount} of {coverage.criteria.length} closed
          {coverage.inFlightCount === 0
            ? null
            : ` · ${coverage.inFlightCount} in flight`}
        </p>
      </div>
      <ol className="space-y-1">
        {coverage.criteria.map((criterion) => (
          <li
            key={criterion.id}
            className="flex items-start gap-2 rounded border border-border-seam px-2 py-1.5"
          >
            <span className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
              {criterion.statement}
            </span>
            <AcceptanceStateChip state={criterion.state} />
          </li>
        ))}
      </ol>
      <AcceptanceCoverageNotes coverage={coverage} truncated={truncated} />
      {approval === null ? null : (
        <PendingAmendments
          amendments={coverage.pendingAmendments}
          approval={approval}
        />
      )}
    </div>
  );
}

// The approval a workflow cannot issue for itself. It is rendered next to the
// criteria it would change so the reader can see what they are agreeing to.
function PendingAmendments({
  amendments,
  approval,
}: {
  amendments: AcceptanceCoverageView["pendingAmendments"];
  approval: AmendmentApprovalTarget;
}) {
  const rpc = useRpc<typeof workflowUiRpcContract>();
  const [approving, setApproving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (amendments.length === 0) return null;
  const approve = async (acceptanceId: string) => {
    setApproving(acceptanceId);
    setError(null);
    try {
      await rpc.call("workflowApproveAmendment", {
        threadId: approval.threadId,
        runId: approval.runId,
        acceptanceId,
      });
      await approval.onApproved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setApproving(null);
    }
  };
  return (
    <div className="mt-2 space-y-2">
      {amendments.map((amendment) => (
        <div
          key={amendment.acceptanceId}
          className="rounded border border-border-seam px-2 py-1.5"
        >
          <p className="text-2xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">
              {amendment.acceptanceId}
            </span>{" "}
            would replace {amendment.supersedes}: {amendment.reason}
          </p>
          {/* The proposed criteria, not just the amending agent's summary of
              them. Approving binds the contract to this body, so the approver
              has to be able to read the body. */}
          <ul className="mt-1 space-y-0.5">
            {amendment.criteria.map((criterion) => (
              <li
                key={criterion.id}
                className="text-2xs leading-relaxed text-muted-foreground"
              >
                <span className="text-foreground">{criterion.id}</span>{" "}
                &middot; {criterion.provenBy} &mdash; {criterion.statement}
                {criterion.detail === null ? null : ` (${criterion.detail})`}
              </li>
            ))}
          </ul>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-1.5"
            disabled={approving !== null}
            onClick={() => void approve(amendment.acceptanceId)}
          >
            {approving === amendment.acceptanceId
              ? "Approving…"
              : "Approve amendment"}
          </Button>
        </div>
      ))}
      {error === null ? null : (
        <p role="alert" className="text-2xs text-destructive-text">
          {error}
        </p>
      )}
    </div>
  );
}

function WorkflowBuildStory({
  state,
  approval,
}: {
  state: Extract<RunDetailsLoadState, { status: "ready" }>;
  approval: AmendmentApprovalTarget | null;
}) {
  const graph = buildDagLayers(
    state.checkpoints,
    state.omittedCheckpointRunCount > 0,
  );
  const hasTransitions = state.checkpoints.some((entry) =>
    isCheckpointKind(entry, "transition"),
  );
  if (
    graph.layers.length === 0 &&
    !hasTransitions &&
    state.coverage === null &&
    state.campaignRuns.length <= 1
  ) {
    return null;
  }
  return (
    <section
      aria-labelledby="workflow-build-story-heading"
      className="space-y-3"
    >
      <div>
        <h3
          id="workflow-build-story-heading"
          className="text-xs font-medium text-muted-foreground"
        >
          Build story
        </h3>
        {state.campaignRuns.length > 1 ? (
          <p className="mt-1 text-2xs text-subtle-foreground">
            {state.campaignRuns.length} related runs, shown as one campaign.
          </p>
        ) : null}
      </div>
      {state.coverage === null ? null : (
        <AcceptanceCoverage
          coverage={state.coverage}
          truncated={state.coverageTruncated}
          approval={approval}
        />
      )}
      <CampaignRunList runs={state.campaignRuns} />
      {state.omittedCheckpointRunCount === 0 ? null : (
        <div
          role="status"
          className="rounded border border-border-seam bg-muted/30 px-2 py-1.5 text-2xs text-subtle-foreground"
        >
          Checkpoint details for {state.omittedCheckpointRunCount} older
          campaign{" "}
          {state.omittedCheckpointRunCount === 1 ? "run was" : "runs were"}{" "}
          omitted to keep the inspector responsive. Every run remains listed.
        </div>
      )}
      <WorkflowDag graph={graph} />
      <TransitionNotes checkpoints={state.checkpoints} />
    </section>
  );
}

function WorkflowCheckpointDetails({
  state,
  approval,
}: {
  state: RunDetailsLoadState;
  approval: AmendmentApprovalTarget | null;
}) {
  if (state.status === "loading") {
    return (
      <div aria-label="Loading workflow details" className="space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }
  if (state.status === "error") {
    return <RefreshWarning message={state.message} />;
  }
  // Coverage alone is enough to show: a campaign can declare its acceptance
  // contract in a run whose checkpoints bounded hydration has already dropped.
  if (
    state.checkpoints.length === 0 &&
    state.campaignRuns.length <= 1 &&
    state.coverage === null
  ) {
    return (
      <div className="space-y-2">
        {state.refreshError === null ? null : (
          <RefreshWarning message={state.refreshError} />
        )}
        <p className="text-xs leading-relaxed text-subtle-foreground">
          This workflow has not published structured execution details.
        </p>
      </div>
    );
  }
  const plans = state.checkpoints.filter((entry) =>
    isCheckpointKind(entry, "plan"),
  );
  const workItems = state.checkpoints.filter((entry) =>
    isCheckpointKind(entry, "work-item"),
  );
  const verifications = state.checkpoints.filter((entry) =>
    isCheckpointKind(entry, "verification"),
  );
  const workItemLabels = new Map(
    plans
      .flatMap((entry) => entry.checkpoint.items)
      .map((item) => [
        item.id,
        item.ticketRef === null
          ? item.title
          : `${item.title} (${item.ticketRef})`,
      ]),
  );
  for (const entry of workItems) {
    const item = entry.checkpoint;
    workItemLabels.set(
      item.id,
      item.ticketRef === null
        ? item.title
        : `${item.title} (${item.ticketRef})`,
    );
  }
  return (
    <div className="space-y-4">
      {state.refreshError === null ? null : (
        <RefreshWarning message={state.refreshError} />
      )}
      <WorkflowBuildStory state={state} approval={approval} />
      {plans.length === 0 ? null : (
        <section aria-labelledby="workflow-plan-heading">
          <h3
            id="workflow-plan-heading"
            className="mb-2 text-xs font-medium text-muted-foreground"
          >
            Selected plan
          </h3>
          <div className="space-y-2">
            {plans.map((entry) => {
              const plan = entry.checkpoint;
              return (
                <CheckpointDisclosure
                  key={entry.id}
                  title={plan.title}
                  status={plan.status}
                  meta={`${plan.items.length} ${plan.items.length === 1 ? "work item" : "work items"}`}
                  defaultOpen
                >
                  {plan.summary === null ? null : (
                    <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
                      {plan.summary}
                    </p>
                  )}
                  {plan.detail === null ? null : (
                    <pre className="mb-2 whitespace-pre-wrap rounded bg-muted px-2 py-1.5 font-sans text-xs leading-relaxed text-muted-foreground">
                      {plan.detail}
                    </pre>
                  )}
                  <ol className="divide-y divide-border-seam">
                    {plan.items.map((item) => (
                      <li key={item.id} className="py-2 first:pt-0 last:pb-0">
                        <div className="flex items-start gap-2">
                          <span className="min-w-0 flex-1 text-xs font-medium text-foreground">
                            {item.title}
                          </span>
                          {item.ticketRef === null ? null : (
                            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
                              {item.ticketRef}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-subtle-foreground">
                          {item.objective}
                        </p>
                        {item.detail === null ? null : (
                          <pre className="mt-1 whitespace-pre-wrap font-sans text-xs leading-relaxed text-muted-foreground">
                            {item.detail}
                          </pre>
                        )}
                      </li>
                    ))}
                  </ol>
                </CheckpointDisclosure>
              );
            })}
          </div>
        </section>
      )}
      {workItems.length === 0 ? null : (
        <section aria-labelledby="workflow-implementation-heading">
          <h3
            id="workflow-implementation-heading"
            className="mb-2 text-xs font-medium text-muted-foreground"
          >
            Implementation
          </h3>
          <div className="space-y-2">
            {workItems.map((entry) => {
              const item = entry.checkpoint;
              return (
                <CheckpointDisclosure
                  key={entry.id}
                  title={item.title}
                  status={item.status}
                  meta={item.ticketRef}
                  defaultOpen={
                    item.status === "running" ||
                    item.status === "failed" ||
                    item.status === "blocked" ||
                    item.status === "interrupted"
                  }
                >
                  {item.summary === null ? null : (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {item.summary}
                    </p>
                  )}
                  {item.blocker === null ? null : (
                    <p className="mt-2 rounded bg-warning/10 px-2 py-1.5 text-xs text-warning-text">
                      Blocker: {item.blocker}
                    </p>
                  )}
                  {item.changedFiles.length === 0 ? null : (
                    <div className="mt-2">
                      <p className="mb-1 text-2xs font-medium text-subtle-foreground">
                        Changed files
                      </p>
                      <ul className="space-y-0.5">
                        {item.changedFiles.map((file) => (
                          <li
                            key={file}
                            className="break-all font-mono text-2xs text-muted-foreground"
                          >
                            {file}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <OpenWorkerButton childThreadId={entry.childThreadId} />
                </CheckpointDisclosure>
              );
            })}
          </div>
        </section>
      )}
      {verifications.length === 0 ? null : (
        <section aria-labelledby="workflow-verification-heading">
          <h3
            id="workflow-verification-heading"
            className="mb-2 text-xs font-medium text-muted-foreground"
          >
            Verification
          </h3>
          <div className="space-y-2">
            {verifications.map((entry) => {
              const verification = entry.checkpoint;
              const counts = verification.counts;
              const countSummary =
                counts === null
                  ? null
                  : `${counts.passed} passed · ${counts.failed} failed · ${counts.skipped} skipped`;
              const workItemLabel =
                verification.workItemId === null
                  ? "Run-wide verification"
                  : (workItemLabels.get(verification.workItemId) ??
                    `Unknown work item (${verification.workItemId})`);
              return (
                <CheckpointDisclosure
                  key={entry.id}
                  title={verification.title}
                  status={verification.status}
                  meta={countSummary}
                  defaultOpen={
                    verification.status === "running" ||
                    verification.status === "failed" ||
                    verification.status === "blocked" ||
                    verification.status === "interrupted"
                  }
                >
                  <p className="mb-2 text-2xs text-subtle-foreground">
                    For: {workItemLabel}
                  </p>
                  {verification.summary === null ? null : (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {verification.summary}
                    </p>
                  )}
                  {verification.command === null ? null : (
                    <div className="mt-2">
                      <p className="mb-1 text-2xs font-medium text-subtle-foreground">
                        Command
                      </p>
                      <code className="block whitespace-pre-wrap break-all rounded bg-muted px-2 py-1.5 text-2xs text-foreground">
                        {verification.command}
                      </code>
                    </div>
                  )}
                  <OpenWorkerButton childThreadId={entry.childThreadId} />
                </CheckpointDisclosure>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

type ArtifactAnnotation = WorkflowArtifactDetailView["annotations"][number];
type ArtifactSemanticClass = NonNullable<
  ArtifactAnnotation["decision"]
>["semanticClass"];

function semanticClass(value: string): ArtifactSemanticClass {
  switch (value) {
    case "editorial":
    case "refinement":
    case "contract":
    case "architecture":
      return value;
    default:
      return "refinement";
  }
}

function ArtifactAnnotationCard({
  annotation,
  threadId,
  runId,
  refresh,
}: {
  annotation: ArtifactAnnotation;
  threadId: string;
  runId: string;
  refresh: () => Promise<void>;
}) {
  const rpc = useRpc<typeof workflowUiRpcContract>();
  const [replyBody, setReplyBody] = useState("");
  const [rationale, setRationale] = useState("");
  const [assessmentSummary, setAssessmentSummary] = useState("");
  const [classification, setClassification] =
    useState<ArtifactSemanticClass>("refinement");
  const [verdict, setVerdict] = useState<
    "no-design-impact" | "bounded-design-delta" | "redesign-required"
  >("no-design-impact");
  const [appliedDecisionSuggestion, setAppliedDecisionSuggestion] = useState<
    string | null
  >(null);
  const [appliedArchitectureSuggestion, setAppliedArchitectureSuggestion] =
    useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (mutationError) {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : String(mutationError),
      );
    } finally {
      setBusy(false);
    }
  };
  const decision = annotation.decision;
  const change = decision?.change ?? null;
  const decisionSuggestion = annotation.assistance;
  const decisionSuggestionKey =
    decisionSuggestion?.status === "ready" &&
    decisionSuggestion.semanticClass !== null &&
    decisionSuggestion.rationale !== null
      ? `${decisionSuggestion.semanticClass}\u0000${decisionSuggestion.rationale}`
      : null;
  const architectureSuggestion = change?.assistance ?? null;
  const architectureSuggestionKey =
    architectureSuggestion?.status === "ready" &&
    architectureSuggestion.verdict !== null &&
    architectureSuggestion.summary !== null
      ? `${architectureSuggestion.verdict}\u0000${architectureSuggestion.summary}`
      : null;

  useEffect(() => {
    if (
      decision === null &&
      decisionSuggestionKey !== null &&
      decisionSuggestionKey !== appliedDecisionSuggestion &&
      decisionSuggestion !== null &&
      decisionSuggestion.semanticClass !== null &&
      decisionSuggestion.rationale !== null
    ) {
      setClassification(decisionSuggestion.semanticClass);
      setRationale(decisionSuggestion.rationale);
      setAppliedDecisionSuggestion(decisionSuggestionKey);
    }
  }, [
    appliedDecisionSuggestion,
    decision,
    decisionSuggestion,
    decisionSuggestionKey,
  ]);

  useEffect(() => {
    if (
      change?.status === "accepted-pending-impact" &&
      architectureSuggestionKey !== null &&
      architectureSuggestionKey !== appliedArchitectureSuggestion &&
      architectureSuggestion !== null &&
      architectureSuggestion.verdict !== null &&
      architectureSuggestion.summary !== null
    ) {
      setVerdict(architectureSuggestion.verdict);
      setAssessmentSummary(architectureSuggestion.summary);
      setAppliedArchitectureSuggestion(architectureSuggestionKey);
    }
  }, [
    appliedArchitectureSuggestion,
    architectureSuggestion,
    architectureSuggestionKey,
    change?.status,
  ]);

  return (
    <li className="rounded-md border border-border-seam bg-muted/20 p-2.5">
      <div className="flex items-start gap-2">
        <span className="rounded bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
          {annotation.kind === "comment" ? "Comment" : "Highlight"}
        </span>
        <span className="ml-auto text-2xs text-subtle-foreground">
          {annotation.status}
        </span>
      </div>
      <blockquote className="mt-2 border-l-2 border-border pl-2 text-xs text-muted-foreground">
        {annotation.anchor.exactQuote}
      </blockquote>
      {annotation.comments.length === 0 ? null : (
        <ol className="mt-2 space-y-1.5" aria-label="Comment history">
          {annotation.comments.map((comment) => (
            <li key={comment.id} className="rounded bg-background px-2 py-1.5">
              <p className="whitespace-pre-wrap text-xs text-foreground">
                {comment.body}
              </p>
              <p className="mt-1 text-2xs text-subtle-foreground">
                {comment.author} ·{" "}
                {new Date(comment.createdAt).toLocaleString()}
              </p>
            </li>
          ))}
        </ol>
      )}
      {annotation.status === "open" ? (
        <div className="mt-2 space-y-2">
          <div className="flex gap-1.5">
            <input
              aria-label="Reply to annotation"
              value={replyBody}
              onChange={(event) => setReplyBody(event.target.value)}
              placeholder="Continue the discussion"
              className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || replyBody.trim() === ""}
              onClick={() =>
                void mutate(async () => {
                  await rpc.call("workflowArtifactReply", {
                    threadId,
                    runId,
                    annotationId: annotation.id,
                    body: replyBody,
                    clientMutationId: nextClientMutationId(),
                  });
                  setReplyBody("");
                })
              }
            >
              Reply
            </Button>
          </div>
          {decisionSuggestion?.status === "pending" ? (
            <p className="text-2xs text-muted-foreground">
              Campaign steward is drafting the classification and rationale…
            </p>
          ) : null}
          {decisionSuggestion?.status === "ready" ? (
            <p className="text-2xs text-success-text">
              Suggested by the campaign steward. Review or edit before deciding.
            </p>
          ) : null}
          {decisionSuggestion?.status === "error" ? (
            <p className="text-2xs text-warning-text">
              Steward assistance was unavailable: {decisionSuggestion.error}
            </p>
          ) : null}
          <div className="grid gap-1.5 sm:grid-cols-2">
            <select
              aria-label="Feedback impact"
              value={classification}
              onChange={(event) =>
                setClassification(semanticClass(event.target.value))
              }
              className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
            >
              <option value="editorial">Editorial</option>
              <option value="refinement">Refinement</option>
              <option value="contract">Contract</option>
              <option value="architecture">Architecture</option>
            </select>
            <input
              aria-label="Decision rationale"
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              placeholder="Decision rationale"
              className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
            />
          </div>
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() =>
                void mutate(() =>
                  rpc.call("workflowArtifactDecide", {
                    threadId,
                    runId,
                    annotationId: annotation.id,
                    outcome: "accepted",
                    semanticClass: classification,
                    rationale,
                    clientMutationId: nextClientMutationId(),
                  }),
                )
              }
            >
              Accept feedback
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void mutate(() =>
                  rpc.call("workflowArtifactDecide", {
                    threadId,
                    runId,
                    annotationId: annotation.id,
                    outcome: "declined",
                    semanticClass: classification,
                    rationale,
                    clientMutationId: nextClientMutationId(),
                  }),
                )
              }
            >
              Decline
            </Button>
          </div>
        </div>
      ) : null}
      {decision === null ? null : (
        <div className="mt-2 rounded-md border border-border-seam bg-background p-2 text-xs">
          <p className="font-medium text-foreground">
            {decision.outcome === "accepted" ? "Accepted" : "Declined"} ·{" "}
            {decision.semanticClass}
          </p>
          {decision.rationale === "" ? null : (
            <p className="mt-1 text-muted-foreground">{decision.rationale}</p>
          )}
          {change?.status === "accepted-pending-impact" ? (
            <div className="mt-2 space-y-2">
              <p className="text-warning-text">
                Awaiting architecture assessment. Running workers have not
                received this change.
              </p>
              {architectureSuggestion?.status === "pending" ? (
                <p className="text-muted-foreground">
                  Architecting agents are assessing the accepted feedback…
                </p>
              ) : null}
              {architectureSuggestion?.status === "ready" ? (
                <p className="text-success-text">
                  Drafted from two architecting-agent reviews and campaign
                  steward synthesis. Review or edit before recording.
                </p>
              ) : null}
              {architectureSuggestion?.status === "error" ? (
                <p className="text-warning-text">
                  Architecture assistance was unavailable:{" "}
                  {architectureSuggestion.error}
                </p>
              ) : null}
              <select
                aria-label="Architecture verdict"
                value={verdict}
                onChange={(event) => {
                  const value = event.target.value;
                  if (
                    value === "no-design-impact" ||
                    value === "bounded-design-delta" ||
                    value === "redesign-required"
                  ) {
                    setVerdict(value);
                  }
                }}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs"
              >
                <option value="no-design-impact">No design impact</option>
                <option value="bounded-design-delta">
                  Bounded design delta
                </option>
                <option value="redesign-required">Redesign required</option>
              </select>
              <textarea
                aria-label="Architecture assessment summary"
                value={assessmentSummary}
                onChange={(event) => setAssessmentSummary(event.target.value)}
                placeholder="Record the architecture assessment"
                className="min-h-16 w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs"
              />
              <Button
                type="button"
                size="sm"
                disabled={busy || assessmentSummary.trim() === ""}
                onClick={() =>
                  void mutate(() =>
                    rpc.call("workflowArtifactAssessChange", {
                      threadId,
                      runId,
                      changeId: change.id,
                      verdict,
                      summary: assessmentSummary,
                      clientMutationId: nextClientMutationId(),
                    }),
                  )
                }
              >
                Record architecture assessment
              </Button>
            </div>
          ) : null}
          {change?.status === "awaiting-confirmation" ? (
            <div className="mt-2 space-y-2">
              <p className="text-muted-foreground">
                {change.architectureVerdict}: {change.architectureSummary}
              </p>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void mutate(() =>
                    rpc.call("workflowArtifactConfirmChange", {
                      threadId,
                      runId,
                      changeId: change.id,
                      clientMutationId: nextClientMutationId(),
                    }),
                  )
                }
              >
                Confirm admission
              </Button>
            </div>
          ) : null}
          {change?.status === "admitted" ? (
            <p className="mt-2 text-success-text">
              Admitted after review. Live worker propagation remains disabled
              for this development slice.
            </p>
          ) : null}
        </div>
      )}
      {error === null ? null : (
        <p role="alert" className="mt-2 text-xs text-destructive-text">
          {error}
        </p>
      )}
    </li>
  );
}

function WorkflowArtifactDocument({
  threadId,
  runId,
  artifactId,
  onBack,
}: {
  threadId: string;
  runId: string;
  artifactId: string;
  onBack: () => void;
}) {
  const rpc = useRpc<typeof workflowUiRpcContract>();
  const [revision, setRevision] = useState<number | null>(null);
  const { state, refresh } = useWorkflowArtifact(
    threadId,
    runId,
    artifactId,
    revision,
  );
  const [selection, setSelection] =
    useState<ExperimentalArtifactReviewSelection | null>(null);
  const [feedbackViewport, setFeedbackViewport] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [stewardThreadId, setStewardThreadId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state.status === "ready") {
      setStewardThreadId(state.detail.stewardThreadId);
    }
  }, [state]);

  if (state.status === "loading") return <LoadingPreview />;
  if (state.status === "error")
    return <EmptyOrError>{state.message}</EmptyOrError>;
  const { detail } = state;
  const addAnnotation = async (kind: "highlight" | "comment") => {
    if (selection === null) return;
    setBusy(true);
    setError(null);
    try {
      await rpc.call("workflowArtifactAnnotate", {
        threadId,
        runId,
        artifactId,
        revision: detail.selectedRevision.revision,
        kind,
        anchor: selection,
        body: kind === "comment" ? commentBody : null,
        clientMutationId: nextClientMutationId(),
      });
      setSelection(null);
      setFeedbackViewport(null);
      setCommentBody("");
      window.getSelection()?.removeAllRanges();
      await refresh();
    } catch (mutationError) {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : String(mutationError),
      );
    } finally {
      setBusy(false);
    }
  };
  const ensureSteward = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("workflowArtifactEnsureSteward", {
        threadId,
        runId,
      });
      setStewardThreadId(result.threadId);
      await refresh();
    } catch (mutationError) {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : String(mutationError),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="workflow-artifact-document-heading"
      className="space-y-3"
    >
      <div className="flex items-start gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>
          <Icon name="ChevronLeft" className="size-3" aria-hidden />
          Artifacts
        </Button>
        <div className="min-w-0 flex-1 text-right">
          <h3
            id="workflow-artifact-document-heading"
            className="truncate text-sm font-medium text-foreground"
          >
            {detail.artifact.title}
          </h3>
          <p className="text-2xs text-subtle-foreground">
            Revision {detail.selectedRevision.revision} ·{" "}
            {detail.selectedRevision.status}
          </p>
        </div>
      </div>
      {state.error === null ? null : <RefreshWarning message={state.error} />}
      <div
        className="flex flex-wrap gap-1"
        aria-label="Artifact revision history"
      >
        {detail.history.map((entry) => (
          <Button
            key={entry.revision}
            type="button"
            size="sm"
            variant={
              entry.revision === detail.selectedRevision.revision
                ? "default"
                : "outline"
            }
            onClick={() => setRevision(entry.revision)}
          >
            Revision {entry.revision}
          </Button>
        ))}
      </div>
      <ArtifactReview
        content={detail.content}
        annotations={detail.annotations.map((annotation) => ({
          id: annotation.id,
          kind: annotation.kind,
          exactQuote: annotation.anchor.exactQuote,
          status: annotation.status,
        }))}
        onSelectionChange={(nextSelection) => {
          setSelection(nextSelection);
          if (nextSelection === null) setFeedbackViewport(null);
        }}
        onFeedbackRequest={(
          request: ExperimentalArtifactReviewFeedbackRequest,
        ) => {
          setSelection(request.selection);
          setFeedbackViewport(request.viewport);
        }}
      />
      {selection === null ? null : (
        <div
          className={cn(
            "space-y-2 rounded-md border border-accent/30 bg-background p-2.5",
            feedbackViewport === null
              ? "bg-accent/5"
              : "fixed z-50 w-[min(24rem,calc(100vw-1.5rem))] shadow-xl",
          )}
          style={
            feedbackViewport === null
              ? undefined
              : {
                  left: `min(${feedbackViewport.x}px, calc(100vw - 24.75rem))`,
                  top: `min(${feedbackViewport.y}px, calc(100vh - 18rem))`,
                }
          }
        >
          <div className="flex items-center gap-2">
            <p className="text-xs font-medium text-foreground">Selected text</p>
            {feedbackViewport === null ? null : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => {
                  setSelection(null);
                  setFeedbackViewport(null);
                  setCommentBody("");
                }}
              >
                Cancel
              </Button>
            )}
          </div>
          <blockquote className="border-l-2 border-accent pl-2 text-xs text-muted-foreground">
            {selection.exactQuote}
          </blockquote>
          <textarea
            aria-label="New artifact comment"
            value={commentBody}
            onChange={(event) => setCommentBody(event.target.value)}
            placeholder="Add feedback about this selection"
            className="min-h-20 w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          />
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void addAnnotation("highlight")}
            >
              Save highlight
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy || commentBody.trim() === ""}
              onClick={() => void addAnnotation("comment")}
            >
              Add comment
            </Button>
          </div>
        </div>
      )}
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive-text">
          {error}
        </p>
      )}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <h4 className="text-xs font-medium text-muted-foreground">
            Review discussion
          </h4>
          <span className="ml-auto text-2xs text-subtle-foreground">
            {detail.annotations.length} saved
          </span>
        </div>
        {detail.annotations.length === 0 ? (
          <p className="text-xs text-subtle-foreground">
            Select text above to add the first durable highlight or comment.
          </p>
        ) : (
          <ol className="space-y-2">
            {detail.annotations.map((annotation) => (
              <ArtifactAnnotationCard
                key={annotation.id}
                annotation={annotation}
                threadId={threadId}
                runId={runId}
                refresh={refresh}
              />
            ))}
          </ol>
        )}
      </div>
      <div className="rounded-md border border-border-seam p-2.5">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <h4 className="text-xs font-medium text-foreground">
              Campaign steward
            </h4>
            <p className="mt-0.5 text-2xs text-subtle-foreground">
              Durable advisory discussion for the whole campaign.
            </p>
          </div>
          {stewardThreadId === null ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void ensureSteward()}
            >
              Start discussion
            </Button>
          ) : null}
        </div>
        {stewardThreadId === null ? null : (
          <div className="mt-2 h-96 min-h-0 overflow-hidden rounded-md border border-border-seam">
            <ThreadChat
              threadId={stewardThreadId}
              variant="compact"
              layout="document"
              permissionPolicy="editable"
              className="h-full"
            />
          </div>
        )}
      </div>
    </section>
  );
}

function WorkflowArtifactsSection({
  threadId,
  runId,
}: {
  threadId: string;
  runId: string;
}) {
  const rpc = useRpc<typeof workflowUiRpcContract>();
  const { state, refresh } = useWorkflowArtifacts(threadId, runId);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(
    null,
  );
  const [seeding, setSeeding] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);
  if (selectedArtifactId !== null) {
    return (
      <WorkflowArtifactDocument
        threadId={threadId}
        runId={runId}
        artifactId={selectedArtifactId}
        onBack={() => setSelectedArtifactId(null)}
      />
    );
  }
  if (state.status === "loading") {
    return (
      <section aria-label="Loading workflow artifacts" className="space-y-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </section>
    );
  }
  if (state.status === "error")
    return <RefreshWarning message={state.message} />;
  const seed = async () => {
    setSeeding(true);
    setSeedError(null);
    try {
      await rpc.call("workflowArtifactSeed", {
        threadId,
        runId,
        documents: null,
        clientMutationId: nextClientMutationId(),
      });
      await refresh();
    } catch (error) {
      setSeedError(error instanceof Error ? error.message : String(error));
    } finally {
      setSeeding(false);
    }
  };
  return (
    <section aria-labelledby="workflow-artifacts-heading" className="space-y-2">
      <div>
        <h3
          id="workflow-artifacts-heading"
          className="text-xs font-medium text-muted-foreground"
        >
          Artifacts
        </h3>
        <p className="mt-1 text-2xs text-subtle-foreground">
          Immutable campaign requirements, architecture, and decisions.
        </p>
      </div>
      {state.error === null ? null : <RefreshWarning message={state.error} />}
      {state.artifacts.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-3">
          <p className="text-xs text-muted-foreground">
            This campaign has no review artifacts yet.
          </p>
          <Button
            type="button"
            size="sm"
            className="mt-2"
            disabled={seeding}
            onClick={() => void seed()}
          >
            {seeding ? "Creating…" : "Create review artifacts"}
          </Button>
        </div>
      ) : (
        <ol className="grid gap-2 sm:grid-cols-3">
          {state.artifacts.map((artifact) => (
            <li key={artifact.id}>
              <button
                type="button"
                className="h-full w-full rounded-md border border-border-seam bg-muted/20 p-2.5 text-left transition-colors hover:bg-muted/40"
                onClick={() => setSelectedArtifactId(artifact.id)}
              >
                <span className="block text-xs font-medium text-foreground">
                  {artifact.title}
                </span>
                <span className="mt-1 block text-2xs text-subtle-foreground">
                  Revision {artifact.currentRevision} · {artifact.status}
                </span>
                <span className="mt-1 block text-2xs text-muted-foreground">
                  {artifact.openAnnotationCount} open
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {seedError === null ? null : (
        <p role="alert" className="text-xs text-destructive-text">
          {seedError}
        </p>
      )}
    </section>
  );
}

function WorkflowRunPanelLoaded({
  threadId,
  runId,
}: {
  threadId: string;
  runId: string | null;
}) {
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof workflowUiRpcContract>();
  const { state, refresh } = useWorkflowRun(threadId, runId);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const run = state.status === "ready" ? state.run : null;
  const detailsRunId = runId ?? run?.id ?? null;
  const { state: detailsState, refresh: refreshDetails } =
    useWorkflowRunDetails(
      threadId,
      detailsRunId,
      run !== null && isRunActive(run),
      runId !== null || run !== null,
    );
  const pinnedDetailsState: RunDetailsLoadState =
    (detailsState.status === "ready" || detailsState.status === "error") &&
    detailsState.runId !== detailsRunId
      ? { status: "loading" }
      : detailsState;
  const shared = useMemo(
    () => (run === null ? null : buildSharedWorkflowView(run)),
    [run],
  );
  if (state.status === "loading") {
    return (
      <WorkflowRunPanelState>
        <LoadingPreview />
      </WorkflowRunPanelState>
    );
  }
  if (state.status === "error") {
    return (
      <WorkflowRunPanelState>
        <EmptyOrError>{state.message}</EmptyOrError>
      </WorkflowRunPanelState>
    );
  }
  if (run === null || shared === null) {
    return (
      <WorkflowRunPanelState>
        <EmptyOrError>
          No workflow runs were found for this thread.
        </EmptyOrError>
      </WorkflowRunPanelState>
    );
  }
  const pillState = runPillState(run.status);
  const duration = formatDuration(run.startedAt, run.finishedAt);
  const settledAgents = settledAgentCount(shared.progress.agents);
  const completedCalls = shared.progress.agents.filter(
    (agent) => agent.state === "done",
  ).length;
  const cachedCalls = shared.progress.agents.filter(
    (agent) => agent.cached,
  ).length;
  const stop = async () => {
    setStopping(true);
    setStopError(null);
    try {
      await rpc.call("workflowStopRun", { threadId, runId: run.id });
      await refresh();
    } catch (error) {
      setStopError(error instanceof Error ? error.message : String(error));
    } finally {
      setStopping(false);
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col bg-border">
      <div
        data-detail-scroll-area="workflow-panel"
        className="min-h-0 flex-1 overflow-y-auto p-4"
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium text-foreground">
              {run.name}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {run.description}
            </p>
          </div>
          {pillState === null ? null : <WorkflowStatusPill state={pillState} />}
        </div>
        <div className="mt-2 flex items-center gap-2 text-2xs tabular-nums text-subtle-foreground">
          <span>
            {shared.progress.agents.length > 0
              ? `${settledAgents}/${shared.progress.agents.length} agents · `
              : ""}
            {duration === null
              ? "Not started"
              : `${duration} ${isRunActive(run) ? "elapsed" : "total"}`}
          </span>
          <span className="ml-auto font-mono">{run.id.slice(-8)}</span>
        </div>
        {run.originThreadId === threadId ? null : (
          <div className="mt-3 flex items-center justify-between rounded-md border border-border-seam bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
            <span>
              Related workflow executing in another agent thread. Open that
              thread to control it.
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => navigate.toThread(run.originThreadId)}
            >
              Open thread
            </Button>
          </div>
        )}
        <WorkflowPhaseStrip
          progress={shared.progress}
          currentPhaseIndex={shared.currentPhaseIndex}
          settled={!isRunActive(run)}
          className="mt-3"
        />
        {stopError === null ? null : (
          <div
            role="alert"
            className="mt-3 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive-text"
          >
            {stopError}
          </div>
        )}
        {state.refreshError === null ? null : (
          <div className="mt-3">
            <RefreshWarning message={state.refreshError} />
          </div>
        )}
        <div className="my-4 h-px bg-border-seam" />
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">
          Phases
        </h3>
        <div className="-mx-2">
          <WorkflowProgress
            progress={shared.progress}
            settled={!isRunActive(run)}
            error={run.error}
            collapsiblePhases
            currentPhaseIndex={shared.currentPhaseIndex}
            terminalState={runTerminalState(run)}
            onAgentActivate={(agent) => {
              const childThreadId =
                agent.id === undefined
                  ? null
                  : (shared.callsById.get(agent.id)?.childThreadId ?? null);
              if (childThreadId !== null) navigate.toThread(childThreadId);
            }}
          />
        </div>
        <div className="my-4 h-px bg-border-seam" />
        <WorkflowCheckpointDetails
          state={pinnedDetailsState}
          approval={
            // Approving is scoped the same way stopping is, so a thread that
            // only observes the run is not offered the control it cannot use.
            run.originThreadId === threadId
              ? { threadId, runId: run.id, onApproved: refreshDetails }
              : null
          }
        />
        <div className="my-4 h-px bg-border-seam" />
        <WorkflowArtifactsSection threadId={threadId} runId={run.id} />
        <div className="my-4 h-px bg-border-seam" />
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">
          Run details
        </h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-subtle-foreground">Agent calls</dt>
          <dd className="text-right text-muted-foreground">
            {completedCalls} of {shared.progress.agents.length}
          </dd>
          <dt className="text-subtle-foreground">Cache hits</dt>
          <dd className="text-right text-muted-foreground">{cachedCalls}</dd>
          <dt className="text-subtle-foreground">Started</dt>
          <dd className="text-right text-muted-foreground">
            {run.startedAt === null
              ? "—"
              : new Date(run.startedAt).toLocaleTimeString()}
          </dd>
          <dt className="text-subtle-foreground">Result</dt>
          <dd className="text-right text-muted-foreground">
            {run.resultAvailable ? "Available" : "—"}
          </dd>
        </dl>
      </div>
      {isRunActive(run) && run.originThreadId === threadId ? (
        <div className="border-t border-border-seam p-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full text-destructive-text"
            disabled={stopping}
            onClick={() => void stop()}
          >
            {stopping ? "Stopping…" : "Stop workflow"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "workflow-thread-row-status",
    mount({ pluginId, signal, experimental_setThreadRowStatus }) {
      return mountWorkflowThreadRowStatuses({
        pluginId,
        signal,
        setThreadRowStatus: experimental_setThreadRowStatus,
      });
    },
  });
  app.slots.experimental_threadHeaderAction({
    id: "workflow-phase",
    title: "Workflow phase",
    component: WorkflowThreadHeaderAction,
  });
  app.composer.customize({
    id: "workflow-status",
    scopes: ["thread"],
    banners: [
      { id: "active-runs", chrome: "bare", component: WorkflowStatusBanner },
    ],
  });
  app.slots.messageDirective({
    id: "workflow-preview",
    component: WorkflowPreviewDirective,
  });
  app.slots.threadPanelAction({
    id: WORKFLOW_PANEL_ACTION_ID,
    title: "Workflow run",
    icon: "Workflow",
    component: WorkflowRunPanel,
    layout: "flush",
  });
});
