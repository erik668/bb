import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const sdkRoot = join(packageRoot, "packages", "plugin-sdk");
const workflowsRoot = join(packageRoot, "plugins", "workflows");
const typescriptCli = resolve(
  dirname(fileURLToPath(import.meta.resolve("typescript"))),
  "..",
  "bin",
  "tsc",
);
const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));

const entries = [
  ["root", "src/index.ts", "dist/index.js", "bundled-types/bb-plugin-sdk.d.ts"],
  ["provider-bridge", "src/provider-bridge.ts", "dist/provider-bridge.js", "bundled-types/bb-plugin-sdk-provider-bridge.d.ts"],
  ["app", "src/app.ts", "dist/app.js", "bundled-types/bb-plugin-sdk-app.d.ts"],
  ["host", "src/host.ts", "dist/host.js", "bundled-types/bb-plugin-sdk-host.d.ts"],
  ["internal-composer-customization-validation", "src/internal/composer-customization-validation.ts", "dist/internal/composer-customization-validation.js", "bundled-types/bb-plugin-sdk-internal-composer-customization-validation.d.ts"],
  ["internal-composer-view", "src/internal/composer-view.ts", "dist/internal/composer-view.js", "bundled-types/bb-plugin-sdk-internal-composer-view.d.ts"],
  ["internal-file-navigation-validation", "src/internal/file-navigation-validation.ts", "dist/internal/file-navigation-validation.js", "bundled-types/bb-plugin-sdk-internal-file-navigation-validation.d.ts"],
  ["internal-host-policy", "src/internal/host-policy.ts", "dist/internal/host-policy.js", "bundled-types/bb-plugin-sdk-internal-host-policy.d.ts"],
  ["internal-plugin-app-collector", "src/internal/plugin-app-collector.ts", "dist/internal/plugin-app-collector.js", "bundled-types/bb-plugin-sdk-internal-plugin-app-collector.d.ts"],
  ["testing", "src/testing/index.ts", "dist/testing/index.js", "bundled-types/bb-plugin-sdk-testing.d.ts"],
  ["testing-app", "src/testing/app.tsx", "dist/testing/app.js", "bundled-types/bb-plugin-sdk-testing-app.d.ts"],
  ["testing-host", "src/testing/host.ts", "dist/testing/host.js", "bundled-types/bb-plugin-sdk-testing-host.d.ts"],
] as const;

export type SdkRowSpec = Readonly<{
  name: string;
  kind: "source-import" | "consumer-resolve" | "consumer-import" | "runtime-import" | "declaration-compile" | "workflows-typecheck";
  target?: string;
  specifier?: string;
}>;

export const SDK_ROW_SPECS: readonly SdkRowSpec[] = [
  { name: "source-entry", kind: "source-import", target: join(sdkRoot, entries[0][1]) },
  { name: "clean-consumer-resolution", kind: "consumer-resolve", specifier: "@get-bb/plugin-sdk" },
  { name: "clean-consumer-import", kind: "consumer-import", specifier: "@get-bb/plugin-sdk" },
  { name: "direct-dist-import", kind: "runtime-import", target: join(sdkRoot, entries[0][2]) },
  { name: "direct-dist-testing-import", kind: "runtime-import", target: join(sdkRoot, entries[9][2]) },
  ...entries.map(([name, , runtime]) => ({
    name: `runtime-entry-${name}`,
    kind: "runtime-import" as const,
    target: join(sdkRoot, runtime),
  })),
  ...entries.map(([name, , , declaration]) => ({
    name: `declaration-entry-${name}`,
    kind: "declaration-compile" as const,
    target: join(sdkRoot, declaration),
  })),
  { name: "workflows-typecheck", kind: "workflows-typecheck" },
];

export type SdkRoots = Readonly<{
  packageRoot: string;
  commandRoot: string;
  buildRoot: string;
  cacheRoot: string;
}>;

const opaqueName = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");

const nodeReadGrants = (paths: readonly string[]): string[] =>
  paths.map((path) => `--allow-fs-read=${path}`);

const writeRunner = (roots: SdkRoots, source: string): string => {
  const path = join(roots.commandRoot, opaqueName(source));
  writeFileSync(path, source, { flag: "wx" });
  return path;
};

