import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { workflowCheckReceiptSchema } from "./check-contract.js";
import { CHECK_MANIFEST_PATH, checkManifestSchema } from "./check-runner.js";

/**
 * The repository ships a real `.bb/workflow-checks.json` so `check()` is not
 * inert in its own repo and so adopters have something to copy. These tests
 * exercise it the way the runner does — same schema, same digest pins, same
 * receipt validation — because a documented example that has drifted out of the
 * contract is worse than no example at all.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const digest = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

/** Run a suite the way the host does: argv directly, request on stdin. */
function runSuite(args: {
  argv: readonly string[];
  cwd: string;
  request: unknown;
}): Promise<string> {
  const [executable, ...rest] = args.argv;
  if (executable === undefined) throw new Error("empty argv");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, rest, { cwd: args.cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`suite exited ${code}: ${stderr}`));
    });
    child.stdin.end(JSON.stringify(args.request));
  });
}

async function readManifest() {
  const content = await readFile(join(REPO_ROOT, CHECK_MANIFEST_PATH), "utf8");
  const manifest = checkManifestSchema.parse(JSON.parse(content));
  const suite = manifest.suites["bb-config"];
  if (suite === undefined) throw new Error("missing bb-config suite");
  // The manifest cannot carry its own digest, so the workflow pins these bytes.
  return { manifest, suite, manifestSha256: digest(content) };
}

function request(manifestSha256: string) {
  return {
    suite: "bb-config",
    manifestSha256,
    contractSha256: digest("contract"),
    candidateSha256: digest("candidate"),
  };
}

describe("the repository's own workflow check manifest", () => {
  it("pins every suite input to the digest that file currently has", async () => {
    const { manifest } = await readManifest();
    for (const suite of Object.values(manifest.suites)) {
      for (const input of suite.inputs) {
        const actual = digest(await readFile(join(REPO_ROOT, input.path)));
        expect(
          actual,
          `${input.path} is not pinned to its current bytes — run: node .bb/checks/pin.mjs`,
        ).toBe(input.sha256);
      }
    }
  });

  it("emits an admitting receipt that satisfies the runner's contract", async () => {
    const { suite, manifestSha256 } = await readManifest();
    const input = request(manifestSha256);
    const stdout = await runSuite({
      argv: suite.argv,
      cwd: REPO_ROOT,
      request: input,
    });

    // The runner parses with this schema, then rejects any receipt whose pins
    // differ from the request it sent, so assert both halves.
    const receipt = workflowCheckReceiptSchema.parse(JSON.parse(stdout));
    expect(receipt).toMatchObject({
      ...input,
      suiteVersion: suite.version,
      admitted: true,
      failed: 0,
      skipped: 0,
      findings: [],
    });
    expect(receipt.selected).toBeGreaterThan(0);
  });

  it("fails closed with a located finding when a checked file is malformed", async () => {
    const { suite, manifestSha256 } = await readManifest();
    const workspace = await mkdtemp(join(tmpdir(), "bb-check-suite-"));
    await mkdir(join(workspace, ".bb"));
    await writeFile(join(workspace, ".bb/broken.json"), '{\n  "version": 1,\n');

    // The host resolves argv against the origin workspace, so point the same
    // suite at a throwaway workspace rather than mutating this repository.
    const stdout = await runSuite({
      argv: suite.argv.map((arg, index) =>
        index === 0 ? arg : join(REPO_ROOT, arg),
      ),
      cwd: workspace,
      request: request(manifestSha256),
    });

    const receipt = workflowCheckReceiptSchema.parse(JSON.parse(stdout));
    expect(receipt.admitted).toBe(false);
    expect(receipt.failed).toBe(1);
    expect(receipt.findings).toEqual([
      expect.objectContaining({
        checkId: "json-parse",
        code: "invalid-json",
        path: ".bb/broken.json",
      }),
    ]);
  });
});
