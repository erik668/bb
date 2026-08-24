// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { WorkflowAcceptanceCoverage } from "./workflow-coverage.js";
import type { WorkflowCheckpointView, WorkflowRunView } from "./ui-contract.js";

const app = await loadPluginApp(() => import("./app"));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const message = {
  id: "msg_1",
  threadId: "thr_origin",
  turnId: "turn_1",
  projectId: "proj_1",
};

const run: WorkflowRunView = {
  id: "wfr_11111111-1111-4111-8111-111111111111",
  originThreadId: "thr_origin",
  presentationThreadId: "thr_origin",
  parentRunId: null,
  rootRunId: "wfr_11111111-1111-4111-8111-111111111111",
  campaignId: "campaign-release",
  name: "Review the release",
  description: "Run independent checks before shipping.",
  status: "running",
  currentPhase: "Review",
  phases: [
    {
      title: "Discover",
      detail: "Inspect the changed surface.",
      calls: [
        {
          id: "wfc_1",
          index: 0,
          label: "Inspect implementation",
          phase: "Discover",
          status: "succeeded",
          provider: "codex",
          model: "gpt-5.6",
          reasoningLevel: "medium",
          cached: false,
          childThreadId: "thr_worker_1",
          promptBytes: 120,
          contextMinimumTokens: null,
          contextFit: "untracked",
          observedContextUsedTokens: null,
          observedModelContextWindow: null,
          contextUsageEstimated: null,
          providerRetryAttempts: 0,
          repairAttempts: 0,
          error: null,
          createdAt: 1_000,
          startedAt: 1_100,
          finishedAt: 2_100,
        },
      ],
    },
    {
      title: "Review",
      detail: "Challenge the combined result.",
      calls: [
        {
          id: "wfc_2",
          index: 1,
          label: "Adversarial review",
          phase: "Review",
          status: "running",
          provider: "claude",
          model: "claude-opus-4-6",
          reasoningLevel: "high",
          cached: false,
          childThreadId: "thr_worker_2",
          promptBytes: 2_400,
          contextMinimumTokens: 1_000_000,
          contextFit: "undersized",
          observedContextUsedTokens: 180_000,
          observedModelContextWindow: 258_400,
          contextUsageEstimated: false,
          providerRetryAttempts: 0,
          repairAttempts: 0,
          error: null,
          createdAt: 2_200,
          startedAt: 2_300,
          finishedAt: null,
        },
      ],
    },
  ],
  unphasedCalls: [],
  resultAvailable: false,
  error: null,
  createdAt: 900,
  startedAt: 1_000,
  finishedAt: null,
};

const checkpoints: WorkflowCheckpointView[] = [
  {
    id: "wcp_plan",
    checkpoint: {
      kind: "plan",
      id: "selected-plan",
      title: "Release readiness plan",
      status: "succeeded",
      summary: "Ship the two accepted tickets, then run focused checks.",
      detail:
        "Lane: implementation\nCoverage: full\nGate: both tickets must verify before delivery",
      items: [
        {
          id: "ticket-101",
          title: "Expose workflow details",
          objective: "Render the full accepted plan in the workflow panel.",
          detail: "Owner: UI worker\nDependency: durable checkpoint API",
          ticketRef: "BB-101",
          dependsOn: [],
          nodeType: "work",
        },
        {
          id: "ticket-102",
          title: "Track verification",
          objective: "Show exact commands and their latest result.",
          detail:
            "Owner: verification worker\nGate: focused and full suites pass",
          ticketRef: "BB-102",
          dependsOn: ["ticket-101"],
          nodeType: "work",
        },
      ],
    },
    phase: "Plan",
    childThreadId: null,
    createdAt: 1_000,
    updatedAt: 1_000,
  },
  {
    id: "wcp_work",
    checkpoint: {
      kind: "work-item",
      id: "ticket-101",
      title: "Expose workflow details",
      status: "running",
      summary: "The durable read path is complete; panel work is underway.",
      ticketRef: "BB-101",
      changedFiles: ["plugins/workflows/src/app.tsx"],
      blocker: null,
      dependsOn: [],
      nodeType: "work",
    },
    phase: "Implement",
    childThreadId: "thr_worker_2",
    createdAt: 2_000,
    updatedAt: 2_500,
  },
  {
    id: "wcp_verify",
    checkpoint: {
      kind: "verification",
      id: "ticket-101:focused-tests",
      title: "Focused workflow tests",
      status: "succeeded",
      summary: "All selected tests passed.",
      workItemId: "ticket-101",
      command: "pnpm exec vitest run src/app.test.tsx",
      counts: { passed: 8, failed: 0, skipped: 1 },
    },
    phase: "Verify",
    childThreadId: "thr_worker_2",
    createdAt: 3_000,
    updatedAt: 3_500,
  },
];

function workCheckpoint(
  id: string,
  status: WorkflowCheckpointView["checkpoint"]["status"],
): WorkflowCheckpointView {
  return {
    id: `wcp_${id}`,
    checkpoint: {
      kind: "work-item",
      id,
      title: id.replaceAll("-", " "),
      status,
      summary: `${id} summary`,
      ticketRef: null,
      changedFiles: [],
      blocker: status === "blocked" ? `${id} blocker` : null,
      dependsOn: [],
      nodeType: "work",
    },
    phase: "Implement",
    childThreadId: null,
    createdAt: 2_000,
    updatedAt: 2_500,
  };
}

describe("workflows app registration", () => {
  it("registers the composer banner, chat directive, and thread panel action", () => {
    expect(app.composerCustomizations).toMatchObject([
      {
        id: "workflow-status",
        scopes: ["thread"],
        banners: [{ id: "active-runs", chrome: "bare" }],
      },
    ]);
    expect(app.messageDirectives.map((directive) => directive.id)).toEqual([
      "workflow-preview",
    ]);
    expect(app.threadPanelActions).toMatchObject([
      {
        id: "workflow-run",
        title: "Workflow run",
        icon: "Workflow",
        layout: "flush",
      },
    ]);
  });
});

