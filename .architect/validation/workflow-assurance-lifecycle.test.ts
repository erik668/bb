import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeWorkflowScript } from "../../plugins/workflows/src/runtime.js";
import type { WorkflowCapabilities } from "../../plugins/workflows/src/types.js";

const threadStorage = process.env.BB_THREAD_STORAGE;
if (!threadStorage)
  throw new Error("BB_THREAD_STORAGE is required for candidate workflow tests");

function candidateBody(filename: string, marker: string): string {
  const directPath = join(threadStorage, filename);
  const candidatePath = existsSync(directPath)
    ? directPath
    : join(dirname(threadStorage), filename);
  const source = readFileSync(candidatePath, "utf8");
  const bodyStart = source.indexOf(marker);
  if (bodyStart < 0)
    throw new Error(`Missing body marker ${marker} in ${filename}`);
  return source.slice(bodyStart);
}

const parentBody = candidateBody(
  "workflow-router-pipeline-staged-assurance.candidate.js",
  "const taskResultSchema",
);
const childBody = candidateBody(
  "workflow-router-staged-assurance.candidate.js",
  "const laneSkills",
);

const contract = {
  contractId: "mvp-1",
  revision: 1,
  objective: "Trial the shakedown-ready workflow",
  targetCohort: {
    eligibilityCriteria: ["reduced-risk customer"],
    exposureLimit: "one customer at a time",
    exclusions: ["regulated production data"],
  },
  coreJobs: ["complete the primary workflow"],
  inScope: ["primary workflow"],
  outOfScope: ["broad availability"],
  criticalInvariants: [
    {
      id: "safe-1",
      requirement: "no cross-customer data",
      verification: "tenant isolation test",
    },
  ],
  temporaryLimitations: ["manual onboarding"],
  telemetry: [
    {
      signal: "completion",
      successThreshold: "at least one success",
      alertThreshold: "any data leak",
    },
  ],
  rollback: {
    trigger: "critical invariant failure",
    procedure: "disable exposure",
    owner: "operator",
  },
  support: {
    owner: "operator",
    responseTarget: "same day",
    escalationPath: "engineering",
  },
  designInvalidationSignals: ["core job cannot be completed"],
};

const mvpApproval = {
  decisionRef: "decision:mvp-1",
  evidenceRef: "run:mvp-definition-1",
  decidedByHuman: true,
  contractId: contract.contractId,
  contractRevision: contract.revision,
  decision: "approved",
  rationale: "Approved for controlled build",
};

function blockedCapabilities() {
  const agent = vi.fn(async () => {
    throw new Error("agent call was not expected");
  });
  const workflow = vi.fn(async () => {
    throw new Error("nested workflow call was not expected");
  });
  const checkpoints: unknown[] = [];
  const capabilities: WorkflowCapabilities = {
    agent,
    workflow,
    checkpoint(value) {
      checkpoints.push(value);
    },
    log: vi.fn(),
    phase: vi.fn(),
  };
  return { agent, workflow, checkpoints, capabilities };
}