export const prepareSdkCommand = (
  row: SdkRowSpec,
  roots: SdkRoots,
): Readonly<{ argv: string[]; readGrants: string[]; writeGrants: string[] }> => {
  const outputPath = join(roots.buildRoot, opaqueName(row.name));
  const cachePath = join(roots.cacheRoot, opaqueName(`${row.name}:cache`));

  if (row.kind === "consumer-resolve" || row.kind === "consumer-import") {
    const scope = join(roots.packageRoot, "node_modules", "@get-bb");
    mkdirSync(scope, { recursive: true });
    symlinkSync(sdkRoot, join(scope, "plugin-sdk"), "dir");
    const runner = writeRunner(
      roots,
      `import { createHash } from "node:crypto";\nimport { writeFileSync } from "node:fs";\nimport { createRequire } from "node:module";\nimport { join } from "node:path";\nconst [packageRoot, outputPath, cachePath, mode, specifier] = process.argv.slice(2);\nconst require = createRequire(join(packageRoot, "entry.mjs"));\nconst resolved = require.resolve(specifier);\nconst value = mode === "import" ? Object.keys(await import(resolved)).sort() : [resolved];\nconst bytes = Buffer.from(JSON.stringify(value));\nwriteFileSync(outputPath, bytes, { flag: "wx" });\nwriteFileSync(cachePath, createHash("sha256").update(bytes).digest("hex"), { flag: "wx" });\nprocess.stdout.write(createHash("sha256").update(bytes).digest("hex"));`,
    );
    return {
      argv: [
        process.execPath,
        "--permission",
        ...nodeReadGrants([runner, roots.packageRoot, sdkRoot]),
        `--allow-fs-write=${roots.buildRoot}`,
        `--allow-fs-write=${roots.cacheRoot}`,
        runner,
        roots.packageRoot,
        outputPath,
        cachePath,
        row.kind === "consumer-import" ? "import" : "resolve",
        row.specifier!,
      ],
      readGrants: [roots.commandRoot, roots.packageRoot, sdkRoot],
      writeGrants: [roots.buildRoot, roots.cacheRoot],
    };
  }

  if (row.kind === "runtime-import" || row.kind === "source-import") {
    const runner = writeRunner(
      roots,
      `import { createHash } from "node:crypto";\nimport { writeFileSync } from "node:fs";\nimport { pathToFileURL } from "node:url";\nconst [target, outputPath, cachePath] = process.argv.slice(2);\nconst value = Object.keys(await import(pathToFileURL(target).href)).sort();\nconst bytes = Buffer.from(JSON.stringify(value));\nwriteFileSync(outputPath, bytes, { flag: "wx" });\nwriteFileSync(cachePath, createHash("sha256").update(bytes).digest("hex"), { flag: "wx" });\nprocess.stdout.write(createHash("sha256").update(bytes).digest("hex"));`,
    );
    const sourceLoader = row.kind === "source-import" ? ["--import", tsxLoader] : [];
    return {
      argv: [
        process.execPath,
        "--permission",
        ...nodeReadGrants([runner, row.target!, sdkRoot, tsxLoader]),
        `--allow-fs-write=${roots.buildRoot}`,
        `--allow-fs-write=${roots.cacheRoot}`,
        ...sourceLoader,
        runner,
        row.target!,
        outputPath,
        cachePath,
      ],
      readGrants: [roots.commandRoot, row.target!, sdkRoot, tsxLoader],
      writeGrants: [roots.buildRoot, roots.cacheRoot],
    };
  }

  if (row.kind === "declaration-compile") {
    const consumerPath = join(roots.packageRoot, opaqueName(row.name) + ".ts");
    writeFileSync(
      consumerPath,
      `import type * as Surface from ${JSON.stringify(row.target)};\nexport type Observed = typeof Surface;\n`,
      { flag: "wx" },
    );
    return {
      argv: [
        process.execPath,
        "--permission",
        ...nodeReadGrants([typescriptCli, roots.packageRoot, sdkRoot, join(packageRoot, "node_modules")]),
        typescriptCli,
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        consumerPath,
      ],
      readGrants: [typescriptCli, roots.packageRoot, sdkRoot, join(packageRoot, "node_modules")],
      writeGrants: [],
    };
  }

  return {
    argv: [
      process.execPath,
      "--permission",
      ...nodeReadGrants([typescriptCli, workflowsRoot, join(packageRoot, "node_modules"), sdkRoot]),
      typescriptCli,
      "--noEmit",
      "-p",
      join(workflowsRoot, "tsconfig.json"),
    ],
    readGrants: [typescriptCli, workflowsRoot, join(packageRoot, "node_modules"), sdkRoot],
    writeGrants: [],
  };
};
