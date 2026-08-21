export const meta = {
  name: "workflow-router",
  description: "Produce a typed workflow route and, when explicitly requested, a bounded execution plan",
  inputSchema: {
    type: "object",
    required: ["objective"],
    additionalProperties: false,
    properties: {
      objective: { type: "string", minLength: 1, maxLength: 2048 },
      context: { type: "string", maxLength: 8192 },
      groundingMode: { enum: ["route-only", "when-required"] },
      planningMode: { enum: ["route-only", "execution-plan"] },
      maxSections: { type: "integer", minimum: 1, maximum: 8 },
      lifecycleStage: {
        enum: [
          "mvp-definition",
          "shakedown-build",
          "customer-shakedown",
          "design-stability",
          "post-shakedown-availability",
        ],
      },
      psaMode: { enum: ["audit", "remediate", "re-audit"] },
      approvedShakedownContract: {
        type: "object",
        additionalProperties: false,
        required: ["contractVersion", "approved", "approvalDecisionRef", "approvalEvidenceRefs", "items"],
        properties: {
          contractVersion: { type: "string", minLength: 1, maxLength: 128 },
          approved: { const: true },
          approvalDecisionRef: { type: "string", minLength: 1, maxLength: 256 },
          approvalEvidenceRefs: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: { type: "string", minLength: 1, maxLength: 2048 },
          },
          items: {
            type: "array",
            minItems: 1,
            maxItems: 64,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "kind", "statement", "nondeferrable"],
              properties: {
                id: { type: "string", minLength: 1, maxLength: 128 },
                kind: {
                  enum: [
                    "target-cohort",
                    "in-scope",
                    "out-of-scope",
                    "core-job",
                    "critical-invariant",
                    "temporary-limitation",
                    "telemetry",
                    "rollback",
                    "support",
                    "design-invalidating-feedback",
                  ],
                },
                statement: { type: "string", minLength: 1, maxLength: 4096 },
                nondeferrable: { type: "boolean" },
              },
            },
          },
        },
      },
      humanDecisionEvidence: {
        type: "array",
        maxItems: 32,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["stage", "decision", "decisionRef", "contractVersion", "summary", "evidenceRefs"],
          properties: {
            stage: {
              enum: [
                "mvp-definition",
                "shakedown-build",
                "customer-shakedown",
                "design-stability",
                "post-shakedown-availability",
              ],
            },
            decision: { enum: ["approve", "revise", "reject"] },
            decisionRef: { type: "string", minLength: 1, maxLength: 256 },
            contractVersion: { type: "string", minLength: 1, maxLength: 128 },
            summary: { type: "string", minLength: 1, maxLength: 4096 },
            evidenceRefs: {
              type: "array",
              minItems: 1,
              maxItems: 32,
              items: { type: "string", minLength: 1, maxLength: 2048 },
            },
          },
        },
      },
      evidenceRefs: {
        type: "array",
        maxItems: 64,
        items: { type: "string", minLength: 1, maxLength: 2048 },
      },
      findingRefs: {
        type: "array",
        maxItems: 64,
        items: { type: "string", minLength: 1, maxLength: 2048 },
      },
    },
  },
  phases: [
    { title: "Route", detail: "Classify the requested deliverable and evidence gates" },
    { title: "Ground", detail: "Resolve unsettled facts when investigation is required" },
    { title: "Plan", detail: "Decompose the route and assign bounded coverage profiles" },
    { title: "Deliver", detail: "Return the typed route or execution plan" },
  ],
};

const laneSkills = {
  "simple-answer": [],
  "spec-driven-development": ["spec-driven-development"],
  implementation: ["implementation-loop", "test-construction", "testing", "test-reviewer", "evidence-packager"],
  architecture: ["mission-charter", "architect-approaches", "architect-risks", "architect-decompose"],
  "qa-evidence": ["qa-evidence-runner"],
  "pr-stack": ["stacked-pr-steward", "pr-feedback-triage"],
  "production-triage": ["prod-app-triage", "debugging"],
  "llm-forensics": ["llm-performance-forensics", "eval-analysis", "eval-management"],
  "eval-execution": ["eval-management"],
  "design-packaging": ["design-review-packager", "polished-review-artifact-authoring"],
  "flow-editing": ["pace-cli", "flow-editing"],
};

