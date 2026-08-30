// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

const memory = {
  id: "mem_1",
  scope: "project",
  projectId: "proj_1",
  name: "validation",
  summary: "Run focused tests.",
  details: "Use the repository test command.",
  kind: "procedure",
  tags: ["testing"],
  importance: 60,
  pinned: false,
  version: 1,
  updatedAt: 1_700_000_000_000,
};

const candidate = {
  id: "mcan_1",
  status: "pending",
  scope: "project",
  projectId: "proj_1",
  name: "reviewer-preference",
  summary: "Prefer explicit parser branches.",
  details:
    "A reviewer requested explicit branches and source inspection found no correctness conflict.",
  kind: "preference",
  tags: ["reviewer-feedback"],
  importance: 55,
  pinned: false,
  evidence: ["PR 123 review thread 456 and the accepted code diff"],
  challenges: [
    {
      id: "mchal_1",
      summary: "Check whether the abstraction is already a project convention.",
      evidence: ["src/parser.ts"],
      sourceThreadId: "critic-thread",
      createdAt: 1_700_000_000_100,
    },
  ],
  proposedByThreadId: "dream-thread",
  proposalReason: "Potentially reusable reviewer preference",
  version: 2,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_100,
  decisionReceipt: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("memory settings", () => {
  it("lists all memories and saves an inline edit", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          listMemories: () => ({ memories: [memory] }),
          listCandidates: () => ({ candidates: [] }),
          updateMemory: () => ({
            memory: {
              ...memory,
              summary: "Run all focused tests.",
              version: 2,
            },
          }),
        },
      },
    );

    expect(await slot.findByText("validation")).toBeTruthy();
    expect(slot.getByText("project")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Edit" }));
    fireEvent.change(slot.getByLabelText("Memory summary"), {
      target: { value: "Run all focused tests." },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "updateMemory",
        input: expect.objectContaining({
          id: memory.id,
          expectedVersion: 1,
          summary: "Run all focused tests.",
        }),
      }),
    );
    await slot.findByText("Run all focused tests.");
  });

  it("confirms and deletes a memory", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          listMemories: () => ({ memories: [memory] }),
          listCandidates: () => ({ candidates: [] }),
          deleteMemory: () => ({ deleted: { id: memory.id, version: 2 } }),
        },
      },
    );

    expect(await slot.findByText("validation")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "deleteMemory",
        input: { id: memory.id, expectedVersion: 1 },
      }),
    );
    await waitFor(() => expect(slot.queryByText("validation")).toBeNull());
  });

  it("requires an owner reason and activates an approved candidate", async () => {
    const promotedMemory = {
      ...memory,
      id: "mem_promoted",
      name: candidate.name,
      summary: candidate.summary,
    };
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          listMemories: () => ({ memories: [] }),
          listCandidates: () => ({ candidates: [candidate] }),
          approveCandidate: () => ({
            candidate: {
              ...candidate,
              status: "approved",
              version: 3,
              decisionReceipt: {
                candidateId: candidate.id,
                decision: "approve",
                candidateVersion: 2,
                actor: "memory-settings-owner",
                reason: "Verified against the accepted PR",
                promotedMemoryId: promotedMemory.id,
                decidedAt: 1_700_000_000_200,
              },
            },
            memory: promotedMemory,
            receipt: {
              candidateId: candidate.id,
              decision: "approve",
              candidateVersion: 2,
              actor: "memory-settings-owner",
              reason: "Verified against the accepted PR",
              promotedMemoryId: promotedMemory.id,
              decidedAt: 1_700_000_000_200,
            },
          }),
        },
      },
    );

    expect(await slot.findByText(candidate.name)).toBeTruthy();
    const approve = slot.getByRole("button", { name: "Approve and activate" });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(
      slot.getByLabelText(`Decision reason for ${candidate.name}`),
      { target: { value: "Verified against the accepted PR" } },
    );
    fireEvent.click(approve);

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "approveCandidate",
        input: {
          id: candidate.id,
          expectedVersion: 2,
          reason: "Verified against the accepted PR",
        },
      }),
    );
    await slot.findByText("Active memories");
    expect(slot.queryByText("No memories stored yet.")).toBeNull();
    expect(
      slot.queryByText("No candidate memories awaiting your review."),
    ).toBeTruthy();
  });

  it("rejects a candidate without adding an active memory", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          listMemories: () => ({ memories: [] }),
          listCandidates: () => ({ candidates: [candidate] }),
          rejectCandidate: () => ({
            candidate: {
              ...candidate,
              status: "rejected",
              version: 3,
              decisionReceipt: {
                candidateId: candidate.id,
                decision: "reject",
                candidateVersion: 2,
                actor: "memory-settings-owner",
                reason: "The evidence is too weak",
                promotedMemoryId: null,
                decidedAt: 1_700_000_000_200,
              },
            },
            receipt: {
              candidateId: candidate.id,
              decision: "reject",
              candidateVersion: 2,
              actor: "memory-settings-owner",
              reason: "The evidence is too weak",
              promotedMemoryId: null,
              decidedAt: 1_700_000_000_200,
            },
          }),
        },
      },
    );

    await slot.findByText(candidate.name);
    fireEvent.change(
      slot.getByLabelText(`Decision reason for ${candidate.name}`),
      { target: { value: "The evidence is too weak" } },
    );
    fireEvent.click(slot.getByRole("button", { name: "Reject candidate" }));

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "rejectCandidate",
        input: {
          id: candidate.id,
          expectedVersion: 2,
          reason: "The evidence is too weak",
        },
      }),
    );
    await slot.findByText("No candidate memories awaiting your review.");
    expect(slot.getByText("No memories stored yet.")).toBeTruthy();
  });
});
