const { copyFile, lstat, realpath, rename, rm } = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { dirname, isAbsolute, relative, resolve } = require("node:path");

function within(root, file) {
  const name = relative(root, file);
  return (
    name === "" ||
    (!isAbsolute(name) && name !== ".." && !name.startsWith("../"))
  );
}

async function assertContainedMutation(root, file) {
  const actualRoot = await realpath(root);
  let ancestor = resolve(file);
  while (true) {
    try {
      const actual = await realpath(ancestor);
      if (!within(actualRoot, actual)) {
        const error = new Error(
          `Native artifact mutation escapes package: ${file}`,
        );
        error.code = "NATIVE_ARTIFACT_ESCAPE";
        throw error;
      }
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

async function detachSharedNativeFile(root, file) {
  await assertContainedMutation(root, file);
  let entry;
  try {
    entry = await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!entry.isFile()) {
    const error = new Error(`Native artifact must be a regular file: ${file}`);
    error.code = "NATIVE_ARTIFACT_FILE_INVALID";
    throw error;
  }
  if (entry.nlink === 1) return false;
  const temporary = `${file}.private-${randomUUID()}`;
  try {
    await copyFile(file, temporary);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}

module.exports = { assertContainedMutation, detachSharedNativeFile };
