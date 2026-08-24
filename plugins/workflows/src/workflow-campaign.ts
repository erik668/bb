import { z } from "zod";

export const MAX_WORKFLOW_RUNS_PER_CAMPAIGN = 100;

/**
 * Campaign inspection keeps every run summary visible, but only hydrates this
 * many checkpoint ledgers. Each ledger is independently capped at 4 MiB, so
 * this bounds the campaign checkpoint payload to 16 MiB.
 */
export const MAX_WORKFLOW_CAMPAIGN_DETAILED_RUNS = 4;

export const workflowCampaignIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