describe("workflow composer banner", () => {
  const banner = app.composerCustomizations[0]!.banners![0]!;

  it("renders active runs for the composer scope thread", async () => {
    const queuedRun: WorkflowRunView = {
      ...run,
      id: "wfr_22222222-2222-4222-8222-222222222222",
      name: "Queue release notes",
      status: "queued",
      currentPhase: null,
      phases: [],
      startedAt: null,
    };
    const slot = renderSlot(
      banner,
      {},
      {
        composer: {
          scope: { kind: "thread", threadId: "thr_scope" },
        },
        rpc: {
          workflowActiveRuns: (input) => {
            expect(input).toEqual({ threadId: "thr_scope" });
            return { runs: [run, queuedRun] };
          },
        },
      },
    );

    await slot.findByText("Review the release");
    expect(slot.getByText("Queue release notes")).toBeTruthy();
    expect(slot.getByText("Review")).toBeTruthy();
    expect(slot.getByText("1/2 agents")).toBeTruthy();
    expect(slot.getAllByRole("region", { name: "Workflow" })).toHaveLength(2);
    expect(
      slot.getByRole("button", {
        name: /open workflow review.*in side panel/i,
      }),
    ).toBeTruthy();
  });

  it("labels workflows presented from another origin thread as related", async () => {
    const relatedRun: WorkflowRunView = {
      ...run,
      originThreadId: "thr_worker",
      presentationThreadId: "thr_root",
    };
    const slot = renderSlot(
      banner,
      {},
      {
        composer: {
          scope: { kind: "thread", threadId: "thr_root" },
        },
        rpc: {
          workflowActiveRuns: () => ({ runs: [relatedRun] }),
        },
      },
    );

    await slot.findByText("Related workflows");
    expect(slot.getByText("1 active")).toBeTruthy();
    expect(slot.getByText("Related")).toBeTruthy();
    expect(slot.getByText("Review the release")).toBeTruthy();
  });

  it("matches the native collapsed summary and expands with an accessible toggle", async () => {
    const slot = renderSlot(
      banner,
      {},
      {
        composer: {
          scope: { kind: "thread", threadId: "thr_scope" },
        },
        rpc: { workflowActiveRuns: () => ({ runs: [run] }) },
      },
    );

    const toggle = await slot.findByRole("button", {
      name: "Workflow: Review the release",
    });
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.focus();
    expect(document.activeElement).toBe(toggle);

    const body = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(body?.getAttribute("role")).toBe("region");
    expect(body?.getAttribute("aria-labelledby")).toBe(toggle.id);
    expect(body?.getAttribute("aria-hidden")).toBe("true");
    expect(body?.className).toContain("grid-rows-[0fr]");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(body?.getAttribute("aria-hidden")).toBe("false");
    expect(body?.className).toContain("grid-rows-[1fr]");
    expect(slot.getByText("Adversarial review")).toBeTruthy();
    expect(slot.getByRole("button", { name: /Review0\/1/ })).toBeTruthy();
    expect(
      slot.container.querySelector('[data-icon="ChevronDown"].rotate-180'),
    ).toBeTruthy();
  });

  it("preserves each run's expansion state across polls", async () => {
    vi.useFakeTimers();
    let polls = 0;
    const slot = renderSlot(
      banner,
      {},
      {
        composer: {
          scope: { kind: "thread", threadId: "thr_scope" },
        },
        rpc: {
          workflowActiveRuns: () => {
            polls += 1;
            return { runs: [{ ...run }] };
          },
        },
      },
    );

    await act(async () => Promise.resolve());
    const toggle = slot.getByRole("button", {
      name: "Workflow: Review the release",
    });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(polls).toBe(2);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    slot.unmount();
  });

  it("renders null when the scope thread has no active runs", async () => {
    const slot = renderSlot(
      banner,
      {},
      {
        composer: {
          scope: { kind: "thread", threadId: "thr_idle" },
        },
        rpc: { workflowActiveRuns: () => ({ runs: [] }) },
      },
    );

    await waitFor(() => expect(slot.rpcCalls).toHaveLength(1));
    expect(slot.container.childElementCount).toBe(0);
  });

  it("does not poll an idle thread; a workflow-runs signal for the thread triggers one refresh", async () => {
    vi.useFakeTimers();
    let runs: WorkflowRunView[] = [];
    const slot = renderSlot(
      banner,
      {},
      {
        composer: {
          scope: { kind: "thread", threadId: "thr_idle" },
        },
        rpc: { workflowActiveRuns: () => ({ runs }) },
      },
    );

    await act(async () => Promise.resolve());
    expect(slot.rpcCalls).toHaveLength(1);
    // Idle thread: no standing 1 s poll (this is what kept a phone's radio
    // and main thread busy on every open thread with the plugin enabled).
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(slot.rpcCalls).toHaveLength(1);

    // A signal about a different thread is ignored.
    await slot.emitRealtime("workflow-runs", { threadId: "thr_other" });
    expect(slot.rpcCalls).toHaveLength(1);

    // The service's signal for this thread refreshes once, and the banner
    // starts polling because the refreshed set has an active run.
    runs = [run];
    await slot.emitRealtime("workflow-runs", { threadId: "thr_idle" });
    await act(async () => Promise.resolve());
    expect(slot.rpcCalls).toHaveLength(2);
    expect(slot.getByText("Review the release")).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(slot.rpcCalls).toHaveLength(3);

    // Once the run set is empty again, polling stops.
    runs = [];
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(slot.rpcCalls).toHaveLength(4);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(slot.rpcCalls).toHaveLength(4);
    slot.unmount();
  });

  it("pauses polling while the document is hidden and refreshes once when it is visible again", async () => {
    vi.useFakeTimers();
    const setVisibility = (state: "visible" | "hidden") => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    const slot = renderSlot(
      banner,
      {},
      {
        composer: {
          scope: { kind: "thread", threadId: "thr_scope" },
        },
        rpc: { workflowActiveRuns: () => ({ runs: [run] }) },
      },
    );
    try {
      await act(async () => Promise.resolve());
      expect(slot.rpcCalls).toHaveLength(1);
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(slot.rpcCalls).toHaveLength(2);

      await act(async () => {
        setVisibility("hidden");
      });
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(slot.rpcCalls).toHaveLength(2);

      await act(async () => {
        setVisibility("visible");
      });
      await act(async () => Promise.resolve());
      // Catch-up refresh on return, then the 1 s cadence resumes.
      expect(slot.rpcCalls).toHaveLength(3);
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(slot.rpcCalls).toHaveLength(4);
    } finally {
      slot.unmount();
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
    }
  });

  it("opens the run in the workflow side panel without stopping it", async () => {
    const openThreadPanel = vi.fn(() => true);
    const slot = renderSlot(
      banner,
      {},
      {
        composer: {
          scope: { kind: "thread", threadId: "thr_scope" },
        },
        openThreadPanel,
        rpc: {
          workflowActiveRuns: () => ({ runs: [run] }),
        },
      },
    );

    fireEvent.click(
      await slot.findByRole("button", {
        name: /open workflow review.*in side panel/i,
      }),
    );
    expect(openThreadPanel).toHaveBeenCalledWith({
      actionId: "workflow-run",
      title: "Review the release",
      params: { runId: run.id },
    });
    expect(
      slot.rpcCalls.some((call) => call.method === "workflowStopRun"),
    ).toBe(false);
  });
});

