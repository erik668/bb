import { z } from "zod";

export const gitObjectIdSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
export const workflowSourcePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value === "." ||
      value
        .split("/")
        .every(
          (part) =>
            part !== "" &&
            part !== "." &&
            part !== ".." &&
            !/[:\\\u0000-\u001f]/u.test(part),
        ),
    "Workflow path must be a relative Git tree path",
  );
export const sourceInspectionSchema = z
  .object({
    repositoryPath: z.string().min(1),
    repositoryIdentity: z.string().min(1),
    commit: gitObjectIdSchema.nullable(),
    tree: gitObjectIdSchema.nullable(),
    workflowPath: workflowSourcePathSchema,
    workflowTree: gitObjectIdSchema.nullable(),
    head: gitObjectIdSchema.nullable(),
    clean: z.boolean(),
  })
  .strict();
export type SourceInspection = z.infer<typeof sourceInspectionSchema>;

export const sourcePinSchema = z
  .object({
    projectId: z.string().min(1),
    hostId: z.string().min(1),
    repositoryPath: z.string().min(1),
    repositoryIdentity: z.string().min(1),
    commit: gitObjectIdSchema,
    tree: gitObjectIdSchema,
    workflowPath: workflowSourcePathSchema,
    workflowTree: gitObjectIdSchema,
    pathPolicy: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("exact"), path: z.string().min(1) }).strict(),
      z.object({ kind: z.literal("new-worktree") }).strict(),
    ]),
    discoveryRef: z.string().min(1).optional(),
  })
  .strict();
export type SourcePin = z.infer<typeof sourcePinSchema>;
