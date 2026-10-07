import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

function parseArgs(argv) {
  if (argv.length !== 5 || argv[0] !== "--mode=candidate-adjudicate" || argv[1] !== "--topology" || argv[3] !== "--recorder-root") {
    throw new Error("CANDIDATE_LAUNCHER_ARGV_INVALID");
  }
  return { topologyPath: resolve(argv[2]), recorderRoot: resolve(argv[4]) };
}

const args = parseArgs(process.argv.slice(2));
const topology = JSON.parse(await readFile(args.topologyPath, "utf8"));
if (process.execPath !== topology.runtime.node.path) throw new Error("CANDIDATE_NODE_IDENTITY_MISMATCH");
if (process.cwd() !== args.recorderRoot || args.recorderRoot.startsWith(topology.repoRoot)) throw new Error("CANDIDATE_CWD_INVALID");
for (const candidate of topology.candidate.paths) {
  const absolute = join(topology.repoRoot, candidate.path);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`CANDIDATE_NOT_REGULAR:${candidate.path}`);
  const actual = createHash("sha256").update(await readFile(absolute)).digest("hex");
  if (actual !== candidate.rejectedSha256) throw new Error(`CANDIDATE_INITIAL_IDENTITY_MISMATCH:${candidate.path}:${actual}`);
}
const child = spawnSync(topology.runtime.node.path, [
  "--import", topology.candidate.tsxImport,
  topology.candidate.entrypoint,
  "--mode=candidate", "--topology", args.topologyPath, "--recorder-root", args.recorderRoot
], {
  cwd: args.recorderRoot,
  env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin", TMPDIR: args.recorderRoot, HOME: args.recorderRoot, F3_RUN_ID: "candidate-adjudicate" },
  encoding: "utf8",
  timeout: 120_000
});
if (child.error || child.status !== 0) throw new Error(`CANDIDATE_PROCESS_FAILED:${child.error?.message ?? child.stderr}`);
process.stdout.write(child.stdout);
