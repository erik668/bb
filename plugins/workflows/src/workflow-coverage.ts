import { z } from "zod";
import {
  type WorkflowCheckpoint,
  canonicalizeAcceptanceCriteria,
  workflowAcceptanceProvenBySchema,
} from "./workflow-checkpoint.js";

/**
 * Acceptance coverage answers the question a green build DAG cannot: did this
 * campaign close the outcomes it committed to, or only the work it chose to do?
 *
 * Every input is already in the ledger, so coverage is derived rather than
 * authored. Nothing here asks an agent to report on itself, which is the point:
 * a drifting orchestrator writes the plan and the progress, so only a reading
 * that it does not author can contradict it.
 */

/**
 * Row cap for the campaign-wide coverage read. Bounds the query at roughly the
 * per-run checkpoint cap times a mid-sized campaign; exceeding it is surfaced as
 * partial coverage rather than answered from a truncated ledger.
 */
export const MAX_WORKFLOW_COVERAGE_CHECKPOINTS = 5_000;

export const acceptanceCriterionStateSchema = z.enum([
  "closed",
  "in-flight",
  "uncovered",
]);

const acceptanceCriterionCoverageSchema = z
  .object({
    id: z.string(),
    statement: z.string(),
    provenBy: workflowAcceptanceProvenBySchema,
    state: acceptanceCriterionStateSchema,
    /** Current-plan item IDs declaring `satisfies` for this criterion. */
    satisfiedBy: z.array(z.string()),
    /** Verification checkpoint IDs that succeeded against this criterion. */
    closedBy: z.array(z.string()),
  })
  .strict();

/**
 * Where an approval was issued from. This is the whole security property: a
 * workflow worker's tool list is exactly `bb_workflow_checkpoint` and
 * `bb_workflow_result`, so neither surface below is reachable from the path
 * that publishes the amendment. Recorded rather than inferred, because "who
 * could have done this" is the question a reviewer actually asks.
 */
export const WORKFLOW_APPROVAL_SURFACES = ["panel", "cli"] as const;

export const workflowApprovalSurfaceSchema = z.enum(WORKFLOW_APPROVAL_SURFACES);

/**
 * An approval as stored: bound to one acceptance checkpoint AND to the exact
 * contract body that was approved, so an approval cannot carry over to a
 * different set of criteria published later under the same ID.
 */
export const acceptanceApprovalSchema = z
  .object({
    acceptanceId: z.string(),
    /** `canonicalizeAcceptanceCriteria` of the body that was approved. */
    contractCanonical: z.string(),
    /** The thread the approval was issued from, not a self-reported actor. */
    approvedByThreadId: z.string(),
    surface: workflowApprovalSurfaceSchema,
    approvedAt: z.number().int(),
  })
  .strict();

const acceptanceApprovalRecordSchema = z
  .object({
    approvedByThreadId: z.string(),
    surface: workflowApprovalSurfaceSchema,
    approvedAt: z.number().int(),
  })
  .strict();

const acceptanceAmendmentRecordSchema = z
  .object({
    /** The amending checkpoint, which becomes authoritative from here on. */
    acceptanceId: z.string(),
    /** The acceptance checkpoint it replaced, still readable in the ledger. */
    supersedes: z.string(),
    reason: z.string(),
  })
  .strict();

/**
 * An amendment that took effect. It carries the approval that let it, because
 * `reason` is the amending agent's own account of itself and cannot be the
 * thing that authorizes the change.
 */
const approvedAmendmentRecordSchema = acceptanceAmendmentRecordSchema
  .extend({ approval: acceptanceApprovalRecordSchema })
  .strict();

const openGateSchema = z
  .object({
    gateId: z.string(),
    /** Criteria the gate requires that are not closed, including undeclared ones. */
    openCriterionIds: z.array(z.string()),
  })
  .strict();

/**
 * Shared by the derivation and the UI contract so the summary the composer
 * renders cannot drift from the one this module computes.
 */
