import { spawn, type ChildProcess } from "node:child_process";

export function spawnPipedProcess(args: {
  command: string;
  commandArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}) {
  return spawn(args.command, args.commandArgs, {
    cwd: args.cwd,
    env: args.env,
    detached: supportsProcessGroups(),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

export function supportsProcessGroups(): boolean {
  return process.platform !== "win32";
}

export function killProcessGroup(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: NodeJS.Signals,
): void {
  if (supportsProcessGroups() && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may already be gone; fall back to the direct child.
    }
  }
  child.kill(signal);
}

export function isProcessGroupAlive(child: Pick<ChildProcess, "pid">): boolean {
  if (!supportsProcessGroups() || child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

const PROCESS_GROUP_EXIT_POLL_MS = 100;

export function stopProcessTreeAfterLeaderClose(
  child: ChildProcess,
  args: { terminateGraceMs: number; killGraceMs: number },
): Promise<void> {
  if (!isProcessGroupAlive(child)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(terminateTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      clearInterval(poll);
      resolve();
    };
    const terminateTimer = setTimeout(() => {
      if (!isProcessGroupAlive(child)) {
        finish();
        return;
      }
      killProcessGroup(child, "SIGKILL");
      killTimer = setTimeout(finish, args.killGraceMs);
    }, args.terminateGraceMs);
    const poll = setInterval(() => {
      if (!isProcessGroupAlive(child)) finish();
    }, PROCESS_GROUP_EXIT_POLL_MS);

    killProcessGroup(child, "SIGTERM");
  });
}
