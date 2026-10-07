import { open, lstat } from "node:fs/promises";
import { join } from "node:path";

export const DENIED_RELATIVE_PATHS = Object.freeze([
  "apps/server/scripts/generate-workflows-plugin-migration-authority.mjs",
  "apps/server/src/services/plugins/generated/workflows-plugin-migration-authority.generated.ts",
  "apps/server/src/services/plugins/plugin-migration-authority-registry.ts",
  "apps/server/src/services/plugins/host-owned-plugin-transaction.ts",
  "apps/server/src/services/plugins/host-transaction-phase-controller.ts",
  "apps/server/package.json",
  "apps/server/src/services/plugins/artifact-review-v3-host-foundation.test.ts",
  "apps/server/src/services/plugins/test-fixtures/artifact-review-v3-host-foundation-child.ts",
  "apps/server/src/services/plugins/artifact-review-v3-host-foundation-reopen-observer.ts",
  "apps/server/src/services/plugins/artifact-review-v3-host-foundation-alternate-observer.ts",
  "apps/server/src/services/plugins/test-fixtures/artifact-review-v3-host-foundation-f2-child.ts",
  "apps/server/src/services/plugins/artifact-review-v3-host-foundation-f2-reopen-observer.ts",
  "apps/server/src/services/plugins/artifact-review-v3-host-foundation-f2-alternate-observer.ts",
  "apps/server/src/services/plugins/artifact-review-v3-host-foundation-f2.test.ts"
]);

async function expectDenied(operation, path) {
  try {
    await operation(path);
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EACCES")) return error.code;
    throw new Error(`DENIAL_PROBE_WRONG_ERROR:${path}:${error?.code ?? error}`);
  }
  throw new Error(`DENIAL_PROBE_UNEXPECTED_ACCESS:${path}`);
}

export async function runDeliberateAccessAudit(repoRoot) {
  const receipts = [];
  for (const relativePath of DENIED_RELATIVE_PATHS) {
    const absolutePath = join(repoRoot, relativePath);
    const readCode = await expectDenied(async (path) => {
      const handle = await open(path, "r");
      await handle.close();
    }, absolutePath);
    const metadataCode = await expectDenied(lstat, absolutePath);
    const writeCode = await expectDenied(async (path) => {
      const handle = await open(path, "a");
      await handle.close();
    }, absolutePath);
    receipts.push({ relativePath, readCode, metadataCode, writeCode });
  }
  return {
    deliberateDenied: receipts.length,
    expectedDenied: DENIED_RELATIVE_PATHS.length,
    legitimateForbiddenAttempts: 0,
    operationsPerPath: 3,
    receipts
  };
}

export function assertLegitimatePath(path, allowedRoots) {
  if (!allowedRoots.some((root) => path === root || path.startsWith(`${root}/`))) {
    throw new Error(`LEGITIMATE_PATH_OUTSIDE_CLOSURE:${path}`);
  }
}