describe("staged assurance parent failure-closed gates", () => {
  it("admits zero calls when the current MVP contract lacks matching human approval", async () => {
    const harness = blockedCapabilities();
    const result = await executeWorkflowScript({
      args: {
        objective: contract.objective,
        lifecycleStage: "shakedown-build",
        executionMode: "execute",
        mvpContract: contract,
      },
      body: parentBody,
      capabilities: harness.capabilities,
    });

    expect(result).toMatchObject({
      status: "awaiting-human-mvp-approval",
      execution: null,
    });
    expect(harness.agent).not.toHaveBeenCalled();
    expect(harness.workflow).not.toHaveBeenCalled();
  });

  it("admits zero calls before a reduced-risk customer shakedown is approved", async () => {
    const harness = blockedCapabilities();
    const result = await executeWorkflowScript({
      args: {
        objective: contract.objective,
        lifecycleStage: "customer-shakedown",
        executionMode: "execute",
        mvpContract: contract,
        mvpApproval,
      },
      body: parentBody,
      capabilities: harness.capabilities,
    });

    expect(result).toMatchObject({
      status: "awaiting-human-shakedown-launch",
      execution: null,
    });
    expect(harness.agent).not.toHaveBeenCalled();
    expect(harness.workflow).not.toHaveBeenCalled();
  });

  it("admits zero PSA calls after material design-changing feedback", async () => {
    const harness = blockedCapabilities();
    const result = await executeWorkflowScript({
      args: {
        objective: contract.objective,
        lifecycleStage: "post-shakedown-availability",
        psaMode: "audit",
        executionMode: "execute",
        mvpContract: contract,
        mvpApproval,
        designStabilityDecision: {
          decisionRef: "decision:stability-1",
          evidenceRef: "run:design-stability-assessment-1",
          decidedByHuman: true,
          contractId: contract.contractId,
          contractRevision: contract.revision,
          decision: "material-change",
          rationale: "Customer feedback changes the core workflow",
        },
      },
      body: parentBody,
      capabilities: harness.capabilities,
    });

    expect(result).toMatchObject({
      status: "redesign-required",
      execution: null,
    });
    expect(harness.agent).not.toHaveBeenCalled();
    expect(harness.workflow).not.toHaveBeenCalled();
  });

  it("rejects PSA mode outside availability before any planner call", async () => {
    const harness = blockedCapabilities();
    const result = await executeWorkflowScript({
      args: {
        objective: contract.objective,
        lifecycleStage: "shakedown-build",
        psaMode: "audit",
        executionMode: "execute",
        mvpContract: contract,
        mvpApproval,
      },
      body: parentBody,
      capabilities: harness.capabilities,
    });

    expect(result).toMatchObject({ status: "blocked", execution: null });
    expect(harness.agent).not.toHaveBeenCalled();
    expect(harness.workflow).not.toHaveBeenCalled();
  });

  it("requires availability approval to occur in a later result-bound decision run", async () => {
    const harness = blockedCapabilities();
    const stabilityDecision = {
      decisionRef: "decision:stability-stable",
      evidenceRef: "run:design-stability-assessment-1",
      decidedByHuman: true,
      contractId: contract.contractId,
      contractRevision: contract.revision,
      decision: "stable",
      rationale: "Feedback does not change the core design",
    };
    const availabilityApproval = {
      decisionRef: "decision:availability-1",
      evidenceRef: "run:psa-re-audit-1",
      decidedByHuman: true,
      contractId: contract.contractId,
      contractRevision: contract.revision,
      decision: "approved",
      rationale: "Reviewed the completed re-audit evidence",
    };
    const premature = await executeWorkflowScript({
      args: {
        objective: contract.objective,
        lifecycleStage: "post-shakedown-availability",
        psaMode: "re-audit",
        executionMode: "execute",
        mvpContract: contract,
        mvpApproval,
        designStabilityDecision: stabilityDecision,
        availabilityApproval,
      },
      body: parentBody,
      capabilities: harness.capabilities,
    });
    expect(premature).toMatchObject({
      status: "blocked",
      lifecycle: { gateState: "availability-decision-must-be-separate" },
    });
    expect(harness.workflow).not.toHaveBeenCalled();

    const decisionRun = await executeWorkflowScript({
      args: {
        objective: contract.objective,
        lifecycleStage: "post-shakedown-availability",
        psaMode: "availability-decision",
        executionMode: "execute",
        mvpContract: contract,
        mvpApproval,
        designStabilityDecision: stabilityDecision,
        availabilityApproval,
      },
      body: parentBody,
      capabilities: harness.capabilities,
    });
    expect(decisionRun).toMatchObject({
      status: "availability-approved",
      lifecycle: {
        humanDecisionEvidenceRef: "run:psa-re-audit-1",
      },
    });
    expect(harness.agent).not.toHaveBeenCalled();
    expect(harness.workflow).not.toHaveBeenCalled();
  });

  it("blocks every PSA audit component when required verification is skipped-only", async () => {
    const psaComponents = [
      "security",
      "reliability",
      "operations",
      "permissions",
      "data-integrity",
      "performance",
      "accessibility",
      "compliance",
    ];
    const approvedContract = {
      contractVersion: `${contract.contractId}:revision-${contract.revision}`,
      approved: true,
      approvalDecisionRef: mvpApproval.decisionRef,
      approvalEvidenceRefs: [mvpApproval.decisionRef, mvpApproval.evidenceRef],
      items: [
        {
          id: "target-cohort-1",
          kind: "target-cohort",
          statement: "Reduced-risk customer with bounded exposure",
          nondeferrable: true,
        },
        {
          id: "in-scope-1",
          kind: "in-scope",
          statement: contract.inScope[0],
          nondeferrable: true,
        },
        {
          id: "core-job-1",
          kind: "core-job",
          statement: contract.coreJobs[0],
          nondeferrable: true,
        },
        {
          id: "safe-1",
          kind: "critical-invariant",
          statement: contract.criticalInvariants[0].requirement,
          nondeferrable: true,
        },
        {
          id: "telemetry-1",
          kind: "telemetry",
          statement: contract.telemetry[0].signal,
          nondeferrable: true,
        },
        {
          id: "rollback-1",
          kind: "rollback",
          statement: contract.rollback.procedure,
          nondeferrable: true,
        },
        {
          id: "support-1",
          kind: "support",
          statement: contract.support.escalationPath,
          nondeferrable: true,
        },
      ],
    };
    const stabilityDecision = {
      decisionRef: "decision:stability-stable",
      evidenceRef: "run:design-stability-assessment-1",
      decidedByHuman: true,
      contractId: contract.contractId,
      contractRevision: contract.revision,
      decision: "stable",
      rationale: "Feedback does not change the core design",
    };
    const route = {
      lane: "implementation",
      why: "Run the bounded PSA audit",
      secondaryGates: [],
      firstAction: "Audit each PSA component",
      stopCondition: "Every component has passing evidence",
      confidence: "high",
    };
    const plannerSections = psaComponents.map((component, index) => ({
      title: `Audit ${component}`,
      objective: `Verify ${component} readiness`,
      coverage: "light",
      riskTriggers: ["none"],
      riskReason: "No additional closed-set risk trigger",
      requiredSkills: [],
      assuranceClass: "post-shakedown-assurance",
      psaComponent: component,
      dependsOn: [],
      mutationIntent: "read-only",
      contractItemRefs:
        index === 0 ? approvedContract.items.map((item) => item.id) : [],
      verificationRequired: true,
      exitCriterion: `A ${component} check passes`,
    }));
    const childAgent = vi
      .fn()
      .mockResolvedValueOnce(route)
      .mockResolvedValueOnce({ sections: plannerSections });
    const workflow = vi.fn(async (_ref, childArgs) =>
      executeWorkflowScript({
        args: childArgs,
        body: childBody,
        capabilities: {
          agent: childAgent,
          log: vi.fn(),
          phase: vi.fn(),
        },
      }),
    );
    const owner = vi.fn(async () => ({
      summary: "The selected check could not run",
      evidence: [],
      risks: ["No passing verification evidence"],
      changedFiles: [],
      verifications: [
        {
          title: "Selected PSA check",
          command: "pnpm test psa",
          status: "skipped",
          summary: "The check was skipped",
          passed: 0,
          failed: 0,
          skipped: 1,
        },
      ],
    }));
    const checkpoints: unknown[] = [];
    const result = await executeWorkflowScript({
      args: {
        objective: contract.objective,
        lifecycleStage: "post-shakedown-availability",
        psaMode: "audit",
        executionMode: "execute",
        maxWorkerCalls: 8,
        mvpContract: contract,
        mvpApproval,
        designStabilityDecision: stabilityDecision,
      },
      body: parentBody,
      capabilities: {
        agent: owner,
        workflow,
        checkpoint(value) {
          checkpoints.push(value);
        },
        log: vi.fn(),
        phase: vi.fn(),
      },
    });

    expect(
      (
        result as { plan: { sections: Array<{ modelProfile: string }> } }
      ).plan.sections.map((section) => section.modelProfile),
    ).toEqual(psaComponents.map(() => "cost-efficient-implementation"));
    expect(owner).toHaveBeenCalledTimes(8);
    expect(owner.mock.results.every((entry) => entry.type === "return")).toBe(
      true,
    );
    expect(result).toMatchObject({
      status: "blocked",
      lifecycle: { missingPsaComponents: psaComponents },
      execution: {
        sections: psaComponents.map(() => ({
          status: "blocked",
          verificationBlocked: true,
        })),
      },
    });
    expect(workflow).toHaveBeenCalledTimes(1);
  });
});

describe("staged assurance child input gates", () => {
  it("returns a typed invalid plan without calling the planner for legacy PSA mode", async () => {
    const agent = vi.fn(async () => ({
      lane: "implementation",
      why: "Implementation is settled",
      secondaryGates: [],
      firstAction: "Plan bounded work",
      stopCondition: "Work is verified",
      confidence: "high",
    }));
    const capabilities: WorkflowCapabilities = {
      agent,
      log: vi.fn(),
      phase: vi.fn(),
    };
    const result = await executeWorkflowScript({
      args: {
        objective: contract.objective,
        planningMode: "execution-plan",
        groundingMode: "route-only",
        psaMode: "audit",
      },
      body: childBody,
      capabilities,
    });

    expect(result).toMatchObject({
      contractVersion: "workflow-router.execution-plan.v2",
      validation: {
        valid: false,
        errors: [{ code: "PSA_MODE_OUTSIDE_AVAILABILITY" }],
      },
    });
    expect(agent).toHaveBeenCalledTimes(1);
  });
});
