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
      walkingSkeletonApproval: {
        type: "object",
        additionalProperties: false,
        required: [
          "decisionRef",
          "evidenceRef",
          "decidedByHuman",
          "contractId",
          "contractRevision",
          "decision",
          "rationale",
          "seamIds",
        ],
        properties: {
          decisionRef: { type: "string", minLength: 1, maxLength: 256 },
          evidenceRef: { type: "string", minLength: 1, maxLength: 512 },
          decidedByHuman: { const: true },
          contractId: { type: "string", minLength: 1, maxLength: 96 },
          contractRevision: { type: "integer", minimum: 1 },
          decision: { enum: ["approved", "revise"] },
          rationale: { type: "string", minLength: 1, maxLength: 2048 },
          seamIds: {
            type: "array",
            minItems: 1,
            maxItems: 32,
            items: { type: "string", minLength: 1, maxLength: 128 },
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

const executionKinds = [
  "walking-skeleton",
  "oracle-closure",
  "production-unit",
  "supporting-assurance",
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
    properties.executionKind = { enum: executionKinds };
    properties.ownedPaths = {
      type: "array",
      maxItems: 32,
      items: { type: "string", minLength: 1, maxLength: 256 },
    };
    properties.producesSeams = {
      type: "array",
      maxItems: 32,
      items: { type: "string", minLength: 1, maxLength: 128 },
    };
    properties.consumesSeams = {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        required: ["id", "requiredAt", "testDoublePolicy"],
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: 128 },
          requiredAt: {
            enum: ["section-start", "section-exit", "shakedown-promotion"],
          },
          testDoublePolicy: { enum: ["forbidden", "allowed"] },
        },
      },
    };
    required.push(
      "assuranceClass",
      "psaComponent",
      "dependsOn",
      "mutationIntent",
      "contractItemRefs",
      "verificationRequired",
      "exitCriterion",
      "executionKind",
      "ownedPaths",
      "producesSeams",
      "consumesSeams",
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
    contractVersion: "workflow-router.execution-plan.v4",
    objective: args.objective,
    route: routeDecision,
    policyVersion: "workflow-router.fanout-policy.v5",
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
Walking-skeleton approval: ${JSON.stringify(args.walkingSkeletonApproval || null)}
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
- Set executionKind to walking-skeleton only for a human-approved, production-owned seam that must complete before oracle closure; oracle-closure for the one shakedown-build unit that inventories and repairs the complete related acceptance-test, fixture, and frozen-oracle closure; production-unit for independently buildable MVP arms; and supporting-assurance for all other work.
- A walking-skeleton is valid only when walkingSkeletonApproval is approved, revision-matched to the shakedown contract, and names exactly the seams it produces. Emit at most one, place it before the oracle, keep it standard or thorough, mutating, verification-required, and make the oracle directly depend on it. Do not absorb the full later unit.
- During shakedown-build, emit exactly one oracle-closure before any production-unit. It must be mutating, verification-required, and standard or thorough coverage. Every production-unit must directly depend on that oracle-closure so its independent reviewer approves the frozen acceptance boundary before production begins.
- Production units should be independently executable after oracle approval. Do not add dependencies between sibling production units unless there is a real artifact dependency.
- ownedPaths is an explicit list of repo-relative file or directory prefixes the section may mutate. Mutating sections require at least one path; read-only sections use an empty list. Sibling production units must have non-overlapping declarations so callers may explicitly opt into best-effort concurrency. These declarations guide and validate worker reports; they do not isolate filesystem capabilities.
- Inventory semantic production dependencies before construction. producesSeams lists stable IDs for production or test seams created by the section. consumesSeams lists every seam the section or shared promotion gate requires, when it must exist, and whether a test-local substitute is allowed. Use empty arrays only when the section truly owns or requires no cross-section seam.
- A consumption with testDoublePolicy forbidden must resolve to exactly one walking-skeleton or production-unit owner inside this plan. That owner must complete before a section-start or section-exit consumer and must be in the consumer's dependency closure. Never place an oracle requirement ahead of its production seam owner; surface the topology instead of inventing a fake adapter.
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

  const executionKind = riskForced ? "supporting-assurance" : section.executionKind;
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
    executionKind,
    ownedPaths: riskForced ? [] : [...section.ownedPaths],
    producesSeams: [...section.producesSeams],
    consumesSeams: section.consumesSeams.map((consumption) => ({
      ...consumption,
    })),
    agentCalls:
      policy.agentCalls +
      (["walking-skeleton", "production-unit"].includes(executionKind)
        ? 1
        : 0),
    dueStage: dueStageForAssuranceClass[riskForced ? "nondeferrable-safety" : section.assuranceClass],
  };
});

