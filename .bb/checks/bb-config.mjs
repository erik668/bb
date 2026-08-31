#!/usr/bin/env node
// Reference deterministic check suite for the BB workflow `check()` capability.
//
// Contract, in both directions:
//   stdin  <- one JSON object: { suite, manifestSha256, contractSha256, candidateSha256 }
//   stdout -> exactly one JSON receipt echoing those pins, plus the check counts
//
// Rules a suite must honour, because BB enforces them:
//   - Echo `suite`, `manifestSha256`, `contractSha256`, and `candidateSha256` back
//     verbatim. BB rejects a receipt pinned to anything else.
//   - `suiteVersion` must equal the `version` the manifest declares for this suite.
//   - `selected` must equal `passed + failed + skipped`, and `admitted` must equal
//     `selected > 0 && failed === 0 && skipped === 0`. BB recomputes both.
//   - Exit 0. A non-zero exit, a signal, a timeout, oversized output, or malformed
//     JSON fails the workflow instead of producing a verdict.
//   - Do not write to the workspace. BB digests every pinned input before and after
//     this process, so persistent drift is caught, but BB does not sandbox writes.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const MANIFEST_PATH = ".bb/workflow-checks.json";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function listJsonFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await listJsonFiles(path)));
    else if (entry.name.endsWith(".json")) found.push(path);
  }
  // Sort so the receipt is byte-identical across hosts and filesystems.
  return found.sort();
}

/** Every JSON file under `.bb/` must parse. Reports the offending line. */
async function checkJsonParses(findings) {
  let selected = 0;
  let failed = 0;
  for (const path of await listJsonFiles(".bb")) {
    selected += 1;
    const workspacePath = relative(".", path).split(sep).join("/");
    const content = await readFile(path, "utf8");
    try {
      JSON.parse(content);
    } catch (error) {
      failed += 1;
      // `JSON.parse` reports a character offset; convert it to a 1-based line.
      const offset = Number(/position (\d+)/u.exec(error.message)?.[1] ?? "0");
      findings.push({
        checkId: "json-parse",
        code: "invalid-json",
        path: workspacePath,
        line: content.slice(0, offset).split("\n").length,
        message: error.message,
      });
    }
  }
  return { selected, failed };
}

/**
 * The check manifest pins each suite implementation by digest. Editing an
 * implementation without re-pinning makes every `check()` call fail at the
 * BB boundary with an opaque digest mismatch, so catch it here instead.
 */
async function checkManifestPinsAreCurrent(findings) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  } catch {
    // A repo with no manifest cannot have reached this suite; a malformed one
    // is already reported by `json-parse`. Either way there is nothing to pin.
    return { selected: 0, failed: 0 };
  }
  let selected = 0;
  let failed = 0;
  for (const [suiteId, suite] of Object.entries(manifest.suites ?? {})) {
    for (const input of suite.inputs ?? []) {
      selected += 1;
      let actual = null;
      try {
        actual = createHash("sha256")
          .update(await readFile(input.path))
          .digest("hex");
      } catch {
        actual = null;
      }
      if (actual === input.sha256) continue;
      failed += 1;
      findings.push({
        checkId: "manifest-pins",
        code: actual === null ? "missing-input" : "stale-pin",
        path: input.path,
        message:
          actual === null
            ? `suite ${suiteId} pins ${input.path}, which does not exist`
            : `suite ${suiteId} pins ${input.sha256} for ${input.path}, which now hashes to ${actual}`,
      });
    }
  }
  return { selected, failed };
}

const request = JSON.parse(await readStdin());
const findings = [];
const results = [
  await checkJsonParses(findings),
  await checkManifestPinsAreCurrent(findings),
];
const selected = results.reduce((total, result) => total + result.selected, 0);
const failed = results.reduce((total, result) => total + result.failed, 0);

process.stdout.write(
  `${JSON.stringify({
    suite: request.suite,
    suiteVersion: 1,
    manifestSha256: request.manifestSha256,
    contractSha256: request.contractSha256,
    candidateSha256: request.candidateSha256,
    selected,
    passed: selected - failed,
    failed,
    skipped: 0,
    admitted: selected > 0 && failed === 0,
    findings,
  })}\n`,
);
