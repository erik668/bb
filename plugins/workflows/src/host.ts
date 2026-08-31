import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  MAX_CHECK_OUTPUT_BYTES,
  workflowCheckHostContract,
} from "./check-contract.js";
import {
  isProcessGroupAlive,
  killProcessGroup,
  spawnPortablePipedProcess,
  stopProcessGroupLeaderFirst,
  supportsProcessGroups,
} from "@bb/process-utils";

function runProcess(
  input: {
    cwd: string;
    executable: string;
    args: string[];
    stdin: string;
    timeoutMs: number;
  },
  signal: AbortSignal,
) {
  return new Promise<{
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    outputTruncated: boolean;
  }>((resolve, reject) => {
    const child = spawnPortablePipedProcess({
      command: input.executable,
      args: input.args,
      cwd: input.cwd,
      env: process.env,
      // Detaching is what puts the check in its own process group, so a suite
      // that forks survivors can be torn down as a tree rather than a leader.
      detached: supportsProcessGroups(),
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let outputTruncated = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let forceKillTimeout: ReturnType<typeof setTimeout> | null = null;

    const abort = () => terminate();
    const cleanup = () => {
      if (timeout !== null) clearTimeout(timeout);
      if (forceKillTimeout !== null) clearTimeout(forceKillTimeout);
      signal.removeEventListener("abort", abort);
    };

    const processTreeAlive = () =>
      isProcessGroupAlive(child) ||
      (child.exitCode === null && child.signalCode === null);
    const terminate = () => {
      if (processTreeAlive()) {
        killProcessGroup({ child, signal: "SIGTERM" });
        forceKillTimeout ??= setTimeout(() => {
          if (processTreeAlive()) {
            killProcessGroup({ child, signal: "SIGKILL" });
          }
        }, 5_000);
      }
    };
    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ) => {
      const remaining = MAX_CHECK_OUTPUT_BYTES - current.length;
      if (remaining <= 0) {
        outputTruncated = true;
        terminate();
        return current;
      }
      if (chunk.length > remaining) {
        outputTruncated = true;
        terminate();
        return Buffer.concat([current, chunk.subarray(0, remaining)]);
      }
      return Buffer.concat([current, chunk]);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      void stopProcessGroupLeaderFirst({
        child,
        timeoutMs: 5_000,
        killGraceMs: 1_000,
      }).then(() => {
        resolve({
          exitCode,
          signal: exitSignal,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          timedOut,
          outputTruncated,
        });
      });
    });
    signal.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);
    child.stdin.end(input.stdin);
    if (signal.aborted) abort();
  });
}

export default experimental_defineHostEntry({
  contract: workflowCheckHostContract,
  handlers: {
    run(input, context) {
      return runProcess(input, context.signal);
    },
  },
});
