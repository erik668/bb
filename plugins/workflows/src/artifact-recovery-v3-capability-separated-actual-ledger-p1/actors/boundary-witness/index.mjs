import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const dispatch = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const artifact = JSON.parse(readFileSync(dispatch.command.injection.artifact, "utf8"));
const startedNs = process.hrtime.bigint().toString();
const commandResult = spawnSync(dispatch.command.argv[0], dispatch.command.argv.slice(1), {
  cwd: dispatch.recorderRoot,
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", TZ: "UTC" },
  maxBuffer: 1024 * 1024,
});
let typedCode = "BOUNDARY_OBSERVED";
let stderr = commandResult.stderr ?? Buffer.from(commandResult.error?.message ?? "");

if (artifact.action === "sdk-replay") {
  try {
    readFileSync(join(dispatch.recorderRoot, `${dispatch.identity}.start`));
    readFileSync(join(dispatch.recorderRoot, `${dispatch.identity}.complete`));
    readFileSync(join(dispatch.recorderRoot, `${dispatch.identity}.output`));
  } catch (error) {
    typedCode = "SDK_ROW_LIFECYCLE_ABSENT";
    stderr = Buffer.from(error?.code ?? "OBSERVED_IO_ERROR");
  }
} else if (artifact.action === "descriptor-decoy") {
  typedCode = "BOUNDARY_MUTANT_OBSERVED";
} else if (artifact.action === "candidate-root") {
  try {
    writeFileSync(join(artifact.candidateRoot, `${dispatch.identity}.bin`), "candidate");
    typedCode = "UNEXPECTED_ROOT_WRITE";
  } catch (error) {
    typedCode = "RECORDER_ROOT_MISMATCH";
    stderr = Buffer.from(error?.code ?? "OBSERVED_IO_ERROR");
  }
} else if (artifact.action === "private-probe") {
  try {
    readFileSync(artifact.privatePath);
    typedCode = "UNEXPECTED_PRIVATE_READ";
  } catch (error) {
    typedCode = "PRIVATE_AUTHORITY_DENIED";
    stderr = Buffer.from(error?.code ?? "OBSERVED_IO_ERROR");
  }
} else if (artifact.action === "fake-executor") {
  typedCode = "EXECUTOR_PROCESS_MISMATCH";
} else if (artifact.action === "uncommitted") {
  typedCode = "COMMITTED_BYTES_ABSENT";
} else if (artifact.action === "rollback") {
  typedCode = "ROLLBACK_BYTES_DIVERGED";
} else if (artifact.action === "rejected-created") {
  typedCode = "REJECTED_PATH_CREATED";
} else if (artifact.action === "stale-runtime") {
  typedCode = "RUNTIME_OUTPUT_IDENTITY_STALE";
} else if (artifact.action === "stale-declaration") {
  typedCode = "DECLARATION_OUTPUT_IDENTITY_STALE";
} else if (artifact.action === "regeneration-divergence") {
  typedCode = "ISOLATED_BUILD_IDENTITIES_DIVERGED";
} else if (artifact.action === "rpc-lit") {
  typedCode = "RPC_REGISTRATION_OBSERVED";
} else if (artifact.action === "ui-lit") {
  typedCode = "UI_REGISTRATION_OBSERVED";
} else if (artifact.action === "renderer-lit") {
  typedCode = "RENDERER_REGISTRATION_OBSERVED";
} else if (artifact.action === "live-lit") {
  typedCode = "LIVE_CHANGE_REGISTRATION_OBSERVED";
}

const stateBytes = Buffer.from(JSON.stringify({
  version: 1,
  identity: dispatch.identity,
  typedBytesBase64: Buffer.from(typedCode).toString("base64"),
}));
writeFileSync(join(dispatch.recorderRoot, `${dispatch.identity}.bin`), stateBytes, { flag: "wx" });
const completedNs = process.hrtime.bigint().toString();
const receipt = {
  version: 1,
  identity: dispatch.identity,
  command: {
    argv: dispatch.command.argv,
    pid: commandResult.pid,
    startedNs,
    completedNs,
    exitCode: commandResult.status ?? 255,
    stdoutBase64: (commandResult.stdout ?? Buffer.alloc(0)).toString("base64"),
    stderrBase64: stderr.toString("base64"),
  },
  process: { pid: process.pid, ppid: process.ppid },
  boundary: { typedBytesBase64: Buffer.from(typedCode).toString("base64") },
  content: {
    stateBytes: stateBytes.byteLength,
    stateSha256: createHash("sha256").update(stateBytes).digest("hex"),
  },
  physical: {
    issuedRootSha256: createHash("sha256").update(dispatch.recorderRoot).digest("hex"),
  },
};
process.stdout.write(JSON.stringify(receipt));