const gateSkills = {
  "redesign-shipped-behavior": ["capability-inventory"],
  "pre-human-handoff": ["pre-handoff-critic", "code-standards", "code-review", "owasp-security", "test-reviewer", "simplify"],
  "investigative-grounding": ["grounded-investigation"],
  "active-design": ["collaborative-design-lab"],
  "security-boundary": ["owasp-security"],
  "contract-edge": ["contract-edge-testing"],
  "ui-product": ["expert-ux-designer", "qa-evidence-runner"],
  "reviewer-feedback": ["pr-feedback-triage"],
  "multi-agent": ["context-packet", "swarm-runner"],
  "pr-handoff": ["evidence-packager", "commit-push-pr", "stacked-pr-steward"],
  "long-running-initiative": ["mission-charter", "context-packet"],
  "grounding-gap": ["scout-manager", "scout"],
};

const routeSchema = {
  type: "object",
  required: ["lane", "why", "secondaryGates", "firstAction", "stopCondition", "confidence"],
  additionalProperties: false,
  properties: {
    lane: { enum: Object.keys(laneSkills) },
    why: { type: "string", minLength: 1, maxLength: 1024 },
    secondaryGates: { type: "array", maxItems: 12, items: { enum: Object.keys(gateSkills) } },
    firstAction: { type: "string", minLength: 1, maxLength: 1024 },
    stopCondition: { type: "string", minLength: 1, maxLength: 1024 },
    confidence: { enum: ["high", "medium", "low"] },
  },
};