function pathIsTestLocal(path) {
  const normalized = path.toLowerCase().replace(/^\.\//, "");
  return (
    normalized.startsWith("test/") ||
    normalized.startsWith("tests/") ||
    normalized.startsWith("__tests__/") ||
    normalized.startsWith("spec/") ||
    normalized.includes("/__tests__/") ||
    /(^|\/)[^/]+\.(spec|test)\.[^/]+$/.test(normalized)
  );
}

function dependencyClosureContains(sectionById, consumerSection, producerId) {
  const pending = [...consumerSection.dependsOn];
  const visited = new Set();
  while (pending.length > 0) {
    const dependencyId = pending.pop();
    if (dependencyId === producerId) return true;
    if (visited.has(dependencyId)) continue;
    visited.add(dependencyId);
    const dependency = sectionById.get(dependencyId);
    if (dependency) pending.push(...dependency.dependsOn);
  }
  return false;
}

function semanticDependencyFindingsForSections(plannedSections, currentStage) {
  const findings = [];
  const sectionById = new Map(plannedSections.map((section) => [section.id, section]));
  const sectionIndexById = new Map(
    plannedSections.map((section, index) => [section.id, index]),
  );
  const producersBySeam = new Map();
  const consumedSeamIds = new Set();
  for (const section of plannedSections) {
    for (const seamId of section.producesSeams || []) {
      const owners = producersBySeam.get(seamId) || [];
      owners.push(section);
      producersBySeam.set(seamId, owners);
    }
  }
  for (const section of plannedSections) {
    for (const consumption of section.consumesSeams || []) {
      consumedSeamIds.add(consumption.id);
      const owners = producersBySeam.get(consumption.id) || [];
      if (owners.length !== 1) {
        findings.push({
          code:
            owners.length === 0
              ? "SEMANTIC_SEAM_OWNER_MISSING"
              : "SEMANTIC_SEAM_OWNER_DUPLICATED",
          seamId: consumption.id,
          sectionId: section.id,
          producerSectionId: owners.length === 1 ? owners[0].id : null,
          deadlock: false,
          message:
            owners.length === 0
              ? `Consumed seam ${consumption.id} has no owner inside the plan.`
              : `Consumed seam ${consumption.id} has ${owners.length} owners; exactly one is required.`,
        });
        continue;
      }
      const producer = owners[0];
      const productionProofRequired = consumption.testDoublePolicy === "forbidden";
      if (
        productionProofRequired &&
        (!["walking-skeleton", "production-unit"].includes(
          producer.executionKind,
        ) ||
          producer.mutationIntent !== "mutate" ||
          producer.ownedPaths.length === 0 ||
          producer.ownedPaths.every(pathIsTestLocal))
      ) {
        findings.push({
          code: "SEMANTIC_PRODUCTION_PROOF_REQUIRED",
          seamId: consumption.id,
          sectionId: section.id,
          producerSectionId: producer.id,
          deadlock: false,
          message: `Seam ${consumption.id} forbids test doubles but its owner ${producer.id} is not a production-mutating unit with a production-owned path.`,
        });
      }
      if (producer.dueStage !== currentStage) {
        findings.push({
          code: "SEMANTIC_SEAM_OWNER_DEFERRED",
          seamId: consumption.id,
          sectionId: section.id,
          producerSectionId: producer.id,
          deadlock: true,
          message: `Seam ${consumption.id} is required during ${currentStage}, but owner ${producer.id} is deferred to ${producer.dueStage}.`,
        });
      }
      if (consumption.requiredAt === "shakedown-promotion") continue;
      if (producer.id === section.id && consumption.requiredAt === "section-exit") {
        continue;
      }
      const producerIndex = sectionIndexById.get(producer.id);
      const consumerIndex = sectionIndexById.get(section.id);
      if (producerIndex >= consumerIndex) {
        findings.push({
          code: "SEMANTIC_DEPENDENCY_DEADLOCK",
          seamId: consumption.id,
          sectionId: section.id,
          producerSectionId: producer.id,
          deadlock: true,
          message: `Section ${section.id} requires seam ${consumption.id} at ${consumption.requiredAt}, but owner ${producer.id} does not complete in its dependency closure first.`,
        });
      } else if (!dependencyClosureContains(sectionById, section, producer.id)) {
        findings.push({
          code: "SEMANTIC_DEPENDENCY_EDGE_MISSING",
          seamId: consumption.id,
          sectionId: section.id,
          producerSectionId: producer.id,
          deadlock: false,
          message: `Section ${section.id} requires seam ${consumption.id} after owner ${producer.id}, but its dependency closure omits that owner.`,
        });
      }
    }
  }
  for (const [seamId, owners] of producersBySeam) {
    if (!consumedSeamIds.has(seamId)) {
      findings.push({
        code: "SEMANTIC_SEAM_UNCONSUMED",
        seamId,
        sectionId: owners[0]?.id || null,
        producerSectionId: owners[0]?.id || null,
        deadlock: false,
        message: `Produced seam ${seamId} has no in-plan consumer or promotion requirement.`,
      });
    }
  }
  return findings;
}

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
  if (!executionKinds.includes(section.executionKind)) {
    validationErrors.push({
      code: "UNKNOWN_EXECUTION_KIND",
      sectionId: section.id,
      message: `Execution kind ${String(section.executionKind)} is not supported.`,
    });
  }
  if (
    !Array.isArray(section.ownedPaths) ||
    section.ownedPaths.some(
      (path) =>
        typeof path !== "string" ||
        path.length === 0 ||
        path.startsWith("/") ||
        path.split("/").includes(".."),
    )
  ) {
    validationErrors.push({
      code: "INVALID_OWNED_PATHS",
      sectionId: section.id,
      message: "ownedPaths must contain safe repo-relative prefixes.",
    });
  }
  if (section.mutationIntent === "mutate" && section.ownedPaths.length === 0) {
    validationErrors.push({
      code: "MUTATION_OWNERSHIP_REQUIRED",
      sectionId: section.id,
      message: "Mutating sections require at least one ownedPaths prefix.",
    });
  }
  if (section.mutationIntent === "read-only" && section.ownedPaths.length > 0) {
    validationErrors.push({
      code: "READ_ONLY_OWNERSHIP_FORBIDDEN",
      sectionId: section.id,
      message: "Read-only sections must use an empty ownedPaths list.",
    });
  }
  if (
    section.producesSeams.some(
      (seamId, seamIndex, seamIds) => seamIds.indexOf(seamId) !== seamIndex,
    )
  ) {
    validationErrors.push({
      code: "DUPLICATE_PRODUCED_SEAM",
      sectionId: section.id,
      message: "producesSeams must not contain duplicate seam IDs.",
    });
  }
  if (
    section.consumesSeams.some(
      (consumption, seamIndex, consumptions) =>
        consumptions.findIndex((candidate) => candidate.id === consumption.id) !==
        seamIndex,
    )
  ) {
    validationErrors.push({
      code: "DUPLICATE_CONSUMED_SEAM",
      sectionId: section.id,
      message: "consumesSeams must not contain duplicate seam IDs.",
    });
  }
  if (
    lifecycleStage !== "shakedown-build" &&
    section.executionKind !== "supporting-assurance"
  ) {
    validationErrors.push({
      code: "EXECUTION_KIND_OUTSIDE_SHAKEDOWN_BUILD",
      sectionId: section.id,
      message: `${section.executionKind} is valid only during shakedown-build.`,
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

for (const finding of semanticDependencyFindingsForSections(
  sections,
  lifecycleStage,
)) {
  validationErrors.push({
    code: finding.code,
    sectionId: finding.sectionId,
    message: finding.message,
  });
}

if (lifecycleStage === "shakedown-build") {
  const walkingSkeletonSections = sections.filter(
    (section) => section.executionKind === "walking-skeleton",
  );
  const oracleSections = sections.filter(
    (section) => section.executionKind === "oracle-closure",
  );
  const productionSections = sections.filter(
    (section) => section.executionKind === "production-unit",
  );
  if (oracleSections.length !== 1) {
    validationErrors.push({
      code: "ORACLE_CLOSURE_REQUIRED",
      sectionId: null,
      message: `shakedown-build requires exactly one oracle-closure section; received ${oracleSections.length}.`,
    });
  }
  if (productionSections.length === 0) {
    validationErrors.push({
      code: "PRODUCTION_UNIT_REQUIRED",
      sectionId: null,
      message: "shakedown-build requires at least one production-unit section.",
    });
  }
  if (walkingSkeletonSections.length > 1) {
    validationErrors.push({
      code: "WALKING_SKELETON_NOT_MINIMAL",
      sectionId: null,
      message: "shakedown-build permits at most one walking-skeleton section.",
    });
  }
  if (walkingSkeletonSections.length === 1) {
    const skeletonSection = walkingSkeletonSections[0];
    const skeletonApproval = args.walkingSkeletonApproval || null;
    const expectedContractVersion = skeletonApproval
      ? `${skeletonApproval.contractId}:revision-${skeletonApproval.contractRevision}`
      : null;
    const approvedSeamIds = skeletonApproval?.seamIds || [];
    const producedSeamIds = skeletonSection.producesSeams || [];
    const approvalMatches =
      skeletonApproval?.decidedByHuman === true &&
      skeletonApproval?.decision === "approved" &&
      expectedContractVersion === shakedownContract?.contractVersion &&
      approvedSeamIds.length === producedSeamIds.length &&
      new Set(approvedSeamIds).size === approvedSeamIds.length &&
      approvedSeamIds.every((seamId) => producedSeamIds.includes(seamId)) &&
      producedSeamIds.every((seamId) => approvedSeamIds.includes(seamId));
    if (!approvalMatches) {
      validationErrors.push({
        code: "WALKING_SKELETON_APPROVAL_REQUIRED",
        sectionId: skeletonSection.id,
        message:
          "walking-skeleton approval must be human, approved, contract-revision matched, and name exactly the produced seams.",
      });
    }
    if (
      skeletonSection.mutationIntent !== "mutate" ||
      skeletonSection.verificationRequired !== true ||
      !["standard", "thorough"].includes(skeletonSection.coverage) ||
      producedSeamIds.length === 0 ||
      skeletonSection.ownedPaths.length === 0 ||
      skeletonSection.ownedPaths.every(pathIsTestLocal)
    ) {
      validationErrors.push({
        code: "WALKING_SKELETON_POLICY_MISMATCH",
        sectionId: skeletonSection.id,
        message:
          "walking-skeleton must be mutating, verification-required, standard or thorough, production-owned, and produce at least one approved seam.",
      });
    }
    if (
      skeletonSection.dependsOn.length > 0 ||
      (oracleSections.length === 1 &&
        (!oracleSections[0].dependsOn.includes(skeletonSection.id) ||
          sections.indexOf(skeletonSection) >= sections.indexOf(oracleSections[0])))
    ) {
      validationErrors.push({
        code: "WALKING_SKELETON_TOPOLOGY_INVALID",
        sectionId: skeletonSection.id,
        message:
          "walking-skeleton must be the root production seam unit and the oracle must directly depend on it.",
      });
    }
  }
  if (oracleSections.length === 1) {
    const oracleSection = oracleSections[0];
    if (
      oracleSection.mutationIntent !== "mutate" ||
      oracleSection.verificationRequired !== true ||
      !["standard", "thorough"].includes(oracleSection.coverage)
    ) {
      validationErrors.push({
        code: "ORACLE_CLOSURE_POLICY_MISMATCH",
        sectionId: oracleSection.id,
        message: "oracle-closure must be mutating, verification-required, and use standard or thorough coverage.",
      });
    }
    for (const productionSection of productionSections) {
      if (!productionSection.dependsOn.includes(oracleSection.id)) {
        validationErrors.push({
          code: "PRODUCTION_REQUIRES_ORACLE_CLOSURE",
          sectionId: productionSection.id,
          message: `production-unit ${productionSection.id} must directly depend on oracle-closure ${oracleSection.id}.`,
        });
      }
      if (productionSection.mutationIntent !== "mutate") {
        validationErrors.push({
          code: "PRODUCTION_UNIT_MUST_MUTATE",
          sectionId: productionSection.id,
          message: "production-unit sections must declare mutating intent.",
        });
      }
    }
    for (let leftIndex = 0; leftIndex < productionSections.length; leftIndex += 1) {
      const left = productionSections[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < productionSections.length; rightIndex += 1) {
        const right = productionSections[rightIndex];
        const overlap = left.ownedPaths.some((leftPath) =>
          right.ownedPaths.some(
            (rightPath) =>
              leftPath === rightPath ||
              leftPath.startsWith(`${rightPath.replace(/\/$/, "")}/`) ||
              rightPath.startsWith(`${leftPath.replace(/\/$/, "")}/`),
          ),
        );
        if (overlap) {
          validationErrors.push({
            code: "PRODUCTION_WRITE_SCOPE_OVERLAP",
            sectionId: right.id,
            message: `production-unit ${left.id} and ${right.id} have overlapping ownedPaths.`,
          });
        }
      }
    }
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
  contractVersion: "workflow-router.execution-plan.v4",
  objective: args.objective,
  route: routeDecision,
  policyVersion: "workflow-router.fanout-policy.v5",
  lifecycle: {
    stage: lifecycleStage,
    psaMode: args.psaMode || null,
    approvedShakedownContract: shakedownContract,
    walkingSkeletonApproval: args.walkingSkeletonApproval || null,
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
