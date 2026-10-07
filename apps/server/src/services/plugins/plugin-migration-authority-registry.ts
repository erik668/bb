import { WORKFLOWS_PLUGIN_MIGRATION_AUTHORITY } from "./generated/workflows-plugin-migration-authority.generated.js";

/** Server-private migration authority selected only by the host plugin id. */
export function getPluginMigrationAuthority(hostPluginId: string) {
  if (hostPluginId !== WORKFLOWS_PLUGIN_MIGRATION_AUTHORITY.pluginId) {
    throw new Error(`No host migration authority for plugin ${hostPluginId}`);
  }
  return WORKFLOWS_PLUGIN_MIGRATION_AUTHORITY;
}
