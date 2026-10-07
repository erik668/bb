/**
 * Definition-level rollout gates are fail-closed for stored rows created by
 * older plugin versions.  Keeping this policy separate makes the settlement
 * boundary explicit without granting a process-wide settings toggle.
 */
export function workflowArtifactLiveChangesEnabled(
  value: boolean | undefined,
): boolean {
  return value === true;
}
