import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "vitest";

const execFileAsync = promisify(execFile);
const pythonAvailable =
  process.platform !== "win32" &&
  spawnSync("python3", [
    "-c",
    "import sys; sys.exit(sys.version_info < (3, 9))",
  ]).status === 0;

describe("safe BB upgrade helper", () => {
  it.skipIf(!pythonAvailable)(
    "guards activation and recovery using disposable repositories and SQLite databases",
    async () => {
      await execFileAsync(
        "python3",
        [
          "-B",
          "-m",
          "unittest",
          "discover",
          "-s",
          "skills/safe-bb-upgrade/scripts",
          "-p",
          "test_*.py",
          "-v",
        ],
        { cwd: import.meta.dirname },
      );
    },
    60_000,
  );
});
