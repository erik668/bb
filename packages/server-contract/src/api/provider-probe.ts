import { z } from "zod";
import { reasoningLevelSchema } from "@bb/domain";
import { providerProbeResultSchema } from "@bb/host-daemon-contract";

export const providerProbeRequestSchema = z
  .object({
    providerId: z.string().min(1),
    hostId: z.string().min(1).optional(),
    environmentId: z.string().min(1).optional(),
    model: z.string().min(1),
    reasoningLevel: reasoningLevelSchema,
  })
  .strict()
  .refine(
    (args) =>
      (args.hostId === undefined) !== (args.environmentId === undefined),
    "Exactly one hostId or environmentId is required",
  );
export type ProviderProbeRequest = z.infer<typeof providerProbeRequestSchema>;
export const providerProbeResponseSchema = providerProbeResultSchema.extend({
  version: z.literal(1),
  mode: z.literal("cached-only-no-retry"),
  providerId: z.string(),
  hostId: z.string().nullable(),
  environmentId: z.string().nullable(),
  model: z.string(),
  reasoningLevel: reasoningLevelSchema,
  bridge: z
    .object({
      pluginId: z.string(),
      digest: z.string(),
      byteLength: z.number(),
    })
    .strict()
    .nullable(),
  hostRpcAttempts: z.union([z.literal(0), z.literal(1)]),
  modelCalls: z.literal(0),
  workerCalls: z.literal(0),
  execution: z.literal("unproven"),
});
export type ProviderProbeResponse = z.infer<typeof providerProbeResponseSchema>;