export const workflowAcceptanceCoverageSchema = z
  .object({
    acceptanceId: z.string(),
    criteria: z.array(acceptanceCriterionCoverageSchema),
    closedCount: z.number().int().nonnegative(),
    inFlightCount: z.number().int().nonnegative(),
    uncoveredCount: z.number().int().nonnegative(),
    /**
     * Amendments in effect, in ledger order. The write path refuses a changed
     * contract that does not declare itself, so a campaign whose scope really
     * did change ends up with a readable chain instead of a rewritten anchor.
     * Every entry here was approved out of band; a declared amendment alone
     * cannot move the contract.
     */
    amendments: z.array(approvedAmendmentRecordSchema),
    /**
     * Declared amendments nobody approved. These are accepted into the ledger
     * and readable, but inert: coverage still measures the contract they tried
     * to replace, so an agent cannot narrow what done means by writing another
     * checkpoint. Approving one is a human act on a surface the workflow's own
     * tool path cannot reach.
     */
    pendingAmendments: z.array(acceptanceAmendmentRecordSchema),
    /**
     * Acceptance checkpoints whose body differs from the authoritative contract
     * without declaring an amendment. The write path refuses these, so a
     * non-empty list means the ledger was written outside the tool path — the
     * reason this is re-derived on read rather than trusting the newest row.
     */
    unauthorizedAcceptanceIds: z.array(z.string()),
    /**
     * Gates in the current plan whose required criteria are not all closed.
     * The write path refuses to record one of these as succeeded, so this is
     * the readable side of that refusal: a campaign can see what it is stuck
     * behind without having to trip the guard first.
     */
    openGates: z.array(openGateSchema),
    /** `satisfies` / `acceptanceId` values matching no declared criterion. */
    unknownReferences: z.array(z.string()),
    /**
     * Succeeded work items advancing no acceptance criterion. Preconditions
     * land here legitimately — a containment gate genuinely satisfies nothing —
     * so this is context for the ratio below, not a defect on its own.
     */
    orphanWorkItemIds: z.array(z.string()),
    /**
     * The remote-evals failure shape, stated mechanically and without a tuned
     * threshold: work is completing, and none of it has closed an outcome. True
     * once succeeded orphan work exists while no criterion is closed.
     */
    unanchoredProgress: z.boolean(),
  })
  .strict();

export type AcceptanceCriterionState = z.infer<
  typeof acceptanceCriterionStateSchema
>;
export type AcceptanceCriterionCoverage = z.infer<
  typeof acceptanceCriterionCoverageSchema
>;
export type WorkflowAcceptanceCoverage = z.infer<
  typeof workflowAcceptanceCoverageSchema
>;
export type AcceptanceAmendmentRecord = z.infer<
  typeof acceptanceAmendmentRecordSchema
>;
export type ApprovedAmendmentRecord = z.infer<
  typeof approvedAmendmentRecordSchema
>;
export type AcceptanceApproval = z.infer<typeof acceptanceApprovalSchema>;
export type WorkflowApprovalSurface = z.infer<
  typeof workflowApprovalSurfaceSchema
>;
export type AcceptanceOpenGate = z.infer<typeof openGateSchema>;

/**
 * Derives coverage from one campaign's checkpoints in chronological order.
 *
 * Returns `null` when the campaign declared no acceptance contract. Absence is
 * reported as absence: inferring criteria from the plan would measure the plan
 * against itself and always agree.
 *
 * `approvals` is required rather than defaulted. A default would make every
 * caller that forgot it report each amendment as pending — a wrong answer that
 * looks like a working one — so the omission is a compile error instead.
 */