describe("workflow-preview directive", () => {
  it("rejects untrusted attributes before making an RPC call", async () => {
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { run: run.id, surprise: "true" },
        source: `::workflow-preview{run="${run.id}" surprise="true"}`,
        message,
        openWorkspaceFile: null,
      },
      { rpc: {} },
    );

    expect((await slot.findByRole("alert")).textContent).toMatch(
      /requires exactly one valid run attribute/i,
    );
    expect(slot.rpcCalls).toEqual([]);
  });

  it("renders live phases and opens the matching shared thread panel", async () => {
    const openThreadPanel = vi.fn(() => true);
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { run: run.id },
        source: `::workflow-preview{run="${run.id}"}`,
        message,
        openWorkspaceFile: null,
      },
      {
        openThreadPanel,
        rpc: {
          workflowRunView: (input) => {
            expect(input).toEqual({ threadId: "thr_origin", runId: run.id });
            return { run };
          },
        },
      },
    );

    await slot.findByText("Review the release");
    expect(slot.getByText("Discover")).toBeTruthy();
    expect(slot.getAllByText("Review")).toHaveLength(1);
    expect(slot.getByText("Adversarial review")).toBeTruthy();
    expect(
      slot.getByText(
        "claude · opus-4-6 · high · context 180k/258k · undersized ≥1M",
      ),
    ).toBeTruthy();
    // A live run has no "Running" pill, and only the top-level header
    // shimmers — phase and agent rows stay static (agents have spinners).
    expect(slot.queryByText("Running")).toBeNull();
    expect(
      slot.getByText("Review the release").className.includes("animate-shine"),
    ).toBe(true);
    expect(
      slot.getByText("Adversarial review").className.includes("animate-shine"),
    ).toBe(false);
    expect(
      slot.getAllByText("Review")[0]!.className.includes("animate-shine"),
    ).toBe(false);

    const workflowToggle = slot.getByRole("button", {
      name: "Workflow: Review the release",
    });
    fireEvent.click(workflowToggle);
    expect(workflowToggle.getAttribute("aria-expanded")).toBe("false");
    const collapsedRegion = document.getElementById(
      workflowToggle.getAttribute("aria-controls")!,
    );
    expect(collapsedRegion?.getAttribute("role")).toBe("region");
    expect(collapsedRegion?.getAttribute("aria-labelledby")).toBe(
      workflowToggle.id,
    );
    expect(collapsedRegion?.hasAttribute("inert")).toBe(true);
    expect(
      collapsedRegion?.querySelector('button[aria-expanded="true"]'),
    ).toBeTruthy();
    fireEvent.click(workflowToggle);

    fireEvent.click(slot.getByRole("button", { name: /open in right panel/i }));
    expect(openThreadPanel).toHaveBeenCalledWith({
      actionId: "workflow-run",
      title: "Review the release",
      params: { runId: run.id },
    });
  });

  it("keeps workers outside declared phases visible", async () => {
    const unphasedRun: WorkflowRunView = {
      ...run,
      currentPhase: null,
      phases: run.phases.map((phase) => ({
        ...phase,
        calls: phase.calls.map((call) => ({
          ...call,
          status: "succeeded" as const,
          finishedAt: 3_000,
        })),
      })),
      unphasedCalls: [
        {
          ...run.phases[0]!.calls[0]!,
          id: "wfc_other",
          label: "Unphased verification",
          phase: null,
          status: "running",
          finishedAt: null,
        },
      ],
    };
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { run: run.id },
        source: `::workflow-preview{run="${run.id}"}`,
        message,
        openWorkspaceFile: null,
      },
      { rpc: { workflowRunView: () => ({ run: unphasedRun }) } },
    );

    await slot.findByText("Other work");
    expect(slot.getByText("Unphased verification")).toBeTruthy();
  });

  it("recovers from initial and active polling failures, then settles", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const terminalRun: WorkflowRunView = {
      ...run,
      status: "succeeded",
      phases: run.phases.map((phase) => ({
        ...phase,
        calls: phase.calls.map((call) => ({
          ...call,
          status: "succeeded" as const,
          finishedAt: 4_000,
        })),
      })),
      finishedAt: 4_000,
    };
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { run: run.id },
        source: `::workflow-preview{run="${run.id}"}`,
        message,
        openWorkspaceFile: null,
      },
      {
        rpc: {
          workflowRunView: () => {
            attempt += 1;
            if (attempt === 1) throw new Error("initial outage");
            if (attempt === 3) throw new Error("poll outage");
            return { run: attempt === 2 ? run : terminalRun };
          },
        },
      },
    );

    await act(async () => Promise.resolve());
    expect(slot.getByRole("alert").textContent).toMatch(/initial outage/i);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(slot.getByText("Review the release")).toBeTruthy();
    expect(slot.queryByText("Complete")).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(slot.getByRole("status").textContent).toMatch(
      /poll outage.*retrying/i,
    );
    expect(slot.getByText("Review the release")).toBeTruthy();

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(slot.getByText("Complete")).toBeTruthy();
    expect(slot.queryByRole("status")).toBeNull();
    expect(attempt).toBe(4);

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(attempt).toBe(4);
    slot.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(attempt).toBe(4);
  });

  it("does not overlap a poll that takes longer than the interval", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    let resolvePoll: ((value: { run: WorkflowRunView }) => void) | null = null;
    const delayedPoll = new Promise<{ run: WorkflowRunView }>((resolve) => {
      resolvePoll = resolve;
    });
    const terminalRun: WorkflowRunView = {
      ...run,
      status: "succeeded",
      phases: run.phases.map((phase) => ({
        ...phase,
        calls: phase.calls.map((call) => ({
          ...call,
          status: "succeeded" as const,
          finishedAt: 4_000,
        })),
      })),
      finishedAt: 4_000,
    };
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { run: run.id },
        source: `::workflow-preview{run="${run.id}"}`,
        message,
        openWorkspaceFile: null,
      },
      {
        rpc: {
          workflowRunView: () => {
            attempt += 1;
            if (attempt === 1) return { run };
            if (attempt === 2) return delayedPoll;
            throw new Error("polls overlapped");
          },
        },
      },
    );

    await act(async () => Promise.resolve());
    expect(slot.getByText("Review the release")).toBeTruthy();
    expect(slot.queryByText("Complete")).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(attempt).toBe(2);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(attempt).toBe(2);

    await act(async () => {
      resolvePoll?.({ run: terminalRun });
      await delayedPoll;
    });
    expect(slot.getByText("Complete")).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(attempt).toBe(2);
  });

  it("renders successful empty phases as settled", async () => {
    const succeededRun: WorkflowRunView = {
      ...run,
      status: "succeeded",
      currentPhase: "Empty phase",
      phases: [{ title: "Empty phase", detail: null, calls: [] }],
      finishedAt: 4_000,
    };
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { run: run.id },
        source: `::workflow-preview{run="${run.id}"}`,
        message,
        openWorkspaceFile: null,
      },
      { rpc: { workflowRunView: () => ({ run: succeededRun }) } },
    );

    await slot.findByText("Complete");
    expect(
      slot
        .getAllByText("Empty phase")
        .some((element) => element.className.includes("line-through")),
    ).toBe(false);
    expect(
      slot
        .getAllByText("Empty phase")
        .some((element) => element.className.includes("no-underline")),
    ).toBe(true);
    expect(slot.getByText("not started")).toBeTruthy();
  });

  it("uses cancelled presentation for the run, phase, and call", async () => {
    const cancelledCall = {
      ...run.phases[1]!.calls[0]!,
      status: "cancelled" as const,
      finishedAt: 4_000,
    };
    const cancelledRun: WorkflowRunView = {
      ...run,
      status: "cancelled",
      phases: [{ title: "Review", detail: null, calls: [cancelledCall] }],
      finishedAt: 4_000,
    };
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { run: run.id },
        source: `::workflow-preview{run="${run.id}"}`,
        message,
        openWorkspaceFile: null,
      },
      { rpc: { workflowRunView: () => ({ run: cancelledRun }) } },
    );

    await slot.findByText("Cancelled");
    // One Pause in the status pill, one on the cancelled call row.
    expect(slot.container.querySelectorAll('[data-icon="Pause"]')).toHaveLength(
      2,
    );
    expect(slot.container.querySelector('[data-icon="Check"]')).toBeNull();
  });
});

