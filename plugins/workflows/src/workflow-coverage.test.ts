import { describe, expect, it } from "vitest";
import type { WorkflowCheckpoint } from "./workflow-checkpoint.js";
import { deriveAcceptanceCoverage } from "./workflow-coverage.js";

// Fixtures are typed against the real checkpoint contract, so a schema change
// that invalidates them fails to compile rather than silently passing here.
function acceptance(
  ids: readonly string[],
  id = "acceptance",
): WorkflowCheckpoint {
  return {
    kind: "acceptance",
    id,
    title: "Phase 0 acceptance",
    status: "succeeded",
    summary: null,
    criteria: ids.map((criterionId) => ({
      id: criterionId,
      statement: `Criterion ${criterionId} holds`,
      provenBy: "command",
      detail: null,
    })),
  };
}

function plan(
  items: readonly { id: string; satisfies?: string[] }[],
  id = "plan",
): WorkflowCheckpoint {
  return {
    kind: "plan",
    id,
    title: "Selected plan",
    status: "succeeded",
    summary: null,
    detail: null,
    items: items.map((item) => ({
      id: item.id,
      title: item.id,
      objective: `Advance ${item.id}`,
      detail: null,
      ticketRef: null,
      ...(item.satisfies === undefined ? {} : { satisfies: item.satisfies }),
    })),
  };
}

function workItem(
  id: string,
  status: "succeeded" | "running" = "succeeded",
): WorkflowCheckpoint {
  return {
    kind: "work-item",
    id,
    title: id,
    status,
    summary: null,
    ticketRef: null,
    changedFiles: [],
    blocker: null,
  };
}

function verification(options: {
  id: string;
  acceptanceId?: string;
  status?: "succeeded" | "failed";
}): WorkflowCheckpoint {
  return {
    kind: "verification",
    id: options.id,
    title: options.id,
    status: options.status ?? "succeeded",
    summary: null,
    workItemId: null,
    ...(options.acceptanceId === undefined
      ? {}
      : { acceptanceId: options.acceptanceId }),
    command: "pnpm test",
    counts: null,
  };
}

