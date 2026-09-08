import { z } from "zod";

export const threadStopExpectedTurnIdSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value);

export const conditionalThreadStopOutcomeSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("stopped"),
        expectedTurnId: threadStopExpectedTurnIdSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("refused"),
        expectedTurnId: threadStopExpectedTurnIdSchema,
        reason: z.enum([
          "turn-mismatch",
          "no-active-turn",
          "thread-not-active",
          "runtime-missing",
          "unproven",
        ]),
        activeTurnId: z.string().min(1).nullable(),
      })
      .strict(),
  ],
);

export type ConditionalThreadStopOutcome = z.infer<
  typeof conditionalThreadStopOutcomeSchema
>;