const riskTriggers = [
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

const assuranceClasses = [
  "mvp-definition",
  "mvp-functionality",
  "nondeferrable-safety",
  "low-regret-psa-prep",
  "shakedown-learning",
  "design-stability",
  "post-shakedown-assurance",
];

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

const dueStageForAssuranceClass = {
  "mvp-definition": "mvp-definition",
  "mvp-functionality": "shakedown-build",
  "nondeferrable-safety": "shakedown-build",
  "low-regret-psa-prep": "shakedown-build",
  "shakedown-learning": "customer-shakedown",
  "design-stability": "design-stability",
  "post-shakedown-assurance": "post-shakedown-availability",
};

function modelProfileFor(routeDecision, coverage, matchedTriggers, requiredSkills) {
  const securityTesting =
    coverage === "red-team" &&
    (routeDecision.secondaryGates.includes("security-boundary") ||
      matchedTriggers.some((trigger) => securityTestingRiskTriggers.includes(trigger)) ||
      requiredSkills.includes("owasp-security"));
  if (securityTesting) return "fable-security";

  const tasteHeavy =
    routeDecision.lane === "design-packaging" ||
    routeDecision.secondaryGates.some((gate) => gate === "active-design" || gate === "ui-product") ||
    requiredSkills.some((skill) => tasteSkills.includes(skill));
  if (tasteHeavy) return "fable-taste";

  if (routeDecision.lane === "implementation" && coverage !== "red-team" && matchedTriggers.length === 0) {
    return "cost-efficient-implementation";
  }

  return "frontier-judgment";
}

function sectionPlanSchema(maxSections, staged) {
  const properties = {
    title: { type: "string", minLength: 1, maxLength: 192 },
    objective: { type: "string", minLength: 1, maxLength: 768 },
    coverage: { enum: ["light", "standard", "thorough", "red-team"] },
    riskTriggers: { type: "array", minItems: 1, items: { enum: riskTriggers } },
    riskReason: { type: "string", minLength: 1, maxLength: 512 },
    requiredSkills: { type: "array", maxItems: 12, items: { type: "string", maxLength: 64 } },
  };
  const required = ["title", "objective", "coverage", "riskTriggers", "riskReason", "requiredSkills"];

  if (staged) {
    properties.assuranceClass = { enum: assuranceClasses };
    properties.psaComponent = { enum: ["none", ...psaComponents] };
    properties.dependsOn = {
      type: "array",
      maxItems: maxSections - 1,
      items: { type: "string", minLength: 1, maxLength: 32 },
    };
    properties.mutationIntent = { enum: ["read-only", "mutate"] };
    properties.contractItemRefs = {
      type: "array",
      maxItems: 40,
      items: { type: "string", minLength: 1, maxLength: 64 },
    };
    properties.verificationRequired = { type: "boolean" };
    properties.exitCriterion = { type: "string", minLength: 1, maxLength: 512 };
    required.push(
      "assuranceClass",
      "psaComponent",
      "dependsOn",
      "mutationIntent",
      "contractItemRefs",
      "verificationRequired",
      "exitCriterion",
    );
  }

  return {
    type: "object",
    required: ["sections"],
    additionalProperties: false,
    properties: {
      sections: {
        type: "array",
        minItems: 1,
        maxItems: maxSections,
        items: {
          type: "object",
          required,
          additionalProperties: false,
          properties,
        },
      },
    },
  };
}

const coveragePolicy = {
  light: { workerRoles: ["owner"], agentCalls: 1, findingsOnly: false, humanGate: false },
  standard: { workerRoles: ["owner", "contract-critic"], agentCalls: 2, findingsOnly: false, humanGate: false },
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

const laneDefinitions = `
- simple-answer: bounded answer or direct lookup; no edits or material investigation
- spec-driven-development: unsettled product idea or bug needs the full spec-to-delivery lifecycle
- implementation: approach and acceptance criteria are settled; make and verify changes
- architecture: design decision, approach comparison, risk assessment, or decomposition is the deliverable
- qa-evidence: prove product behavior in a live, dev, or preview flow
- pr-stack: branches, stacked PRs, review state, conflicts, or merge order control the work
- production-triage: diagnose broken or confusing production behavior
- llm-forensics: investigate LLM, eval, or agent latency, cost, flakiness, or divergence
- eval-execution: run, inspect, tag, or report an already-defined eval suite without causal analysis or flow changes
- design-packaging: turn settled design material into a review-ready artifact
- flow-editing: Pace flows, graders, eval cases, simulations, or prompt-lab configuration`;

phase("Route");
const route = await agent(
  `Act as a workflow intake router. Do not perform the requested task.

Objective: ${args.objective}
Context: ${args.context || "None supplied."}

Choose exactly one lane by the requested deliverable and stop condition:${laneDefinitions}

Apply these REQUIRED gates whenever their trigger matches:
- redesign-shipped-behavior: replacing, consolidating, revamping, redesigning, or migrating behavior that already ships
- pre-human-handoff: pushing a branch for review or opening/undrafting a PR
- investigative-grounding: material claims about current behavior, root cause, blockers, risks, what could break, or deployment/runtime facts beyond a direct lookup

Add optional gates only when concrete scope requires them:
- active-design, security-boundary, contract-edge, ui-product, reviewer-feedback, multi-agent, pr-handoff, long-running-initiative, grounding-gap

Decision procedure:
1. Route by the requested deliverable, not isolated verbs. A known production remediation to implement is implementation; diagnosis without edits is production-triage.
2. Direct symbol/file lookup and supplied-contract explanation do not require investigative grounding.
3. Greenfield work is not redesign of shipped behavior.
4. Local verification and document packaging are not pre-human handoff.
5. Return every matching gate and no speculative gates.`,
  {
    label: "Route intake",
    provider: "codex",
    model: "gpt-5.4-mini",
    reasoningLevel: "medium",
    schema: routeSchema,
  },
);

const secondaryGates = route.secondaryGates.filter((gate, index, gates) => gates.indexOf(gate) === index);

let grounding = null;
if ((args.groundingMode || "route-only") === "when-required" && secondaryGates.includes("investigative-grounding")) {
  phase("Ground");
  grounding = await workflow("grounded-investigation", {
    objective: args.objective,
    scope: "Resolve only the unsettled facts needed to make the route and first action accurate.",
    knownContext: args.context || "None supplied.",
  });
}

const skillSet = {};
for (const skill of laneSkills[route.lane]) skillSet[skill] = true;
for (const gate of secondaryGates) {
  for (const skill of gateSkills[gate]) skillSet[skill] = true;
}

const routeDecision = {
  contractVersion: "workflow-router.route-decision.v1",
  objective: args.objective,
  lane: route.lane,
  why: route.why,
  requiredSkills: Object.keys(skillSet),
  secondaryGates,
  firstAction: route.firstAction,
  stopCondition: route.stopCondition,
  confidence: route.confidence,
  grounding,
};

if ((args.planningMode || "route-only") === "route-only") {
  phase("Deliver");
  return routeDecision;
}

phase("Plan");
const lifecycleStage = args.lifecycleStage || null;
const staged = lifecycleStage !== null;
const completePsaCoverage = args.psaMode === "audit" || args.psaMode === "re-audit";
const maxSections = args.maxSections || (staged && completePsaCoverage ? 8 : 6);
const shakedownContract = args.approvedShakedownContract || null;
const contractItems = shakedownContract ? shakedownContract.items : [];
const contractItemIds = contractItems.map((item) => item.id);
if (args.psaMode && lifecycleStage === null) {
  phase("Deliver");
  return {
    contractVersion: "workflow-router.execution-plan.v2",
    objective: args.objective,
    route: routeDecision,
    policyVersion: "workflow-router.fanout-policy.v3",
    lifecycle: {
      stage: null,
      psaMode: args.psaMode,
      approvedShakedownContract: null,
      humanDecisionEvidence: args.humanDecisionEvidence || [],
      evidenceRefs: args.evidenceRefs || [],
      findingRefs: args.findingRefs || [],
    },
    sections: [],
    truncation: null,
    totals: { sections: 0, requestedAgentCalls: 0, redTeamSections: 0 },
    warnings: ["psaMode is invalid without post-shakedown-availability."],
    validation: {
      valid: false,
      errors: [{
        code: "PSA_MODE_OUTSIDE_AVAILABILITY",
        sectionId: null,
        message: "psaMode requires lifecycleStage post-shakedown-availability.",
      }],
      warnings: [],
    },
  };
}
const sectionPlan = await agent(
  `Decompose this routed objective into independently executable sections. Do not perform the work.

Objective: ${args.objective}
Lane: ${route.lane}
Why: ${route.why}
Required skills: ${JSON.stringify(routeDecision.requiredSkills)}
Secondary gates: ${JSON.stringify(routeDecision.secondaryGates)}
Maximum sections: ${maxSections}
Lifecycle stage: ${lifecycleStage || "legacy planning; no staged-assurance fields"}
PSA mode: ${args.psaMode || "none"}
Approved shakedown contract: ${JSON.stringify(shakedownContract)}
Human decision evidence: ${JSON.stringify(args.humanDecisionEvidence || [])}
Evidence refs: ${JSON.stringify(args.evidenceRefs || [])}
Finding refs: ${JSON.stringify(args.findingRefs || [])}

Return between 1 and ${maxSections} sections in dependency-respecting order. Prefer the smallest useful decomposition.

Coverage guidance:
- light: one reversible, narrow unit with cheap deterministic validation
- standard: normal unit needing an owner and contract critic
- thorough: broad or ambiguous unit needing an owner plus two distinct critics
- red-team: high-cost error or weak/one-shot validation needing findings-only adversarial review and a human gate

Risk triggers are a closed set. Use "none" only when no trigger applies. Any of these force red-team coverage: auth/access boundaries; a claim that all traffic passes one chokepoint; irreversible migration/data operations; multi-region residency; secrets or environment threading; publishing/egressing data; or a conditional guard on a shared chokepoint.

Choose requiredSkills only from the supplied list. Do not invent skills.

${
    staged
      ? `Staged-assurance requirements:
- Classify each section as one assuranceClass: mvp-definition, mvp-functionality, nondeferrable-safety, low-regret-psa-prep, shakedown-learning, design-stability, or post-shakedown-assurance.
- low-regret-psa-prep is limited to threat/boundary inventories, telemetry and rollback wiring, deterministic harnesses, failure-injection scaffolding, evidence inventories, runbook skeletons, and permission/data-flow documentation. Do not place implementation-specific binding audits there.
- Set psaComponent to none unless the section owns one of these post-shakedown domains: ${psaComponents.join(", ")}.
- dependsOn may contain only earlier generated IDs (section-1, section-2, and so on). Never name the current or a later section.
- mutationIntent is read-only or mutate. Risk-triggered red-team work must be read-only.
- contractItemRefs must use only these approved contract IDs: ${JSON.stringify(contractItemIds)}.
- Every contract item marked nondeferrable must be covered by at least one section.
- verificationRequired is true for any risk-triggered or nondeferrable-safety section.
- exitCriterion must be observable and specific.
- In PSA audit or re-audit mode, cover every PSA component exactly or explicitly enough that deterministic validation can prove complete component coverage.`
      : "Do not add staged-assurance fields because lifecycleStage was not supplied."
  }`,
  {
    label: "Plan bounded execution",
    provider: "codex",
    model: "gpt-5.6-sol",
    reasoningLevel: "high",
    schema: sectionPlanSchema(maxSections, staged),
  },
);

const warnings = [];
const validationErrors = [];
const validationWarnings = [];
const truncation =
  sectionPlan.sections.length > maxSections
    ? {
        returnedSections: sectionPlan.sections.length,
        keptSections: maxSections,
        droppedSections: sectionPlan.sections.length - maxSections,
      }
    : null;
if (truncation !== null) {
  warnings.push(`Planner returned ${sectionPlan.sections.length} sections; kept the first ${maxSections}.`);
}

const sections = sectionPlan.sections.slice(0, maxSections).map((section, index) => {
  const matchedTriggers = section.riskTriggers.filter((trigger) => trigger !== "none");
  const riskForced = matchedTriggers.length > 0;
  const coverage = riskForced ? "red-team" : section.coverage;
  const policy = coveragePolicy[coverage];
  const requiredSkills = section.requiredSkills
    .filter(
      (skill, skillIndex, allSkills) =>
        routeDecision.requiredSkills.includes(skill) && allSkills.indexOf(skill) === skillIndex,
    )
    .slice(0, 24);
  if (requiredSkills.length !== section.requiredSkills.length) {
    warnings.push(
      `Section ${index + 1} dropped ${section.requiredSkills.length - requiredSkills.length} invalid, duplicate, or excess skill references.`,
    );
  }

  const base = {
    id: `section-${index + 1}`,
    title: section.title,
    objective: section.objective,
    coverage,
    riskTriggers: riskForced ? matchedTriggers : ["none"],
    riskReason: section.riskReason,
    requiredSkills,
    workerRoles: [...policy.workerRoles],
    agentCalls: policy.agentCalls,
    findingsOnly: policy.findingsOnly,
    humanGate: policy.humanGate,
    modelProfile: modelProfileFor(routeDecision, coverage, matchedTriggers, requiredSkills),
  };

  if (!staged) return base;

  if (riskForced) {
    validationWarnings.push({
      code: "RISK_POLICY_FORCED",
      sectionId: base.id,
      message: "Risk trigger forced red-team, nondeferrable-safety, read-only, and verificationRequired policy.",
    });
  }

  return {
    ...base,
    assuranceClass: riskForced ? "nondeferrable-safety" : section.assuranceClass,
    psaComponent: section.psaComponent,
    dependsOn: [...section.dependsOn],
    mutationIntent: riskForced ? "read-only" : section.mutationIntent,
    contractItemRefs: [...section.contractItemRefs],
    verificationRequired:
      riskForced || completePsaCoverage ? true : section.verificationRequired,
    exitCriterion: section.exitCriterion,
    dueStage: dueStageForAssuranceClass[riskForced ? "nondeferrable-safety" : section.assuranceClass],
  };
});

if (!staged) {
  phase("Deliver");
  return {
    contractVersion: "workflow-router.execution-plan.v1",
    objective: args.objective,
    route: routeDecision,
    policyVersion: "workflow-router.fanout-policy.v2",
    sections,
    truncation,
    totals: {
      sections: sections.length,
      requestedAgentCalls: sections.reduce((sum, section) => sum + section.agentCalls, 0),
      redTeamSections: sections.filter((section) => section.coverage === "red-team").length,
    },
    warnings,
  };
}

if (lifecycleStage !== "mvp-definition" && shakedownContract === null) {
  validationErrors.push({
    code: "APPROVED_SHAKEDOWN_CONTRACT_REQUIRED",
    sectionId: null,
    message: `An approved shakedown contract is required for lifecycle stage ${lifecycleStage}.`,
  });
}

for (let contractIndex = 0; contractIndex < contractItemIds.length; contractIndex += 1) {
  const contractItemId = contractItemIds[contractIndex];
  if (
    contractItemIds.indexOf(contractItemId) === contractIndex &&
    contractItemIds.lastIndexOf(contractItemId) !== contractIndex
  ) {
    validationErrors.push({
      code: "DUPLICATE_CONTRACT_ITEM_ID",
      sectionId: null,
      message: `Approved shakedown contract item ID ${contractItemId} is duplicated.`,
    });
  }
}

if (args.psaMode && lifecycleStage !== "post-shakedown-availability") {
  validationErrors.push({
    code: "PSA_MODE_OUTSIDE_AVAILABILITY",
    sectionId: null,
    message: "psaMode is valid only during post-shakedown-availability.",
  });
}
if (lifecycleStage === "post-shakedown-availability" && !args.psaMode) {
  validationErrors.push({
    code: "PSA_MODE_REQUIRED",
    sectionId: null,
    message: "post-shakedown-availability requires psaMode audit, remediate, or re-audit.",
  });
}

const decisions = args.humanDecisionEvidence || [];
const requiredPriorHumanGate = {
  "customer-shakedown": "shakedown-build",
  "design-stability": "customer-shakedown",
  "post-shakedown-availability": "design-stability",
}[lifecycleStage];
if (requiredPriorHumanGate) {
  const matchingDecisions = decisions.filter(
    (decision) =>
      decision.stage === requiredPriorHumanGate &&
      decision.contractVersion === shakedownContract?.contractVersion,
  );
  const latestDecision = matchingDecisions.length > 0 ? matchingDecisions[matchingDecisions.length - 1] : null;
  if (latestDecision === null || latestDecision.decision !== "approve") {
    validationErrors.push({
      code: "PRIOR_HUMAN_GATE_APPROVAL_REQUIRED",
      sectionId: null,
      message: `${lifecycleStage} requires the latest human decision at ${requiredPriorHumanGate} to be approve.`,
    });
  }
}

for (let index = 0; index < sections.length; index += 1) {
  const section = sections[index];
  const earlierIds = sections.slice(0, index).map((candidate) => candidate.id);
  for (const dependency of section.dependsOn) {
    if (!earlierIds.includes(dependency)) {
      validationErrors.push({
        code: "INVALID_SECTION_DEPENDENCY",
        sectionId: section.id,
        message: `Dependency ${dependency} must refer to an earlier section and was preserved without repair.`,
      });
    }
  }
  if (section.dependsOn.some((dependency, dependencyIndex, all) => all.indexOf(dependency) !== dependencyIndex)) {
    validationErrors.push({
      code: "DUPLICATE_SECTION_DEPENDENCY",
      sectionId: section.id,
      message: "Duplicate dependencies were preserved without repair.",
    });
  }
  for (const contractRef of section.contractItemRefs) {
    if (!contractItemIds.includes(contractRef)) {
      validationErrors.push({
        code: "UNKNOWN_CONTRACT_ITEM_REF",
        sectionId: section.id,
        message: `Contract item reference ${contractRef} is not present in the approved shakedown contract.`,
      });
    }
  }
  if (section.assuranceClass === "nondeferrable-safety" && !section.verificationRequired) {
    validationErrors.push({
      code: "NONDEFERRABLE_VERIFICATION_REQUIRED",
      sectionId: section.id,
      message: "Nondeferrable safety work requires verification.",
    });
  }
  if (
    section.psaComponent !== "none" &&
    (lifecycleStage !== "post-shakedown-availability" ||
      (section.assuranceClass !== "post-shakedown-assurance" &&
        section.assuranceClass !== "nondeferrable-safety"))
  ) {
    validationErrors.push({
      code: "PSA_COMPONENT_OUTSIDE_AVAILABILITY",
      sectionId: section.id,
      message: `PSA component ${section.psaComponent} is not due before post-shakedown availability.`,
    });
  }
  if (
    lifecycleStage === "post-shakedown-availability" &&
    section.assuranceClass === "post-shakedown-assurance" &&
    section.psaComponent === "none"
  ) {
    validationErrors.push({
      code: "PSA_COMPONENT_REQUIRED",
      sectionId: section.id,
      message: "Post-shakedown assurance work must identify its PSA component.",
    });
  }
}

for (const contractItem of contractItems) {
  if (contractItem.nondeferrable !== true) continue;
  const covered = sections.some(
    (section) =>
      section.contractItemRefs.includes(contractItem.id) &&
      (lifecycleStage !== "shakedown-build" ||
        section.assuranceClass === "mvp-functionality" ||
        section.assuranceClass === "nondeferrable-safety" ||
        section.assuranceClass === "low-regret-psa-prep"),
  );
  if (!covered) {
    validationErrors.push({
      code: "UNCOVERED_NONDEFERRABLE_CONTRACT_ITEM",
      sectionId: null,
      message: `Nondeferrable contract item ${contractItem.id} has no section coverage.`,
    });
  }
}

if (completePsaCoverage) {
  for (const component of psaComponents) {
    const covered = sections.some(
      (section) =>
        section.psaComponent === component &&
        (section.assuranceClass === "post-shakedown-assurance" ||
          section.assuranceClass === "nondeferrable-safety"),
    );
    if (!covered) {
      validationErrors.push({
        code: "MISSING_PSA_COMPONENT",
        sectionId: null,
        message: `PSA ${args.psaMode} plan does not cover required component ${component}.`,
      });
    }
  }
}
if (args.psaMode === "remediate" && (args.findingRefs || []).length === 0) {
  validationErrors.push({
    code: "REMEDIATION_FINDINGS_REQUIRED",
    sectionId: null,
    message: "PSA remediation requires at least one findingRef.",
  });
}

phase("Deliver");
return {
  contractVersion: "workflow-router.execution-plan.v2",
  objective: args.objective,
  route: routeDecision,
  policyVersion: "workflow-router.fanout-policy.v3",
  lifecycle: {
    stage: lifecycleStage,
    psaMode: args.psaMode || null,
    approvedShakedownContract: shakedownContract,
    humanDecisionEvidence: decisions,
    evidenceRefs: args.evidenceRefs || [],
    findingRefs: args.findingRefs || [],
  },
  sections,
  truncation,
  totals: {
    sections: sections.length,
    requestedAgentCalls: sections.reduce((sum, section) => sum + section.agentCalls, 0),
    redTeamSections: sections.filter((section) => section.coverage === "red-team").length,
    nondeferrableSafetySections: sections.filter(
      (section) => section.assuranceClass === "nondeferrable-safety",
    ).length,
    psaComponentsCovered: psaComponents.filter((component) =>
      sections.some((section) => section.psaComponent === component),
    ).length,
  },
  validation: {
    valid: validationErrors.length === 0,
    errors: validationErrors,
    warnings: validationWarnings,
  },
  warnings,
};
