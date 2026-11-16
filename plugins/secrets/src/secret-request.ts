import { z } from "zod";

export const SECRET_REQUEST_RENDERER_ID = "secret-request";

const SECRET_VALUE_MAX_LENGTH = 16 * 1024;

export const secretNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);

export const secretRequestPayloadSchema = z.object({
  purpose: z.string().min(1).nullable(),
  destination: z.object({ kind: z.literal("dotenv"), path: z.string().min(1) }),
  fields: z
    .array(
      z.object({
        name: secretNameSchema,
        description: z.string().min(1).nullable(),
        optional: z.boolean(),
      }),
    )
    .min(1),
});

const secretValueSchema = z
  .string()
  .min(1)
  .max(SECRET_VALUE_MAX_LENGTH)
  .refine((value) => !value.includes("\n") && !value.includes("\r"), {
    message: "Secret values must be single-line strings",
  })
  .refine((value) => !value.includes("\0"), {
    message: "Secret values must not contain NUL",
  });

export const secretRequestResponseSchema = z.object({
  values: z.record(secretNameSchema, secretValueSchema),
});

export type SecretRequestField = z.infer<
  typeof secretRequestPayloadSchema
>["fields"][number];

export function compareSubmittedNames(
  fields: readonly SecretRequestField[],
  submittedNames: readonly string[],
): { missing: string[]; unexpected: string[] } {
  const submitted = new Set(submittedNames);
  const requested = new Set(fields.map((field) => field.name));
  return {
    missing: fields
      .filter((field) => !field.optional && !submitted.has(field.name))
      .map((field) => field.name),
    unexpected: submittedNames.filter((name) => !requested.has(name)),
  };
}
