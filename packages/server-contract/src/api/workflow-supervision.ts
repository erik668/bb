import { z } from "zod";
import { sourceInspectionSchema, workflowSourcePathSchema } from "@bb/domain";

export const inspectThreadSourceRequestSchema = z
  .object({
    projectId: z.string().min(1),
    hostId: z.string().min(1),
    ref: z.string().min(1),
    workflowPath: workflowSourcePathSchema,
  })
  .strict();
export type InspectThreadSourceRequest = z.infer<
  typeof inspectThreadSourceRequestSchema
>;
export const inspectThreadSourceResponseSchema = sourceInspectionSchema.extend({
  projectId: z.string().min(1),
  hostId: z.string().min(1),
});
export type InspectThreadSourceResponse = z.infer<
  typeof inspectThreadSourceResponseSchema
>;

export const supervisorAddressSchema = z
  .object({
    managerThreadId: z.string().min(1),
    campaignId: z.string().min(1).max(200),
    inboxId: z.string().min(1).max(200),
  })
  .strict();
export type SupervisorAddress = z.infer<typeof supervisorAddressSchema>;
export const supervisorCredentialSchema = supervisorAddressSchema.extend({
  bindingToken: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type SupervisorCredential = z.infer<typeof supervisorCredentialSchema>;
export const supervisorBindingSchema = supervisorCredentialSchema.extend({
  taskId: z.string().min(1).max(200),
});
export type SupervisorBinding = z.infer<typeof supervisorBindingSchema>;
export const registerSupervisorRequestSchema = supervisorAddressSchema.extend({
  bindingToken: supervisorCredentialSchema.shape.bindingToken.optional(),
});
export type RegisterSupervisorRequest = z.infer<
  typeof registerSupervisorRequestSchema
>;
export const supervisorInboxRequestSchema = supervisorAddressSchema
  .extend({
    afterKey: z.string().min(1).optional(),
    noticeKey: z.string().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .refine(
    (args) => args.noticeKey === undefined || args.afterKey === undefined,
    {
      message: "noticeKey and afterKey cannot be combined",
      path: ["noticeKey"],
    },
  );
export type SupervisorInboxRequest = z.infer<
  typeof supervisorInboxRequestSchema
>;
export const supervisorInboxItemSchema = z
  .object({
    key: z.string(),
    managerThreadId: z.string(),
    campaignId: z.string(),
    inboxId: z.string(),
    childThreadId: z.string().nullable(),
    taskId: z.string().nullable(),
    turnId: z.string().nullable(),
    kind: z.enum([
      "completion",
      "exception",
      "manual-interruption",
      "decision",
    ]),
    output: z.string().nullable(),
    createdAt: z.number(),
    queuedMessageId: z.string().nullable(),
    delivery: z.enum(["inbox", "queued", "requested"]),
    requestSequence: z.number().int().nullable(),
  })
  .strict();
export type SupervisorInboxItem = z.infer<typeof supervisorInboxItemSchema>;
export const supervisorInboxResponseSchema = z
  .object({
    items: z.array(supervisorInboxItemSchema),
    nextKey: z.string().nullable(),
  })
  .strict();
export type SupervisorInboxResponse = z.infer<
  typeof supervisorInboxResponseSchema
>;
export const supervisorPeekItemSchema = supervisorInboxItemSchema.extend({
  requestInputText: z.string(),
});
export const supervisorPeekResponseSchema = z
  .object({
    registration: z.enum(["present", "missing"]),
    items: z.array(supervisorPeekItemSchema),
    nextKey: z.string().nullable(),
  })
  .strict();
export type SupervisorPeekResponse = z.infer<
  typeof supervisorPeekResponseSchema
>;

export const supervisorNotifyRequestSchema = supervisorCredentialSchema.extend({
  key: z.string().min(1).max(200),
  taskId: z.string().min(1).max(200).nullable(),
  kind: z.enum(["decision", "exception"]),
  message: z.string().min(1).max(16_000),
});
export type SupervisorNotifyRequest = z.infer<
  typeof supervisorNotifyRequestSchema
>;
