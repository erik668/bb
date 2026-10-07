import { z } from "zod";

export const BROWSER_SNAPSHOT_MAX_BASE64_LENGTH = 8_388_608;
const BROWSER_IDENTIFIER_MAX_LENGTH = 256;
const BROWSER_URL_MAX_LENGTH = 4_096;
const BROWSER_DIMENSION_MAX = 16_384;

const browserIdentifierSchema = z
  .string()
  .min(1)
  .max(BROWSER_IDENTIFIER_MAX_LENGTH);
const browserHttpUrlSchema = z
  .string()
  .url()
  .max(BROWSER_URL_MAX_LENGTH)
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "Browser snapshot URL must use HTTP(S)");

export const browserGrantRequestSchema = z
  .object({
    controllerId: browserIdentifierSchema,
    tabId: browserIdentifierSchema,
    threadId: browserIdentifierSchema,
  })
  .strict();
export type BrowserGrantRequest = z.infer<typeof browserGrantRequestSchema>;

export const browserGrantSchema = z
  .object({
    controllerId: browserIdentifierSchema,
    generation: z.number().int().positive(),
    grantId: browserIdentifierSchema,
    tabId: browserIdentifierSchema,
    threadId: browserIdentifierSchema,
  })
  .strict();
export type BrowserGrant = z.infer<typeof browserGrantSchema>;

export const browserControllerCommandSchema = z
  .object({
    commandId: browserIdentifierSchema,
    type: z.literal("snapshot"),
  })
  .strict();
export type BrowserControllerCommand = z.infer<
  typeof browserControllerCommandSchema
>;

export const browserSnapshotSchema = z
  .object({
    data: z.string().min(1).max(BROWSER_SNAPSHOT_MAX_BASE64_LENGTH),
    height: z.number().int().positive().max(BROWSER_DIMENSION_MAX),
    mimeType: z.literal("image/jpeg"),
    tabId: browserIdentifierSchema,
    threadId: browserIdentifierSchema,
    url: browserHttpUrlSchema,
    width: z.number().int().positive().max(BROWSER_DIMENSION_MAX),
  })
  .strict();
export type BrowserSnapshot = z.infer<typeof browserSnapshotSchema>;

export const browserCommandOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({ snapshot: browserSnapshotSchema, status: z.literal("success") })
    .strict(),
  z
    .object({
      message: z.string().min(1).max(1_024),
      status: z.literal("error"),
    })
    .strict(),
]);
export type BrowserCommandOutcome = z.infer<typeof browserCommandOutcomeSchema>;

export const browserControllerConnectMessageSchema = z
  .object({
    ...browserGrantRequestSchema.shape,
    type: z.literal("browser-controller-connect"),
  })
  .strict();
export type BrowserControllerConnectMessage = z.infer<
  typeof browserControllerConnectMessageSchema
>;

export const browserControllerDisconnectMessageSchema = z
  .object({
    controllerId: browserIdentifierSchema,
    type: z.literal("browser-controller-disconnect"),
  })
  .strict();
export type BrowserControllerDisconnectMessage = z.infer<
  typeof browserControllerDisconnectMessageSchema
>;

export const browserControllerCompleteMessageSchema = z
  .object({
    commandId: browserIdentifierSchema,
    controllerId: browserIdentifierSchema,
    generation: z.number().int().positive(),
    grantId: browserIdentifierSchema,
    outcome: browserCommandOutcomeSchema,
    type: z.literal("browser-controller-complete"),
  })
  .strict();
export type BrowserControllerCompleteMessage = z.infer<
  typeof browserControllerCompleteMessageSchema
>;

export const browserControllerClientMessageSchema = z.discriminatedUnion(
  "type",
  [
    browserControllerConnectMessageSchema,
    browserControllerDisconnectMessageSchema,
    browserControllerCompleteMessageSchema,
  ],
);
export type BrowserControllerClientMessage = z.infer<
  typeof browserControllerClientMessageSchema
>;

export const browserControllerConnectedMessageSchema = z
  .object({
    grant: browserGrantSchema,
    type: z.literal("browser-controller-connected"),
  })
  .strict();
export type BrowserControllerConnectedMessage = z.infer<
  typeof browserControllerConnectedMessageSchema
>;

export const browserControllerCommandMessageSchema = z
  .object({
    command: browserControllerCommandSchema,
    controllerId: browserIdentifierSchema,
    generation: z.number().int().positive(),
    grantId: browserIdentifierSchema,
    type: z.literal("browser-controller-command"),
  })
  .strict();
export type BrowserControllerCommandMessage = z.infer<
  typeof browserControllerCommandMessageSchema
>;

export const browserControllerDisconnectedMessageSchema = z
  .object({
    controllerId: browserIdentifierSchema,
    message: z.string().min(1).max(1_024),
    type: z.literal("browser-controller-disconnected"),
  })
  .strict();
export type BrowserControllerDisconnectedMessage = z.infer<
  typeof browserControllerDisconnectedMessageSchema
>;

export const browserControllerServerMessageSchema = z.discriminatedUnion(
  "type",
  [
    browserControllerConnectedMessageSchema,
    browserControllerCommandMessageSchema,
    browserControllerDisconnectedMessageSchema,
  ],
);
export type BrowserControllerServerMessage = z.infer<
  typeof browserControllerServerMessageSchema
>;

export const browserSnapshotRequestSchema = z
  .object({ threadId: browserIdentifierSchema })
  .strict();
export type BrowserSnapshotRequest = z.infer<
  typeof browserSnapshotRequestSchema
>;
