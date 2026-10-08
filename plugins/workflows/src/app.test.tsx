// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type {
  WorkflowRunView,
  WorkflowThreadStatusView,
} from "./ui-contract.js";

const app = await loadPluginApp(() => import("./app"));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const message = {
  id: "msg_1",
  threadId: "thr_origin",
  turnId: "turn_1",
  projectId: "proj_1",
};

const run: WorkflowRunView = {
  id: "wfr_11111111-1111-4111-8111-111111111111",
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

const originStatus: WorkflowThreadStatusView = {
  role: "origin",
  threadId: "thr_origin",
  runId: run.id,
  runName: run.name,
  runStatus: "running",
  activePhases: ["Review"],
};

const workerStatus: WorkflowThreadStatusView = {
  role: "worker",
  threadId: "thr_worker_2",
  runId: run.id,
  runName: run.name,
  callStatus: "running",
  phase: "Review",
};

describe("workflows app registration", () => {
  it("registers thread phase indicators alongside the existing workflow surfaces", () => {
    expect(app.contentScripts.map((script) => script.id)).toEqual([
      "workflow-thread-row-status",
    ]);
    expect(app.threadHeaderActions).toMatchObject([
      { id: "workflow-phase", title: "Workflow phase" },
    ]);
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
      { id: "workflow-run", title: "Workflow run", icon: "Workflow" },
    ]);
  });
});

describe("workflow thread phase indicators", () => {
  const header = app.threadHeaderActions[0]!;

  it("shows every concurrently active phase on an origin thread", async () => {
    const openThreadPanel = vi.fn(() => true);
    const slot = renderSlot(
      header,
      {
        threadId: "thr_origin",
        projectId: "proj_1",
        isCompactViewport: false,
      },
      {
        openThreadPanel,
        rpc: {
          workflowThreadStatuses: () => ({
            statuses: [
              { ...originStatus, activePhases: ["Discover", "Review"] },
            ],
          }),
        },
      },
    );

    const button = await slot.findByRole("button", {
      name: "Workflow Review the release: Discover + Review",
    });
    expect(button.textContent).toBe("Workflow · Discover + Review");
    fireEvent.click(button);
    expect(openThreadPanel).toHaveBeenCalledWith({
      actionId: "workflow-run",
      title: run.name,
      params: { runId: run.id },
    });
  });

  it("shows the assigned phase and state on a worker thread", async () => {
    const slot = renderSlot(
      header,
      {
        threadId: "thr_worker_2",
        projectId: "proj_1",
        isCompactViewport: false,
      },
      {
        rpc: {
          workflowThreadStatuses: () => ({
            statuses: [workerStatus],
          }),
        },
      },
    );

    const indicator = await slot.findByRole("status", {
      name: "Workflow Review the release: Review, Running",
    });
    expect(indicator.textContent).toBe("Workflow · Review · Running");
    expect(
      indicator.querySelector('[data-icon="Workflow"]')?.getAttribute("class"),
    ).toContain("animate-shine-icon");
  });

  it("keeps the exact phase in the compact header's accessible label", async () => {
    const slot = renderSlot(
      header,
      {
        threadId: "thr_worker_2",
        projectId: "proj_1",
        isCompactViewport: true,
      },
      {
        rpc: {
          workflowThreadStatuses: () => ({
            statuses: [workerStatus],
          }),
        },
      },
    );

    const indicator = await slot.findByRole("status", {
      name: "Workflow Review the release: Review, Running",
    });
    expect(indicator.className).toContain("w-7");
    expect(indicator.querySelector(".sr-only")?.textContent).toBe(
      "Workflow · Review · Running",
    );
  });

  it("summarizes parent and multiple locally-originated workflows consistently", async () => {
    const localRun = {
      ...originStatus,
      threadId: "thr_worker_2",
      runId: "wfr_22222222-2222-4222-8222-222222222222",
      runName: "Verify the fix",
      activePhases: ["Verify"],
    } satisfies WorkflowThreadStatusView;
    const secondLocalRun = {
      ...localRun,
      runId: "wfr_33333333-3333-4333-8333-333333333333",
      runName: "Check the docs",
      activePhases: ["Publish"],
    } satisfies WorkflowThreadStatusView;
    const openThreadPanel = vi.fn(() => true);
    const slot = renderSlot(
      header,
      {
        threadId: "thr_worker_2",
        projectId: "proj_1",
        isCompactViewport: false,
      },
      {
        openThreadPanel,
        rpc: {
          workflowThreadStatuses: () => ({
            statuses: [workerStatus, localRun, secondLocalRun],
          }),
        },
      },
    );

    const button = await slot.findByRole("button", {
      name: "Parent workflow Review the release: Review, Running; workflow Verify the fix started here: Verify; workflow Check the docs started here: Publish",
    });
    expect(button.textContent).toBe(
      "Workflow · Review · Local: 2 local workflows · Verify + Publish",
    );
    fireEvent.click(button);
    expect(openThreadPanel).toHaveBeenCalledWith({
      actionId: "workflow-run",
      title: localRun.runName,
      params: { runId: localRun.runId },
    });
  });

  it("projects phases into sidebar rows and clears stale statuses", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { statuses: [originStatus, workerStatus] },
        }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { statuses: [] } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountPluginContentScripts(app, {
      pluginId: "workflows",
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mounted.inspection.getThreadRowStatus("thr_origin")).toEqual({
      icon: "Workflow",
      label: "Workflow Review the release: Review",
      tone: "running",
    });
    expect(mounted.inspection.getThreadRowStatus("thr_worker_2")).toEqual({
      icon: "Workflow",
      label: "Workflow Review the release: Review, Running",
      tone: "running",
    });

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(mounted.inspection.getThreadRowStatus("thr_origin")).toBeNull();
    expect(mounted.inspection.getThreadRowStatus("thr_worker_2")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/plugins/workflows/rpc/workflowAllActiveThreadStatuses",
      expect.objectContaining({ method: "POST", body: "null" }),
    );
    await mounted.lifecycle.dispose();
  });

  it("does not reapply unchanged sidebar projections", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: { statuses: [originStatus] },
        }),
      }),
    );
    const mounted = await mountPluginContentScripts(app, {
      pluginId: "workflows",
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mounted.inspection.threadRowStatusCalls).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(mounted.inspection.threadRowStatusCalls).toHaveLength(1);
    await mounted.lifecycle.dispose();
  });

  it("clears sidebar projections after three malformed refreshes", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { statuses: [originStatus] },
        }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: { statuses: [{ unexpected: true }] },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountPluginContentScripts(app, {
      pluginId: "workflows",
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mounted.inspection.getThreadRowStatus("thr_origin")).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(mounted.inspection.getThreadRowStatus("thr_origin")).toBeNull();
    await mounted.lifecycle.dispose();
  });

  it("degrades safely when the client lacks sidebar status support", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountPluginContentScripts(app, {
      pluginId: "workflows",
      omitExperimentalThreadRowStatus: true,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    await mounted.lifecycle.dispose();
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
    expect(slot.getByText("claude · opus-4-6 · high")).toBeTruthy();
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
    expect(slot.rpcCalls).toEqual([]);
  });
});
