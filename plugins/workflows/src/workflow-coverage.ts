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
     * Declared amendments in ledger order. The write path refuses a changed
     * contract that does not declare itself, so a campaign whose scope really
     * did change ends up with a readable chain instead of a rewritten anchor.
     */
    amendments: z.array(acceptanceAmendmentRecordSchema),
    /**
     * Acceptance checkpoints whose body differs from the authoritative contract
     * without declaring an amendment. The write path refuses these, so a
     * non-empty list means the ledger was written outside the tool path — the
     * reason this is re-derived on read rather than trusting the newest row.
     */
    unauthorizedAcceptanceIds: z.array(z.string()),
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
  const original = acceptances[0];
  if (original === undefined) return null;

  // The authoritative contract is the head of the declared amendment chain, not
  // simply the newest acceptance checkpoint. A campaign whose scope legitimately
  // changed is measured against what it amended to; a contract that changed
  // without saying so is reported and does NOT take over, so editing the ledger
  // directly cannot make coverage agree with a rewrite.
  //
  // An amendment is accepted here when it names any earlier acceptance
  // checkpoint. The write path already refuses one that names a predecessor the
  // campaign never published, so the read side only has to separate a declared
  // amendment from an undeclared rewrite.
  let contract = original;
  const amendments: AcceptanceAmendmentRecord[] = [];
  const unauthorizedAcceptanceIds: string[] = [];
  const seenAcceptanceIds = new Set([original.id]);
  for (const later of acceptances.slice(1)) {
    const changed =
      canonicalizeAcceptanceCriteria(later.criteria) !==
      canonicalizeAcceptanceCriteria(contract.criteria);
    if (!changed) {
      seenAcceptanceIds.add(later.id);
      continue;
    }
    const amends = later.amends;
    if (amends !== undefined && seenAcceptanceIds.has(amends.supersedes)) {
      amendments.push({
        acceptanceId: later.id,
        supersedes: amends.supersedes,
        reason: amends.reason,
      });
      contract = later;
    } else {
      unauthorizedAcceptanceIds.push(later.id);
    }
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
    unauthorizedAcceptanceIds,
    unknownReferences: [...unknownReferences],
    orphanWorkItemIds,
    unanchoredProgress: closedCount === 0 && orphanWorkItemIds.length > 0,
  };
}
