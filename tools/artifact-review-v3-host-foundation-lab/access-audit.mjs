import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { beginRuntimeClosure } from "./runtime-closure.mjs";

const accessProbePath = fileURLToPath(new URL("./access-probe.mjs", import.meta.url));
const controllerPaths = [
  ["accessAudit", fileURLToPath(import.meta.url)],
  ["runtimeClosure", fileURLToPath(new URL("./runtime-closure.mjs", import.meta.url))],
];

const exactKeys = (value, expected, label) => {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new TypeError(`${label} has unexpected fields`);
  }
};

const run = (command, args, cwd, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("access probe timed out"));
    }, timeoutMs);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ pid: child.pid, code, signal, stdout, stderr });
    });
  });

export async function runForbiddenAccessProbe({ forbiddenPath, root, timeoutMs = 5_000 }) {
  if (!isAbsolute(forbiddenPath) || !isAbsolute(root)) {
    throw new TypeError("forbiddenPath and root must be absolute");
  }
  const canonicalForbiddenPath = await realpath(forbiddenPath);
  const runtime = await beginRuntimeClosure({
    root,
    executedMembers: { accessProbe: accessProbePath },
    controllerPaths,
    executablePaths: [
      ["node", process.execPath],
      ["sandboxExec", "/usr/bin/sandbox-exec"],
    ],
  });
  const profile = `(version 1) (allow default) (deny file-read* (literal ${JSON.stringify(canonicalForbiddenPath)}))`;
  const processResult = await run(
    "/usr/bin/sandbox-exec",
    ["-p", profile, process.execPath, runtime.runtimePaths.accessProbe, canonicalForbiddenPath],
    root,
    timeoutMs,
  );
  const runtimeClosure = await runtime.seal();
  const receipt = {
    schemaVersion: 1,
    forbiddenPath: canonicalForbiddenPath,
    probePid: processResult.pid,
    childExit: { code: processResult.code, signal: processResult.signal },
    observedError: {
      code: /code: 'EPERM'/.test(processResult.stderr) ? "EPERM" : null,
      syscall: /syscall: 'open'/.test(processResult.stderr) ? "open" : null,
      path: processResult.stderr.includes(canonicalForbiddenPath) ? canonicalForbiddenPath : null,
    },
    stdout: processResult.stdout,
    stderr: processResult.stderr,
    runtimeClosure,
  };

  exactKeys(receipt, ["schemaVersion", "forbiddenPath", "probePid", "childExit", "observedError", "stdout", "stderr", "runtimeClosure"], "access receipt");
  if (
    receipt.schemaVersion !== 1 ||
    receipt.childExit.code !== 1 ||
    receipt.childExit.signal !== null ||
    receipt.observedError.code !== "EPERM" ||
    receipt.observedError.syscall !== "open" ||
    receipt.observedError.path !== canonicalForbiddenPath ||
    receipt.stdout !== "" ||
    runtimeClosure.stable !== true
  ) {
    throw new Error(
      `forbidden access did not produce the required OS denial receipt: ${JSON.stringify({
        childExit: receipt.childExit,
        observedError: receipt.observedError,
        stdout: receipt.stdout,
        stderr: receipt.stderr,
        runtimeStable: runtimeClosure.stable,
      })}`,
    );
  }
  return receipt;
}
