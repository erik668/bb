import { z } from "zod";

const maintenancePolicySchema = z.enum(["standard", "cache-only"]);

export function codexMaintenancePolicy(): z.infer<
  typeof maintenancePolicySchema
> {
  return maintenancePolicySchema.parse(
    process.env.BB_CODEX_MAINTENANCE_POLICY ?? "standard",
  );
}
