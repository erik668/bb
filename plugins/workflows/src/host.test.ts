import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { describe, expect, it } from "vitest";
import workflowCheckHostEntry from "./host.js";
import { supportsProcessGroups } from "@bb/process-utils";

describe("workflow check host entry", () => {
  it("executes argv without shell interpolation and streams stdin", async () => {
    const harness = experimental_createHostEntryHarness(workflowCheckHostEntry);
    const marker = "$(printf shell-expanded)";
    const result = await harness.experimental_call("run", {
      cwd: process.cwd(),
      executable: process.execPath,
      args: [
        "-e",
        "process.stdin.on('data', chunk => process.stdout.write(process.argv[1] + ':' + chunk))",
        marker,
      ],
      stdin: "receipt-input",
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      stdout: `${marker}:receipt-input`,
      stderr: "",
      timedOut: false,
      outputTruncated: false,
    });
  });

  it("terminates timed-out checks and bounds their output", async () => {
    const harness = experimental_createHostEntryHarness(workflowCheckHostEntry);
    const timedOut = await harness.experimental_call("run", {
      cwd: process.cwd(),
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      stdin: "",
      timeoutMs: 20,
    });
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.signal).not.toBeNull();

    const oversized = await harness.experimental_call("run", {
      cwd: process.cwd(),
      executable: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(1024 * 1024 + 1))"],
      stdin: "",
      timeoutMs: 5_000,
    });
    expect(oversized.outputTruncated).toBe(true);
    expect(Buffer.byteLength(oversized.stdout)).toBe(1024 * 1024);
  });

  it.skipIf(!supportsProcessGroups())(
    "terminates descendant processes with a timed-out check",
    async () => {
      const harness = experimental_createHostEntryHarness(
        workflowCheckHostEntry,
      );
      const result = await harness.experimental_call("run", {
        cwd: process.cwd(),
        executable: process.execPath,
        args: [
          "-e",
          `const { spawn } = require("node:child_process");
           const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
           process.stdout.write(String(grandchild.pid));
           setInterval(() => {}, 1000);`,
        ],
        stdin: "",
        timeoutMs: 100,
      });
      const grandchildPid = Number(result.stdout);
      expect(grandchildPid).toBeGreaterThan(0);
      expect(result.timedOut).toBe(true);
      const deadline = Date.now() + 2_000;
      while (isAlive(grandchildPid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(isAlive(grandchildPid)).toBe(false);
    },
  );

  it.skipIf(!supportsProcessGroups())(
    "terminates descendants after the process-group leader exits",
    async () => {
      const harness = experimental_createHostEntryHarness(
        workflowCheckHostEntry,
      );
      const result = await harness.experimental_call("run", {
        cwd: process.cwd(),
        executable: process.execPath,
        args: [
          "-e",
          `const { spawn } = require("node:child_process");
           const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", process.stdout, "ignore"] });
           process.stdout.write(String(grandchild.pid) + "\\n");`,
        ],
        stdin: "",
        timeoutMs: 100,
      });
      const grandchildPid = Number(result.stdout.trim());
      expect(grandchildPid).toBeGreaterThan(0);
      expect(result.timedOut).toBe(true);
      const deadline = Date.now() + 2_000;
      while (isAlive(grandchildPid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(isAlive(grandchildPid)).toBe(false);
    },
  );

  it.skipIf(!supportsProcessGroups())(
    "reaps a detached-stdio descendant before returning success",
    async () => {
      const harness = experimental_createHostEntryHarness(
        workflowCheckHostEntry,
      );
      const result = await harness.experimental_call("run", {
        cwd: process.cwd(),
        executable: process.execPath,
        args: [
          "-e",
          `const { spawn } = require("node:child_process");
           const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.send('ready'); process.disconnect(); setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
           grandchild.once("message", () => {
             grandchild.disconnect();
             grandchild.unref();
             process.stdout.write(String(grandchild.pid));
           });`,
        ],
        stdin: "",
        timeoutMs: 10_000,
      });
      const grandchildPid = Number(result.stdout);
      expect(grandchildPid).toBeGreaterThan(0);
      expect(result).toMatchObject({
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputTruncated: false,
      });
      expect(isAlive(grandchildPid)).toBe(false);
    },
  );
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