describe("workflow thread panel", () => {
  it("shows related-run provenance and opens the execution origin thread", async () => {
    const relatedRun: WorkflowRunView = {
      ...run,
      originThreadId: "thr_worker",
      presentationThreadId: "thr_root",
    };
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_root", params: { runId: relatedRun.id } },
      {
        rpc: {
          workflowRunView: (input) => {
            expect(input).toEqual({
              threadId: "thr_root",
              runId: relatedRun.id,
            });
            return { run: relatedRun };
          },
          workflowRunDetails: () => ({ checkpoints: [] }),
        },
      },
    );

    await slot.findByText(/Related workflow executing in another agent thread/);
    expect(slot.queryByRole("button", { name: "Stop workflow" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Open thread" }));
    expect(slot.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thr_worker",
    });
  });

  it("pins latest-run details to the run resolved for the panel header", async () => {
    let resolveRun: ((value: { run: WorkflowRunView }) => void) | null = null;
    const pendingRun = new Promise<{ run: WorkflowRunView }>((resolve) => {
      resolveRun = resolve;
    });
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_origin", params: null },
      {
        rpc: {
          workflowRunView: () => pendingRun,
          workflowRunDetails: (input) => {
            expect(input).toEqual({ threadId: "thr_origin", runId: run.id });
            return {
              checkpoints,
              campaign: {
                id: run.campaignId,
                detailedRunLimit: 4,
                omittedCheckpointRunCount: 1,
                runs: [
                  {
                    run: { ...run, status: "succeeded", finishedAt: 2_000 },
                    checkpoints: [],
                    checkpointsOmitted: false,
                  },
                  {
                    run: {
                      ...run,
                      id: "wfr_campaign_build",
                      name: "Build accepted units",
                    },
                    checkpoints: [
                      {
                        id: "wcp_gate",
                        checkpoint: {
                          kind: "work-item",
                          id: "promotion-gate",
                          title: "Promotion gate",
                          status: "blocked",
                          summary: "Awaiting a human redesign decision.",
                          ticketRef: null,
                          changedFiles: [],
                          blocker: "approach-level feedback",
                          dependsOn: [],
                          nodeType: "work",
                        },
                        phase: "Promote",
                        childThreadId: null,
                        createdAt: 4_000,
                        updatedAt: 4_000,
                      },
                      {
                        id: "wcp_transition",
                        checkpoint: {
                          kind: "transition",
                          id: "decision:promotion",
                          title: "Promotion decision",
                          status: "blocked",
                          summary: null,
                          actor: "synthesizer",
                          fromState: "implementation-review",
                          toState: "awaiting-human-redesign-decision",
                          workItemIds: ["ticket-101", "ticket-102"],
                          rationale:
                            "Critics found conflicting approach-level evidence across both units.",
                          evidenceRefs: [
                            "critic:ticket-101",
                            "critic:ticket-102",
                          ],
                        },
                        phase: "Promote",
                        childThreadId: null,
                        createdAt: 4_100,
                        updatedAt: 4_100,
                      },
                    ],
                    checkpointsOmitted: false,
                  },
                ],
              },
            };
          },
        },
      },
    );

    await act(async () => Promise.resolve());
    expect(
      slot.rpcCalls.filter((call) => call.method === "workflowRunDetails"),
    ).toHaveLength(0);

    await act(async () => {
      resolveRun?.({ run });
      await pendingRun;
    });
    await slot.findByRole("heading", { name: "Selected plan" });
    expect(slot.getByRole("heading", { name: "Build story" })).toBeTruthy();
    expect(slot.getByLabelText("Build dependency graph")).toBeTruthy();
    expect(
      slot.getByText("2 related runs, shown as one campaign."),
    ).toBeTruthy();
    expect(
      slot.getByText(/Checkpoint details for 1 older campaign run was omitted/),
    ).toBeTruthy();
    expect(slot.getByText("After: Expose workflow details")).toBeTruthy();
    expect(slot.queryByText("After: Track verification")).toBeNull();
    expect(slot.queryByText("Gate")).toBeNull();
    expect(
      slot.getByText(
        "Critics found conflicting approach-level evidence across both units.",
      ),
    ).toBeTruthy();
    expect(
      slot.rpcCalls.filter((call) => call.method === "workflowRunDetails"),
    ).toHaveLength(1);
  });

  it("warns when merged campaign work items contain unknown or cyclic dependencies", async () => {
    const unknown = workCheckpoint("unknown-ref", "running");
    const cycleA = workCheckpoint("cycle-a", "pending");
    const cycleB = workCheckpoint("cycle-b", "pending");
    if (unknown.checkpoint.kind !== "work-item") throw new Error("test setup");
    if (cycleA.checkpoint.kind !== "work-item") throw new Error("test setup");
    if (cycleB.checkpoint.kind !== "work-item") throw new Error("test setup");
    unknown.checkpoint.dependsOn = ["missing-node"];
    cycleA.checkpoint.dependsOn = ["cycle-b"];
    cycleB.checkpoint.dependsOn = ["cycle-a"];
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_origin", params: { runId: run.id } },
      {
        rpc: {
          workflowRunView: () => ({ run }),
          workflowRunDetails: () => ({
            checkpoints: [unknown, cycleA, cycleB],
            campaign: null,
          }),
        },
      },
    );

    expect(await slot.findByText("Invalid build graph")).toBeTruthy();
    expect(
      slot.getByText(
        "Unknown dependency missing-node referenced by unknown-ref.",
      ),
    ).toBeTruthy();
    expect(
      slot.getByText(
        "Cyclic or cycle-blocked dependencies affect: cycle-a, cycle-b.",
      ),
    ).toBeTruthy();
  });

  it("labels unresolved dependencies as incomplete when older ledgers were omitted", async () => {
    const unknown = workCheckpoint("cross-run-work", "running");
    if (unknown.checkpoint.kind !== "work-item") throw new Error("test setup");
    unknown.checkpoint.dependsOn = ["historical-plan-item"];
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_origin", params: { runId: run.id } },
      {
        rpc: {
          workflowRunView: () => ({ run }),
          workflowRunDetails: () => ({
            checkpoints: [unknown],
            campaign: {
              id: run.campaignId,
              detailedRunLimit: 4,
              omittedCheckpointRunCount: 1,
              runs: [
                {
                  run,
                  checkpoints: [],
                  checkpointsOmitted: false,
                },
                {
                  run: { ...run, id: "wfr_omitted", name: "Older run" },
                  checkpoints: [],
                  checkpointsOmitted: true,
                },
              ],
            },
          }),
        },
      },
    );

    expect(await slot.findByText("Incomplete build graph")).toBeTruthy();
    expect(
      slot.getByText(
        "Dependency historical-plan-item referenced by cross-run-work may be in an omitted older ledger.",
      ),
    ).toBeTruthy();
    expect(slot.queryByText("Invalid build graph")).toBeNull();
  });

  it("renders derived acceptance coverage and the notes it derives", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_origin", params: { runId: run.id } },
      {
        rpc: {
          workflowRunView: () => ({ run }),
          workflowRunDetails: () => ({
            checkpoints: [],
            campaign: {
              id: run.campaignId,
              detailedRunLimit: 4,
              omittedCheckpointRunCount: 0,
              coverage: {
                acceptanceId: "phase-0",
                criteria: [
                  {
                    id: "cli-runs-two-cases",
                    statement:
                      "An engineer runs two synthetic cases from one command.",
                    provenBy: "command",
                    state: "uncovered",
                    satisfiedBy: [],
                    closedBy: [],
                  },
                  {
                    id: "sealed-result",
                    statement: "A cancelled job still yields a sealed result.",
                    provenBy: "artifact",
                    state: "in-flight",
                    satisfiedBy: ["sealing"],
                    closedBy: [],
                  },
                ],
                closedCount: 0,
                inFlightCount: 1,
                uncoveredCount: 1,
                amendments: [
                  {
                    acceptanceId: "phase-0-acceptance-v2",
                    supersedes: "phase-0-acceptance",
                    reason: "The CLI outcome moved to phase 1",
                    approval: {
                      approvedByThreadId: "thread-1",
                      surface: "panel",
                      approvedAt: 1_700_000_000_000,
                    },
                  },
                ],
                pendingAmendments: [
                  {
                    acceptanceId: "phase-0-acceptance-v4",
                    supersedes: "phase-0-acceptance-v2",
                    reason: "Drop the sealed-result outcome",
                  },
                ],
                unauthorizedAcceptanceIds: ["phase-0-acceptance-v3"],
                openGates: [
                  {
                    gateId: "containment",
                    openCriterionIds: ["cli-runs-two-cases"],
                  },
                ],
                unknownReferences: [],
                orphanWorkItemIds: ["containment"],
                unanchoredProgress: true,
                // Typed against the derivation's own contract, so the next
                // coverage field lands here as a compile error rather than as a
                // panel that silently renders nothing.
              } satisfies WorkflowAcceptanceCoverage,
              coverageTruncated: false,
              runs: [{ run, checkpoints: [], checkpointsOmitted: false }],
            },
          }),
        },
      },
    );

    expect(await slot.findByText("Acceptance")).toBeTruthy();
    expect(slot.getByText("0 of 2 closed · 1 in flight")).toBeTruthy();
    expect(
      slot.getByText("An engineer runs two synthetic cases from one command."),
    ).toBeTruthy();
    expect(slot.getByText("Uncovered")).toBeTruthy();
    expect(slot.getByText("In flight")).toBeTruthy();
    expect(
      slot.getByText(
        "1 work item has succeeded and no stated outcome has closed yet.",
      ),
    ).toBeTruthy();
    // An undeclared contract change is the alarm: the write path refuses it, so
    // its presence means the counts above were measured against a contract
    // nobody declared.
    expect(
      slot.getByText(
        "An acceptance checkpoint changed this contract without declaring an amendment (phase-0-acceptance-v3). Coverage still measures the declared contract; treat the change as unreviewed.",
      ),
    ).toBeTruthy();
    expect(
      slot.getByText(
        "Contract amended once, most recently by phase-0-acceptance-v2 replacing phase-0-acceptance: The CLI outcome moved to phase 1",
      ),
    ).toBeTruthy();
    // The readable side of the write path's refusal: what the campaign is stuck
    // behind, without having to trip the guard to find out.
    expect(
      slot.getByText(
        "Gate containment cannot pass until cli-runs-two-cases closes.",
      ),
    ).toBeTruthy();
    // A declared amendment is inert until a person acts, so the panel says what
    // is waiting and offers the one control that can move it.
    expect(
      slot.getByText(
        "An amendment is waiting for approval, most recently phase-0-acceptance-v4 replacing phase-0-acceptance-v2 (Drop the sealed-result outcome). Coverage is measured against the approved contract until then.",
      ),
    ).toBeTruthy();
    expect(
      slot.getByRole("button", { name: "Approve amendment" }),
    ).toBeTruthy();
  });

  // The panel is one of the two surfaces that can issue an approval, so these
  // cover the call it makes and who is offered it.
  function pendingAmendmentCoverage(): WorkflowAcceptanceCoverage {
    return {
      acceptanceId: "phase-0-acceptance",
      criteria: [
        {
          id: "sealed-result",
          statement: "A cancelled job still yields a sealed result.",
          provenBy: "artifact",
          state: "uncovered",
          satisfiedBy: [],
          closedBy: [],
        },
      ],
      closedCount: 0,
      inFlightCount: 0,
      uncoveredCount: 1,
      amendments: [],
      pendingAmendments: [
        {
          acceptanceId: "phase-0-acceptance-v2",
          supersedes: "phase-0-acceptance",
          reason: "Drop the sealed-result outcome",
        },
      ],
      unauthorizedAcceptanceIds: [],
      openGates: [],
      unknownReferences: [],
      orphanWorkItemIds: [],
      unanchoredProgress: false,
    };
  }

  function campaignWith(coverage: WorkflowAcceptanceCoverage, runView = run) {
    return {
      id: runView.campaignId,
      detailedRunLimit: 4,
      omittedCheckpointRunCount: 0,
      coverage,
      coverageTruncated: false,
      runs: [{ run: runView, checkpoints: [], checkpointsOmitted: false }],
    };
  }

  it("approves a pending amendment through the run it is scoped to", async () => {
    let approved = false;
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_origin", params: { runId: run.id } },
      {
        rpc: {
          workflowRunView: () => ({ run }),
          workflowRunDetails: () => ({
            checkpoints: [],
            campaign: campaignWith(
              approved
                ? {
                    ...pendingAmendmentCoverage(),
                    pendingAmendments: [],
                    amendments: [
                      {
                        acceptanceId: "phase-0-acceptance-v2",
                        supersedes: "phase-0-acceptance",
                        reason: "Drop the sealed-result outcome",
                        approval: {
                          approvedByThreadId: "thr_origin",
                          surface: "panel",
                          approvedAt: 1_700_000_000_000,
                        },
                      },
                    ],
                  }
                : pendingAmendmentCoverage(),
            ),
          }),
          workflowApproveAmendment: (input) => {
            expect(input).toEqual({
              threadId: "thr_origin",
              runId: run.id,
              acceptanceId: "phase-0-acceptance-v2",
            });
            approved = true;
            return {
              acceptanceId: "phase-0-acceptance-v2",
              supersedes: "phase-0-acceptance",
              newlyApproved: true,
            };
          },
        },
      },
    );

    fireEvent.click(
      await slot.findByRole("button", { name: "Approve amendment" }),
    );
    await waitFor(() => {
      expect(
        slot.rpcCalls.some(
          (call) => call.method === "workflowApproveAmendment",
        ),
      ).toBe(true);
      // Refetched after approval, so the note flips from waiting to amended
      // without the reader reloading the panel.
      expect(
        slot.getByText(
          "Contract amended once, most recently by phase-0-acceptance-v2 replacing phase-0-acceptance: Drop the sealed-result outcome",
        ),
      ).toBeTruthy();
    });
    expect(
      slot.queryByRole("button", { name: "Approve amendment" }),
    ).toBeNull();
  });

  it("withholds the approval control from a thread that only observes the run", async () => {
    const relatedRun: WorkflowRunView = {
      ...run,
      originThreadId: "thr_worker",
    };
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_root", params: { runId: relatedRun.id } },
      {
        rpc: {
          workflowRunView: () => ({ run: relatedRun }),
          workflowRunDetails: () => ({
            checkpoints: [],
            campaign: campaignWith(pendingAmendmentCoverage(), relatedRun),
          }),
        },
      },
    );

    // The note still reports what is waiting; only the control is absent, so
    // this thread cannot issue an approval the server would refuse anyway.
    expect(
      await slot.findByText(/An amendment is waiting for approval/),
    ).toBeTruthy();
    expect(
      slot.queryByRole("button", { name: "Approve amendment" }),
    ).toBeNull();
  });

  it("hides prior details while a newer latest run resolves its own ledger", async () => {
    vi.useFakeTimers();
    let currentRun = run;
    let resolveNewDetails:
      | ((value: { checkpoints: WorkflowCheckpointView[] }) => void)
      | null = null;
    const pendingNewDetails = new Promise<{
      checkpoints: WorkflowCheckpointView[];
    }>((resolve) => {
      resolveNewDetails = resolve;
    });
    const newerRun: WorkflowRunView = {
      ...run,
      id: "wfr_22222222-2222-4222-8222-222222222222",
      name: "Newer workflow run",
    };
    const newerCheckpoints: WorkflowCheckpointView[] = checkpoints.map(
      (entry) =>
        entry.checkpoint.kind === "plan"
          ? {
              ...entry,
              runId: newerRun.id,
              checkpoint: {
                ...entry.checkpoint,
                title: "New selected plan",
              },
            }
          : { ...entry, runId: newerRun.id },
    );
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_origin", params: null },
      {
        rpc: {
          workflowRunView: () => ({ run: currentRun }),
          workflowRunDetails: (input) =>
            (input as { runId: string }).runId === newerRun.id
              ? pendingNewDetails
              : { checkpoints },
        },
      },
    );

    await act(async () => Promise.resolve());
    expect(slot.getByRole("heading", { name: "Selected plan" })).toBeTruthy();

    currentRun = newerRun;
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(slot.getByText("Newer workflow run")).toBeTruthy();
    expect(slot.queryByRole("heading", { name: "Selected plan" })).toBeNull();

    await act(async () => {
      resolveNewDetails?.({ checkpoints: newerCheckpoints });
      await pendingNewDetails;
    });
    expect(
      slot.getByRole("button", { name: /New selected plan/ }),
    ).toBeTruthy();
  });

  it("opens worker threads and stops an active run through typed RPC", async () => {
    let stopped = false;
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_origin", params: { runId: run.id } },
      {
        rpc: {
          workflowRunView: () => ({
            run: stopped ? { ...run, status: "cancelled" as const } : run,
          }),
          workflowRunDetails: () => ({ checkpoints: [] }),
          workflowStopRun: (input) => {
            expect(input).toEqual({ threadId: "thr_origin", runId: run.id });
            stopped = true;
            return {
              stopped: true,
              run: { ...run, status: "cancelled" as const },
            };
          },
        },
      },
    );

    await slot.findByText("Run independent checks before shipping.");
    expect(
      slot.getByText(
        "This workflow has not published structured execution details.",
      ),
    ).toBeTruthy();
    // The settled Discover phase starts collapsed; the active phase is open.
    expect(slot.queryByText("Inspect implementation")).toBeNull();
    expect(slot.getByText("Adversarial review")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: /Discover1\/1/ }));
    expect(slot.getByText("Inspect implementation")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: /adversarial review/i }));
    expect(slot.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thr_worker_2",
    });

    fireEvent.click(slot.getByRole("button", { name: "Stop workflow" }));
    await waitFor(() => {
      expect(
        slot.rpcCalls.some((call) => call.method === "workflowStopRun"),
      ).toBe(true);
      expect(slot.getByText("Cancelled")).toBeTruthy();
    });
  });

  it("expands the selected plan, per-ticket progress, and exact verification status", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_origin", params: { runId: run.id } },
      {
        rpc: {
          workflowRunView: () => ({ run }),
          workflowRunDetails: (input) => {
            expect(input).toEqual({ threadId: "thr_origin", runId: run.id });
            return { checkpoints };
          },
        },
      },
    );

    await slot.findByRole("heading", { name: "Selected plan" });
    expect(slot.getAllByText("BB-101")).toHaveLength(2);
    expect(
      slot.getByText("Render the full accepted plan in the workflow panel."),
    ).toBeTruthy();
    expect(slot.getByText(/Lane: implementation/)).toBeTruthy();
    expect(slot.getByText(/Owner: UI worker/)).toBeTruthy();
    expect(slot.getByText("plugins/workflows/src/app.tsx")).toBeTruthy();

    const verificationToggle = slot.getByRole("button", {
      name: /focused workflow tests/i,
    });
    expect(verificationToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(verificationToggle);
    expect(
      slot.getByText("pnpm exec vitest run src/app.test.tsx"),
    ).toBeTruthy();
    expect(slot.getByText("8 passed · 0 failed · 1 skipped")).toBeTruthy();
    expect(
      slot.getByText("For: Expose workflow details (BB-101)"),
    ).toBeTruthy();

    fireEvent.click(
      slot.getAllByRole("button", { name: /open worker thread/i })[0]!,
    );
    expect(slot.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thr_worker_2",
    });
  });

  it("refreshes live details for the matching thread and stops polling when terminal", async () => {
    vi.useFakeTimers();
    let currentRun = run;
    let currentDetails = [workCheckpoint("live-implementation", "running")];
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_origin", params: { runId: run.id } },
      {
        rpc: {
          workflowRunView: () => ({ run: currentRun }),
          workflowRunDetails: () => ({ checkpoints: currentDetails }),
        },
      },
    );

    await act(async () => Promise.resolve());
    expect(
      slot.getByRole("button", { name: /live implementation.*running/i }),
    ).toBeTruthy();
    const detailCallCount = () =>
      slot.rpcCalls.filter((call) => call.method === "workflowRunDetails")
        .length;
    expect(detailCallCount()).toBe(1);

    await slot.emitRealtime("workflow-runs", { threadId: "thr_other" });
    expect(detailCallCount()).toBe(1);

    currentDetails = [workCheckpoint("live-implementation", "succeeded")];
    await slot.emitRealtime("workflow-runs", { threadId: "thr_origin" });
    expect(detailCallCount()).toBe(2);
    expect(
      slot.getByRole("button", { name: /live implementation.*complete/i }),
    ).toBeTruthy();

    currentDetails = [workCheckpoint("live-implementation", "failed")];
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(detailCallCount()).toBe(3);
    expect(
      slot.getByRole("button", { name: /live implementation.*failed/i }),
    ).toBeTruthy();

    currentRun = { ...run, status: "succeeded", finishedAt: 4_000 };
    currentDetails = [workCheckpoint("live-implementation", "succeeded")];
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    const terminalCallCount = detailCallCount();
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(detailCallCount()).toBe(terminalCallCount);
    slot.unmount();
  });

  it("renders every checkpoint status and sparse optional detail safely", async () => {
    const statuses = [
      ["pending-item", "pending", "Pending", false],
      ["running-item", "running", "Running", true],
      ["complete-item", "succeeded", "Complete", false],
      ["failed-item", "failed", "Failed", true],
      ["blocked-item", "blocked", "Blocked", true],
      ["skipped-item", "skipped", "Skipped", false],
      ["interrupted-item", "interrupted", "Interrupted", true],
    ] as const;
    const sparseDetails: WorkflowCheckpointView[] = [
      {
        id: "wcp_empty_plan",
        checkpoint: {
          kind: "plan",
          id: "empty-plan",
          title: "Empty selected plan",
          status: "pending",
          summary: null,
          detail: null,
          items: [],
        },
        phase: "Plan",
        childThreadId: null,
        createdAt: 1,
        updatedAt: 1,
      },
      ...statuses.map(([id, status]) => workCheckpoint(id, status)),
      {
        id: "wcp_sparse_verification",
        checkpoint: {
          kind: "verification",
          id: "sparse-verification",
          title: "Sparse verification",
          status: "pending",
          summary: null,
          workItemId: null,
          command: null,
          counts: null,
        },
        phase: "Verify",
        childThreadId: null,
        createdAt: 3,
        updatedAt: 3,
      },
    ];
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_origin", params: { runId: run.id } },
      {
        rpc: {
          workflowRunView: () => ({ run }),
          workflowRunDetails: () => ({ checkpoints: sparseDetails }),
        },
      },
    );

    await slot.findByText("0 work items");
    for (const [id, , label, expanded] of statuses) {
      const button = slot.getByRole("button", {
        name: new RegExp(`${id.replaceAll("-", " ")}.*${label}`, "i"),
      });
      expect(button.getAttribute("aria-expanded")).toBe(String(expanded));
    }
    expect(slot.getByText(/Blocker:/).textContent).toContain(
      "blocked-item blocker",
    );
    const sparseToggle = slot.getByRole("button", {
      name: /sparse verification.*pending/i,
    });
    fireEvent.click(sparseToggle);
    expect(slot.queryByText("Command")).toBeNull();
    expect(
      slot.queryByText(/\d+ passed · \d+ failed · \d+ skipped/),
    ).toBeNull();
    expect(slot.queryByText("Changed files")).toBeNull();
    expect(
      slot.queryByRole("button", { name: /open worker thread/i }),
    ).toBeNull();
  });

  it("rejects restored panel params with unknown fields", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      {
        threadId: "thr_origin",
        params: { runId: run.id, unexpected: true },
      },
      { rpc: {} },
    );

    expect((await slot.findByRole("alert")).textContent).toMatch(
      /invalid run parameters/i,
    );
    expect(slot.getByRole("alert").parentElement?.className).toContain("p-4");
    expect(slot.rpcCalls).toEqual([]);
  });

  it("keeps the run usable when structured details fail to refresh", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_origin", params: { runId: run.id } },
      {
        rpc: {
          workflowRunView: () => ({ run }),
          workflowRunDetails: () => {
            throw new Error("Checkpoint service unavailable");
          },
        },
      },
    );

    await slot.findByText("Run independent checks before shipping.");
    expect(slot.getByRole("status").textContent).toContain(
      "Checkpoint service unavailable",
    );
    expect(slot.getByRole("button", { name: "Stop workflow" })).toBeTruthy();
  });

  it("preserves the last good ledger when a later details refresh fails", async () => {
    let failRefresh = false;
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_origin", params: { runId: run.id } },
      {
        rpc: {
          workflowRunView: () => ({ run }),
          workflowRunDetails: () => {
            if (failRefresh) throw new Error("Temporary checkpoint failure");
            return { checkpoints };
          },
        },
      },
    );

    await slot.findByText(/Lane: implementation/);
    failRefresh = true;
    await slot.emitRealtime("workflow-runs", { threadId: "thr_origin" });

    await waitFor(() => {
      expect(slot.getByRole("status").textContent).toContain(
        "Temporary checkpoint failure",
      );
    });
    expect(slot.getByText(/Lane: implementation/)).toBeTruthy();
    expect(slot.getByText(/Owner: UI worker/)).toBeTruthy();
  });
});
