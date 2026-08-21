export const meta = {
  name: "workflow-router-pipeline",
  description: "Plan and explicitly execute bounded routed sections with risk-first red-team escalation",
  inputSchema: {
    type: "object",
    required: ["objective"],
    additionalProperties: false,
    properties: {
      objective: { type: "string", minLength: 1, maxLength: 2048 },
      context: { type: "string", maxLength: 8192 },
      executionMode: { enum: ["plan-only", "execute"] },
      allowMutations: { type: "boolean" },
      maxSections: { type: "integer", minimum: 1, maximum: 8 },
      maxWorkerCalls: { type: "integer", minimum: 1, maximum: 100 },
      lifecycleStage: {
        enum: [
          "mvp-definition",
          "shakedown-build",
          "customer-shakedown",
          "design-stability",
          "post-shakedown-availability",
        ],
      },
      psaMode: { enum: ["audit", "remediate", "re-audit", "availability-decision"] },
      mvpContract: {
        type: "object",
        required: [
          "contractId",
          "revision",
          "objective",
          "targetCohort",
          "coreJobs",
          "inScope",
          "outOfScope",
          "criticalInvariants",
          "temporaryLimitations",
          "telemetry",
          "rollback",
          "support",
          "designInvalidationSignals",
        ],
        additionalProperties: false,
        properties: {
          contractId: { type: "string", minLength: 1, maxLength: 96 },
          revision: { type: "integer", minimum: 1 },
          objective: { type: "string", minLength: 1, maxLength: 768 },
          targetCohort: {
            type: "object",
            required: ["eligibilityCriteria", "exposureLimit", "exclusions"],
            additionalProperties: false,
            properties: {
              eligibilityCriteria: {
                type: "array",
                minItems: 1,
                maxItems: 6,
                items: { type: "string", minLength: 1, maxLength: 192 },
              },
              exposureLimit: { type: "string", minLength: 1, maxLength: 384 },
              exclusions: {
                type: "array",
                maxItems: 6,
                items: { type: "string", minLength: 1, maxLength: 192 },
              },
            },
          },
          coreJobs: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 192 },
          },
          inScope: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 192 },
          },
          outOfScope: {
            type: "array",
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 192 },
          },
          criticalInvariants: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: {
              type: "object",
              required: ["id", "requirement", "verification"],
              additionalProperties: false,
              properties: {
                id: { type: "string", minLength: 1, maxLength: 64 },
                requirement: { type: "string", minLength: 1, maxLength: 256 },
                verification: { type: "string", minLength: 1, maxLength: 256 },
              },
            },
          },
          temporaryLimitations: {
            type: "array",
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 192 },
          },
          telemetry: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            items: {
              type: "object",
              required: ["signal", "successThreshold", "alertThreshold"],
              additionalProperties: false,
              properties: {
                signal: { type: "string", minLength: 1, maxLength: 192 },
                successThreshold: { type: "string", minLength: 1, maxLength: 192 },
                alertThreshold: { type: "string", minLength: 1, maxLength: 192 },
              },
            },
          },
          rollback: {
            type: "object",
            required: ["trigger", "procedure", "owner"],
            additionalProperties: false,
            properties: {
              trigger: { type: "string", minLength: 1, maxLength: 256 },
              procedure: { type: "string", minLength: 1, maxLength: 384 },
              owner: { type: "string", minLength: 1, maxLength: 192 },
            },
          },
          support: {
            type: "object",
            required: ["owner", "responseTarget", "escalationPath"],
            additionalProperties: false,
            properties: {
              owner: { type: "string", minLength: 1, maxLength: 192 },
              responseTarget: { type: "string", minLength: 1, maxLength: 192 },
              escalationPath: { type: "string", minLength: 1, maxLength: 384 },
            },
          },
          designInvalidationSignals: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 192 },
          },
        },
      },
      mvpApproval: {
        type: "object",
        required: ["decisionRef", "evidenceRef", "decidedByHuman", "contractId", "contractRevision", "decision", "rationale"],
        additionalProperties: false,
        properties: {
          decisionRef: { type: "string", minLength: 1, maxLength: 256 },
          evidenceRef: { type: "string", minLength: 1, maxLength: 512 },
          decidedByHuman: { const: true },
          contractId: { type: "string", minLength: 1, maxLength: 96 },
          contractRevision: { type: "integer", minimum: 1 },
          decision: { enum: ["approved", "revise"] },
          rationale: { type: "string", minLength: 1, maxLength: 2048 },
        },
      },
      shakedownLaunchApproval: {
        type: "object",
        required: ["decisionRef", "evidenceRef", "decidedByHuman", "contractId", "contractRevision", "decision", "rationale"],
        additionalProperties: false,
        properties: {
          decisionRef: { type: "string", minLength: 1, maxLength: 256 },
          evidenceRef: { type: "string", minLength: 1, maxLength: 512 },
          decidedByHuman: { const: true },
          contractId: { type: "string", minLength: 1, maxLength: 96 },
          contractRevision: { type: "integer", minimum: 1 },
          decision: { enum: ["approved", "not-ready"] },
          rationale: { type: "string", minLength: 1, maxLength: 2048 },
        },
      },
      shakedownEvidenceRefs: {
        type: "array",
        maxItems: 50,
        items: { type: "string", minLength: 1, maxLength: 512 },
      },
      customerFeedback: { type: "string", maxLength: 8192 },
      designStabilityDecision: {
        type: "object",
        required: ["decisionRef", "evidenceRef", "decidedByHuman", "contractId", "contractRevision", "decision", "rationale"],
        additionalProperties: false,
        properties: {
          decisionRef: { type: "string", minLength: 1, maxLength: 256 },
          evidenceRef: { type: "string", minLength: 1, maxLength: 512 },
          decidedByHuman: { const: true },
          contractId: { type: "string", minLength: 1, maxLength: 96 },
          contractRevision: { type: "integer", minimum: 1 },
          decision: { enum: ["stable", "material-change"] },
          rationale: { type: "string", minLength: 1, maxLength: 2048 },
        },
      },
      findingRefs: {
        type: "array",
        maxItems: 64,
        items: { type: "string", minLength: 1, maxLength: 512 },
      },
      availabilityApproval: {
        type: "object",
        required: ["decisionRef", "evidenceRef", "decidedByHuman", "contractId", "contractRevision", "decision", "rationale"],
        additionalProperties: false,
        properties: {
          decisionRef: { type: "string", minLength: 1, maxLength: 256 },
          evidenceRef: { type: "string", minLength: 1, maxLength: 512 },
          decidedByHuman: { const: true },
          contractId: { type: "string", minLength: 1, maxLength: 96 },
          contractRevision: { type: "integer", minimum: 1 },
          decision: { enum: ["approved", "not-ready"] },
          rationale: { type: "string", minLength: 1, maxLength: 2048 },
        },
      },
    },
  },
  phases: [
    { title: "Define MVP", detail: "Draft the human-approved shakedown contract" },
    { title: "Plan", detail: "Route, decompose, and assign bounded coverage" },
    { title: "Admit", detail: "Fit complete section profiles within the run budget" },
    { title: "Execute", detail: "Run admitted sections with deterministic worker roles" },
    { title: "Stability", detail: "Assess shakedown evidence without replacing the human decision" },
    { title: "Deliver", detail: "Return results, skipped coverage, and human gates" },
  ],
};

const taskResultSchema = {
  type: "object",
  required: ["summary", "evidence", "risks", "changedFiles", "verifications"],
  additionalProperties: false,
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 2048 },
    evidence: { type: "array", maxItems: 16, items: { type: "string", maxLength: 1024 } },
    risks: { type: "array", maxItems: 16, items: { type: "string", maxLength: 1024 } },
    changedFiles: { type: "array", maxItems: 64, items: { type: "string", maxLength: 512 } },
    verifications: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        required: ["title", "command", "status", "summary", "passed", "failed", "skipped"],
        additionalProperties: false,
        properties: {
          title: { type: "string", minLength: 1, maxLength: 256 },
          command: { type: "string", minLength: 1, maxLength: 2048 },
          status: { enum: ["passed", "failed", "skipped"] },
          summary: { type: "string", minLength: 1, maxLength: 1024 },
          passed: { type: "integer", minimum: 0 },
          failed: { type: "integer", minimum: 0 },
          skipped: { type: "integer", minimum: 0 },
        },
      },
    },
  },
};

