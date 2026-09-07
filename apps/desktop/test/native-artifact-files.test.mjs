import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  link,
  symlink,
  stat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nativeFiles from "../scripts/native-artifact-files.cjs";
import preparation from "../scripts/prepare-native-modules.cjs";

test("native preparation detaches a shared binding before a writer can change another installation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bb-native-private-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "workspace.node"),
    packaged = join(root, "package"),
    binary = join(packaged, "binding.node");
  await mkdir(packaged);
  await writeFile(source, "Node127");
  await link(source, binary);
  assert.equal((await stat(source)).nlink, 2);
  assert.equal(
    await nativeFiles.detachSharedNativeFile(packaged, binary),
    true,
  );
  await writeFile(binary, "Electron145");
  assert.equal(await readFile(source, "utf8"), "Node127");
  assert.equal((await stat(binary)).nlink, 1);
  assert.equal(
    await nativeFiles.detachSharedNativeFile(packaged, binary),
    false,
  );
});

test("a symlinked binary or missing child of an escaping directory cannot authorize artifact writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bb-native-escape-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packaged = join(root, "package"),
    outside = join(root, "outside");
  await mkdir(packaged);
  await mkdir(outside);
  await writeFile(join(outside, "binding.node"), "unchanged");
  await symlink(outside, join(packaged, "build"));
  for (const name of ["binding.node", "missing.node"])
    await assert.rejects(
      nativeFiles.detachSharedNativeFile(
        packaged,
        join(packaged, "build", name),
      ),
      { code: "NATIVE_ARTIFACT_ESCAPE" },
    );
  assert.equal(
    await readFile(join(outside, "binding.node"), "utf8"),
    "unchanged",
  );
});

test("node-pty patch and executable helper chmod preserve hardlinked workspace files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bb-pty-private-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packaged = join(root, "package"),
    lib = join(packaged, "lib"),
    build = join(packaged, "build/Release");
  await mkdir(lib, { recursive: true });
  await mkdir(build, { recursive: true });
  const original =
    "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');";
  const workspaceJs = join(root, "workspace.js"),
    workspaceHelper = join(root, "workspace-helper");
  await writeFile(workspaceJs, original);
  await writeFile(workspaceHelper, "helper", { mode: 0o644 });
  await link(workspaceJs, join(lib, "unixTerminal.js"));
  await link(workspaceHelper, join(build, "spawn-helper"));
  await preparation.prepareNodePtyPackageDirectory(packaged);
  assert.equal(await readFile(workspaceJs, "utf8"), original);
  assert.equal((await stat(workspaceHelper)).mode & 0o777, 0o644);
  assert.equal((await stat(join(build, "spawn-helper"))).mode & 0o777, 0o755);
  assert.notEqual(
    await readFile(join(lib, "unixTerminal.js"), "utf8"),
    original,
  );
});
