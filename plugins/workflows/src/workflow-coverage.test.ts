import { describe, expect, it } from "vitest";
import type { WorkflowCheckpoint } from "./workflow-checkpoint.js";
import { deriveAcceptanceCoverage } from "./workflow-coverage.js";

// Fixtures are typed against the real checkpoint contract, so a schema change
// that invalidates them fails to compile rather than silently passing here.
function acceptance(
  ids: readonly string[],
  id = "acceptance",
  options: {
    amends?: { supersedes: string; reason: string };
    detail?: string;
  } = {},
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
      detail: options.detail ?? null,
    })),
    ...(options.amends === undefined ? {} : { amends: options.amends }),
  };
}

function plan(
  items: readonly {
    id: string;
    satisfies?: string[];
    requiresClosed?: string[];
  }[],
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
      // The schema only allows requirements on a gate, so a fixture that names
      // them is a gate by construction.
      ...(item.requiresClosed === undefined
        ? {}
        : { nodeType: "gate" as const, requiresClosed: item.requiresClosed }),
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
      plan([{ id: "containment", satisfies: [] }, { id: "image-pinning" }]),
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
      plan([{ id: "cli-unit", satisfies: ["cli"] }, { id: "in-progress" }]),
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

  it("measures the campaign against a declared amendment", () => {
    const coverage = deriveAcceptanceCoverage([
      acceptance(["cli", "grader"]),
      acceptance(["containment"], "acceptance-v2", {
        amends: { supersedes: "acceptance", reason: "Grader moved to phase 2" },
      }),
    ]);

    // A scope change that says so is legitimate, so it becomes authoritative
    // rather than being reported forever against a contract nobody holds.
    expect(coverage?.acceptanceId).toBe("acceptance-v2");
    expect(coverage?.criteria.map((criterion) => criterion.id)).toEqual([
      "containment",
    ]);
    expect(coverage?.amendments).toEqual([
      {
        acceptanceId: "acceptance-v2",
        supersedes: "acceptance",
        reason: "Grader moved to phase 2",
      },
    ]);
    expect(coverage?.unauthorizedAcceptanceIds).toEqual([]);
  });

  it("refuses to adopt a contract that changed without declaring it", () => {
    // The write path refuses this, so reaching it means the ledger was written
    // another way. Coverage must not let the rewrite become the measure.
    const coverage = deriveAcceptanceCoverage([
      acceptance(["cli", "grader"]),
      acceptance(["containment"], "acceptance-v2"),
    ]);

    expect(coverage?.acceptanceId).toBe("acceptance");
    expect(coverage?.criteria.map((criterion) => criterion.id)).toEqual([
      "cli",
      "grader",
    ]);
    expect(coverage?.amendments).toEqual([]);
    expect(coverage?.unauthorizedAcceptanceIds).toEqual(["acceptance-v2"]);
  });

  it("rejects an amendment naming a predecessor the campaign never published", () => {
    const coverage = deriveAcceptanceCoverage([
      acceptance(["cli"]),
      acceptance(["containment"], "acceptance-v2", {
        amends: { supersedes: "acceptance-that-never-existed", reason: "why" },
      }),
    ]);

    expect(coverage?.acceptanceId).toBe("acceptance");
    expect(coverage?.unauthorizedAcceptanceIds).toEqual(["acceptance-v2"]);
  });

  it("treats reordering as the same contract and a changed detail as a new one", () => {
    const reordered = deriveAcceptanceCoverage([
      acceptance(["cli", "grader"]),
      acceptance(["grader", "cli"], "acceptance-restated"),
    ]);
    expect(reordered?.amendments).toEqual([]);
    expect(reordered?.unauthorizedAcceptanceIds).toEqual([]);

    // A qualifier deleted from `detail` narrows what done means, so it counts
    // as a contract change even though every criterion ID is unchanged.
    const requalified = deriveAcceptanceCoverage([
      acceptance(["cli"], "acceptance", { detail: "Must also pass in the EU" }),
      acceptance(["cli"], "acceptance-v2"),
    ]);
    expect(requalified?.unauthorizedAcceptanceIds).toEqual(["acceptance-v2"]);
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

  it("reports a gate as open until every criterion it requires is closed", () => {
    const checkpoints = [
      acceptance(["cli", "grader"]),
      plan([
        { id: "cli-unit", satisfies: ["cli"] },
        { id: "grader-unit", satisfies: ["grader"] },
        { id: "phase-gate", requiresClosed: ["cli", "grader"] },
      ]),
      verification({ id: "verify-cli", acceptanceId: "cli" }),
    ];

    expect(deriveAcceptanceCoverage(checkpoints)?.openGates).toEqual([
      { gateId: "phase-gate", openCriterionIds: ["grader"] },
    ]);
    expect(
      deriveAcceptanceCoverage([
        ...checkpoints,
        verification({ id: "verify-grader", acceptanceId: "grader" }),
      ])?.openGates,
    ).toEqual([]);
  });

  it("keeps a gate open on a requirement no contract declares", () => {
    // A criterion nobody declared can never close, so the gate stays shut and
    // the typo is reported. Reading it as satisfied would let a misspelling
    // silently disable the gate.
    const coverage = deriveAcceptanceCoverage([
      acceptance(["cli"]),
      plan([{ id: "phase-gate", requiresClosed: ["cli", "clii"] }]),
      verification({ id: "verify-cli", acceptanceId: "cli" }),
    ]);

    expect(coverage?.openGates).toEqual([
      { gateId: "phase-gate", openCriterionIds: ["clii"] },
    ]);
    expect(coverage?.unknownReferences).toEqual(["clii"]);
  });

  it("forgets a gate the current plan dropped", () => {
    // Coverage reports what is being built now. A gate only an older plan
    // declared is not something this campaign is still stuck behind.
    const coverage = deriveAcceptanceCoverage([
      acceptance(["cli"]),
      plan([{ id: "phase-gate", requiresClosed: ["cli"] }], "plan-1"),
      plan([{ id: "cli-unit", satisfies: ["cli"] }], "plan-2"),
    ]);

    expect(coverage?.openGates).toEqual([]);
  });
});