const reviewResultSchema = {
  type: "object",
  required: ["verdict", "findings"],
  additionalProperties: false,
  properties: {
    verdict: { enum: ["pass", "concern", "blocked"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "classification", "summary", "evidence"],
        additionalProperties: false,
        properties: {
          severity: { enum: ["critical", "high", "medium", "low"] },
          classification: { enum: ["patch-level", "approach-level", "human-gate"] },
          summary: { type: "string", minLength: 1 },
          evidence: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

const redTeamSynthesisSchema = {
  type: "object",
  required: ["verdict", "findings", "verifications"],
  additionalProperties: false,
  properties: {
    ...reviewResultSchema.properties,
    verifications: taskResultSchema.properties.verifications,
  },
};

const architectProposalSchema = {
  type: "object",
  required: ["perspective", "recommendations", "risks", "openQuestions", "contractSuggestions"],
  additionalProperties: false,
  properties: {
    perspective: { type: "string", minLength: 1, maxLength: 192 },
    recommendations: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: { type: "string", minLength: 1, maxLength: 192 },
    },
    risks: {
      type: "array",
      maxItems: 6,
      items: { type: "string", minLength: 1, maxLength: 192 },
    },
    openQuestions: {
      type: "array",
      maxItems: 6,
      items: { type: "string", minLength: 1, maxLength: 192 },
    },
    contractSuggestions: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 192 },
    },
  },
};

const shakedownContractSchema = {
  type: "object",
  required: [
    "contractId",
    "revision",
    "objective",
    "targetCohort",
    "coreJobs",
    "inScope",
    "outOfScope",
    "criticalInvariants",
    "temporaryLimitations",
    "telemetry",
    "rollback",
    "support",
    "designInvalidationSignals",
  ],
  additionalProperties: false,
  properties: {
    contractId: { type: "string", minLength: 1, maxLength: 96 },
    revision: { type: "integer", minimum: 1 },
    objective: { type: "string", minLength: 1, maxLength: 768 },
    targetCohort: {
      type: "object",
      required: ["eligibilityCriteria", "exposureLimit", "exclusions"],
      additionalProperties: false,
      properties: {
        eligibilityCriteria: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          items: { type: "string", minLength: 1, maxLength: 192 },
        },
        exposureLimit: { type: "string", minLength: 1, maxLength: 384 },
        exclusions: {
          type: "array",
          maxItems: 6,
          items: { type: "string", minLength: 1, maxLength: 192 },
        },
      },
    },
    coreJobs: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 192 },
    },
    inScope: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 192 },
    },
    outOfScope: {
      type: "array",
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 192 },
    },
    criticalInvariants: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        required: ["id", "requirement", "verification"],
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: 64 },
          requirement: { type: "string", minLength: 1, maxLength: 256 },
          verification: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
    },
    temporaryLimitations: {
      type: "array",
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 192 },
    },
    telemetry: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        required: ["signal", "successThreshold", "alertThreshold"],
        additionalProperties: false,
        properties: {
          signal: { type: "string", minLength: 1, maxLength: 192 },
          successThreshold: { type: "string", minLength: 1, maxLength: 192 },
          alertThreshold: { type: "string", minLength: 1, maxLength: 192 },
        },
      },
    },
    rollback: {
      type: "object",
      required: ["trigger", "procedure", "owner"],
      additionalProperties: false,
      properties: {
        trigger: { type: "string", minLength: 1, maxLength: 256 },
        procedure: { type: "string", minLength: 1, maxLength: 384 },
        owner: { type: "string", minLength: 1, maxLength: 192 },
      },
    },
    support: {
      type: "object",
      required: ["owner", "responseTarget", "escalationPath"],
      additionalProperties: false,
      properties: {
        owner: { type: "string", minLength: 1, maxLength: 192 },
        responseTarget: { type: "string", minLength: 1, maxLength: 192 },
        escalationPath: { type: "string", minLength: 1, maxLength: 384 },
      },
    },
    designInvalidationSignals: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 192 },
    },
  },
};

const stabilityAssessmentSchema = {
  type: "object",
  required: ["recommendation", "designChangeSignals", "residualRisks", "evidenceGaps", "rationale"],
  additionalProperties: false,
  properties: {
    recommendation: { enum: ["stable", "material-change", "insufficient-evidence"] },
    designChangeSignals: { type: "array", items: { type: "string", minLength: 1 } },
    residualRisks: { type: "array", items: { type: "string", minLength: 1 } },
    evidenceGaps: { type: "array", items: { type: "string", minLength: 1 } },
    rationale: { type: "string", minLength: 1 },
  },
};

