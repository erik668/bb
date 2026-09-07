import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPackagedRuntime } from "./packaged-runtime-preflight.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const preparation = require("./prepare-native-modules.cjs");

export class PackagedNativeRuntimeError extends Error {
  constructor(code, detail, receiptPath = null) {
    super(
      `Packaged native runtime blocked: ${code}${receiptPath ? `; receipt: ${receiptPath}` : ""}`,
    );
    this.code = code;
    this.detail = detail;
    this.receiptPath = receiptPath;
  }
}

function validName(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !/[\\/]/.test(value)
  );
}

export async function pinnedElectronVersion() {
  const metadata = JSON.parse(
    await readFile(join(desktopRoot, "package.json"), "utf8"),
  );
  const version = metadata.devDependencies?.electron;
  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/.test(version)
  ) {
    throw new PackagedNativeRuntimeError("ELECTRON_PIN_INVALID", {
      version: version ?? null,
    });
  }
  return version;
}

export async function configuredDesktopArchitecture(platform) {
  const config = JSON.parse(
    await readFile(join(desktopRoot, "electron-builder.config.json"), "utf8"),
  );
  const target =
    platform === "darwin"
      ? config.mac?.target
      : platform === "linux"
        ? config.linux?.target
        : null;
  const architectures = new Set(
    Array.isArray(target)
      ? target.flatMap((item) =>
          Array.isArray(item?.arch) ? item.arch : [null],
        )
      : [],
  );
  if (
    architectures.size !== 1 ||
    !["arm64", "x64"].includes([...architectures][0])
  ) {
    throw new PackagedNativeRuntimeError("PACKAGING_TARGET_INVALID", {
      platform,
      architectures: [...architectures],
    });
  }
  return [...architectures][0];
}

export async function resolveAfterPackTarget(context) {
  const { Arch } = require("electron-builder");
  const arch = Number.isInteger(context.arch) ? Arch[context.arch] : null;
  const platform = context.electronPlatformName;
  if (
    !["arm64", "x64"].includes(arch) ||
    !["darwin", "linux"].includes(platform) ||
    !isAbsolute(context.appOutDir ?? "")
  ) {
    throw new PackagedNativeRuntimeError("PACKAGING_TARGET_INVALID", {
      arch: context.arch,
      platform,
    });
  }
  const name =
    platform === "darwin"
      ? context.packager?.appInfo?.productFilename
      : context.packager?.executableName;
  if (!validName(name))
    throw new PackagedNativeRuntimeError("PACKAGING_EXECUTABLE_INVALID", {
      name: name ?? null,
    });
  const executable =
    platform === "darwin"
      ? join(context.appOutDir, `${name}.app`, "Contents", "MacOS", name)
      : join(context.appOutDir, name);
  return {
    appOutDir: context.appOutDir,
    executable,
    arch,
    platform,
    electronVersion: await pinnedElectronVersion(),
  };
}

export async function packagedNativeRequest({
  appOutDir,
  executable,
  arch,
  platform,
  electronVersion,
}) {
  if (!isAbsolute(appOutDir ?? "") || !isAbsolute(executable ?? ""))
    throw new PackagedNativeRuntimeError("PACKAGING_PATH_INVALID", {});
  const artifactRoot = await realpath(appOutDir);
  const actualExecutable = await realpath(executable);
  const executableRelative = relative(artifactRoot, actualExecutable);
  if (
    executableRelative === ".." ||
    executableRelative.startsWith("../") ||
    isAbsolute(executableRelative)
  ) {
    throw new PackagedNativeRuntimeError("PACKAGED_EXECUTABLE_ESCAPE", {
      executable: actualExecutable,
      artifactRoot,
    });
  }
  const names = preparation.PACKAGED_NATIVE_PACKAGE_NAMES;
  const found = await preparation.findPackageDirectories(artifactRoot, names);
  const modules = names.flatMap((name) => {
    const roots = found.get(name);
    if (roots.length === 0)
      throw new PackagedNativeRuntimeError("PACKAGED_NATIVE_MODULE_MISSING", {
        name,
      });
    return roots.sort().map((root) => ({ name, root }));
  });
  return {
    artifactRoot,
    executable: actualExecutable,
    expected: { family: "electron", version: electronVersion, platform, arch },
    modules,
    lockfile: resolve(desktopRoot, "../../pnpm-lock.yaml"),
  };
}

export async function checkPackagedNativeRuntime(
  target,
  phase,
  { allowNativeLoadFailure = false } = {},
) {
  if (!["before-preparation", "after-pack", "smoke"].includes(phase))
    throw new PackagedNativeRuntimeError("PACKAGING_PHASE_INVALID", { phase });
  const request = await packagedNativeRequest(target);
  const result = inspectPackagedRuntime(request);
  const receiptPath = join(
    dirname(request.artifactRoot),
    `${target.platform}-${target.arch}-${phase}.native-runtime.json`,
  );
  const temporary = `${receiptPath}.${randomUUID()}.tmp`;
  await mkdir(dirname(receiptPath), { recursive: true });
  try {
    await writeFile(
      temporary,
      JSON.stringify({ phase, ...result }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await rename(temporary, receiptPath);
  } finally {
    await rm(temporary, { force: true });
  }
  if (
    !result.passed &&
    !(allowNativeLoadFailure && result.blocker.code === "NATIVE_LOAD_FAILED")
  ) {
    throw new PackagedNativeRuntimeError(
      result.blocker.code,
      result.blocker.detail,
      receiptPath,
    );
  }
  return { receiptPath, result };
}
