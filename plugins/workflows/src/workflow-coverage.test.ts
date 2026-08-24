import { describe, expect, it } from "vitest";
import {
  type WorkflowCheckpoint,
  canonicalizeAcceptanceCriteria,
} from "./workflow-checkpoint.js";
import {
  type AcceptanceApproval,
  deriveAcceptanceCoverage,
} from "./workflow-coverage.js";

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

// Most cases have nothing to approve, so the default keeps them readable; the
// amendment cases pass approvals explicitly.
function coverageOf(
  checkpoints: readonly WorkflowCheckpoint[],
  approvals: readonly AcceptanceApproval[] = [],
) {
  return deriveAcceptanceCoverage(checkpoints, approvals);
}

// An approval is bound to the criteria body it was issued against, so the
// fixture derives that string from the same checkpoint the test publishes.
/**
 * The proposed body an amendment record must carry, taken from the same fixture
 * the amendment was built from. An approver reads this, so a record that
 * carried the *current* contract's criteria instead would fail here.
 */
function proposedBody(checkpoint: WorkflowCheckpoint): {
  criteria: { id: string; statement: string; provenBy: string; detail: string | null }[];
  contractCanonical: string;
} {
  if (checkpoint.kind !== "acceptance") {
    throw new Error("Only an acceptance checkpoint proposes a contract");
  }
  return {
    criteria: checkpoint.criteria.map((criterion) => ({
      id: criterion.id,
      statement: criterion.statement,
      provenBy: criterion.provenBy,
      detail: criterion.detail,
    })),
    contractCanonical: canonicalizeAcceptanceCriteria(checkpoint.criteria),
  };
}

function approvalFor(
  checkpoint: WorkflowCheckpoint,
  options: { surface?: "panel" | "cli" } = {},
): AcceptanceApproval {
  if (checkpoint.kind !== "acceptance") {
    throw new Error("Only an acceptance checkpoint can be approved");
  }
  return {
    acceptanceId: checkpoint.id,
    contractCanonical: canonicalizeAcceptanceCriteria(checkpoint.criteria),
    approvedByThreadId: "thread-human",
    surface: options.surface ?? "panel",
    approvedAt: 1_700_000_000_000,
  };
}