const currentPlanContractVersion = "workflow-router.execution-plan.v1";
const stagedPlanContractVersion = "workflow-router.execution-plan.v2";
const currentRouteContractVersion = "workflow-router.route-decision.v1";
const currentPolicyVersion = "workflow-router.fanout-policy.v2";
const stagedPolicyVersion = "workflow-router.fanout-policy.v3";
const knownAssuranceClasses = [
  "mvp-definition",
  "mvp-functionality",
  "nondeferrable-safety",
  "low-regret-psa-prep",
  "shakedown-learning",
  "design-stability",
  "post-shakedown-assurance",
];
const knownPsaComponents = [
  "none",
  "security",
  "reliability",
  "operations",
  "permissions",
  "data-integrity",
  "performance",
  "accessibility",
  "compliance",
];
const dueStageForAssuranceClass = {
  "mvp-definition": "mvp-definition",
  "mvp-functionality": "shakedown-build",
  "nondeferrable-safety": "shakedown-build",
  "low-regret-psa-prep": "shakedown-build",
  "shakedown-learning": "customer-shakedown",
  "design-stability": "design-stability",
  "post-shakedown-assurance": "post-shakedown-availability",
};
const knownLanes = [
  "simple-answer",
  "spec-driven-development",
  "implementation",
  "architecture",
  "qa-evidence",
  "pr-stack",
  "production-triage",
  "llm-forensics",
  "eval-execution",
  "design-packaging",
  "flow-editing",
];
const knownSecondaryGates = [
  "redesign-shipped-behavior",
  "pre-human-handoff",
  "investigative-grounding",
  "active-design",
  "security-boundary",
  "contract-edge",
  "ui-product",
  "reviewer-feedback",
  "multi-agent",
  "pr-handoff",
  "long-running-initiative",
  "grounding-gap",
];
const knownRiskTriggers = [
  "none",
  "auth-access",
  "single-chokepoint-security",
  "migration-irreversible",
  "multi-region-residency",
  "secrets-environment",
  "data-egress-publication",
  "shared-chokepoint-guard",
];
const securityTestingRiskTriggers = [
  "auth-access",
  "single-chokepoint-security",
  "secrets-environment",
  "data-egress-publication",
  "shared-chokepoint-guard",
];
const tasteSkills = [
  "collaborative-design-lab",
  "design-review-packager",
  "expert-ux-designer",
  "polished-review-artifact-authoring",
];
const coveragePolicies = {
  light: {
    workerRoles: ["owner"],
    agentCalls: 1,
    findingsOnly: false,
    humanGate: false,
  },
  standard: {
    workerRoles: ["owner", "contract-critic"],
    agentCalls: 2,
    findingsOnly: false,
    humanGate: false,
  },
  thorough: {
    workerRoles: ["owner", "contract-critic", "edge-case-critic"],
    agentCalls: 3,
    findingsOnly: false,
    humanGate: false,
  },
  "red-team": {
    workerRoles: [
      "issue-hunter",
      "problem-solution-challenger",
      "regression-critic",
      "evidence-verifier",
      "red-team-synthesizer",
    ],
    agentCalls: 5,
    findingsOnly: true,
    humanGate: true,
  },
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decisionMatches(decision, contract, expectedDecision) {
  return (
    isObject(decision) &&
    isObject(contract) &&
    decision.decidedByHuman === true &&
    decision.decision === expectedDecision &&
    decision.contractId === contract.contractId &&
    decision.contractRevision === contract.revision
  );
}

function writeGateCheckpoint(id, title, status, summary, blocker) {
  checkpoint({
    kind: "work-item",
    id,
    title,
    status,
    summary,
    ticketRef: null,
    changedFiles: [],
    blocker,
  });
}

function lifecycleContractRef(contract) {
  return isObject(contract)
    ? { contractId: contract.contractId, revision: contract.revision }
    : null;
}

function approvedContractForRouter(contract, approval) {
  if (!decisionMatches(approval, contract, "approved")) return null;
  const items = [];
  items.push({
    id: "target-cohort-1",
    kind: "target-cohort",
    statement: `Eligibility: ${contract.targetCohort.eligibilityCriteria.join("; ")}. Exposure limit: ${contract.targetCohort.exposureLimit}. Exclusions: ${contract.targetCohort.exclusions.join("; ") || "none"}.`,
    nondeferrable: true,
  });
  for (let index = 0; index < contract.inScope.length; index += 1) {
    items.push({
      id: `in-scope-${index + 1}`,
      kind: "in-scope",
      statement: contract.inScope[index],
      nondeferrable: true,
    });
  }
  for (let index = 0; index < contract.outOfScope.length; index += 1) {
    items.push({
      id: `out-of-scope-${index + 1}`,
      kind: "out-of-scope",
      statement: contract.outOfScope[index],
      nondeferrable: false,
    });
  }
  for (let index = 0; index < contract.coreJobs.length; index += 1) {
    items.push({
      id: `core-job-${index + 1}`,
      kind: "core-job",
      statement: contract.coreJobs[index],
      nondeferrable: true,
    });
  }
  for (const invariant of contract.criticalInvariants) {
    items.push({
      id: invariant.id,
      kind: "critical-invariant",
      statement: `${invariant.requirement} Verification: ${invariant.verification}`,
      nondeferrable: true,
    });
  }
  for (let index = 0; index < contract.temporaryLimitations.length; index += 1) {
    items.push({
      id: `temporary-limitation-${index + 1}`,
      kind: "temporary-limitation",
      statement: contract.temporaryLimitations[index],
      nondeferrable: false,
    });
  }
  for (let index = 0; index < contract.telemetry.length; index += 1) {
    const signal = contract.telemetry[index];
    items.push({
      id: `telemetry-${index + 1}`,
      kind: "telemetry",
      statement: `${signal.signal}; success: ${signal.successThreshold}; alert: ${signal.alertThreshold}`,
      nondeferrable: true,
    });
  }
  items.push({
    id: "rollback-1",
    kind: "rollback",
    statement: `${contract.rollback.trigger}; ${contract.rollback.procedure}; owner: ${contract.rollback.owner}`,
    nondeferrable: true,
  });
  items.push({
    id: "support-1",
    kind: "support",
    statement: `${contract.support.owner}; response: ${contract.support.responseTarget}; escalation: ${contract.support.escalationPath}`,
    nondeferrable: true,
  });
  for (let index = 0; index < contract.designInvalidationSignals.length; index += 1) {
    items.push({
      id: `design-invalidating-feedback-${index + 1}`,
      kind: "design-invalidating-feedback",
      statement: contract.designInvalidationSignals[index],
      nondeferrable: false,
    });
  }
  return {
    contractVersion: `${contract.contractId}:revision-${contract.revision}`,
    approved: true,
    approvalDecisionRef: approval.decisionRef,
    approvalEvidenceRefs: [approval.decisionRef, approval.evidenceRef],
    items,
  };
}

function humanDecisionEvidenceForRouter() {
  const decisions = [];
  const append = (stage, decision, source) => {
    if (!isObject(source)) return;
    decisions.push({
      stage,
      decision,
      decisionRef: source.decisionRef,
      contractVersion: `${source.contractId}:revision-${source.contractRevision}`,
      summary: source.rationale,
      evidenceRefs: [source.decisionRef, source.evidenceRef],
    });
  };
  if (isObject(args.mvpApproval)) {
    append(
      "mvp-definition",
      args.mvpApproval.decision === "approved" ? "approve" : "revise",
      args.mvpApproval,
    );
  }
  if (isObject(args.shakedownLaunchApproval)) {
    append(
      "shakedown-build",
      args.shakedownLaunchApproval.decision === "approved" ? "approve" : "revise",
      args.shakedownLaunchApproval,
    );
  }
  if (isObject(args.designStabilityDecision)) {
    const decision =
      args.designStabilityDecision.decision === "stable" ? "approve" : "revise";
    append("customer-shakedown", decision, args.designStabilityDecision);
    append("design-stability", decision, args.designStabilityDecision);
  }
  if (isObject(args.availabilityApproval)) {
    append(
      "post-shakedown-availability",
      args.availabilityApproval.decision === "approved" ? "approve" : "revise",
      args.availabilityApproval,
    );
  }
  return decisions;
}

function sameArray(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function expectedModelProfile(route, section, matchedTriggers) {
  const requiredSkills = Array.isArray(section.requiredSkills) ? section.requiredSkills : [];
  const secondaryGates = Array.isArray(route.secondaryGates) ? route.secondaryGates : [];
  const securityTesting =
    section.coverage === "red-team" &&
    (secondaryGates.includes("security-boundary") ||
      matchedTriggers.some((trigger) => securityTestingRiskTriggers.includes(trigger)) ||
      requiredSkills.includes("owasp-security"));
  if (securityTesting) return "fable-security";

  const tasteHeavy =
    route.lane === "design-packaging" ||
    secondaryGates.some((gate) => gate === "active-design" || gate === "ui-product") ||
    requiredSkills.some((skill) => tasteSkills.includes(skill));
  if (tasteHeavy) return "fable-taste";

  if (
    route.lane === "implementation" &&
    section.coverage !== "red-team" &&
    matchedTriggers.length === 0
  ) {
    return "cost-efficient-implementation";
  }
  return "frontier-judgment";
}

function validatePlan(plan, expected) {
  const errors = [];
  const staged = expected.lifecycleStage !== null;
  if (!isObject(plan)) return ["plan must be an object"];
  if (plan.objective !== expected.objective) {
    errors.push("plan objective does not match the current request");
  }
  if (
    plan.contractVersion !==
    (staged ? stagedPlanContractVersion : currentPlanContractVersion)
  ) {
    errors.push("plan contractVersion is stale or unsupported");
  }
  if (
    plan.policyVersion !== (staged ? stagedPolicyVersion : currentPolicyVersion)
  ) {
    errors.push("plan policyVersion is stale or unsupported");
  }
  if (!isObject(plan.route)) {
    errors.push("plan route must be an object");
    return errors;
  }
  if (plan.route.contractVersion !== currentRouteContractVersion) {
    errors.push("route contractVersion is stale or unsupported");
  }
  if (plan.route.objective !== expected.objective) {
    errors.push("route objective does not match the current request");
  }
  if (!knownLanes.includes(plan.route.lane)) errors.push("route lane is unknown");
  if (
    !Array.isArray(plan.route.secondaryGates) ||
    plan.route.secondaryGates.some((gate) => !knownSecondaryGates.includes(gate))
  ) {
    errors.push("route secondaryGates are malformed or unknown");
  }
  if (!Array.isArray(plan.sections) || plan.sections.length < 1 || plan.sections.length > 8) {
    errors.push("plan sections must contain between 1 and 8 items");
    return errors;
  }
  if (plan.sections.length > expected.maxSections) {
    errors.push("plan sections exceed the current request maximum");
  }

  const ids = [];
  let requestedAgentCalls = 0;
  let redTeamSections = 0;
  for (let index = 0; index < plan.sections.length; index += 1) {
    const section = plan.sections[index];
    const label = `section ${index + 1}`;
    if (!isObject(section)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (typeof section.id !== "string" || section.id.length === 0) {
      errors.push(`${label} id must be a non-empty string`);
    } else {
      ids.push(section.id);
    }
    const policy = coveragePolicies[section.coverage];
    if (!policy) {
      errors.push(`${label} coverage is unknown`);
      continue;
    }
    if (
      !Array.isArray(section.riskTriggers) ||
      section.riskTriggers.length === 0 ||
      section.riskTriggers.some((trigger) => !knownRiskTriggers.includes(trigger)) ||
      (section.riskTriggers.includes("none") && section.riskTriggers.length !== 1)
    ) {
      errors.push(`${label} riskTriggers are malformed or unknown`);
      continue;
    }
    const matchedTriggers = section.riskTriggers.filter((trigger) => trigger !== "none");
    if (matchedTriggers.length > 0 && section.coverage !== "red-team") {
      errors.push(`${label} risk triggers require red-team coverage`);
    }
    if (!sameArray(section.workerRoles, policy.workerRoles)) {
      errors.push(`${label} workerRoles do not match coverage policy`);
    }
    if (section.agentCalls !== policy.agentCalls) {
      errors.push(`${label} agentCalls do not match coverage policy`);
    }
    if (section.findingsOnly !== policy.findingsOnly) {
      errors.push(`${label} findingsOnly does not match coverage policy`);
    }
    if (section.humanGate !== policy.humanGate) {
      errors.push(`${label} humanGate does not match coverage policy`);
    }
    if (!Array.isArray(section.requiredSkills)) {
      errors.push(`${label} requiredSkills must be an array`);
    }
    const expectedProfile = expectedModelProfile(plan.route, section, matchedTriggers);
    if (section.modelProfile !== expectedProfile) {
      errors.push(`${label} modelProfile does not match deterministic routing policy`);
    }
    if (staged) {
      if (!knownAssuranceClasses.includes(section.assuranceClass)) {
        errors.push(`${label} assuranceClass is unknown`);
      }
      if (!knownPsaComponents.includes(section.psaComponent)) {
        errors.push(`${label} psaComponent is unknown`);
      }
      if (
        !Array.isArray(section.dependsOn) ||
        section.dependsOn.some((dependency) =>
          !plan.sections.slice(0, index).some((candidate) => candidate.id === dependency),
        )
      ) {
        errors.push(`${label} dependencies must reference earlier sections`);
      }
      if (!["read-only", "mutate"].includes(section.mutationIntent)) {
        errors.push(`${label} mutationIntent is unknown`);
      }
      if (!Array.isArray(section.contractItemRefs)) {
        errors.push(`${label} contractItemRefs must be an array`);
      }
      if (typeof section.verificationRequired !== "boolean") {
        errors.push(`${label} verificationRequired must be boolean`);
      }
      if (
        expected.lifecycleStage === "post-shakedown-availability" &&
        (expected.psaMode === "audit" || expected.psaMode === "re-audit") &&
        section.verificationRequired !== true
      ) {
        errors.push(`${label} PSA audit and re-audit work requires verification`);
      }
      if (typeof section.exitCriterion !== "string" || section.exitCriterion.length === 0) {
        errors.push(`${label} exitCriterion must be non-empty`);
      }
      if (section.dueStage !== dueStageForAssuranceClass[section.assuranceClass]) {
        errors.push(`${label} dueStage does not match assuranceClass`);
      }
      if (
        (expected.lifecycleStage === "customer-shakedown" ||
          (expected.lifecycleStage === "post-shakedown-availability" &&
            (expected.psaMode === "audit" || expected.psaMode === "re-audit"))) &&
        section.mutationIntent !== "read-only"
      ) {
        errors.push(`${label} must be read-only in the current lifecycle stage`);
      }
      if (
        expected.lifecycleStage === "post-shakedown-availability" &&
        section.assuranceClass === "post-shakedown-assurance" &&
        section.psaComponent === "none"
      ) {
        errors.push(`${label} post-shakedown assurance requires a PSA component`);
      }
      if (matchedTriggers.length > 0) {
        if (
          section.assuranceClass !== "nondeferrable-safety" ||
          section.mutationIntent !== "read-only" ||
          section.verificationRequired !== true
        ) {
          errors.push(`${label} risk triggers must remain nondeferrable, read-only, and verification-required`);
        }
      }
    }
    requestedAgentCalls += policy.agentCalls;
    if (section.coverage === "red-team") redTeamSections += 1;
  }
  if (new Set(ids).size !== ids.length) errors.push("section ids must be unique");

  if (!isObject(plan.totals)) {
    errors.push("plan totals must be an object");
  } else if (
    plan.totals.sections !== plan.sections.length ||
    plan.totals.requestedAgentCalls !== requestedAgentCalls ||
    plan.totals.redTeamSections !== redTeamSections
  ) {
    errors.push("plan totals do not match sections");
  }
  if (!Array.isArray(plan.warnings) || plan.warnings.some((warning) => typeof warning !== "string")) {
    errors.push("plan warnings must be an array of strings");
  }
  if (staged) {
    if (!isObject(plan.lifecycle) || plan.lifecycle.stage !== expected.lifecycleStage) {
      errors.push("plan lifecycle does not match the requested stage");
    } else {
      if (plan.lifecycle.psaMode !== expected.psaMode) {
        errors.push("plan lifecycle PSA mode does not match the current request");
      }
      if (
        plan.lifecycle.approvedShakedownContract?.contractVersion !==
        expected.approvedContractVersion
      ) {
        errors.push("plan lifecycle contract version does not match the approved contract");
      }
      if (!sameArray(plan.lifecycle.evidenceRefs, expected.evidenceRefs)) {
        errors.push("plan lifecycle evidence refs do not match the current request");
      }
      if (!sameArray(plan.lifecycle.findingRefs, expected.findingRefs)) {
        errors.push("plan lifecycle finding refs do not match the current request");
      }
    }
    if (!isObject(plan.validation) || plan.validation.valid !== true) {
      const childErrors =
        isObject(plan.validation) && Array.isArray(plan.validation.errors)
          ? plan.validation.errors.map((entry) => entry.message).filter(Boolean)
          : [];
      errors.push(
        childErrors.length > 0
          ? `nested staged plan is invalid: ${childErrors.join("; ")}`
          : "nested staged plan is invalid",
      );
    }
  }
  if (plan.truncation !== null) {
    if (
      !isObject(plan.truncation) ||
      !Number.isInteger(plan.truncation.returnedSections) ||
      !Number.isInteger(plan.truncation.keptSections) ||
      !Number.isInteger(plan.truncation.droppedSections) ||
      plan.truncation.keptSections !== plan.sections.length ||
      plan.truncation.droppedSections < 1 ||
      plan.truncation.returnedSections !==
        plan.truncation.keptSections + plan.truncation.droppedSections
    ) {
      errors.push("plan truncation record is incoherent");
    }
  }
  return errors;
}

async function selectedAgent(section, role, prompt, label, schema) {
  if (section.modelProfile === "fable-security" || section.modelProfile === "fable-taste") {
    return agent(prompt, {
      provider: "claude-code",
      model: "claude-fable-5",
      reasoningLevel: "high",
      label,
      phase: "Execute",
      schema,
    });
  }
  if (section.modelProfile === "cost-efficient-implementation" && role === "owner") {
    return agent(prompt, {
      provider: "codex",
      model: "gpt-5.6-luna",
      reasoningLevel: "medium",
      label,
      phase: "Execute",
      schema,
    });
  }
  if (
    section.modelProfile === "frontier-judgment" ||
    (section.modelProfile === "cost-efficient-implementation" && role !== "owner")
  ) {
    return agent(prompt, {
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
      label,
      phase: "Execute",
      schema,
    });
  }
  throw new Error(`Unsupported model profile: ${String(section.modelProfile)}`);
}

function securityTestingInstruction(section) {
  if (section.modelProfile !== "fable-security") return "";
  return `Authorized security-testing boundary:
- This work is defensive hardening of systems the user owns or is explicitly authorized to assess. Do not infer authorization from this label alone.
- If the target, ownership or authorization, permitted techniques, or data-handling limits are not explicit in the objective or context, return a human-gate finding and do not perform live interaction.
- Remain findings-only and read-only. No persistence, destructive effects, credential attacks, exfiltration, third-party targets, or scope expansion.
- Do not obfuscate, euphemize, or attempt to bypass provider safeguards. Surface a refusal or ambiguous boundary as a human gate.`;
}

function coveragePriority(coverage) {
  if (coverage === "red-team") return 4;
  if (coverage === "thorough") return 3;
  if (coverage === "standard") return 2;
  return 1;
}

function skillsInstruction(section) {
  if (section.requiredSkills.length === 0) return "No routed skills were assigned to this section.";
  return `Use these routed skills when available: ${section.requiredSkills.join(", ")}.`;
}

function reviewStatus(results, missingWorkers) {
  for (const result of results) {
    if (result.verdict === "blocked") return "blocked";
    if (
      result.findings.some(
        (finding) =>
          finding.classification === "approach-level" ||
          finding.classification === "human-gate" ||
          finding.severity === "critical" ||
          finding.severity === "high",
      )
    ) {
      return "blocked";
    }
  }
  if (missingWorkers.length > 0) return "partial";
  if (
    results.some(
      (result) => result.verdict === "concern" || result.findings.length > 0,
    )
  ) {
    return "partial";
  }
  return "completed";
}

function sectionMayMutate(section) {
  return (
    effectiveAllowMutations &&
    section.coverage !== "red-team" &&
    (lifecycleStage === null || section.mutationIntent === "mutate")
  );
}

async function executeNormalOwner(section) {
  const owner = await selectedAgent(
    section,
    "owner",
    `Role: owner
Section: ${section.title}
Objective: ${section.objective}
Parent objective: ${args.objective}
Context: ${args.context || "None supplied."}
${skillsInstruction(section)}
Mutations authorized for this section: ${sectionMayMutate(section) ? "yes" : "no"}

Progress contract:
- The parent workflow owns work-item ID ${section.id} and transitions it around this call. Do not publish or update that work-item checkpoint from the worker.
- Give each selected verification the stable ID ${section.id}:verification-N (1-based). Report the exact command as running before execution, then update the same ID with its actual result and pass/fail/skip counts.
- Return changedFiles and verifications explicitly. Use empty arrays when this bounded section changes no files or selects no executable checks.

Execute only this bounded section. Do not spawn or delegate to additional agents; the workflow owns orchestration. ${
      sectionMayMutate(section)
        ? "Edits are explicitly authorized; keep them scoped to the section and parent objective."
        : "Do not edit files or external state; return analysis and evidence only."
    } Return a concise result with concrete evidence, exact changed files, exact verification commands and results, and unresolved risks.`,
    `${section.id}:owner`,
    taskResultSchema,
  );

  for (let index = 0; index < owner.verifications.length; index += 1) {
    const verification = owner.verifications[index];
    checkpoint({
      kind: "verification",
      id: `${section.id}:verification-${index + 1}`,
      title: verification.title,
      status:
        verification.status === "passed"
          ? "succeeded"
          : verification.status === "failed"
            ? "failed"
            : "skipped",
      summary: verification.summary,
      workItemId: section.id,
      command: verification.command,
      counts: {
        passed: verification.passed,
        failed: verification.failed,
        skipped: verification.skipped,
      },
    });
  }

  return owner;
}

async function reviewNormalSection(section, owner) {
  const hasFailedVerification = owner.verifications.some(
    (verification) => verification.status === "failed" || verification.failed > 0,
  );
  const missingRequiredVerification =
    section.verificationRequired === true && owner.verifications.length === 0;
  const missingPassedRequiredVerification =
    section.verificationRequired === true &&
    !owner.verifications.some(
      (verification) => verification.status === "passed" && verification.failed === 0,
    );
  const verificationBlocked =
    hasFailedVerification ||
    missingRequiredVerification ||
    missingPassedRequiredVerification;
  const criticRoles = section.workerRoles.slice(1);
  if (criticRoles.length === 0) {
    return {
      sectionId: section.id,
      coverage: section.coverage,
      status: verificationBlocked ? "blocked" : "completed",
      workers: [{ role: "owner", result: owner }],
      missingWorkers: [],
      humanGate: false,
      verificationBlocked,
    };
  }

  const criticResults = await parallel(
    criticRoles.map(
      (role) => async () => {
        try {
          return await selectedAgent(
            section,
            role,
            `Role: ${role}
Section: ${section.title}
Section objective: ${section.objective}
Owner result: ${JSON.stringify(owner)}
${skillsInstruction(section)}

Review the owner result against the section objective. Do not edit files or external state. Do not spawn other agents. Construct concrete failure scenarios and distinguish patch-level, approach-level, and human-gate findings.`,
            `${section.id}:${role}`,
            reviewResultSchema,
          );
        } catch {
          return null;
        }
      },
    ),
  );

  const workers = [{ role: "owner", result: owner }];
  const missingWorkers = [];
  for (let index = 0; index < criticRoles.length; index += 1) {
    const result = criticResults[index];
    if (result === null) missingWorkers.push(criticRoles[index]);
    else workers.push({ role: criticRoles[index], result });
  }
  const reviewResults = workers.slice(1).map((worker) => worker.result);
  const humanGate = reviewResults.some((result) =>
    result.findings.some((finding) => finding.classification === "human-gate"),
  );
  return {
    sectionId: section.id,
    coverage: section.coverage,
    status: verificationBlocked
      ? "blocked"
      : reviewStatus(reviewResults, missingWorkers),
    workers,
    missingWorkers,
    humanGate,
    verificationBlocked,
  };
}

async function executeNormalSection(section) {
  const owner = await executeNormalOwner(section);
  return reviewNormalSection(section, owner);
}

async function executeRedTeamSection(section) {
  const criticRoles = section.workerRoles.slice(0, -1);
  const criticResults = await parallel(
    criticRoles.map(
      (role) => async () => {
        try {
          return await selectedAgent(
            section,
            role,
            `Role: ${role}
High-risk section: ${section.title}
Section objective: ${section.objective}
Parent objective: ${args.objective}
Risk triggers: ${section.riskTriggers.join(", ")}
Risk reason: ${section.riskReason}
Context: ${args.context || "None supplied."}
	${skillsInstruction(section)}
	${securityTestingInstruction(section)}

	Run a findings-only adversarial pass. Do not edit files or external state. Do not spawn other agents. Test both whether the proposed work introduces issues and whether it actually solves the stated problem. Every finding needs concrete evidence; reject plausible but unverified holes.`,
            `${section.id}:${role}`,
            reviewResultSchema,
          );
        } catch {
          return null;
        }
      },
    ),
  );

  const survivingCritiques = [];
  const missingWorkers = [];
  for (let index = 0; index < criticRoles.length; index += 1) {
    const result = criticResults[index];
    if (result === null) missingWorkers.push(criticRoles[index]);
    else survivingCritiques.push({ role: criticRoles[index], result });
  }

  let synthesis = null;
  try {
    synthesis = await selectedAgent(
      section,
      "red-team-synthesizer",
      `Role: red-team-synthesizer
High-risk section: ${section.title}
Section objective: ${section.objective}
Risk triggers: ${section.riskTriggers.join(", ")}
Independent critiques: ${JSON.stringify(survivingCritiques)}
Missing critic roles: ${JSON.stringify(missingWorkers)}
${securityTestingInstruction(section)}

Synthesize only evidence-backed findings. Treat missing critics as incomplete coverage, never as a pass. Do not edit files or external state. Tag any unresolved authorization, migration, security, residency, secret, or egress decision as a human gate.

Verification contract:
- Execute the narrowest deterministic checks that prove or disprove this section's nondeferrable safety claims.
- Return every exact command and truthful passed, failed, and skipped counts in verifications.
- No passed verification means this section is blocked, never implicitly complete.`,
      `${section.id}:red-team-synthesizer`,
      redTeamSynthesisSchema,
    );
  } catch {
    missingWorkers.push("red-team-synthesizer");
  }

  const reviewResults = survivingCritiques.map((worker) => worker.result);
  const workers = [...survivingCritiques];
  if (synthesis !== null) {
    reviewResults.push(synthesis);
    workers.push({ role: "red-team-synthesizer", result: synthesis });
    for (let index = 0; index < synthesis.verifications.length; index += 1) {
      const verification = synthesis.verifications[index];
      checkpoint({
        kind: "verification",
        id: `${section.id}:verification-${index + 1}`,
        title: verification.title,
        status:
          verification.status === "passed"
            ? "succeeded"
            : verification.status === "failed"
              ? "failed"
              : "skipped",
        summary: verification.summary,
        workItemId: section.id,
        command: verification.command,
        counts: {
          passed: verification.passed,
          failed: verification.failed,
          skipped: verification.skipped,
        },
      });
    }
  }
  const blockingHumanGate = reviewResults.some((result) =>
    result.findings.some((finding) => finding.classification === "human-gate"),
  );
  const verificationBlocked =
    section.verificationRequired === true &&
    (synthesis === null ||
      synthesis.verifications.some(
        (verification) => verification.status === "failed" || verification.failed > 0,
      ) ||
      !synthesis.verifications.some(
        (verification) => verification.status === "passed" && verification.failed === 0,
      ));

  return {
    sectionId: section.id,
    coverage: section.coverage,
    status: verificationBlocked
      ? "blocked"
      : reviewStatus(reviewResults, missingWorkers),
    workers,
    missingWorkers,
    humanGate: true,
    blockingHumanGate,
    verificationBlocked,
  };
}

const lifecycleStage = args.lifecycleStage || null;
const effectiveAllowMutations =
  lifecycleStage === null || lifecycleStage === "shakedown-build"
    ? args.allowMutations === true
    : lifecycleStage === "post-shakedown-availability" &&
        args.psaMode === "remediate" &&
        args.allowMutations === true;

if (args.psaMode && lifecycleStage !== "post-shakedown-availability") {
  phase("Deliver");
  return {
    contractVersion:
      lifecycleStage === null
        ? "workflow-router.pipeline-result.v1"
        : "workflow-router.pipeline-result.v2",
    status: "blocked",
    plan: null,
    budget: budget(),
    execution: null,
    lifecycle:
      lifecycleStage === null
        ? undefined
        : {
            stage: lifecycleStage,
            gateState: "psa-mode-outside-availability",
            contractRef: lifecycleContractRef(args.mvpContract),
          },
    limitations: ["psaMode is accepted only during post-shakedown-availability."],
  };
}

if (lifecycleStage === "mvp-definition") {
  phase("Define MVP");
  const sharedDesignPrompt = `Objective: ${args.objective}
User context: ${args.context || "None supplied."}
Prior draft, if any: ${JSON.stringify(args.mvpContract || null)}

Define what a shakedown-ready MVP should be for a controlled, reduced-risk customer cohort. Preserve nondeferrable safety, data, authorization, rollback, and observability requirements, while deferring implementation-specific availability audits until the design has survived customer feedback. Do not approve the MVP; surface the exact questions and tradeoffs the human must decide. Do not include customer identities.`;
  const architectResults = await parallel([
    () =>
      agent(`Role: product, jobs, and UX architect\n${sharedDesignPrompt}`, {
        label: "MVP product/UX architecture",
        phase: "Define MVP",
        provider: "claude-code",
        model: "claude-fable-5",
        reasoningLevel: "high",
        schema: architectProposalSchema,
      }),
    () =>
      agent(`Role: systems, data, and integration architect\n${sharedDesignPrompt}`, {
        label: "MVP systems architecture",
        phase: "Define MVP",
        provider: "codex",
        model: "gpt-5.6-sol",
        reasoningLevel: "high",
        schema: architectProposalSchema,
      }),
    () =>
      agent(`Role: shakedown safety, operations, and reversibility architect\n${sharedDesignPrompt}`, {
        label: "MVP shakedown architecture",
        phase: "Define MVP",
        provider: "codex",
        model: "gpt-5.6-sol",
        reasoningLevel: "high",
        schema: architectProposalSchema,
      }),
  ]);
  const successfulArchitects = architectResults.filter(Boolean);
  if (successfulArchitects.length !== 3) {
    writeGateCheckpoint(
      "gate:mvp-definition",
      "MVP definition gate",
      "blocked",
      `Only ${successfulArchitects.length} of 3 required architecture perspectives completed.`,
      "architecture-cohort-incomplete",
    );
    phase("Deliver");
    return {
      contractVersion: "workflow-router.pipeline-result.v2",
      status: "blocked",
      plan: null,
      budget: budget(),
      execution: null,
      lifecycle: {
        stage: lifecycleStage,
        gateState: "architecture-cohort-incomplete",
        contractRef: null,
        nextGate: {
          owner: "workflow",
          decision: "rerun-complete-architecture-cohort",
          requiredEvidenceRefs: [],
        },
      },
      limitations: ["A shakedown contract is not synthesized from an incomplete architecture cohort."],
    };
  }

  const contractDraft = await agent(
    `Role: lead shakedown-contract architect
Objective: ${args.objective}
User context: ${args.context || "None supplied."}
Independent architecture perspectives: ${JSON.stringify(successfulArchitects)}

Synthesize a single draft contract for human review. Reconcile disagreements explicitly in the contract boundaries. The target cohort must use eligibility and exposure constraints without customer identities. Critical invariants must cover all irreversible or nondeferrable risks. The contract is a proposal only: never state or imply that the human approved it.`,
    {
      label: "Synthesize shakedown contract",
      phase: "Define MVP",
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
      schema: shakedownContractSchema,
    },
  );

  checkpoint({
    kind: "plan",
    id: "selected-plan",
    title: "Draft shakedown-ready MVP contract",
    status: "blocked",
    summary: "Three architecture perspectives were synthesized; explicit human approval is required before build admission.",
    detail: JSON.stringify({ lifecycleStage, contractDraft }, null, 2),
    items: successfulArchitects.map((proposal, index) => ({
      id: `architecture-perspective-${index + 1}`,
      title: proposal.perspective,
      objective: proposal.recommendations.join("\n"),
      detail: JSON.stringify({
        risks: proposal.risks,
        openQuestions: proposal.openQuestions,
        contractSuggestions: proposal.contractSuggestions,
      }, null, 2),
      ticketRef: null,
    })),
  });
  writeGateCheckpoint(
    "gate:mvp-definition",
    "MVP definition gate",
    "blocked",
    "Review, revise if needed, and explicitly approve this contract in a later run.",
    "awaiting-human-mvp-approval",
  );
  phase("Deliver");
  return {
    contractVersion: "workflow-router.pipeline-result.v2",
    status: "awaiting-human-mvp-approval",
    plan: { contractDraft, architecturePerspectives: successfulArchitects },
    budget: budget(),
    execution: null,
    lifecycle: {
      stage: lifecycleStage,
      gateState: "awaiting-human-mvp-approval",
      contractRef: lifecycleContractRef(contractDraft),
      nextGate: {
        owner: "human",
        decision: "approve-or-revise-mvp-contract",
        requiredEvidenceRefs: [],
      },
    },
    limitations: ["Architecture agents can draft and challenge the MVP contract but cannot approve it."],
  };
}

phase("Plan");
const approvedRouterContract = approvedContractForRouter(
  args.mvpContract,
  args.mvpApproval,
);
const routerDecisionEvidence = humanDecisionEvidenceForRouter();
const stagedResultVersion =
  lifecycleStage === null
    ? "workflow-router.pipeline-result.v1"
    : "workflow-router.pipeline-result.v2";
const contractRef = lifecycleContractRef(args.mvpContract);

if (approvedRouterContract !== null) {
  const contractItemIds = approvedRouterContract.items.map((item) => item.id);
  const duplicateContractItemIds = contractItemIds.filter(
    (id, index) => contractItemIds.indexOf(id) !== index,
  );
  if (duplicateContractItemIds.length > 0) {
    writeGateCheckpoint(
      "gate:mvp-definition",
      "MVP definition gate",
      "blocked",
      `The approved contract has duplicate item IDs: ${[...new Set(duplicateContractItemIds)].join(", ")}.`,
      "duplicate-contract-item-ids",
    );
    phase("Deliver");
    return {
      contractVersion: stagedResultVersion,
      status: "blocked",
      plan: null,
      budget: budget(),
      execution: null,
      lifecycle: {
        stage: lifecycleStage,
        gateState: "duplicate-contract-item-ids",
        contractRef,
      },
      limitations: ["No planner or worker calls were admitted from an ambiguous contract."],
    };
  }
}

if (
  lifecycleStage !== null &&
  lifecycleStage !== "mvp-definition" &&
  approvedRouterContract === null
) {
  writeGateCheckpoint(
    "gate:mvp-definition",
    "MVP definition gate",
    "blocked",
    "A matching human approval for the current shakedown contract is required.",
    "awaiting-human-mvp-approval",
  );
  phase("Deliver");
  return {
    contractVersion: stagedResultVersion,
    status: "awaiting-human-mvp-approval",
    plan: null,
    budget: budget(),
    execution: null,
    lifecycle: {
      stage: lifecycleStage,
      gateState: "awaiting-human-mvp-approval",
      contractRef,
      nextGate: {
        owner: "human",
        decision: "approve-current-mvp-contract-revision",
        requiredEvidenceRefs: [],
      },
    },
    limitations: ["No planning or worker calls were admitted without matching human approval."],
  };
}

if (
  lifecycleStage === "customer-shakedown" &&
  !decisionMatches(args.shakedownLaunchApproval, args.mvpContract, "approved")
) {
  writeGateCheckpoint(
    "gate:shakedown-ready",
    "Shakedown-ready gate",
    "blocked",
    "A matching human shakedown-launch approval is required before customer trial work.",
    "awaiting-human-shakedown-launch",
  );
  phase("Deliver");
  return {
    contractVersion: stagedResultVersion,
    status: "awaiting-human-shakedown-launch",
    plan: null,
    budget: budget(),
    execution: null,
    lifecycle: {
      stage: lifecycleStage,
      gateState: "awaiting-human-shakedown-launch",
      contractRef,
      nextGate: {
        owner: "human",
        decision: "approve-or-reject-reduced-risk-customer-shakedown",
        requiredEvidenceRefs: [],
      },
    },
    limitations: ["Agents cannot authorize customer exposure."],
  };
}

if (lifecycleStage === "design-stability") {
  if (
    !decisionMatches(args.shakedownLaunchApproval, args.mvpContract, "approved") ||
    !Array.isArray(args.shakedownEvidenceRefs) ||
    args.shakedownEvidenceRefs.length === 0
  ) {
    writeGateCheckpoint(
      "gate:design-stability",
      "Design-stability gate",
      "blocked",
      "Shakedown launch approval and at least one shakedown evidence reference are required.",
      "shakedown-evidence-required",
    );
    phase("Deliver");
    return {
      contractVersion: stagedResultVersion,
      status: "blocked",
      plan: null,
      budget: budget(),
      execution: null,
      lifecycle: {
        stage: lifecycleStage,
        gateState: "shakedown-evidence-required",
        contractRef,
        nextGate: {
          owner: "human",
          decision: "supply-shakedown-evidence",
          requiredEvidenceRefs: [],
        },
      },
      limitations: ["The design-stability assessor does not infer customer evidence."],
    };
  }
  phase("Stability");
  const humanDecision = args.designStabilityDecision || null;
  const assessment =
    humanDecision === null
      ? await agent(
          `Role: design-stability assessor
Approved shakedown contract: ${JSON.stringify(args.mvpContract)}
Shakedown evidence refs: ${JSON.stringify(args.shakedownEvidenceRefs)}
Sanitized customer feedback: ${args.customerFeedback || "None supplied."}

Assess whether the evidence suggests incremental hardening or a material change to core jobs, workflows, data model, safety boundaries, or architecture. Identify evidence gaps and residual risks. Recommend stable, material-change, or insufficient-evidence, but do not make or impersonate the human decision.`,
          {
            label: "Assess shakedown design stability",
            phase: "Stability",
            provider: "codex",
            model: "gpt-5.6-sol",
            reasoningLevel: "high",
            schema: stabilityAssessmentSchema,
          },
        )
      : null;
  const matchingStable = decisionMatches(
    humanDecision,
    args.mvpContract,
    "stable",
  );
  const matchingMaterial = decisionMatches(
    humanDecision,
    args.mvpContract,
    "material-change",
  );
  const gateState = matchingStable
    ? "ready-for-psa"
    : matchingMaterial
      ? "redesign-required"
      : "awaiting-human-design-stability-decision";
  writeGateCheckpoint(
    "gate:design-stability",
    "Design-stability gate",
    matchingStable ? "succeeded" : "blocked",
    matchingStable
      ? "The human marked this contract revision stable enough for PSA."
      : matchingMaterial
        ? "The human identified material design-changing feedback; PSA remains locked."
        : "Review the advisory assessment and make the design-stability decision.",
    matchingStable ? null : gateState,
  );
  phase("Deliver");
  return {
    contractVersion: stagedResultVersion,
    status: gateState,
    plan: assessment === null ? null : { assessment },
    budget: budget(),
    execution: null,
    lifecycle: {
      stage: lifecycleStage,
      gateState,
      contractRef,
      humanDecisionRef: humanDecision === null ? null : humanDecision.decisionRef,
      humanDecisionEvidenceRef:
        humanDecision === null ? null : humanDecision.evidenceRef,
      nextGate: matchingStable
        ? {
            owner: "workflow",
            decision: "run-post-shakedown-availability-audit",
            requiredEvidenceRefs: args.shakedownEvidenceRefs,
          }
        : matchingMaterial
          ? {
              owner: "human",
              decision: "revise-mvp-contract-and-build",
              requiredEvidenceRefs: args.shakedownEvidenceRefs,
            }
          : {
              owner: "human",
              decision: "stable-or-material-change",
              requiredEvidenceRefs: args.shakedownEvidenceRefs,
            },
    },
    limitations: ["The assessor is advisory; only the supplied human decision controls PSA admission."],
  };
}

if (lifecycleStage === "post-shakedown-availability") {
  if (!decisionMatches(args.designStabilityDecision, args.mvpContract, "stable")) {
    const materialChange = decisionMatches(
      args.designStabilityDecision,
      args.mvpContract,
      "material-change",
    );
    writeGateCheckpoint(
      "gate:design-stability",
      "Design-stability gate",
      "blocked",
      materialChange
        ? "Material design-changing feedback requires a revised MVP contract before PSA."
        : "A matching human design-stability decision is required before PSA.",
      materialChange ? "redesign-required" : "awaiting-human-design-stability-decision",
    );
    phase("Deliver");
    return {
      contractVersion: stagedResultVersion,
      status: materialChange
        ? "redesign-required"
        : "awaiting-human-design-stability-decision",
      plan: null,
      budget: budget(),
      execution: null,
      lifecycle: {
        stage: lifecycleStage,
        gateState: materialChange
          ? "redesign-required"
          : "awaiting-human-design-stability-decision",
        contractRef,
        nextGate: {
          owner: "human",
          decision: materialChange
            ? "revise-mvp-contract-and-build"
            : "stable-or-material-change",
          requiredEvidenceRefs: args.shakedownEvidenceRefs || [],
        },
      },
      limitations: ["PSA launched zero workers because the human stability gate did not pass."],
    };
  }
  if (!args.psaMode) {
    phase("Deliver");
    return {
      contractVersion: stagedResultVersion,
      status: "blocked",
      plan: null,
      budget: budget(),
      execution: null,
      lifecycle: {
        stage: lifecycleStage,
        gateState: "psa-mode-required",
        contractRef,
        nextGate: {
          owner: "human",
          decision: "choose-audit-remediate-or-re-audit",
          requiredEvidenceRefs: args.shakedownEvidenceRefs || [],
        },
      },
      limitations: ["PSA mode is explicit so audits and mutations cannot be conflated."],
    };
  }
  if (args.psaMode === "availability-decision") {
    const approved = decisionMatches(
      args.availabilityApproval,
      args.mvpContract,
      "approved",
    );
    const notReady = decisionMatches(
      args.availabilityApproval,
      args.mvpContract,
      "not-ready",
    );
    const gateState = approved
      ? "availability-approved"
      : notReady
        ? "availability-not-ready"
        : "awaiting-human-availability-decision";
    writeGateCheckpoint(
      "gate:post-shakedown-availability",
      "Post-shakedown availability gate",
      approved ? "succeeded" : "blocked",
      approved
        ? "The caller supplied a human availability approval bound to prior re-audit evidence."
        : notReady
          ? "The caller supplied a human not-ready decision; availability remains locked."
          : "A revision-matched human decision bound to prior re-audit evidence is required.",
      approved ? null : gateState,
    );
    phase("Deliver");
    return {
      contractVersion: stagedResultVersion,
      status: gateState,
      plan: null,
      budget: budget(),
      execution: null,
      lifecycle: {
        stage: lifecycleStage,
        psaMode: args.psaMode,
        gateState,
        contractRef,
        humanDecisionRef: args.availabilityApproval?.decisionRef || null,
        humanDecisionEvidenceRef:
          args.availabilityApproval?.evidenceRef || null,
        nextGate: approved
          ? { owner: "workflow", decision: "none", requiredEvidenceRefs: [] }
          : {
              owner: "human",
              decision: "approve-or-reject-post-shakedown-availability",
              requiredEvidenceRefs: [],
            },
      },
      limitations: [
        "The workflow validates the evidence reference shape and contract revision; the authenticated caller must verify provenance and prevent replay.",
      ],
    };
  }
  if (args.availabilityApproval) {
    phase("Deliver");
    return {
      contractVersion: stagedResultVersion,
      status: "blocked",
      plan: null,
      budget: budget(),
      execution: null,
      lifecycle: {
        stage: lifecycleStage,
        psaMode: args.psaMode,
        gateState: "availability-decision-must-be-separate",
        contractRef,
      },
      limitations: [
        "Availability approval must be supplied in a later availability-decision run so it can reference the completed re-audit result.",
      ],
    };
  }
  if (
    args.psaMode === "remediate" &&
    (!Array.isArray(args.findingRefs) || args.findingRefs.length === 0)
  ) {
    phase("Deliver");
    return {
      contractVersion: stagedResultVersion,
      status: "blocked",
      plan: null,
      budget: budget(),
      execution: null,
      lifecycle: {
        stage: lifecycleStage,
        gateState: "finding-ledger-required",
        contractRef,
        nextGate: {
          owner: "human",
          decision: "supply-human-reviewed-finding-refs",
          requiredEvidenceRefs: args.shakedownEvidenceRefs || [],
        },
      },
      limitations: ["Remediation cannot invent its own finding scope."],
    };
  }
}

const routerInput = {
  objective: args.objective,
  context: args.context || "",
  groundingMode: "route-only",
  planningMode: "execution-plan",
  maxSections:
    args.maxSections ||
    (lifecycleStage === "post-shakedown-availability" &&
    (args.psaMode === "audit" || args.psaMode === "re-audit")
      ? 8
      : 6),
};
if (lifecycleStage !== null) {
  routerInput.lifecycleStage = lifecycleStage;
  routerInput.approvedShakedownContract = approvedRouterContract;
  routerInput.humanDecisionEvidence = routerDecisionEvidence;
  routerInput.evidenceRefs = args.shakedownEvidenceRefs || [];
  routerInput.findingRefs = args.findingRefs || [];
  if (args.psaMode) routerInput.psaMode = args.psaMode;
}
const plan = await workflow("workflow-router", routerInput);

const planErrors = validatePlan(plan, {
  objective: args.objective,
  maxSections: routerInput.maxSections,
  lifecycleStage,
  psaMode: args.psaMode || null,
  approvedContractVersion: approvedRouterContract?.contractVersion || null,
  evidenceRefs: args.shakedownEvidenceRefs || [],
  findingRefs: args.findingRefs || [],
});
if (planErrors.length > 0) {
  phase("Deliver");
  return {
    contractVersion: stagedResultVersion,
    status: "blocked",
    plan,
    budget: budget(),
    execution: null,
    lifecycle:
      lifecycleStage === null
        ? undefined
        : {
            stage: lifecycleStage,
            gateState: "invalid-plan",
            contractRef,
            psaMode: args.psaMode || null,
          },
    limitations: [
      `Execution was blocked because the nested plan failed contract validation: ${planErrors.join("; ")}.`,
      "No worker calls were admitted from the invalid plan.",
      "Workers inherit the origin filesystem permission mode; use a restricted environment when capability isolation is required.",
    ],
  };
}

checkpoint({
  kind: "plan",
  id: "selected-plan",
  title: `Selected ${plan.route.lane} plan`,
  status: plan.truncation === null ? "succeeded" : "blocked",
  summary: `${plan.sections.length} bounded ${plan.sections.length === 1 ? "section" : "sections"}; ${plan.totals.requestedAgentCalls} requested worker calls.`,
  detail: JSON.stringify({
    contractVersion: plan.contractVersion,
    objective: plan.objective,
    route: plan.route,
    policyVersion: plan.policyVersion,
    lifecycleStage,
    psaMode: args.psaMode || null,
    contractRef,
    humanDecisionRefs: routerDecisionEvidence.map((decision) => decision.evidenceRefs).flat(),
    truncation: plan.truncation,
    totals: plan.totals,
    warnings: plan.warnings,
    validation: plan.validation || null,
  }, null, 2),
  items: plan.sections.map((section) => ({
    id: section.id,
    title: section.title,
    objective: section.objective,
    detail: JSON.stringify({
      coverage: section.coverage,
      riskTriggers: section.riskTriggers,
      riskReason: section.riskReason,
      requiredSkills: section.requiredSkills,
      workerRoles: section.workerRoles,
      agentCalls: section.agentCalls,
      findingsOnly: section.findingsOnly,
      humanGate: section.humanGate,
      assuranceClass: section.assuranceClass || null,
      psaComponent: section.psaComponent || "none",
      dueStage: section.dueStage || null,
      dependsOn: section.dependsOn || [],
      mutationIntent: section.mutationIntent || null,
      contractItemRefs: section.contractItemRefs || [],
      verificationRequired: section.verificationRequired === true,
      exitCriterion: section.exitCriterion || null,
    }, null, 2),
    ticketRef: null,
  })),
});

if ((args.executionMode || "plan-only") === "plan-only") {
  phase("Deliver");
  return {
    contractVersion: stagedResultVersion,
    status: "planned",
    plan,
    budget: budget(),
    execution: null,
    lifecycle:
      lifecycleStage === null
        ? undefined
        : {
            stage: lifecycleStage,
            gateState: "planned",
            contractRef,
            psaMode: args.psaMode || null,
            nextGate: {
              owner: "workflow",
              decision: "execute-approved-plan",
              requiredEvidenceRefs: args.shakedownEvidenceRefs || [],
            },
          },
    limitations: [
      "The workflow names routed skills in worker prompts; skill compliance remains provider-executed rather than capability-isolated.",
      "Taste-heavy and authorized security-testing profiles route to Fable; bounded implementation owners route to Luna; judgment roles and unclassified work route to Sol.",
      "Security-testing authorization and read-only behavior are instruction-guided; use a restricted environment when capability isolation is required.",
      "Workers inherit the origin filesystem permission mode; read-only behavior is instruction-guided rather than capability-isolated.",
      "Mutating owner sections require allowMutations: true and are serialized in the shared workspace.",
    ],
  };
}

if (plan.truncation !== null) {
  phase("Deliver");
  return {
    contractVersion: stagedResultVersion,
    status: "blocked",
    plan,
    budget: budget(),
    execution: null,
    lifecycle:
      lifecycleStage === null
        ? undefined
        : {
            stage: lifecycleStage,
            gateState: "plan-truncated",
            contractRef,
            psaMode: args.psaMode || null,
          },
    limitations: [
      "Execution was blocked because the planner returned more sections than the requested maximum; omitted sections may contain mandatory risk coverage.",
      "The workflow names routed skills in worker prompts; skill compliance remains provider-executed rather than capability-isolated.",
      "Workers inherit the origin filesystem permission mode; read-only behavior is instruction-guided rather than capability-isolated.",
    ],
  };
}

for (const section of plan.sections) {
  checkpoint({
    kind: "work-item",
    id: section.id,
    title: section.title,
    status: "pending",
    summary: `Awaiting admission (${section.coverage} coverage; ${section.agentCalls} worker calls requested).`,
    ticketRef: null,
    changedFiles: [],
    blocker: null,
  });
}

phase("Admit");
const beforeExecution = budget();
const runtimeWorkerCapacity = Math.max(0, beforeExecution.maxAgentCalls - beforeExecution.agentCalls);
const workerCallLimit = Math.min(args.maxWorkerCalls || runtimeWorkerCapacity, runtimeWorkerCapacity);
function sectionIsDueInCurrentStage(section) {
  if (lifecycleStage === null) return true;
  if (section.assuranceClass === "nondeferrable-safety") return true;
  if (lifecycleStage === "shakedown-build") {
    return ["mvp-functionality", "low-regret-psa-prep"].includes(section.assuranceClass);
  }
  if (lifecycleStage === "customer-shakedown") {
    return section.assuranceClass === "shakedown-learning";
  }
  if (lifecycleStage === "post-shakedown-availability") {
    return section.assuranceClass === "post-shakedown-assurance";
  }
  return section.dueStage === lifecycleStage;
}

const dueSections = plan.sections.filter(sectionIsDueInCurrentStage);
const deferredSections = plan.sections
  .filter((section) => !sectionIsDueInCurrentStage(section))
  .map((section) => ({
    sectionId: section.id,
    title: section.title,
    coverage: section.coverage,
    assuranceClass: section.assuranceClass,
    dueStage: section.dueStage,
    requestedAgentCalls: section.agentCalls,
    reason:
      section.dueStage === "post-shakedown-availability"
        ? "not-due-until-design-stability"
        : "not-due-in-current-stage",
  }));
for (const section of deferredSections) {
  checkpoint({
    kind: "work-item",
    id: section.sectionId,
    title: section.title,
    status: "skipped",
    summary: `Deferred: ${section.reason}; due during ${section.dueStage}.`,
    ticketRef: null,
    changedFiles: [],
    blocker: null,
  });
}

const prioritizedSections = dueSections
  .map((section, index) => ({ section, index }))
  .sort((left, right) => {
    const mandatory = (section) =>
      section.assuranceClass === "nondeferrable-safety" ||
      (lifecycleStage === "post-shakedown-availability" &&
        (args.psaMode === "audit" || args.psaMode === "re-audit"));
    return (
      Number(mandatory(right.section)) - Number(mandatory(left.section)) ||
      coveragePriority(right.section.coverage) - coveragePriority(left.section.coverage) ||
      left.index - right.index
    );
  });
const admittedIds = [];
const admittedIdSet = new Set();
const skippedSections = [];
const dueSectionById = new Map(dueSections.map((section) => [section.id, section]));
let remainingWorkerCalls = workerCallLimit;
for (const entry of prioritizedSections) {
  const section = entry.section;
  if (admittedIdSet.has(section.id)) continue;
  const closure = [];
  const closureIds = new Set();
  let dependencyAvailable = true;
  const collectClosure = (candidate) => {
    if (admittedIdSet.has(candidate.id) || closureIds.has(candidate.id)) return;
    for (const dependencyId of candidate.dependsOn || []) {
      const dependency = dueSectionById.get(dependencyId);
      if (!dependency) {
        dependencyAvailable = false;
        return;
      }
      collectClosure(dependency);
      if (!dependencyAvailable) return;
    }
    closureIds.add(candidate.id);
    closure.push(candidate);
  };
  collectClosure(section);
  const closureCalls = closure.reduce((sum, candidate) => sum + candidate.agentCalls, 0);
  if (dependencyAvailable && closureCalls <= remainingWorkerCalls) {
    for (const candidate of closure) {
      admittedIds.push(candidate.id);
      admittedIdSet.add(candidate.id);
      remainingWorkerCalls -= candidate.agentCalls;
    }
  } else {
    skippedSections.push({
      sectionId: section.id,
      title: section.title,
      coverage: section.coverage,
      requestedAgentCalls: section.agentCalls,
      reason: dependencyAvailable ? "agent-call-budget" : "dependency-not-admitted",
    });
    log(
      dependencyAvailable
        ? `Skipped ${section.id} (${section.coverage}): dependency closure needs ${closureCalls} worker calls, ${remainingWorkerCalls} remain.`
        : `Skipped ${section.id} (${section.coverage}): a dependency is not due in the current stage.`,
    );
  }
}
let admittedSections = dueSections.filter((section) => admittedIds.includes(section.id));

for (const section of skippedSections) {
  checkpoint({
    kind: "work-item",
    id: section.sectionId,
    title: section.title,
    status: "skipped",
    summary: `Skipped during admission: ${section.reason}.`,
    ticketRef: null,
    changedFiles: [],
    blocker: section.reason,
  });
}
for (const section of admittedSections) {
  checkpoint({
    kind: "work-item",
    id: section.id,
    title: section.title,
    status: "pending",
    summary: `Admitted with ${section.coverage} coverage and ${section.agentCalls} worker calls.`,
    ticketRef: null,
    changedFiles: [],
    blocker: null,
  });
}

if (
  dueSections.some(sectionMayMutate) &&
  dueSections.some((section) => section.coverage === "red-team")
) {
  const gatedSections = admittedSections.filter((section) => section.coverage !== "red-team");
  for (const section of gatedSections) {
    skippedSections.push({
      sectionId: section.id,
      title: section.title,
      coverage: section.coverage,
      requestedAgentCalls: section.agentCalls,
      reason: "red-team-human-gate",
    });
    checkpoint({
      kind: "work-item",
      id: section.id,
      title: section.title,
      status: "skipped",
      summary: "Skipped during admission: red-team-human-gate.",
      ticketRef: null,
      changedFiles: [],
      blocker: "red-team-human-gate",
    });
    log(`Skipped ${section.id} (${section.coverage}): a planned red-team section requires human review before mutations continue.`);
  }
  admittedSections = admittedSections.filter((section) => section.coverage === "red-team");
}

function beginTrackedSection(section) {
  checkpoint({
    kind: "work-item",
    id: section.id,
    title: section.title,
    status: "running",
    summary: `Executing ${section.coverage} coverage with ${section.workerRoles.join(", ")}.`,
    ticketRef: null,
    changedFiles: [],
    blocker: null,
  });
}

function finishTrackedSection(section, result) {
  const ownerWorker =
    result === null
      ? null
      : result.workers.find((worker) => worker.role === "owner") || null;
  const status =
    result === null
      ? "failed"
      : result.status === "completed"
        ? "succeeded"
        : result.status === "failed"
          ? "failed"
          : "blocked";
  checkpoint({
    kind: "work-item",
    id: section.id,
    title: section.title,
    status,
    summary:
      result === null
        ? "Section execution failed before a structured result was returned."
        : `Section finished with ${result.status} coverage status.`,
    ticketRef: null,
    changedFiles: ownerWorker === null ? [] : ownerWorker.result.changedFiles,
    blocker:
      status === "blocked"
        ? "Review findings, missing workers, or a required human gate prevented completion."
        : status === "failed"
          ? "Section execution failed."
          : null,
  });
}

async function executeTrackedSection(section) {
  beginTrackedSection(section);
  let result = null;
  try {
    result =
      section.coverage === "red-team"
        ? await executeRedTeamSection(section)
        : await executeNormalSection(section);
    return result;
  } finally {
    finishTrackedSection(section, result);
  }
}

phase("Execute");
const executionResultsById = new Map();
const remainingExecutionIds = new Set(admittedSections.map((section) => section.id));
while (remainingExecutionIds.size > 0) {
  const readySections = admittedSections.filter(
    (section) =>
      remainingExecutionIds.has(section.id) &&
      (section.dependsOn || []).every(
        (dependencyId) => !remainingExecutionIds.has(dependencyId),
      ),
  );
  if (readySections.length === 0) {
    for (const section of admittedSections.filter((candidate) => remainingExecutionIds.has(candidate.id))) {
      const result = {
        sectionId: section.id,
        coverage: section.coverage,
        status: "blocked",
        workers: [],
        missingWorkers: [...section.workerRoles],
        humanGate: false,
        dependencyBlocked: true,
      };
      beginTrackedSection(section);
      finishTrackedSection(section, result);
      executionResultsById.set(section.id, result);
      remainingExecutionIds.delete(section.id);
    }
    break;
  }

  const executableSections = [];
  for (const section of readySections) {
    const failedDependencies = (section.dependsOn || []).filter(
      (dependencyId) => executionResultsById.get(dependencyId)?.status !== "completed",
    );
    if (failedDependencies.length === 0) {
      executableSections.push(section);
      continue;
    }
    const result = {
      sectionId: section.id,
      coverage: section.coverage,
      status: "blocked",
      workers: [],
      missingWorkers: [],
      humanGate: false,
      dependencyBlocked: true,
      failedDependencies,
    };
    beginTrackedSection(section);
    finishTrackedSection(section, result);
    executionResultsById.set(section.id, result);
    remainingExecutionIds.delete(section.id);
  }

  const ownerStates = new Map();
  for (const section of executableSections.filter(sectionMayMutate)) {
    beginTrackedSection(section);
    let owner = null;
    try {
      owner = await executeNormalOwner(section);
    } catch {}
    ownerStates.set(section.id, owner);
  }
  const waveResults =
    executableSections.length === 0
      ? []
      : await parallel(executableSections.map((section) => async () => {
      if (!sectionMayMutate(section)) return executeTrackedSection(section);
      const owner = ownerStates.get(section.id) || null;
      let result = null;
      try {
        if (owner === null) return null;
        result = await reviewNormalSection(section, owner);
        return result;
      } finally {
        finishTrackedSection(section, result);
      }
        }));
  for (let index = 0; index < executableSections.length; index += 1) {
    executionResultsById.set(executableSections[index].id, waveResults[index]);
    remainingExecutionIds.delete(executableSections[index].id);
  }
}
const rawResults = admittedSections.map((section) => executionResultsById.get(section.id));
const sectionResults = rawResults.map((result, index) =>
  result || {
    sectionId: admittedSections[index].id,
    coverage: admittedSections[index].coverage,
    status: "failed",
    workers: [],
    missingWorkers: [...admittedSections[index].workerRoles],
    humanGate: admittedSections[index].humanGate,
  },
);

const hasBlocked = sectionResults.some(
  (result) => result.status === "failed" || result.status === "blocked",
);
const hasPartial = sectionResults.some((result) => result.status === "partial");
const hasHumanGate = sectionResults.some((result) =>
  lifecycleStage === null
    ? result.humanGate
    : result.blockingHumanGate === true,
);
const skippedRedTeam = skippedSections.some((section) => section.coverage === "red-team");
const skippedMandatoryCoverage = skippedSections.some((skipped) => {
  const section = plan.sections.find((candidate) => candidate.id === skipped.sectionId);
  return (
    section?.assuranceClass === "nondeferrable-safety" ||
    (lifecycleStage === "post-shakedown-availability" &&
      (args.psaMode === "audit" || args.psaMode === "re-audit"))
  );
});
const completedSectionIds = new Set(
  sectionResults
    .filter((result) => result.status === "completed")
    .map((result) => result.sectionId),
);
const completedContractItemRefs = new Set(
  admittedSections
    .filter((section) => completedSectionIds.has(section.id))
    .flatMap((section) => section.contractItemRefs || []),
);
const missingNondeferrableContractItemRefs =
  lifecycleStage === "shakedown-build"
    ? (approvedRouterContract?.items || [])
        .filter((item) => item.nondeferrable === true)
        .map((item) => item.id)
        .filter((id) => !completedContractItemRefs.has(id))
    : [];
const requiredPsaComponents =
  lifecycleStage === "post-shakedown-availability" &&
  (args.psaMode === "audit" || args.psaMode === "re-audit")
    ? knownPsaComponents.filter((component) => component !== "none")
    : [];
const completedPsaComponents = new Set(
  admittedSections
    .filter((section) => completedSectionIds.has(section.id))
    .map((section) => section.psaComponent)
    .filter((component) => component && component !== "none"),
);
const missingPsaComponents = requiredPsaComponents.filter(
  (component) => !completedPsaComponents.has(component),
);
const executionStatus =
  sectionResults.length === 0 ||
  skippedRedTeam ||
  skippedMandatoryCoverage ||
  missingNondeferrableContractItemRefs.length > 0 ||
  missingPsaComponents.length > 0 ||
  hasBlocked ||
  hasHumanGate
    ? "blocked"
    : hasPartial || skippedSections.length > 0
      ? "partial"
      : "completed";

function lifecycleStatusForExecution() {
  if (lifecycleStage === null) return executionStatus;
  if (executionStatus !== "completed") return "blocked";
  if (lifecycleStage === "shakedown-build") {
    return "awaiting-human-shakedown-launch";
  }
  if (lifecycleStage === "customer-shakedown") {
    return "awaiting-human-design-stability-decision";
  }
  if (lifecycleStage === "post-shakedown-availability") {
    if (args.psaMode === "audit") return "awaiting-human-psa-review";
    if (args.psaMode === "remediate") return "awaiting-psa-re-audit";
    return "awaiting-human-availability-decision";
  }
  return executionStatus;
}
const finalStatus = lifecycleStatusForExecution();

function lifecycleResult() {
  if (lifecycleStage === null) return undefined;
  const nextGateByStatus = {
    "awaiting-human-shakedown-launch": "approve-or-reject-reduced-risk-customer-shakedown",
    "awaiting-human-design-stability-decision": "review-shakedown-evidence-then-run-design-stability-stage",
    "awaiting-human-psa-review": "review-psa-findings-and-select-remediation-scope",
    "awaiting-psa-re-audit": "run-psa-re-audit",
    "awaiting-human-availability-decision": "approve-or-reject-post-shakedown-availability",
    "availability-approved": "none",
    blocked: "resolve-blocked-or-missing-required-coverage",
  };
  return {
    stage: lifecycleStage,
    gateState: finalStatus,
    contractRef,
    psaMode: args.psaMode || null,
    humanDecisionRef:
      finalStatus === "availability-approved"
        ? args.availabilityApproval.decisionRef
        : null,
    deferredSectionIds: deferredSections.map((section) => section.sectionId),
    missingNondeferrableContractItemRefs,
    missingPsaComponents,
    nextGate: {
      owner:
        finalStatus === "awaiting-psa-re-audit" || finalStatus === "availability-approved"
          ? "workflow"
          : "human",
      decision: nextGateByStatus[finalStatus] || "review-execution-result",
      requiredEvidenceRefs: args.shakedownEvidenceRefs || [],
    },
  };
}

phase("Deliver");
return {
  contractVersion: stagedResultVersion,
  status: finalStatus,
  plan,
  budget: {
    beforeExecution,
    workerCallLimit,
    admittedAgentCalls: admittedSections.reduce((sum, section) => sum + section.agentCalls, 0),
    skippedAgentCalls: skippedSections.reduce((sum, section) => sum + section.requestedAgentCalls, 0),
    afterExecution: budget(),
  },
  execution: {
    sections: sectionResults,
    skippedSections,
    deferredSections,
    humanGateSectionIds: sectionResults
      .filter((result) => result.humanGate)
      .map((result) => result.sectionId),
    blockedHumanGateSectionIds: skippedSections
      .filter((section) => section.coverage === "red-team")
      .map((section) => section.sectionId),
  },
  lifecycle: lifecycleResult(),
  limitations: [
    "The workflow names routed skills in worker prompts; skill compliance remains provider-executed rather than capability-isolated.",
    "Taste-heavy and authorized security-testing profiles route to Fable; bounded implementation owners route to Luna; judgment roles and unclassified work route to Sol.",
    "Security-testing authorization and read-only behavior are instruction-guided; use a restricted environment when capability isolation is required.",
    "Workers inherit the origin filesystem permission mode; read-only behavior is instruction-guided rather than capability-isolated.",
    "Mutating owner sections require allowMutations: true and are serialized in the shared workspace.",
  ],
};
