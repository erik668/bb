import { describe, expect, it } from "vitest";
import { workflowCheckpointSchema } from "./workflow-checkpoint.js";

describe("workflow checkpoint contract", () => {
  it("accepts a structured selected plan", () => {
    expect(
      workflowCheckpointSchema.parse({
        kind: "plan",
        id: "selected-plan",
        title: "Selected plan",
        status: "succeeded",
        summary: "Three work items",
        detail: "Lane: implementation\nGate: reviewer approval",
        items: [
          {
            id: "section-1",
            title: "Reproduce the mismatch",
            objective: "Confirm the current failure shape.",
            detail: "Role: scout\nVerification: capture the failing output",
            ticketRef: "TASK-23",
            dependsOn: [],
            nodeType: "work",
          },
        ],
      }),
    ).toEqual({
      kind: "plan",
      id: "selected-plan",
      title: "Selected plan",
      status: "succeeded",
      summary: "Three work items",
      detail: "Lane: implementation\nGate: reviewer approval",
      items: [
        {
          id: "section-1",
          title: "Reproduce the mismatch",
          objective: "Confirm the current failure shape.",
          detail: "Role: scout\nVerification: capture the failing output",
          ticketRef: "TASK-23",
          dependsOn: [],
          nodeType: "work",
        },
      ],
    });
  });

  it("accepts work-item progress and rejects cross-kind fields", () => {
    const workItem = {
      kind: "work-item" as const,
      id: "section-1",
      title: "Repair the contract",
      status: "running" as const,
      summary: null,
      ticketRef: null,
      changedFiles: [],
      blocker: null,
      dependsOn: [],
      nodeType: "work" as const,
    };
    expect(workflowCheckpointSchema.parse(workItem)).toEqual(workItem);
    expect(() =>
      workflowCheckpointSchema.parse({
        ...workItem,
        command: "pnpm test",
      }),
    ).toThrow();
  });

  it("rejects duplicate plan item IDs", () => {
    const item = {
      id: "section-1",
      title: "One section",
      objective: "Do one bounded thing.",
      detail: null,
      ticketRef: null,
    };
    expect(() =>
      workflowCheckpointSchema.parse({
        kind: "plan",
        id: "selected-plan",
        title: "Selected plan",
        status: "succeeded",
        summary: null,
        detail: null,
        items: [item, { ...item, title: "Duplicate section" }],
      }),
    ).toThrow(/Plan item IDs must be unique/);
  });

  it("accepts exact verification results", () => {
    expect(
      workflowCheckpointSchema.parse({
        kind: "verification",
        id: "targeted-spec",
        title: "Targeted workflow spec",
        status: "succeeded",
        summary: "52 tests passed",
        workItemId: "section-3",
        command: "pnpm vitest run src/workflow.spec.ts",
        counts: { passed: 52, failed: 0, skipped: 0 },
      }),
    ).toMatchObject({ kind: "verification", status: "succeeded" });
  });

  it("accepts an acyclic dependency graph and rejects unknown or cyclic edges", () => {
    const item = (id: string, dependsOn: string[] = []) => ({
      id,
      title: id,
      objective: `Deliver ${id}.`,
      detail: null,
      ticketRef: null,
      dependsOn,
      nodeType: "work" as const,
    });
    const plan = {
      kind: "plan" as const,
      id: "selected-plan",
      title: "Selected plan",
      status: "succeeded" as const,
      summary: null,
      detail: null,
      items: [item("oracle"), item("build", ["oracle"])],
    };
    expect(workflowCheckpointSchema.parse(plan)).toMatchObject(plan);
    expect(() =>
      workflowCheckpointSchema.parse({
        ...plan,
        items: [item("build", ["missing"])],
      }),
    ).toThrow(/Unknown plan dependency/);
    expect(() =>
      workflowCheckpointSchema.parse({
        ...plan,
        items: [item("a", ["b"]), item("b", ["a"])],
      }),
    ).toThrow(/acyclic/);
  });

  it("accepts structured transition rationale", () => {
    expect(
      workflowCheckpointSchema.parse({
        kind: "transition",
        id: "decision:promotion",
        title: "Promotion decision",
        status: "blocked",
        summary: "Shared assumptions need human review.",
        actor: "synthesizer",
        fromState: "implementation-review",
        toState: "awaiting-human-redesign-decision",
        workItemIds: ["unit-a", "unit-b"],
        rationale:
          "Independent critics found conflicting approach-level evidence across both units.",
        evidenceRefs: ["critic:unit-a", "critic:unit-b"],
      }),
    ).toMatchObject({ kind: "transition", actor: "synthesizer" });
  });

  it("accepts a campaign acceptance contract linked from a plan", () => {
    expect(
      workflowCheckpointSchema.parse({
        kind: "acceptance",
        id: "phase-0-acceptance",
        title: "Phase 0 acceptance",
        status: "succeeded",
        summary: "Two outcomes define done",
        criteria: [
          {
            id: "cli-runs-two-cases",
            statement:
              "An engineer runs two synthetic cases from `pnpm fae` and observes status.",
            provenBy: "command",
            detail: "Evidence: the recorded command output",
          },
          {
            id: "sealed-result",
            statement: "A cancelled job still yields a sealed result artifact.",
            provenBy: "artifact",
            detail: null,
          },
        ],
      }),
    ).toMatchObject({
      kind: "acceptance",
      criteria: [
        { id: "cli-runs-two-cases", provenBy: "command" },
        { id: "sealed-result", provenBy: "artifact" },
      ],
    });

    expect(
      workflowCheckpointSchema.parse({
        kind: "plan",
        id: "run-7-plan",
        title: "Selected plan",
        status: "running",
        summary: null,
        detail: null,
        items: [
          {
            id: "fae-remote-command",
            title: "Add `fae remote`",
            objective: "Expose the two synthetic cases behind one command.",
            detail: null,
            ticketRef: null,
            satisfies: ["cli-runs-two-cases"],
          },
          {
            id: "containment-gate",
            title: "Containment proof",
            objective: "Precondition only; closes no stated outcome.",
            detail: null,
            ticketRef: null,
            nodeType: "gate",
          },
        ],
      }),
    ).toMatchObject({
      items: [
        { id: "fae-remote-command", satisfies: ["cli-runs-two-cases"] },
        { id: "containment-gate", nodeType: "gate" },
      ],
    });
  });

  it("keeps gate requirements on gate nodes only", () => {
    const gate = {
      id: "containment-gate",
      title: "Containment proof",
      objective: "Hold the phase open until the stated outcomes close.",
      detail: null,
      ticketRef: null,
      nodeType: "gate" as const,
      requiresClosed: ["cli-runs-two-cases"],
    };
    const plan = {
      kind: "plan" as const,
      id: "run-7-plan",
      title: "Selected plan",
      status: "running" as const,
      summary: null,
      detail: null,
      items: [gate],
    };
    expect(workflowCheckpointSchema.parse(plan)).toMatchObject({
      items: [
        { id: "containment-gate", requiresClosed: ["cli-runs-two-cases"] },
      ],
    });

    // On a work node the field would read as enforced and never be, so it is
    // refused instead of accepted and ignored.
    expect(() =>
      workflowCheckpointSchema.parse({
        ...plan,
        items: [{ ...gate, nodeType: "work" as const }],
      }),
    ).toThrow(/Only a gate node can require acceptance criteria/);
  });

  it.each([
    {
      name: "no criteria at all",
      criteria: [],
    },
    {
      name: "duplicate criterion IDs",
      criteria: [
        { id: "same", statement: "First", provenBy: "human", detail: null },
        { id: "same", statement: "Second", provenBy: "human", detail: null },
      ],
    },
    {
      name: "an unknown provenance",
      criteria: [
        {
          id: "graded",
          statement: "A grader agrees",
          provenBy: "vibes",
          detail: null,
        },
      ],
    },
  ])("rejects an acceptance contract with $name", ({ criteria }) => {
    expect(() =>
      workflowCheckpointSchema.parse({
        kind: "acceptance",
        id: "phase-0-acceptance",
        title: "Phase 0 acceptance",
        status: "running",
        summary: null,
        criteria,
      }),
    ).toThrow();
  });

  it("accepts an amendment that names the contract it supersedes", () => {
    expect(
      workflowCheckpointSchema.parse({
        kind: "acceptance",
        id: "phase-0-acceptance-v2",
        title: "Phase 0 acceptance",
        status: "succeeded",
        summary: null,
        criteria: [
          {
            id: "sealed-result",
            statement: "A cancelled job still yields a sealed result artifact.",
            provenBy: "artifact",
            detail: null,
          },
        ],
        amends: {
          supersedes: "phase-0-acceptance",
          reason:
            "The CLI outcome moved to phase 1 after the containment spike.",
        },
      }),
    ).toMatchObject({
      amends: { supersedes: "phase-0-acceptance" },
    });
  });

  it("rejects an acceptance checkpoint that supersedes itself", () => {
    // Superseding your own ID is an in-place rewrite wearing an amendment's
    // clothes: it destroys the body it claims to replace.
    expect(() =>
      workflowCheckpointSchema.parse({
        kind: "acceptance",
        id: "phase-0-acceptance",
        title: "Phase 0 acceptance",
        status: "succeeded",
        summary: null,
        criteria: [
          {
            id: "sealed-result",
            statement: "A cancelled job still yields a sealed result artifact.",
            provenBy: "artifact",
            detail: null,
          },
        ],
        amends: { supersedes: "phase-0-acceptance", reason: "Scope changed" },
      }),
    ).toThrow();
  });

  it("rejects duplicate satisfies and acceptance references on a plan item", () => {
    expect(() =>
      workflowCheckpointSchema.parse({
        kind: "plan",
        id: "run-7-plan",
        title: "Selected plan",
        status: "running",
        summary: null,
        detail: null,
        items: [
          {
            id: "fae-remote-command",
            title: "Add `fae remote`",
            objective: "Expose the two synthetic cases behind one command.",
            detail: null,
            ticketRef: null,
            satisfies: ["cli-runs-two-cases", "cli-runs-two-cases"],
          },
        ],
      }),
    ).toThrow(/Acceptance criterion IDs must be unique/);
  });

  it("rejects succeeded verification with failed results", () => {
    expect(() =>
      workflowCheckpointSchema.parse({
        kind: "verification",
        id: "contradictory-spec",
        title: "Contradictory workflow spec",
        status: "succeeded",
        summary: "One test failed",
        workItemId: null,
        command: "pnpm test",
        counts: { passed: 51, failed: 1, skipped: 0 },
      }),
    ).toThrow();
  });

  it.each([
    {
      name: "unsafe ID",
      id: "unsafe/checkpoint",
      counts: { passed: 0, failed: 1, skipped: 0 },
    },
    {
      name: "negative count",
      id: "safe-checkpoint",
      counts: { passed: 0, failed: -1, skipped: 0 },
    },
  ])(
    "rejects an otherwise valid verification with an $name",
    ({ id, counts }) => {
      expect(() =>
        workflowCheckpointSchema.parse({
          kind: "verification",
          id,
          title: "Targeted workflow spec",
          status: "failed",
          summary: null,
          workItemId: null,
          command: "pnpm test",
          counts,
        }),
      ).toThrow();
    },
  );
});