describe("acceptance coverage", () => {
  it("reports absence rather than inferring criteria from the plan", () => {
    expect(
      deriveAcceptanceCoverage([plan([{ id: "build" }]), workItem("build")]),
    ).toBeNull();
  });

  it("separates uncovered, in-flight, and closed criteria", () => {
    const coverage = deriveAcceptanceCoverage([
      acceptance(["cli", "grader", "evidence"]),
      plan([
        { id: "cli-unit", satisfies: ["cli"] },
        { id: "grader-unit", satisfies: ["grader"] },
      ]),
      verification({ id: "verify-cli", acceptanceId: "cli" }),
    ]);

    expect(coverage).not.toBeNull();
    expect({
      closed: coverage?.closedCount,
      inFlight: coverage?.inFlightCount,
      uncovered: coverage?.uncoveredCount,
    }).toEqual({ closed: 1, inFlight: 1, uncovered: 1 });
    expect(
      coverage?.criteria.map((criterion) => [criterion.id, criterion.state]),
    ).toEqual([
      ["cli", "closed"],
      ["grader", "in-flight"],
      ["evidence", "uncovered"],
    ]);
    expect(coverage?.criteria[0]?.closedBy).toEqual(["verify-cli"]);
    expect(coverage?.criteria[1]?.satisfiedBy).toEqual(["grader-unit"]);
  });

  it("does not let a failed verification close a criterion", () => {
    const coverage = deriveAcceptanceCoverage([
      acceptance(["cli"]),
      plan([{ id: "cli-unit", satisfies: ["cli"] }]),
      verification({ id: "verify-cli", acceptanceId: "cli", status: "failed" }),
    ]);

    expect(coverage?.criteria[0]?.state).toBe("in-flight");
    expect(coverage?.closedCount).toBe(0);
  });

  it("flags unanchored progress when work lands and no outcome closes", () => {
    // The remote-evals shape: containment work all green, none of it closing a
    // stated Phase 0 outcome.
    const coverage = deriveAcceptanceCoverage([
      acceptance(["cli", "grader"]),
      plan([
        { id: "containment", satisfies: [] },
        { id: "image-pinning" },
      ]),
      workItem("containment"),
      workItem("image-pinning"),
    ]);

    expect(coverage?.orphanWorkItemIds).toEqual([
      "containment",
      "image-pinning",
    ]);
    expect(coverage?.unanchoredProgress).toBe(true);
    expect(coverage?.uncoveredCount).toBe(2);
  });

  it("clears unanchored progress once any criterion closes", () => {
    const coverage = deriveAcceptanceCoverage([
      acceptance(["cli"]),
      plan([{ id: "containment" }, { id: "cli-unit", satisfies: ["cli"] }]),
      workItem("containment"),
      verification({ id: "verify-cli", acceptanceId: "cli" }),
    ]);

    expect(coverage?.orphanWorkItemIds).toEqual(["containment"]);
    expect(coverage?.unanchoredProgress).toBe(false);
  });

  it("excludes work that is unfinished or anchored from orphans", () => {
    const coverage = deriveAcceptanceCoverage([
      acceptance(["cli"]),
      plan([
        { id: "cli-unit", satisfies: ["cli"] },
        { id: "in-progress" },
      ]),
      workItem("cli-unit"),
      workItem("in-progress", "running"),
    ]);

    expect(coverage?.orphanWorkItemIds).toEqual([]);
  });

  it("re-opens a criterion the newest plan dropped", () => {
    // Union-over-all-plans would keep reporting `grader` as in-flight forever.
    // Coverage must track what is being built now, or a quietly abandoned
    // outcome stays green for the rest of the campaign.
    const coverage = deriveAcceptanceCoverage([
      acceptance(["cli", "grader"]),
      plan([{ id: "grader-unit", satisfies: ["grader"] }], "plan-run-1"),
      plan([{ id: "cli-unit", satisfies: ["cli"] }], "plan-run-40"),
    ]);

    expect(
      coverage?.criteria.map((criterion) => [criterion.id, criterion.state]),
    ).toEqual([
      ["cli", "in-flight"],
      ["grader", "uncovered"],
    ]);
  });

  it("resolves orphan status through a superseded plan", () => {
    const coverage = deriveAcceptanceCoverage([
      acceptance(["cli"]),
      plan([{ id: "grader-unit", satisfies: ["cli"] }], "plan-run-1"),
      plan([{ id: "cli-unit", satisfies: ["cli"] }], "plan-run-2"),
      workItem("grader-unit"),
    ]);

    // Declared against a criterion by the earlier plan, so it is anchored work
    // even though the current plan no longer lists it.
    expect(coverage?.orphanWorkItemIds).toEqual([]);
  });

  it("counts a rewritten contract as an amendment but tolerates reordering", () => {
    const rewritten = deriveAcceptanceCoverage([
      acceptance(["cli", "grader"]),
      acceptance(["containment"], "acceptance-v2"),
    ]);
    expect(rewritten?.amendmentCount).toBe(1);
    // The first contract stays authoritative; the rewrite does not silently win.
    expect(rewritten?.criteria.map((criterion) => criterion.id)).toEqual([
      "cli",
      "grader",
    ]);

    const reordered = deriveAcceptanceCoverage([
      acceptance(["cli", "grader"]),
      acceptance(["grader", "cli"], "acceptance-restated"),
    ]);
    expect(reordered?.amendmentCount).toBe(0);
  });

  it("collects references that match no declared criterion", () => {
    const coverage = deriveAcceptanceCoverage([
      acceptance(["cli"]),
      plan([{ id: "ghost-unit", satisfies: ["typo-criterion"] }]),
      verification({ id: "verify-ghost", acceptanceId: "another-typo" }),
    ]);

    expect(coverage?.unknownReferences).toEqual([
      "typo-criterion",
      "another-typo",
    ]);
    expect(coverage?.criteria[0]?.state).toBe("uncovered");
  });
});
