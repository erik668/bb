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
