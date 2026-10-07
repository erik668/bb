import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = "/Users/erik/.bb/personal-workspaces/env_88g5eb749t/bb-workflow-details";
const MODULE_ABI = Object.freeze({
  "apps/server/scripts/generate-workflows-plugin-migration-authority.mjs": ["generateWorkflowsPluginMigrationAuthority"],
  "apps/server/src/services/plugins/generated/workflows-plugin-migration-authority.generated.ts": ["WORKFLOWS_PLUGIN_MIGRATION_AUTHORITY"],
  "apps/server/src/services/plugins/plugin-migration-authority-registry.ts": ["getPluginMigrationAuthority"],
  "apps/server/src/services/plugins/host-owned-plugin-transaction.ts": ["runHostOwnedPluginTransaction"],
  "apps/server/src/services/plugins/host-transaction-phase-controller.ts": ["createHostTransactionPhaseController"]
});
const PACKAGE_PATH = "apps/server/package.json";

function rejectSubstitution() {
  const forbiddenArg = process.argv.slice(2).find((value) => /^--(module|candidate|import|loader|require)(=|$)/.test(value));
  const forbiddenEnv = Object.keys(process.env).find((key) => /^F3_(MODULE|CANDIDATE|IMPORT|LOADER)_/.test(key));
  if (forbiddenArg || forbiddenEnv) throw new Error("CALLER_MODULE_SUBSTITUTION_REJECTED");
}

function parseArgs(argv) {
  rejectSubstitution();
  if (argv.length === 3 && argv[0] === "--mode=abi-self-check" && argv[1] === "--topology") {
    return { mode: "abi-self-check", topologyPath: resolve(argv[2]) };
  }
  if (argv.length === 5 && argv[0] === "--mode=candidate" && argv[1] === "--topology" && argv[3] === "--recorder-root") {
    return { mode: "candidate", topologyPath: resolve(argv[2]), recorderRoot: resolve(argv[4]) };
  }
  throw new Error("CANDIDATE_ENTRY_ARGV_INVALID");
}

function assertFrozenAbi(topology) {
  if (topology.repoRoot !== REPO_ROOT || topology.candidate.callerModuleSubstitution !== false) throw new Error("CANDIDATE_ABI_TOPOLOGY_INVALID");
  if (JSON.stringify(topology.candidate.namedExports) !== JSON.stringify(MODULE_ABI)) throw new Error("CANDIDATE_NAMED_EXPORT_ABI_MISMATCH");
  const expectedPaths = [...Object.keys(MODULE_ABI), PACKAGE_PATH];
  if (JSON.stringify(topology.candidate.paths.map((entry) => entry.path)) !== JSON.stringify(expectedPaths)) throw new Error("CANDIDATE_PATH_ABI_MISMATCH");
  return { mode: "abi-self-check", callerModuleSubstitution: false, paths: expectedPaths, namedExports: MODULE_ABI };
}

async function importCandidates() {
  const modules = {};
  for (const [relativePath, exportNames] of Object.entries(MODULE_ABI)) {
    const module = await import(pathToFileURL(join(REPO_ROOT, relativePath)).href);
    for (const exportName of exportNames) {
      if (!(exportName in module)) throw new Error(`CANDIDATE_EXPORT_MISSING:${relativePath}:${exportName}`);
    }
    modules[relativePath] = module;
  }
  return modules;
}

async function executeNamedExports(modules, packageJson, recorderRoot) {
  const generator = modules["apps/server/scripts/generate-workflows-plugin-migration-authority.mjs"].generateWorkflowsPluginMigrationAuthority;
  const generatedAuthority = modules["apps/server/src/services/plugins/generated/workflows-plugin-migration-authority.generated.ts"].WORKFLOWS_PLUGIN_MIGRATION_AUTHORITY;
  const registryLookup = modules["apps/server/src/services/plugins/plugin-migration-authority-registry.ts"].getPluginMigrationAuthority;
  const runTransaction = modules["apps/server/src/services/plugins/host-owned-plugin-transaction.ts"].runHostOwnedPluginTransaction;
  const createPhaseController = modules["apps/server/src/services/plugins/host-transaction-phase-controller.ts"].createHostTransactionPhaseController;
  const generated = await generator();
  const registered = await registryLookup("workflows");
  const controller = createPhaseController();
  if (typeof runTransaction !== "function" || typeof controller !== "object") throw new Error("CANDIDATE_PRODUCTION_EXPORT_NOT_EXECUTABLE");
  const authorityMigrations = Array.isArray(generatedAuthority) ? generatedAuthority : generatedAuthority?.migrations;
  if (!Array.isArray(authorityMigrations) || authorityMigrations.length !== 23) throw new Error("CANDIDATE_MIGRATION_VECTOR_INVALID");
  if (authorityMigrations.some((migration, index) => (migration.index ?? migration.migrationIndex ?? index) !== index)) throw new Error("CANDIDATE_MIGRATION_ORDER_INVALID");
  if (JSON.stringify(generated) !== JSON.stringify(generatedAuthority) || JSON.stringify(registered) !== JSON.stringify(generatedAuthority)) throw new Error("CANDIDATE_AUTHORITY_DIVERGENCE");
  const transactionResult = await runTransaction({
    pluginId: "workflows",
    databasePath: join(recorderRoot, "candidate-neutral.sqlite"),
    beginMode: "IMMEDIATE",
    migrationAuthority: registered,
    phaseController: controller
  });
  if (transactionResult !== undefined) throw new Error("CANDIDATE_TRANSACTION_RESULT_NOT_PRIVATE");
  return {
    generatorExecuted: true,
    generatorOutput: generated,
    generatedAuthority,
    registryAuthority: registered,
    transactionExportExecuted: true,
    phaseControllerExecuted: true,
    packageWiring: {
      generatorScript: packageJson.scripts?.["generate:workflows-plugin-migration-authority"] ?? null,
      tsx: packageJson.devDependencies?.tsx ?? packageJson.dependencies?.tsx ?? null,
      betterSqlite3: packageJson.dependencies?.["better-sqlite3"] ?? null
    }
  };
}

const args = parseArgs(process.argv.slice(2));
const topology = JSON.parse(await readFile(args.topologyPath, "utf8"));
const abi = assertFrozenAbi(topology);
if (args.mode === "abi-self-check") {
  process.stdout.write(JSON.stringify(abi));
} else {
  if (dirname(args.recorderRoot) === args.recorderRoot || args.recorderRoot.startsWith(REPO_ROOT)) throw new Error("CANDIDATE_RECORDER_ROOT_INVALID");
  const modules = await importCandidates();
  const packageJson = JSON.parse(await readFile(join(REPO_ROOT, PACKAGE_PATH), "utf8"));
  const executed = await executeNamedExports(modules, packageJson, args.recorderRoot);
  if (!executed.packageWiring.generatorScript || !executed.packageWiring.tsx || !executed.packageWiring.betterSqlite3) throw new Error("CANDIDATE_PACKAGE_WIRING_INVALID");
  process.stdout.write(JSON.stringify(executed));
}
