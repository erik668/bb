import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import {
  checkPackagedNativeRuntime,
  configuredDesktopArchitecture,
  packagedNativeRequest,
  pinnedElectronVersion,
  resolveAfterPackTarget,
} from "../scripts/packaged-native-gate.mjs";
import afterPack from "../scripts/prepare-native-modules.cjs";

const require = createRequire(import.meta.url);
const { Arch } = require("electron-builder");

test("release target uses the declared platform and architecture and rejects missing or unknown targets", async () => {
  const context = {
    appOutDir: "/tmp/release/mac-arm64",
    arch: Arch.arm64,
    electronPlatformName: "darwin",
    packager: { appInfo: { productFilename: "BB Test" } },
  };
  const target = await resolveAfterPackTarget(context);
  assert.equal(
    target.executable,
    "/tmp/release/mac-arm64/BB Test.app/Contents/MacOS/BB Test",
  );
  assert.equal(target.arch, "arm64");
  assert.equal(target.electronVersion, await pinnedElectronVersion());
  for (const changed of [
    { arch: undefined },
    { arch: 999 },
    { arch: "arm64" },
    { electronPlatformName: undefined },
    { electronPlatformName: "win32" },
  ])
    await assert.rejects(resolveAfterPackTarget({ ...context, ...changed }), {
      code: "PACKAGING_TARGET_INVALID",
    });
  await assert.rejects(
    resolveAfterPackTarget({
      ...context,
      packager: { appInfo: { productFilename: "../escape" } },
    }),
    { code: "PACKAGING_EXECUTABLE_INVALID" },
  );
  const linux = await resolveAfterPackTarget({
    ...context,
    arch: Arch.x64,
    electronPlatformName: "linux",
    packager: { executableName: "bb-nightly" },
  });
  assert.equal(linux.executable, join(context.appOutDir, "bb-nightly"));
  assert.equal(linux.arch, "x64");
  assert.equal(await configuredDesktopArchitecture("darwin"), "arm64");
  assert.equal(await configuredDesktopArchitecture("linux"), "x64");
  await assert.rejects(configuredDesktopArchitecture("unknown"), {
    code: "PACKAGING_TARGET_INVALID",
  });
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "bb-packaged-native-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appOutDir = join(root, "mac-arm64"),
    executable = join(appOutDir, "Fixture.app/Contents/MacOS/Fixture");
  await mkdir(join(appOutDir, "Fixture.app/Contents/MacOS"), {
    recursive: true,
  });
  await copyFile(process.execPath, executable, constants.COPYFILE_FICLONE);
  const moduleRoot = join(
    appOutDir,
    "Fixture.app/Contents/Resources/node_modules",
  );
  for (const name of ["better-sqlite3", "node-pty"]) {
    const packageRoot = join(moduleRoot, name);
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name, version: "1.0.0", main: "index.cjs" }),
    );
    await writeFile(
      join(packageRoot, "index.cjs"),
      "throw new Error('module code must not execute before runtime verification');\n",
    );
  }
  return {
    root,
    moduleRoot,
    target: {
      appOutDir,
      executable,
      platform: process.platform,
      arch: process.arch,
      electronVersion: await pinnedElectronVersion(),
    },
  };
}

test("packaged runtime cannot resolve to a workspace executable outside the artifact", async (t) => {
  const f = await fixture(t);
  const escaped = join(f.target.appOutDir, "workspace-node");
  await symlink(process.execPath, escaped);
  await assert.rejects(
    packagedNativeRequest({ ...f.target, executable: escaped }),
    { code: "PACKAGED_EXECUTABLE_ESCAPE" },
  );
  const request = await packagedNativeRequest(f.target);
  assert.deepEqual(request.modules.map((module) => module.name).sort(), [
    "better-sqlite3",
    "node-pty",
  ]);
});

test("missing selected native packages stop the release gate", async (t) => {
  const f = await fixture(t);
  await rm(join(f.moduleRoot, "better-sqlite3"), { recursive: true });
  await assert.rejects(
    packagedNativeRequest(f.target),
    (error) =>
      error.code === "PACKAGED_NATIVE_MODULE_MISSING" &&
      error.detail.name === "better-sqlite3",
  );
});

test("wrong actual runtime writes a typed blocker and cannot use native-repair permission to bypass it", async (t) => {
  const f = await fixture(t);
  let receiptPath;
  await assert.rejects(
    checkPackagedNativeRuntime(f.target, "before-preparation", {
      allowNativeLoadFailure: true,
    }),
    (error) => {
      receiptPath = error.receiptPath;
      return error.code === "RUNTIME_IDENTITY_MISMATCH";
    },
  );
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.passed, false);
  assert.equal(receipt.phase, "before-preparation");
  assert.equal(receipt.runtime.family, "node");
  assert.equal(receipt.runtime.version, process.versions.node);
  assert.equal(receipt.expected.family, "electron");
});

test("actual afterPack rejects a wrong runtime before node-pty mutation or prebuild installation", async (t) => {
  const f = await fixture(t);
  const context = {
    appOutDir: f.target.appOutDir,
    arch: Arch[process.arch],
    electronPlatformName: "darwin",
    packager: { appInfo: { productFilename: "Fixture" } },
  };
  await assert.rejects(afterPack(context), {
    code: "RUNTIME_IDENTITY_MISMATCH",
  });
  assert.equal(
    await readFile(join(f.moduleRoot, "node-pty/index.cjs"), "utf8"),
    "throw new Error('module code must not execute before runtime verification');\n",
  );
});
