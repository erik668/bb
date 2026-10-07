import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

const sha256File = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });

const identify = async (path) => {
  const metadata = await stat(path);
  return {
    path,
    byteLength: metadata.size,
    sha256: await sha256File(path),
  };
};

export async function beginRuntimeClosure({ root, executedMembers, controllerPaths, executablePaths }) {
  const runtimeRoot = join(root, `runtime-${randomUUID()}`);
  await mkdir(runtimeRoot, { recursive: false });

  const members = [];
  const runtimePaths = {};
  for (const [role, sourcePath] of Object.entries(executedMembers)) {
    const snapshotPath = join(runtimeRoot, `${role}-${basename(sourcePath)}`);
    const sourceBefore = await identify(sourcePath);
    await copyFile(sourcePath, snapshotPath);
    await chmod(snapshotPath, 0o444);
    const snapshotBefore = await identify(snapshotPath);
    if (
      sourceBefore.byteLength !== snapshotBefore.byteLength ||
      sourceBefore.sha256 !== snapshotBefore.sha256
    ) {
      throw new Error(`runtime snapshot mismatch for ${role}`);
    }
    runtimePaths[role] = snapshotPath;
    members.push({ role, sourceBefore, snapshotBefore });
  }

  const controllersBefore = await Promise.all(
    controllerPaths.map(async ([role, path]) => ({ role, ...(await identify(path)) })),
  );
  const executablesBefore = await Promise.all(
    executablePaths.map(async ([role, path]) => ({ role, ...(await identify(path)) })),
  );

  return {
    runtimeRoot,
    runtimePaths,
    async seal() {
      const sealedMembers = await Promise.all(
        members.map(async ({ role, sourceBefore, snapshotBefore }) => {
          const sourceAfter = await identify(sourceBefore.path);
          const snapshotAfter = await identify(snapshotBefore.path);
          return {
            role,
            sourcePath: sourceBefore.path,
            snapshotPath: snapshotBefore.path,
            byteLength: snapshotBefore.byteLength,
            sourceSha256Before: sourceBefore.sha256,
            sourceSha256After: sourceAfter.sha256,
            snapshotSha256Before: snapshotBefore.sha256,
            snapshotSha256After: snapshotAfter.sha256,
          };
        }),
      );
      const controllers = await Promise.all(
        controllersBefore.map(async (before) => {
          const after = await identify(before.path);
          return {
            role: before.role,
            path: before.path,
            byteLength: before.byteLength,
            sha256Before: before.sha256,
            sha256After: after.sha256,
          };
        }),
      );
      const executables = await Promise.all(
        executablesBefore.map(async (before) => {
          const after = await identify(before.path);
          return {
            role: before.role,
            path: before.path,
            byteLength: before.byteLength,
            sha256Before: before.sha256,
            sha256After: after.sha256,
          };
        }),
      );
      const stable =
        sealedMembers.every(
          (member) =>
            member.sourceSha256Before === member.sourceSha256After &&
            member.sourceSha256Before === member.snapshotSha256Before &&
            member.snapshotSha256Before === member.snapshotSha256After,
        ) &&
        controllers.every((member) => member.sha256Before === member.sha256After) &&
        executables.every((member) => member.sha256Before === member.sha256After);

      return { runtimeRoot, stable, members: sealedMembers, controllers, executables };
    },
  };
}

