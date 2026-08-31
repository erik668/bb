#!/usr/bin/env node
// Re-pin `.bb/workflow-checks.json` after editing a suite implementation.
//
// Digests nest, so the order matters and is easy to get wrong by hand:
//   1. each suite's `inputs[].sha256` is the digest of that file's bytes;
//   2. `manifestSha256` is the digest of the whole manifest file *after* step 1;
//   3. `manifestSha256` lives in the workflow that calls `check()`, never in the
//      manifest itself — a file cannot contain its own digest.
//
// This script does steps 1 and 2 and prints the value for step 3.
//
//   node .bb/checks/pin.mjs           # rewrite pins, print manifestSha256
//   node .bb/checks/pin.mjs --check   # verify only; exit 1 if a pin is stale
//
// Digests cover the manifest's exact bytes, so a reformat changes
// `manifestSha256`. This script therefore edits the digest literals in place and
// never reserialises: your formatter stays the single authority on layout.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const MANIFEST_PATH = ".bb/workflow-checks.json";
const verifyOnly = process.argv.includes("--check");

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const original = await readFile(MANIFEST_PATH, "utf8");

/**
 * Replace the `sha256` literal belonging to one input, located by the `path`
 * that precedes it in the same object. Anchoring on the path rather than on a
 * suite index keeps this correct no matter how the JSON is laid out or how the
 * runtime happens to order suite keys.
 */
function repin(text, path, sha256) {
  const pathLiteral = `"path": ${JSON.stringify(path)}`;
  const pathIndex = text.indexOf(pathLiteral);
  if (pathIndex === -1) {
    throw new Error(`${MANIFEST_PATH} has no "path" literal for ${path}`);
  }
  const digestPattern = /"sha256":\s*"[a-f0-9]{64}"/u;
  const rest = text.slice(pathIndex);
  const match = digestPattern.exec(rest);
  if (match === null) {
    throw new Error(`${MANIFEST_PATH} has no "sha256" literal after ${path}`);
  }
  const start = pathIndex + match.index;
  return `${text.slice(0, start)}"sha256": "${sha256}"${text.slice(start + match[0].length)}`;
}

const stale = [];
let updated = original;
for (const suite of Object.values(JSON.parse(original).suites)) {
  for (const input of suite.inputs) {
    const sha256 = digest(await readFile(input.path));
    if (sha256 !== input.sha256) stale.push(input.path);
    updated = repin(updated, input.path, sha256);
  }
}

if (stale.length > 0 && verifyOnly) {
  process.stderr.write(
    `${MANIFEST_PATH} has stale pins: ${stale.join(", ")}\nRun: node .bb/checks/pin.mjs\n`,
  );
  process.exit(1);
}
if (stale.length > 0) await writeFile(MANIFEST_PATH, updated);
process.stdout.write(`manifestSha256 ${digest(updated)}\n`);
