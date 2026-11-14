import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { z } from "zod";
import { afterEach, expect, it, vi } from "vitest";
import { createDesktopLogger } from "../src/desktop-logger.js";
import { resolveCurrentLogFile } from "../src/log-viewer.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  writeSync: vi.fn(() => 0),
}));

const tempDirs: string[] = [];
const children = new Set<ChildProcess>();
const electronBinary = z
  .string()
  .min(1)
  .parse(createRequire(__filename)("electron"));

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  children.clear();
  vi.restoreAllMocks();
  vi.mocked(writeSync).mockReset();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it.each(
  ["node", "electron"].flatMap((runtime) =>
    [false, true].map((blockedLogDirectory) => ({
      runtime,
      blockedLogDirectory,
    })),
  ),
)(
  "$runtime survives real closed stderr (blocked log directory: $blockedLogDirectory)",
  async ({ runtime, blockedLogDirectory }) => {
    const logDir = await logDirectory();
    if (blockedLogDirectory) await writeFile(logDir, "obstructed directory");
    const fixture = join(logDir, "..", "closed-pipe.cjs");
    await build({
      entryPoints: [
        join(__dirname, "fixtures", "desktop-logger-closed-pipe.ts"),
      ],
      outfile: fixture,
      bundle: true,
      platform: "node",
      format: "cjs",
    });
    const child = spawn(
      runtime === "electron" ? electronBinary : process.execPath,
      [fixture, logDir],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    children.add(child);
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    await Promise.race([
      once(child.stdout, "data"),
      exited.then(() => {
        throw new Error("Logger fixture exited before ready");
      }),
    ]);
    const closed = once(child.stderr, "close");
    child.stderr.destroy();
    await closed;
    child.stdin.end("wake\n");
    expect(await exited).toBe(0);
    expect(stdout).toContain("survived");
    if (!blockedLogDirectory) {
      const records = (await readFile(join(logDir, "desktop.log"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.map((record) => record.msg)).toEqual([
        "Connect resumed after wake",
        "Connection retry",
        "Connection unavailable",
        "Logging still works",
      ]);
    }
  },
  15_000,
);

async function logDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "bb-desktop-logger-"));
  tempDirs.push(path);
  return join(path, "logs");
}

it("persists all desktop levels without a terminal and appends across launches", async () => {
  const logDir = await logDirectory();
  vi.mocked(writeSync).mockReturnValue(0);
  const logger = createDesktopLogger({ logDir });
  logger.info("updater checking");
  logger.warn("Connect auth failed");
  logger.error("startup failed\nError: details");
  createDesktopLogger({ logDir }).info("next launch");

  const records = (await readFile(join(logDir, "desktop.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records).toEqual([
    expect.objectContaining({
      component: "desktop",
      level: 30,
      time: expect.any(Number),
      msg: "updater checking",
    }),
    expect.objectContaining({
      component: "desktop",
      level: 40,
      msg: "Connect auth failed",
    }),
    expect.objectContaining({
      component: "desktop",
      level: 50,
      msg: "startup failed\nError: details",
    }),
    expect.objectContaining({ msg: "next launch" }),
  ]);
});

it("retains the error even when the launcher's stderr is closed", async () => {
  const logDir = await logDirectory();
  vi.mocked(writeSync).mockImplementation(() => {
    throw new Error("closed stderr");
  });
  const logger = createDesktopLogger({ logDir });
  expect(() => logger.error("startup failure")).not.toThrow();
  expect(await readFile(join(logDir, "desktop.log"), "utf8")).toContain(
    "startup failure",
  );
});

it("rotates at the byte limit and retains only the four latest archives", async () => {
  const logDir = await logDirectory();
  await mkdir(logDir);
  vi.mocked(writeSync).mockReturnValue(0);
  const logger = createDesktopLogger({ logDir });
  const padding = "x".repeat(10 * 1024 * 1024 - 100);
  for (let index = 0; index < 6; index += 1) {
    await writeFile(join(logDir, "desktop.log"), `${index}${padding}`);
    logger.info("界".repeat(20));
  }
  expect((await readdir(logDir)).sort()).toEqual([
    "desktop.1.log",
    "desktop.2.log",
    "desktop.3.log",
    "desktop.4.log",
    "desktop.log",
  ]);
  for (let index = 1; index <= 4; index += 1) {
    expect(
      (await readFile(join(logDir, `desktop.${index}.log`), "utf8"))[0],
    ).toBe(String(6 - index));
  }
  expect(
    JSON.parse(await readFile(join(logDir, "desktop.log"), "utf8")).msg,
  ).toBe("界".repeat(20));
  expect(await resolveCurrentLogFile({ component: "desktop", logDir })).toBe(
    join(logDir, "desktop.log"),
  );
});

it("falls back to stderr on a filesystem failure and resumes persistence after recovery", async () => {
  const logDir = await logDirectory();
  await writeFile(logDir, "obstructed directory");
  const stderr = vi.mocked(writeSync).mockReturnValue(0);
  const logger = createDesktopLogger({ logDir });
  expect(() => logger.error("updater failed")).not.toThrow();
  expect(stderr.mock.calls.flat().join("")).toContain("could not write");
  expect(stderr.mock.calls.flat().join("")).toContain("updater failed");
  await rm(logDir);
  logger.info("logging recovered");
  expect(await readFile(join(logDir, "desktop.log"), "utf8")).toContain(
    "logging recovered",
  );
});
