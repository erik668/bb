import { z } from "zod";
import {
  type WorkflowAcceptanceCriterion,
  type WorkflowCheckpoint,
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
     * Acceptance checkpoints published after the first with a different
     * criteria body. Until campaign-scoped immutability is enforced, a
     * rewritten contract is the drift, so it is surfaced rather than silently
     * adopted.
     */
    amendmentCount: z.number().int().nonnegative(),
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

function canonicalCriteria(criteria: readonly WorkflowAcceptanceCriterion[]) {
  return JSON.stringify(
    [...criteria]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((criterion) => [
        criterion.id,
        criterion.statement,
        criterion.provenBy,
      ]),
  );
}

/**
 * Derives coverage from one campaign's checkpoints in chronological order.
 *
 * Returns `null` when the campaign declared no acceptance contract. Absence is
 * reported as absence: inferring criteria from the plan would measure the plan
 * against itself and always agree.
 */
export function deriveAcceptanceCoverage(
  checkpoints: readonly WorkflowCheckpoint[],
): WorkflowAcceptanceCoverage | null {
  const acceptances = checkpoints.filter(
    (checkpoint) => checkpoint.kind === "acceptance",
  );
  const contract = acceptances[0];
  if (contract === undefined) return null;

  const baseline = canonicalCriteria(contract.criteria);
  const amendmentCount = acceptances
    .slice(1)
    .filter((later) => canonicalCriteria(later.criteria) !== baseline).length;

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
    amendmentCount,
    unknownReferences: [...unknownReferences],
    orphanWorkItemIds,
    unanchoredProgress: closedCount === 0 && orphanWorkItemIds.length > 0,
  };
}
