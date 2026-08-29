// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkflowArtifactService } from "./artifact-storage.js";
import plugin from "./server.js";
import { workflowUiRpcContract } from "./ui-contract.js";

const workflowApp = await loadPluginApp(() => import("./app"));

function resolvePlaygroundPath(): string {
  for (const candidate of [
    resolve(process.cwd(), ".bb/workflows/artifact-review-playground.js"),
    resolve(
      process.cwd(),
      "../..",
      ".bb/workflows/artifact-review-playground.js",
    ),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Unable to locate the artifact review playground fixture");
}

const playgroundPath = resolvePlaygroundPath();
const workflowSource = readFileSync(playgroundPath, "utf8");

describe("workflow artifact review e2e", () => {
  let currentHost: ReturnType<typeof createFakePluginHost> | null = null;

  afterEach(async () => {
    cleanup();
    await currentHost?.harness.dispose();
    currentHost = null;
  });

  it("persists immutable revisions and review control state across plugin restarts", async () => {
    let architectIndex = 0;
    let stewardOutputCount = 0;
    currentHost = createFakePluginHost({
      pluginId: "workflows",
      agentSkillIds: ["workflows"],
      sdk: {
        threads: {
          get: async ({ threadId }) =>
            makeThreadResponse({
              id: threadId,
              projectId: "project-test",
              environmentId: "environment-test",
              providerId: "codex",
              visibility: "visible",
              status: "idle",
            }),
          defaultExecutionOptions: async () => ({
            model: "gpt-test",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "default",
            source: "default",
          }),
          fork: async () =>
            makeThreadResponse({
              id: "thread-artifact-steward",
              projectId: "project-test",
              environmentId: "environment-test",
              providerId: "codex",
              visibility: "hidden",
              status: "idle",
            }),
          send: async () => ({}),
          wait: async () => ({}),
          output: async ({ threadId }) => {
            if (threadId === "thread-artifact-steward") {
              stewardOutputCount += 1;
              return stewardOutputCount <= 2
                ? {
                    output: JSON.stringify({
                      semanticClass: "refinement",
                      rationale:
                        "The feedback clarifies an existing artifact boundary.",
                    }),
                  }
                : {
                    output: JSON.stringify({
                      verdict: "bounded-design-delta",
                      summary:
                        "Add an explicit rollback gate and update the architecture and decisions artifacts.",
                    }),
                  };
            }
            return {
              output: JSON.stringify({
                verdict: "bounded-design-delta",
                summary: "A bounded rollback-boundary update is required.",
                affectedArtifacts: ["architecture", "decisions"],
                risks: ["ambiguous rollback trigger"],
                recommendedChanges: ["record the rollback gate"],
              }),
            };
          },
          spawn: async () => {
            architectIndex += 1;
            return makeThreadResponse({
              id: `thread-architect-${architectIndex}`,
              projectId: "project-test",
              environmentId: "environment-test",
              providerId: "codex",
              visibility: "hidden",
              status: "idle",
            });
          },
          archive: async () => ({}),
          stop: async () => ({}),
        },
      },
    });
    await plugin(currentHost.bb);

    const runResult = await currentHost.harness.runCli(
      ["run", "--script", workflowSource],
      { threadId: "thread-test", projectId: "project-test" },
    );
    expect(runResult.exitCode, runResult.stderr ?? runResult.stdout).toBe(0);
    const runOutput = JSON.parse(runResult.stdout ?? "null") as {
      runId: string;
      campaignId: string;
    };
    const { runId } = runOutput;
    const baseInput = { threadId: "thread-test", runId };

    const seeded = workflowUiRpcContract.workflowArtifactSeed.output.parse(
      await currentHost.harness.callRpc("workflowArtifactSeed", {
        ...baseInput,
        documents: null,
        clientMutationId: "seed-initial",
      }),
    );
    expect(seeded.artifacts.map((artifact) => artifact.kind)).toEqual([
      "requirements",
      "architecture",
      "decisions",
    ]);
    const requirements = seeded.artifacts[0]!;
    const architecture = seeded.artifacts.find(
      (artifact) => artifact.kind === "architecture",
    );
    if (architecture === undefined)
      throw new Error("Expected an Architecture artifact");

    currentHost = await currentHost.harness.reload(plugin);
    const afterRestart =
      workflowUiRpcContract.workflowArtifactList.output.parse(
        await currentHost.harness.callRpc("workflowArtifactList", baseInput),
      );
    expect(afterRestart.artifacts).toHaveLength(3);
    const cliList = await currentHost.harness.runCli(
      ["artifact", "list", runId],
      { threadId: "thread-test", projectId: "project-test" },
    );
    expect(cliList.exitCode).toBe(0);
    expect(JSON.parse(cliList.stdout ?? "null")).toEqual(
      afterRestart.artifacts,
    );
    const repository = createWorkflowArtifactService(
      currentHost.bb,
      currentHost.bb.storage.database(),
    );
    expect(
      repository.list({
        campaignId: runOutput.campaignId,
        projectId: "project-test",
        environmentId: "environment-test",
        presentationThreadId: "alternate-authorized-grant",
        originRunId: runId,
      }),
    ).toEqual(afterRestart.artifacts);

    const mountedHost = currentHost;
    const slot = renderSlot(
      workflowApp.threadPanelActions[0]!,
      { threadId: "thread-test", params: { runId } },
      {
        rpc: {
          workflowRunView: async (input) =>
            workflowUiRpcContract.workflowRunView.output.parse(
              await mountedHost.harness.callRpc(
                "workflowRunView",
                workflowUiRpcContract.workflowRunView.input.parse(input),
              ),
            ),
          workflowRunDetails: async (input) =>
            workflowUiRpcContract.workflowRunDetails.output.parse(
              await mountedHost.harness.callRpc(
                "workflowRunDetails",
                workflowUiRpcContract.workflowRunDetails.input.parse(input),
              ),
            ),
          workflowArtifactList: async (input) =>
            workflowUiRpcContract.workflowArtifactList.output.parse(
              await mountedHost.harness.callRpc(
                "workflowArtifactList",
                workflowUiRpcContract.workflowArtifactList.input.parse(input),
              ),
            ),
          workflowArtifactRead: async (input) =>
            workflowUiRpcContract.workflowArtifactRead.output.parse(
              await mountedHost.harness.callRpc(
                "workflowArtifactRead",
                workflowUiRpcContract.workflowArtifactRead.input.parse(input),
              ),
            ),
          workflowArtifactAnnotate: async (input) =>
            workflowUiRpcContract.workflowArtifactAnnotate.output.parse(
              await mountedHost.harness.callRpc(
                "workflowArtifactAnnotate",
                workflowUiRpcContract.workflowArtifactAnnotate.input.parse(
                  input,
                ),
              ),
            ),
        },
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: /Architecture/ }));
    fireEvent.click(await slot.findByTestId("bb-artifact-review-select"));
    fireEvent.change(slot.getByLabelText("New artifact comment"), {
      target: { value: "Explain why this boundary stays advisory." },
    });
    fireEvent.click(slot.getByRole("button", { name: "Add comment" }));
    expect(
      await slot.findByText("Explain why this boundary stays advisory."),
    ).toBeTruthy();
    slot.unmount();

    let uiSavedArchitecture =
      workflowUiRpcContract.workflowArtifactRead.output.parse(
        await currentHost.harness.callRpc("workflowArtifactRead", {
          ...baseInput,
          artifactId: architecture.id,
          revision: 1,
        }),
      );
    await waitFor(async () => {
      uiSavedArchitecture =
        workflowUiRpcContract.workflowArtifactRead.output.parse(
          await currentHost!.harness.callRpc("workflowArtifactRead", {
            ...baseInput,
            artifactId: architecture.id,
            revision: 1,
          }),
        );
      expect(uiSavedArchitecture.annotations[0]?.assistance?.status).toBe(
        "ready",
      );
    });
    expect(uiSavedArchitecture.annotations[0]?.comments[0]?.body).toBe(
      "Explain why this boundary stays advisory.",
    );
    expect(uiSavedArchitecture.annotations[0]?.assistance).toEqual({
      status: "ready",
      semanticClass: "refinement",
      rationale: "The feedback clarifies an existing artifact boundary.",
      error: null,
      generatedBy: "campaign-steward",
    });

    await currentHost.harness.callRpc("workflowArtifactSeed", {
      ...baseInput,
      documents: [
        {
          kind: "requirements",
          title: "Requirements",
          content: "# Requirements\n\nShip safely.\n",
          expectedRevision: 1,
        },
      ],
      clientMutationId: "requirements-revision-2",
    });
    const revisionOne = workflowUiRpcContract.workflowArtifactRead.output.parse(
      await currentHost.harness.callRpc("workflowArtifactRead", {
        ...baseInput,
        artifactId: requirements.id,
        revision: 1,
      }),
    );
    const revisionTwo = workflowUiRpcContract.workflowArtifactRead.output.parse(
      await currentHost.harness.callRpc("workflowArtifactRead", {
        ...baseInput,
        artifactId: requirements.id,
        revision: 2,
      }),
    );
    expect(revisionOne.content).toContain("hands-on artifact review testing");
    expect(revisionOne.selectedRevision.status).toBe("superseded");
    expect(revisionTwo.content).toBe("# Requirements\n\nShip safely.\n");
    expect(revisionTwo.history.map((revision) => revision.revision)).toEqual([
      2, 1,
    ]);
    await expect(
      currentHost.harness.callRpc("workflowArtifactSeed", {
        ...baseInput,
        documents: [
          {
            kind: "requirements",
            title: "Requirements",
            content: revisionTwo.content,
            expectedRevision: 1,
          },
        ],
        clientMutationId: "requirements-stale-noop",
      }),
    ).rejects.toThrow(/revision conflict/i);

    const quote = "Ship safely";
    const start = revisionTwo.content.indexOf(quote);
    const annotationInput = {
      ...baseInput,
      artifactId: requirements.id,
      revision: 2,
      kind: "comment" as const,
      anchor: {
        blockId: "requirements-safety",
        start,
        end: start + quote.length,
        exactQuote: quote,
        prefix: revisionTwo.content.slice(0, start),
        suffix: revisionTwo.content.slice(start + quote.length),
      },
      body: "Define the rollback signal.",
      clientMutationId: "annotation-1",
    };
    const annotation =
      workflowUiRpcContract.workflowArtifactAnnotate.output.parse(
        await currentHost.harness.callRpc(
          "workflowArtifactAnnotate",
          annotationInput,
        ),
      );
    await expect(
      currentHost.harness.callRpc("workflowArtifactAnnotate", annotationInput),
    ).resolves.toEqual(annotation);
    await expect(
      currentHost.harness.callRpc("workflowArtifactAnnotate", {
        ...annotationInput,
        body: "A different request with the same mutation id.",
      }),
    ).rejects.toThrow(/idempotency conflict/i);
    await expect(
      currentHost.harness.callRpc("workflowArtifactAnnotate", {
        ...annotationInput,
        anchor: { ...annotationInput.anchor, exactQuote: "Wrong bytes" },
        clientMutationId: "annotation-wrong-anchor",
      }),
    ).rejects.toThrow(/anchor does not match/i);
    await expect(
      currentHost.harness.callRpc("workflowArtifactAnnotate", {
        ...annotationInput,
        anchor: { ...annotationInput.anchor, prefix: "wrong context" },
        clientMutationId: "annotation-wrong-context",
      }),
    ).rejects.toThrow(/anchor does not match/i);

    await currentHost.harness.callRpc("workflowArtifactReply", {
      ...baseInput,
      annotationId: annotation.annotationId,
      body: "Rollback begins after two failed health checks.",
      clientMutationId: "reply-1",
    });
    const decision = workflowUiRpcContract.workflowArtifactDecide.output.parse(
      await currentHost.harness.callRpc("workflowArtifactDecide", {
        ...baseInput,
        annotationId: annotation.annotationId,
        outcome: "accepted",
        semanticClass: "contract",
        rationale: "This changes release behavior.",
        clientMutationId: "decision-1",
      }),
    );
    expect(decision.changeId).not.toBeNull();
    await waitFor(async () => {
      const detail = workflowUiRpcContract.workflowArtifactRead.output.parse(
        await currentHost!.harness.callRpc("workflowArtifactRead", {
          ...baseInput,
          artifactId: requirements.id,
          revision: 2,
        }),
      );
      expect(detail.annotations[0]?.decision?.change?.assistance?.status).toBe(
        "ready",
      );
    });
    const architectureAssistance =
      workflowUiRpcContract.workflowArtifactRead.output.parse(
        await currentHost.harness.callRpc("workflowArtifactRead", {
          ...baseInput,
          artifactId: requirements.id,
          revision: 2,
        }),
      ).annotations[0]?.decision?.change?.assistance;
    expect(architectureAssistance).toEqual({
      status: "ready",
      verdict: "bounded-design-delta",
      summary:
        "Add an explicit rollback gate and update the architecture and decisions artifacts.",
      error: null,
      generatedBy: "architecting-agents",
    });
    expect(currentHost.harness.sdk.callsTo("threads.spawn")).toHaveLength(2);
    await expect(
      currentHost.harness.callRpc("workflowArtifactConfirmChange", {
        ...baseInput,
        changeId: decision.changeId,
        clientMutationId: "confirm-too-early",
      }),
    ).rejects.toThrow(/architecture-assessed/i);
    await currentHost.harness.callRpc("workflowArtifactAssessChange", {
      ...baseInput,
      changeId: decision.changeId,
      verdict: "bounded-design-delta",
      summary: "Add an explicit rollback gate before worker adoption.",
      clientMutationId: "assessment-1",
    });
    await expect(
      currentHost.harness.callRpc("workflowArtifactConfirmChange", {
        ...baseInput,
        changeId: decision.changeId,
        clientMutationId: "confirm-1",
      }),
    ).resolves.toMatchObject({
      status: "admitted",
      workerPropagation: "disabled",
    });

    const assistanceFailure =
      workflowUiRpcContract.workflowArtifactAnnotate.output.parse(
        await currentHost.harness.callRpc("workflowArtifactAnnotate", {
          ...annotationInput,
          anchor: {
            ...annotationInput.anchor,
            blockId: "requirements-assistance-fallback",
          },
          body: "Keep this editable if agent assistance is unavailable.",
          clientMutationId: "annotation-assistance-fallback",
        }),
      );
    await waitFor(async () => {
      const detail = workflowUiRpcContract.workflowArtifactRead.output.parse(
        await currentHost!.harness.callRpc("workflowArtifactRead", {
          ...baseInput,
          artifactId: requirements.id,
          revision: 2,
        }),
      );
      const fallback = detail.annotations.find(
        (candidate) => candidate.id === assistanceFailure.annotationId,
      );
      expect(fallback).toMatchObject({
        status: "open",
        assistance: {
          status: "error",
          semanticClass: null,
          rationale: null,
          generatedBy: "campaign-steward",
        },
      });
    });

    const firstSteward = await currentHost.harness.callRpc(
      "workflowArtifactEnsureSteward",
      baseInput,
    );
    const sameSteward = await currentHost.harness.callRpc(
      "workflowArtifactEnsureSteward",
      baseInput,
    );
    expect(sameSteward).toEqual(firstSteward);

    currentHost = await currentHost.harness.reload(plugin);
    const durable = workflowUiRpcContract.workflowArtifactRead.output.parse(
      await currentHost.harness.callRpc("workflowArtifactRead", {
        ...baseInput,
        artifactId: requirements.id,
        revision: 2,
      }),
    );
    expect(durable.stewardThreadId).toBe("thread-artifact-steward");
    expect(
      durable.annotations.find(
        (candidate) => candidate.id === annotation.annotationId,
      ),
    ).toMatchObject({
      status: "resolved",
      comments: [
        { body: "Define the rollback signal." },
        { body: "Rollback begins after two failed health checks." },
      ],
      decision: {
        outcome: "accepted",
        semanticClass: "contract",
        change: {
          status: "admitted",
          architectureVerdict: "bounded-design-delta",
          workerPropagation: "disabled",
        },
      },
    });
    const durableArchitecture =
      workflowUiRpcContract.workflowArtifactRead.output.parse(
        await currentHost.harness.callRpc("workflowArtifactRead", {
          ...baseInput,
          artifactId: architecture.id,
          revision: 1,
        }),
      );
    expect(durableArchitecture.annotations[0]?.comments[0]?.body).toBe(
      "Explain why this boundary stays advisory.",
    );
    await expect(
      currentHost.harness.callRpc("workflowArtifactRead", {
        threadId: "unrelated-thread",
        runId,
        artifactId: requirements.id,
        revision: 2,
      }),
    ).rejects.toThrow(/not available in this thread/i);

    currentHost.bb.storage
      .database()
      .prepare(
        "UPDATE workflow_artifact_blobs SET content = ? WHERE sha256 = ?",
      )
      .run(Buffer.from("damaged", "utf8"), durable.selectedRevision.blobSha256);
    await expect(
      currentHost.harness.callRpc("workflowArtifactRead", {
        ...baseInput,
        artifactId: requirements.id,
        revision: 2,
      }),
    ).rejects.toThrow(/integrity verification/i);
  });
});