describe("acceptance coverage", () => {
  it("reports absence rather than inferring criteria from the plan", () => {
    expect(coverageOf([plan([{ id: "build" }]), workItem("build")])).toBeNull();
  });

  it("separates uncovered, in-flight, and closed criteria", () => {
    const coverage = coverageOf([
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
    const coverage = coverageOf([
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
    const coverage = coverageOf([
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
    const coverage = coverageOf([
      acceptance(["cli"]),
      plan([{ id: "containment" }, { id: "cli-unit", satisfies: ["cli"] }]),
      workItem("containment"),
      verification({ id: "verify-cli", acceptanceId: "cli" }),
    ]);

    expect(coverage?.orphanWorkItemIds).toEqual(["containment"]);
    expect(coverage?.unanchoredProgress).toBe(false);
  });

  it("excludes work that is unfinished or anchored from orphans", () => {
    const coverage = coverageOf([
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
    const coverage = coverageOf([
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
    const coverage = coverageOf([
      acceptance(["cli"]),
      plan([{ id: "grader-unit", satisfies: ["cli"] }], "plan-run-1"),
      plan([{ id: "cli-unit", satisfies: ["cli"] }], "plan-run-2"),
      workItem("grader-unit"),
    ]);

    // Declared against a criterion by the earlier plan, so it is anchored work
    // even though the current plan no longer lists it.
    expect(coverage?.orphanWorkItemIds).toEqual([]);
  });

  it("holds a declared amendment inert until a human approves it", () => {
    const amended = acceptance(["containment"], "acceptance-v2", {
      amends: { supersedes: "acceptance", reason: "Grader moved to phase 2" },
    });
    const checkpoints = [acceptance(["cli", "grader"]), amended];

    // Declaring a change is not authorizing one. The amendment is stored and
    // readable, but the campaign is still measured against what was agreed.
    const pending = coverageOf(checkpoints);
    expect(pending?.acceptanceId).toBe("acceptance");
    expect(pending?.criteria.map((criterion) => criterion.id)).toEqual([
      "cli",
      "grader",
    ]);
    expect(pending?.pendingAmendments).toEqual([
      {
        acceptanceId: "acceptance-v2",
        supersedes: "acceptance",
        reason: "Grader moved to phase 2",
        ...proposedBody(amended),
      },
    ]);
    expect(pending?.amendments).toEqual([]);
    // Not unauthorized: nothing was smuggled in, it is waiting on a human.
    expect(pending?.unauthorizedAcceptanceIds).toEqual([]);

    const approved = coverageOf(checkpoints, [approvalFor(amended)]);
    expect(approved?.acceptanceId).toBe("acceptance-v2");
    expect(approved?.criteria.map((criterion) => criterion.id)).toEqual([
      "containment",
    ]);
    expect(approved?.pendingAmendments).toEqual([]);
    expect(approved?.amendments).toEqual([
      {
        acceptanceId: "acceptance-v2",
        supersedes: "acceptance",
        reason: "Grader moved to phase 2",
        ...proposedBody(amended),
        approval: {
          approvedByThreadId: "thread-human",
          surface: "panel",
          approvedAt: 1_700_000_000_000,
        },
      },
    ]);
  });

  it("binds an approval to the body it was issued against", () => {
    const reviewed = acceptance(["containment"], "acceptance-v2", {
      amends: { supersedes: "acceptance", reason: "Narrow to containment" },
    });
    // Same checkpoint ID, different criteria: what a run would publish if it
    // wanted the approval of one body to carry a different one.
    const swapped = acceptance(["anything-goes"], "acceptance-v2", {
      amends: { supersedes: "acceptance", reason: "Narrow to containment" },
    });

    const coverage = coverageOf(
      [acceptance(["cli"]), swapped],
      [approvalFor(reviewed)],
    );

    expect(coverage?.acceptanceId).toBe("acceptance");
    // The body the ledger actually holds is the swapped one, not the body the
    // approval was issued against — which is why the approval does not match.
    expect(coverage?.pendingAmendments).toEqual([
      {
        acceptanceId: "acceptance-v2",
        supersedes: "acceptance",
        reason: "Narrow to containment",
        ...proposedBody(swapped),
      },
    ]);
    expect(coverage?.amendments).toEqual([]);
  });

  it("does not let an approved narrowing open a gate the plan still holds", () => {
    // Two separate things must give way: the contract must stop owing the
    // outcome, and the plan must stop requiring it. Approving the amendment
    // alone leaves the gate shut, because the plan still names a criterion
    // nothing can close.
    const amended = acceptance(["cli"], "acceptance-v2", {
      amends: { supersedes: "acceptance", reason: "Grader is out of scope" },
    });
    const gatedPlan = plan([
      { id: "phase-gate", requiresClosed: ["cli", "grader"] },
    ]);
    const checkpoints = [
      acceptance(["cli", "grader"]),
      amended,
      gatedPlan,
      verification({ id: "verify-cli", acceptanceId: "cli" }),
    ];

    expect(coverageOf(checkpoints)?.openGates).toEqual([
      { gateId: "phase-gate", openCriterionIds: ["grader"] },
    ]);
    const approved = coverageOf(checkpoints, [approvalFor(amended)]);
    expect(approved?.openGates).toEqual([
      { gateId: "phase-gate", openCriterionIds: ["grader"] },
    ]);
    // The dropped criterion is now a requirement no contract declares, which is
    // exactly what the fail-closed rule reports.
    expect(approved?.unknownReferences).toEqual(["grader"]);

    // Restating the plan against the approved contract is what opens the gate.
    const restated = coverageOf(
      [
        ...checkpoints,
        plan([{ id: "phase-gate", requiresClosed: ["cli"] }], "plan-v2"),
      ],
      [approvalFor(amended)],
    );
    expect(restated?.openGates).toEqual([]);
  });

  it("approves an amendment that supersedes a still-pending one", () => {
    // A pending amendment is a real, readable checkpoint, so a later one may
    // name it. Approving the later one approves the body it carries.
    const first = acceptance(["containment"], "acceptance-v2", {
      amends: { supersedes: "acceptance", reason: "First attempt" },
    });
    const second = acceptance(["containment", "cost"], "acceptance-v3", {
      amends: { supersedes: "acceptance-v2", reason: "Add the cost bound" },
    });

    const coverage = coverageOf(
      [acceptance(["cli"]), first, second],
      [approvalFor(second, { surface: "cli" })],
    );

    expect(coverage?.acceptanceId).toBe("acceptance-v3");
    expect(coverage?.pendingAmendments).toEqual([
      {
        acceptanceId: "acceptance-v2",
        supersedes: "acceptance",
        reason: "First attempt",
        ...proposedBody(first),
      },
    ]);
    expect(
      coverage?.amendments.map((record) => record.approval.surface),
    ).toEqual(["cli"]);
    expect(coverage?.unauthorizedAcceptanceIds).toEqual([]);
  });

  it("refuses to adopt a contract that changed without declaring it", () => {
    // The write path refuses this, so reaching it means the ledger was written
    // another way. Coverage must not let the rewrite become the measure.
    const coverage = coverageOf([
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
    const coverage = coverageOf([
      acceptance(["cli"]),
      acceptance(["containment"], "acceptance-v2", {
        amends: { supersedes: "acceptance-that-never-existed", reason: "why" },
      }),
    ]);

    expect(coverage?.acceptanceId).toBe("acceptance");
    expect(coverage?.unauthorizedAcceptanceIds).toEqual(["acceptance-v2"]);
  });

  it("treats reordering as the same contract and a changed detail as a new one", () => {
    const reordered = coverageOf([
      acceptance(["cli", "grader"]),
      acceptance(["grader", "cli"], "acceptance-restated"),
    ]);
    expect(reordered?.amendments).toEqual([]);
    expect(reordered?.unauthorizedAcceptanceIds).toEqual([]);

    // A qualifier deleted from `detail` narrows what done means, so it counts
    // as a contract change even though every criterion ID is unchanged.
    const requalified = coverageOf([
      acceptance(["cli"], "acceptance", { detail: "Must also pass in the EU" }),
      acceptance(["cli"], "acceptance-v2"),
    ]);
    expect(requalified?.unauthorizedAcceptanceIds).toEqual(["acceptance-v2"]);
  });

  it("collects references that match no declared criterion", () => {
    const coverage = coverageOf([
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

    expect(coverageOf(checkpoints)?.openGates).toEqual([
      { gateId: "phase-gate", openCriterionIds: ["grader"] },
    ]);
    expect(
      coverageOf([
        ...checkpoints,
        verification({ id: "verify-grader", acceptanceId: "grader" }),
      ])?.openGates,
    ).toEqual([]);
  });

  it("keeps a gate open on a requirement no contract declares", () => {
    // A criterion nobody declared can never close, so the gate stays shut and
    // the typo is reported. Reading it as satisfied would let a misspelling
    // silently disable the gate.
    const coverage = coverageOf([
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
    const coverage = coverageOf([
      acceptance(["cli"]),
      plan([{ id: "phase-gate", requiresClosed: ["cli"] }], "plan-1"),
      plan([{ id: "cli-unit", satisfies: ["cli"] }], "plan-2"),
    ]);

    expect(coverage?.openGates).toEqual([]);
  });
});
