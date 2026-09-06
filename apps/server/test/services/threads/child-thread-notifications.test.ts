import { listQueuedThreadMessages } from "@bb/db";
import { turnScope } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildChildThreadNeedsAttentionInput,
  buildChildThreadTurnStatusBatchInput,
  queueChildThreadTurnNotificationBestEffort,
  type ChildThreadNotificationSource,
  type ChildThreadTurnNotificationBatchItem,
} from "../../../src/services/threads/child-thread-notifications.js";
import {
  seedStoredEvent,
  seedThread,
  seedThreadFixture,
  seedThreadRuntimeState,
} from "../../helpers/seed.js";
import { withTestHarness } from "../../helpers/test-app.js";

interface TestThreadArgs {
  id: string;
  title: string | null;
}

function testThread(args: TestThreadArgs): ChildThreadNotificationSource {
  return {
    id: args.id,
    projectId: "proj_alpha",
    title: args.title,
  };
}

function renderBatchMessage(args: {
  items: ChildThreadTurnNotificationBatchItem[];
}): string {
  const [input] = buildChildThreadTurnStatusBatchInput(args);
  if (!input || input.type !== "text") {
    throw new Error("Expected one text input");
  }
  return input.text;
}

describe("child thread notifications", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps final output for a single completed outcome", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child",
            title: "Fix checkout flow",
          }),
          terminalOutput: "Implemented the requested change.",
          turnStatus: "completed",
        },
      ],
    });

    expect(message).toContain(
      [
        "@thread:thr_child completed:",
        "",
        "Implemented the requested change.",
      ].join("\n"),
    );
    expect(message).not.toContain("Child thread updates:");
  });

  it("omits output for a single failed outcome", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child",
            title: "Patch deploy script",
          }),
          terminalOutput: "Deploy script failed on preflight.",
          turnStatus: "failed",
        },
      ],
    });

    expect(message).toContain(
      [
        "@thread:thr_child failed.",
        "",
        "Review the thread before deciding next steps.",
      ].join("\n"),
    );
    expect(message).not.toContain("Deploy script failed on preflight.");
  });

  it("omits output and preserves manual-stop safety guidance for a single interrupted outcome", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child",
            title: "Fix checkout flow",
          }),
          terminalOutput: "Stopped after writing the checkout summary.",
          turnStatus: "interrupted",
        },
      ],
    });

    expect(message).toContain(
      [
        "@thread:thr_child was interrupted.",
        "",
        "Review the thread before deciding next steps.",
        "",
        "If the user stopped it manually, do not resume, restart, retry, replace, or continue the work unless the user explicitly asks.",
      ].join("\n"),
    );
    expect(message).not.toContain("Child thread updates:");
    expect(message).not.toContain(
      "Stopped after writing the checkout summary.",
    );
  });

  it("renders accepted workflow cleanup without manual-stop guidance", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child",
            title: "Collect evidence",
          }),
          interruptionReason: "workflow-result-cleanup",
          terminalOutput: null,
          turnStatus: "interrupted",
        },
      ],
    });

    expect(message).toContain(
      "@thread:thr_child returned an accepted workflow result and was stopped for cleanup.",
    );
    expect(message).not.toContain("do not resume");
  });

  it("renders multiple child outcomes as status-only bullet lines", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_one",
            title: "Fix checkout flow",
          }),
          terminalOutput: "Checkout flow is fixed.",
          turnStatus: "completed",
        },
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_two",
            title: "Patch deploy script",
          }),
          terminalOutput: "Deploy script failed on preflight.",
          turnStatus: "failed",
        },
      ],
    });

    expect(message).toContain(
      [
        "[bb system]",
        "",
        "Child thread updates:",
        "",
        "- @thread:thr_child_one completed.",
        "- @thread:thr_child_two failed.",
      ].join("\n"),
    );
    expect(message).not.toContain("Checkout flow is fixed.");
    expect(message).not.toContain("Deploy script failed on preflight.");
  });

  it("keeps batch manual-stop guidance only for non-cleanup interruptions", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_one",
            title: "Return result",
          }),
          interruptionReason: "workflow-result-cleanup",
          terminalOutput: null,
          turnStatus: "interrupted",
        },
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_two",
            title: "Patch deploy script",
          }),
          interruptionReason: "manual-stop",
          terminalOutput: null,
          turnStatus: "interrupted",
        },
      ],
    });

    expect(message).toContain(
      "- @thread:thr_child_one returned workflow result.",
    );
    expect(message).toContain("- @thread:thr_child_two was interrupted.");
    expect(message).toContain(
      "If the user stopped any interrupted thread manually",
    );
  });

  it.each(["none", "manual-stop", "later-turn"] as const)(
    "refreshes queued cleanup when %s arrives before notification flush",
    async (change) => {
      vi.useFakeTimers();
      await withTestHarness(async (harness) => {
        const errors = vi.spyOn(harness.deps.logger, "error");
        vi.spyOn(
          harness.deps.pendingInteractions,
          "hasPendingThreadInteraction",
        ).mockReturnValue(true);
        const {
          environment,
          project,
          thread: parent,
        } = seedThreadFixture(harness, { thread: { status: "active" } });
        seedThreadRuntimeState(harness.deps, {
          threadId: parent.id,
          environmentId: environment.id,
          providerThreadId: "provider-parent-notify",
        });
        const child = seedThread(harness.deps, {
          environmentId: environment.id,
          parentThreadId: parent.id,
          projectId: project.id,
          status: "idle",
          title: "Return result",
          visibility: "hidden",
        });
        seedStoredEvent(harness.deps, {
          data: {
            reason: "workflow-result-cleanup",
            workflowResult: {
              acceptance: "accepted",
              callId: "wfc_notify",
              childThreadId: child.id,
              pluginId: "workflows",
              resultSha256: "c".repeat(64),
              runId: "wfr_notify",
            },
          },
          environmentId: environment.id,
          scope: turnScope("turn-notify"),
          sequence: 1,
          threadId: child.id,
          type: "system/thread/interrupted",
        });

        await queueChildThreadTurnNotificationBestEffort(harness.deps, {
          childThread: child,
          parentThreadId: parent.id,
          turnStatus: "interrupted",
        });
        if (change !== "none") seedStoredEvent(harness.deps, {
          data: change === "manual-stop" ? { reason: "manual-stop" } : {},
          environmentId: environment.id,
          scope: turnScope("turn-notify-next"),
          sequence: 2,
          threadId: child.id,
          type:
            change === "manual-stop"
              ? "system/thread/interrupted"
              : "turn/started",
        });

        await vi.advanceTimersByTimeAsync(2_000);

        expect(errors.mock.calls).toEqual([]);
        const [queued] = listQueuedThreadMessages(harness.db, parent.id);
        expect(queued).toBeDefined();
        expect(JSON.parse(queued!.systemNotice!).kind).toBe(
          change === "none" ? "child-completed" : "child-interrupted",
        );
        const [input] = JSON.parse(queued!.content) as Array<{ text: string }>;
        if (change === "none") {
          expect(input.text).toContain("returned an accepted workflow result");
          expect(input.text).not.toContain("do not resume");
          return;
        }
        expect(input.text).toContain(
          "@thread:" + child.id + " was interrupted.",
        );
        expect(input.text).toContain("do not resume");
        expect(input.text).not.toContain(
          "returned an accepted workflow result",
        );
      });
    },
  );

  it("builds mention ranges for batched outcome thread references", () => {
    const input = buildChildThreadTurnStatusBatchInput({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_one",
            title: "Fix checkout flow",
          }),
          terminalOutput: "Checkout flow is fixed.",
          turnStatus: "completed",
        },
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_two",
            title: null,
          }),
          terminalOutput: "Deploy script failed.",
          turnStatus: "failed",
        },
      ],
    });

    expect(input).toHaveLength(1);
    const [textInput] = input;
    if (!textInput || textInput.type !== "text") {
      throw new Error("Expected one text input");
    }
    expect(textInput).toEqual({
      type: "text",
      text: expect.stringContaining("@thread:thr_child_one"),
      mentions: [
        {
          start: expect.any(Number),
          end: expect.any(Number),
          resource: {
            kind: "thread",
            label: "Fix checkout flow",
            projectId: "proj_alpha",
            threadId: "thr_child_one",
          },
        },
        {
          start: expect.any(Number),
          end: expect.any(Number),
          resource: {
            kind: "thread",
            label: "thr_child_two",
            projectId: "proj_alpha",
            threadId: "thr_child_two",
          },
        },
      ],
    });
    expect(textInput.text).toContain("@thread:thr_child_two");
    expect(textInput.text).toContain("Child thread updates:");
    expect(
      textInput.mentions.map((mention) =>
        textInput.text.slice(mention.start, mention.end),
      ),
    ).toEqual(["@thread:thr_child_one", "@thread:thr_child_two"]);
  });

  it("does not render raw title suffixes next to rich thread mentions", () => {
    const nestedToken = "@thread:thr_child_two";
    const input = buildChildThreadTurnStatusBatchInput({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_one",
            title: `Title mentions ${nestedToken}`,
          }),
          terminalOutput: "Checkout flow is fixed.",
          turnStatus: "completed",
        },
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_two",
            title: "Second thread",
          }),
          terminalOutput: "Deploy script failed.",
          turnStatus: "failed",
        },
      ],
    });

    expect(input).toHaveLength(1);
    const [textInput] = input;
    if (!textInput || textInput.type !== "text") {
      throw new Error("Expected one text input");
    }

    const secondLineTokenStart = textInput.text.lastIndexOf(nestedToken);
    expect(textInput.text).not.toContain("Title mentions");
    expect(textInput.mentions.map((mention) => mention.start)).toEqual([
      textInput.text.indexOf("@thread:thr_child_one"),
      secondLineTokenStart,
    ]);
    expect(
      textInput.mentions.map((mention) =>
        textInput.text.slice(mention.start, mention.end),
      ),
    ).toEqual(["@thread:thr_child_one", nestedToken]);
  });

  it("renders a final output fallback for a completed child without output", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child",
            title: "Patch deploy script",
          }),
          terminalOutput: null,
          turnStatus: "completed",
        },
      ],
    });

    expect(message).toContain(
      [
        "@thread:thr_child completed:",
        "",
        "No final output was recorded.",
      ].join("\n"),
    );
  });

  it("flags a still-running workflow on a single completed outcome", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 1,
          childThread: testThread({
            id: "thr_child",
            title: "Rebalance archetypes",
          }),
          terminalOutput: "Kicked off the balance pass.",
          turnStatus: "completed",
        },
      ],
    });

    expect(message).toContain(
      [
        "@thread:thr_child completed, with 1 workflow still running:",
        "",
        "Kicked off the balance pass.",
        "",
        "A workflow it started is still running, so this output is not its final result. The thread will report again when the workflow finishes.",
      ].join("\n"),
    );
  });

  it("pluralizes and flags still-running workflows across batched outcomes", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 2,
          childThread: testThread({
            id: "thr_child_one",
            title: "Rebalance archetypes",
          }),
          terminalOutput: "Kicked off two workflows.",
          turnStatus: "completed",
        },
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_two",
            title: "Patch deploy script",
          }),
          terminalOutput: "Deploy script failed on preflight.",
          turnStatus: "failed",
        },
      ],
    });

    expect(message).toContain(
      [
        "Child thread updates:",
        "",
        "- @thread:thr_child_one completed, with 2 workflows still running.",
        "- @thread:thr_child_two failed.",
        "",
        "Threads with a workflow still running have not finished; they will report again when their workflow does.",
      ].join("\n"),
    );
  });

  it("builds mention ranges for needs-attention thread references", () => {
    const input = buildChildThreadNeedsAttentionInput({
      blockerSummary: null,
      childThread: testThread({
        id: "thr_child",
        title: "Backend cleanup",
      }),
    });

    expect(input).toHaveLength(1);
    const [textInput] = input;
    if (!textInput || textInput.type !== "text") {
      throw new Error("Expected one text input");
    }
    const threadMention = "@thread:thr_child";
    const mentionStart = textInput.text.indexOf(threadMention);
    expect(textInput.mentions).toEqual([
      {
        start: mentionStart,
        end: mentionStart + threadMention.length,
        resource: {
          kind: "thread",
          label: "Backend cleanup",
          projectId: "proj_alpha",
          threadId: "thr_child",
        },
      },
    ]);
    expect(textInput.text).toContain(
      "Review the blocker. If you can resolve it from existing context, reply to the thread with guidance.",
    );
  });

  it("renders needs-attention blocker summaries when provided", () => {
    const input = buildChildThreadNeedsAttentionInput({
      blockerSummary: ["Blocked on command approval:", "git push"].join("\n"),
      childThread: testThread({
        id: "thr_child",
        title: "Backend cleanup",
      }),
    });

    const [textInput] = input;
    if (!textInput || textInput.type !== "text") {
      throw new Error("Expected one text input");
    }

    expect(textInput.text).toContain(
      ["Blocked on command approval:", "git push"].join("\n"),
    );
    expect(textInput.text).not.toContain(
      "It is blocked on a pending interaction.",
    );
  });
});