export function deriveAcceptanceCoverage(
  checkpoints: readonly WorkflowCheckpoint[],
  approvals: readonly AcceptanceApproval[],
): WorkflowAcceptanceCoverage | null {
  const acceptances = checkpoints.filter(
    (checkpoint) => checkpoint.kind === "acceptance",
  );
  const original = acceptances[0];
  if (original === undefined) return null;

  // The authoritative contract is the head of the declared amendment chain, not
  // simply the newest acceptance checkpoint. A campaign whose scope legitimately
  // changed is measured against what it amended to; a contract that changed
  // without saying so is reported and does NOT take over, so editing the ledger
  // directly cannot make coverage agree with a rewrite.
  //
  // An amendment is declared here when it names any earlier acceptance
  // checkpoint. The write path already refuses one that names a predecessor the
  // campaign never published, so the read side only has to separate a declared
  // amendment from an undeclared rewrite.
  //
  // Declaring is not authorizing. `amends.reason` is the amending agent's
  // account of itself, so it attributes the change and cannot license it; only
  // an approval issued from the panel or the CLI moves the contract. An
  // unapproved amendment stays in the ledger and stays inert.
  let contract = original;
  const amendments: ApprovedAmendmentRecord[] = [];
  const pendingAmendments: AcceptanceAmendmentRecord[] = [];
  const unauthorizedAcceptanceIds: string[] = [];
  const seenAcceptanceIds = new Set([original.id]);
  for (const later of acceptances.slice(1)) {
    const canonical = canonicalizeAcceptanceCriteria(later.criteria);
    const changed =
      canonical !== canonicalizeAcceptanceCriteria(contract.criteria);
    if (!changed) {
      seenAcceptanceIds.add(later.id);
      continue;
    }
    const amends = later.amends;
    if (amends !== undefined && seenAcceptanceIds.has(amends.supersedes)) {
      const declared = {
        acceptanceId: later.id,
        supersedes: amends.supersedes,
        reason: amends.reason,
      };
      // Matched on the body as well as the ID: approving one set of criteria
      // must not bless a different set republished later.
      const approval = approvals.find(
        (candidate) =>
          candidate.acceptanceId === later.id &&
          candidate.contractCanonical === canonical,
      );
      if (approval === undefined) {
        pendingAmendments.push(declared);
      } else {
        amendments.push({
          ...declared,
          approval: {
            approvedByThreadId: approval.approvedByThreadId,
            surface: approval.surface,
            approvedAt: approval.approvedAt,
          },
        });
        contract = later;
      }
    } else {
      unauthorizedAcceptanceIds.push(later.id);
    }
    // Seen regardless of approval: a pending amendment is a real, readable
    // checkpoint, so a later amendment may legitimately name it as the thing it
    // supersedes. Approving that later one approves the body it carries.
    seenAcceptanceIds.add(later.id);
  }

  // Two different resolutions of "the plan", deliberately:
  //
  // `currentPlan` is the newest plan checkpoint alone, because coverage must
  // reflect what is being built NOW. Unioning every plan ever published would
  // let a criterion that run 1 claimed and run 40 quietly dropped keep counting
  // as covered — which is the drift this module exists to expose.
  //
  // `planItemsById` merges all plans (last write wins) only to resolve a work
  // item back to its declaration, since a work item may belong to a plan that a
  // later run superseded.
  const plans = checkpoints.filter((checkpoint) => checkpoint.kind === "plan");
  const currentPlan = plans.at(-1);
  const planItemsById = new Map<string, { satisfies?: string[] }>();
  for (const plan of plans) {
    for (const item of plan.items) {
      planItemsById.set(item.id, item);
    }
  }

  const declaredIds = new Set(
    contract.criteria.map((criterion) => criterion.id),
  );
  const unknownReferences = new Set<string>();

  const satisfiedBy = new Map<string, string[]>();
  for (const item of currentPlan?.items ?? []) {
    for (const criterionId of item.satisfies ?? []) {
      if (!declaredIds.has(criterionId)) {
        unknownReferences.add(criterionId);
        continue;
      }
      const existing = satisfiedBy.get(criterionId);
      if (existing === undefined) satisfiedBy.set(criterionId, [item.id]);
      else existing.push(item.id);
    }
  }

  // Only a succeeded verification closes a criterion. The schema already
  // refuses a succeeded verification that reports failures, so this inherits
  // that guarantee rather than re-checking counts here.
  const closedBy = new Map<string, string[]>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.kind !== "verification") continue;
    const criterionId = checkpoint.acceptanceId;
    if (criterionId === undefined) continue;
    if (!declaredIds.has(criterionId)) {
      unknownReferences.add(criterionId);
      continue;
    }
    if (checkpoint.status !== "succeeded") continue;
    const existing = closedBy.get(criterionId);
    if (existing === undefined) closedBy.set(criterionId, [checkpoint.id]);
    else existing.push(checkpoint.id);
  }

  const criteria = contract.criteria.map((criterion) => {
    const closed = closedBy.get(criterion.id) ?? [];
    const satisfied = satisfiedBy.get(criterion.id) ?? [];
    const state: AcceptanceCriterionState =
      closed.length > 0
        ? "closed"
        : satisfied.length > 0
          ? "in-flight"
          : "uncovered";
    return {
      id: criterion.id,
      statement: criterion.statement,
      provenBy: criterion.provenBy,
      state,
      satisfiedBy: satisfied,
      closedBy: closed,
    };
  });

  // Gates are read from the current plan only, for the same reason criterion
  // state is: a gate an older plan declared and the newest one dropped is not
  // something this campaign is still stuck behind. A required criterion that no
  // contract declares can never close, so it counts as open here and is also
  // reported as an unknown reference — that is what explains the stuck gate.
  const closedCriterionIds = new Set(
    criteria
      .filter((criterion) => criterion.state === "closed")
      .map((criterion) => criterion.id),
  );
  const openGates = (currentPlan?.items ?? []).flatMap((item) => {
    if (item.nodeType !== "gate") return [];
    const required = item.requiresClosed ?? [];
    for (const criterionId of required) {
      if (!declaredIds.has(criterionId)) unknownReferences.add(criterionId);
    }
    const openCriterionIds = required.filter(
      (criterionId) => !closedCriterionIds.has(criterionId),
    );
    return openCriterionIds.length === 0
      ? []
      : [{ gateId: item.id, openCriterionIds }];
  });

  const orphanWorkItemIds: string[] = [];
  const seenOrphans = new Set<string>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.kind !== "work-item") continue;
    if (checkpoint.status !== "succeeded") continue;
    if (seenOrphans.has(checkpoint.id)) continue;
    const declared = planItemsById.get(checkpoint.id)?.satisfies ?? [];
    const anchored = declared.some((id) => declaredIds.has(id));
    if (anchored) continue;
    seenOrphans.add(checkpoint.id);
    orphanWorkItemIds.push(checkpoint.id);
  }

  const closedCount = criteria.filter(
    (criterion) => criterion.state === "closed",
  ).length;

  return {
    acceptanceId: contract.id,
    criteria,
    closedCount,
    inFlightCount: criteria.filter(
      (criterion) => criterion.state === "in-flight",
    ).length,
    uncoveredCount: criteria.filter(
      (criterion) => criterion.state === "uncovered",
    ).length,
    amendments,
    pendingAmendments,
    unauthorizedAcceptanceIds,
    openGates,
    unknownReferences: [...unknownReferences],
    orphanWorkItemIds,
    unanchoredProgress: closedCount === 0 && orphanWorkItemIds.length > 0,
  };
}
