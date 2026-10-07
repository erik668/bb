import { fork, spawn } from "node:child_process";
import { chmod, appendFile } from "node:fs/promises";
import { once } from "node:events";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beginRuntimeClosure } from "./runtime-closure.mjs";
import { validateCrashResult } from "./result-validator.mjs";

const sourcePaths = {
  child: fileURLToPath(new URL("./transaction-child.mjs", import.meta.url)),
  node: fileURLToPath(new URL("./observer-node.mjs", import.meta.url)),
  sqlite3: fileURLToPath(new URL("./observer-sqlite3.mjs", import.meta.url)),
};
const controllerPaths = [
  ["parentRunner", fileURLToPath(import.meta.url)],
  ["runtimeClosure", fileURLToPath(new URL("./runtime-closure.mjs", import.meta.url))],
  ["resultValidator", fileURLToPath(new URL("./result-validator.mjs", import.meta.url))],
  ["resultSchema", fileURLToPath(new URL("./result.schema.json", import.meta.url))],
];

export class LabRunError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "LabRunError";
    this.code = code;
    this.details = details;
  }
}

const withTimeout = (promise, code, label, timeoutMs = 5_000) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new LabRunError(code, `${label} timed out`)), timeoutMs);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const observe = (kind, observerPath, databasePath, cwd, record) =>
  new Promise((resolve, reject) => {
      const observerProcess = spawn(process.execPath, [observerPath, databasePath], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      record(`observer-start:${kind}`, { pid: observerProcess.pid });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        observerProcess.kill("SIGKILL");
        reject(new Error(`${kind} observer timed out`));
      }, 5_000);
      timer.unref();
      observerProcess.stdout.setEncoding("utf8");
      observerProcess.stderr.setEncoding("utf8");
      observerProcess.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      observerProcess.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      observerProcess.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      observerProcess.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (code !== 0 || signal !== null) {
          reject(new Error(`${kind} observer failed: code=${code} signal=${signal} ${stderr}`));
          return;
        }
        try {
          record(`observer-exit:${kind}`, { pid: observerProcess.pid });
          resolve({ pid: observerProcess.pid, actual: JSON.parse(stdout) });
        } catch (error) {
          reject(new Error(`${kind} observer emitted invalid JSON: ${error.message}`));
        }
      });
    });

export async function runCrashScenario({ phase, root, capsule = "none", timeoutMs = 5_000 }) {
  if (!["pre-commit", "post-commit-pre-close"].includes(phase)) {
    throw new TypeError(`unsupported phase: ${phase}`);
  }
  if (!isAbsolute(root)) throw new TypeError("root must be absolute");
  const allowedCapsules = new Set([
    "none",
    "clean-exit-before-barrier",
    "sigterm-before-barrier",
    "throw-before-barrier",
    "timeout-before-barrier",
    "wrong-barrier",
    "tamper-runtime-after-barrier",
  ]);
  if (!allowedCapsules.has(capsule)) throw new TypeError(`unsupported capsule: ${capsule}`);

  const databasePath = join(root, "lab.db");
  const runtime = await beginRuntimeClosure({
    root,
    executedMembers: sourcePaths,
    controllerPaths,
    executablePaths: [
      ["node", process.execPath],
      ["sqlite3", "/usr/bin/sqlite3"],
    ],
  });
  const observerPaths = {
    node: runtime.runtimePaths.node,
    sqlite3: runtime.runtimePaths.sqlite3,
  };
  const events = [];
  const record = (type, details = {}) => {
    events.push({ sequence: events.length, type, ...details });
  };
  const child = fork(runtime.runtimePaths.child, [phase, databasePath, capsule], {
    cwd: root,
    execPath: process.execPath,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let childStderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    childStderr += chunk;
  });
  const childExitPromise = once(child, "exit").then(([code, signal]) => ({ code, signal }));

  let barrier;
  try {
    barrier = await withTimeout(
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("message", (message) => {
          if (message?.type !== "barrier" || message.phase !== phase || message.pid !== child.pid) {
            reject(new LabRunError("INVALID_BARRIER_RECEIPT", `invalid barrier receipt: ${JSON.stringify(message)}`, { receipt: message }));
            return;
          }
          resolve(message.phase);
        });
        child.once("exit", (code, signal) => {
          reject(new LabRunError("CHILD_EXIT_BEFORE_BARRIER", `child exited before barrier: code=${code} signal=${signal}`, { code, signal, stderr: childStderr }));
        });
      }),
      "CHILD_BARRIER_TIMEOUT",
      "child barrier",
      timeoutMs,
    );
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const childExit = await withTimeout(childExitPromise, "CHILD_CLEANUP_TIMEOUT", "failed child cleanup", timeoutMs).catch(() => undefined);
    error.details = { ...error.details, childExit, runtimeClosure: await runtime.seal() };
    throw error;
  }
  record("barrier-received", { childPid: child.pid, phase: barrier });

  if (capsule === "tamper-runtime-after-barrier") {
    await chmod(runtime.runtimePaths.child, 0o644);
    await appendFile(runtime.runtimePaths.child, "\n// deliberate runtime drift\n");
  }

  if (!child.kill("SIGKILL")) throw new Error("SIGKILL was not delivered");
  record("sigkill-sent", { childPid: child.pid });
  const childExit = await withTimeout(childExitPromise, "CHILD_DEATH_TIMEOUT", "child death", timeoutMs);
  if (childExit.code !== null || childExit.signal !== "SIGKILL") {
    throw new Error(`child did not die by SIGKILL: ${JSON.stringify(childExit)}`);
  }
  record("child-exit", { childPid: child.pid, ...childExit });

  const nodeObservation = await observe("node", observerPaths.node, databasePath, root, record);
  const sqlite3Observation = await observe("sqlite3", observerPaths.sqlite3, databasePath, root, record);

  const runtimeClosure = await runtime.seal();
  if (!runtimeClosure.stable) {
    throw new LabRunError("RUNTIME_CLOSURE_DRIFT", "runtime byte identity changed during execution", { runtimeClosure });
  }

  return validateCrashResult({
    schemaVersion: 1,
    phase,
    barrier,
    databasePath,
    childPid: child.pid,
    childExit,
    events,
    observers: {
      node: nodeObservation,
      sqlite3: sqlite3Observation,
    },
    runtimeClosure,
  });
}
