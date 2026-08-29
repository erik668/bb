import { execFile, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const installerPath = resolve(
  __dirname,
  "../scripts/safe-install-macos-bundle.zsh",
);
const repositoryRoot = resolve(__dirname, "../../..");
const temporaryRoots: string[] = [];

async function execFileText(file: string, args: string[]) {
  const result = await execFileAsync(file, args, { encoding: "utf8" });
  return { stderr: result.stderr, stdout: result.stdout };
}

async function createBundle(bundlePath: string, nodePtyVersion: string) {
  const executablePath = join(bundlePath, "Contents", "MacOS", "bb");
  const packagePath = join(
    bundlePath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "package.json",
  );
  await mkdir(dirname(executablePath), { recursive: true });
  await mkdir(dirname(packagePath), { recursive: true });
  await writeFile(executablePath, "#!/bin/sh\nexit 0\n");
  await chmod(executablePath, 0o755);
  await writeFile(
    join(bundlePath, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>bb</string>
<key>CFBundleIdentifier</key><string>dev.bb.installer-test</string>
<key>CFBundleName</key><string>bb</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>
`,
  );
  await writeFile(
    packagePath,
    `${JSON.stringify({ version: nodePtyVersion })}\n`,
  );
  await execFileText("/usr/bin/codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    bundlePath,
  ]);
}

async function readNodePtyVersion(bundlePath: string) {
  const packagePath = join(
    bundlePath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "package.json",
  );
  return JSON.parse(await readFile(packagePath, "utf8")).version;
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "bb-safe-install-test-"));
  temporaryRoots.push(root);
  const source = join(root, "source", "bb.app");
  const target = join(root, "target", "bb.app");
  await createBundle(source, "1.2.0-beta.14");
  await createBundle(target, "1.1.0");
  return { root, source, target };
}

async function install(source: string, target: string) {
  return await execFileText("/bin/zsh", [
    installerPath,
    source,
    target,
    "1.2.0-beta.14",
    "--confirm-replace",
  ]);
}

async function installThroughPackageScript(source: string, target: string) {
  const result = await execFileAsync(
    "pnpm",
    [
      "--filter",
      "@bb/desktop",
      "run",
      "install:packaged:macos",
      "--",
      source,
      target,
      "1.2.0-beta.14",
      "--confirm-replace",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  return { stderr: result.stderr, stdout: result.stdout };
}

async function installWithFinalVerificationFailure(
  source: string,
  target: string,
) {
  const result = await execFileAsync(
    "/bin/zsh",
    [installerPath, source, target, "1.2.0-beta.14", "--confirm-replace"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        BB_SAFE_INSTALL_TEST_FAIL_AFTER_PROMOTION: "1",
      },
    },
  );
  return { stderr: result.stderr, stdout: result.stdout };
}

async function expectInstallFailure(
  promise: ReturnType<typeof execFileText>,
  message: RegExp,
) {
  await expect(promise).rejects.toMatchObject({
    stderr: expect.stringMatching(message),
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

describe.runIf(process.platform === "darwin")(
  "safe macOS bundle installer",
  () => {
    it("contains no process lifecycle or automatic retry commands", async () => {
      const source = await readFile(installerPath, "utf8");

      expect(source).not.toMatch(
        /\b(?:launchctl|osascript|open|kill|killall|pkill|nohup|disown|setsid|crontab|sleep|while|until|repeat|for)\b/u,
      );
      expect(source).not.toMatch(/(?:^|[^&])&(?:[^&]|$)/u);
    });

    it("requires explicit replacement confirmation", async () => {
      const { source, target } = await createFixture();

      await expectInstallFailure(
        execFileText("/bin/zsh", [
          installerPath,
          source,
          target,
          "1.2.0-beta.14",
        ]),
        /explicit --confirm-replace approval is required/u,
      );
      expect(await readNodePtyVersion(target)).toBe("1.1.0");
    });

    it("refuses source and target aliases that resolve to the same bundle", async () => {
      const { root, target } = await createFixture();
      const targetAlias = join(root, "target-alias");
      await symlink(join(root, "target"), targetAlias, "dir");

      await expectInstallFailure(
        execFileText("/bin/zsh", [
          installerPath,
          join(targetAlias, "bb.app"),
          target,
          "1.1.0",
          "--confirm-replace",
        ]),
        /source and target bundles must differ/u,
      );

      expect(await readNodePtyVersion(target)).toBe("1.1.0");
    });

    it("installs once and retains the previous bundle as rollback", async () => {
      const { source, target } = await createFixture();

      await installThroughPackageScript(source, target);

      expect(await readNodePtyVersion(target)).toBe("1.2.0-beta.14");
      expect(await readNodePtyVersion(`${target}.bb-install-backup`)).toBe(
        "1.1.0",
      );
      await expectInstallFailure(
        install(source, target),
        /rollback bundle already exists/u,
      );
      expect(await readNodePtyVersion(target)).toBe("1.2.0-beta.14");
    });

    it("refuses a concurrent attempt before mutating the target", async () => {
      const { source, target } = await createFixture();
      await mkdir(`${target}.bb-install-lock`);

      await expectInstallFailure(
        install(source, target),
        /another install attempt holds/u,
      );

      expect(await readNodePtyVersion(target)).toBe("1.1.0");
    });

    it("refuses a process using any file inside the target bundle without signaling it", async () => {
      const { source, target } = await createFixture();
      const openBundleFile = join(
        target,
        "Contents",
        "Resources",
        "app.asar.unpacked",
        "node_modules",
        "node-pty",
        "package.json",
      );
      const child = spawn(
        process.execPath,
        [
          "-e",
          'require("node:fs").openSync(process.argv[1], "r"); process.stdout.write("ready\\n"); setInterval(() => {}, 1_000)',
          openBundleFile,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      await once(child, "spawn");
      await once(child.stdout!, "data");

      try {
        expect(child.exitCode).toBeNull();
        const childFiles = await execFileText("/usr/sbin/lsof", [
          "-p",
          String(child.pid),
        ]);
        expect(childFiles.stdout).toContain(await realpath(openBundleFile));
        await expectInstallFailure(
          install(source, target),
          /target bundle is running/u,
        );
        expect(child.exitCode).toBeNull();
        expect(await readNodePtyVersion(target)).toBe("1.1.0");
      } finally {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
    });

    it("leaves the target untouched when source preflight fails", async () => {
      const { source, target } = await createFixture();

      await expectInstallFailure(
        execFileText("/bin/zsh", [
          installerPath,
          source,
          target,
          "9.9.9",
          "--confirm-replace",
        ]),
        /node-pty version mismatch/u,
      );

      expect(await readNodePtyVersion(target)).toBe("1.1.0");
    });

    it("leaves the target untouched when the source signature is invalid", async () => {
      const { source, target } = await createFixture();
      await writeFile(join(source, "Contents", "MacOS", "bb"), "tampered\n");

      await expect(install(source, target)).rejects.toMatchObject({ code: 1 });

      expect(await readNodePtyVersion(target)).toBe("1.1.0");
    });

    it("preserves an invalid existing target as the rollback bundle", async () => {
      const { source, target } = await createFixture();
      await writeFile(join(target, "Contents", "MacOS", "bb"), "broken\n");

      const result = await install(source, target);

      expect(result.stderr).toMatch(/existing target signature is invalid/u);
      expect(await readNodePtyVersion(target)).toBe("1.2.0-beta.14");
      expect(await readNodePtyVersion(`${target}.bb-install-backup`)).toBe(
        "1.1.0",
      );
    });

    it("restores the previous target and releases the lock when final verification fails", async () => {
      const { source, target } = await createFixture();

      await expect(
        installWithFinalVerificationFailure(source, target),
      ).rejects.toMatchObject({ code: 1 });

      expect(await readNodePtyVersion(target)).toBe("1.1.0");
      expect(await readNodePtyVersion(`${target}.bb-install-failed`)).toBe(
        "1.2.0-beta.14",
      );
      await mkdir(`${target}.bb-install-lock`);
    });

    it("refuses a dangling recovery-artifact symlink", async () => {
      const { source, target } = await createFixture();
      await symlink("missing-backup", `${target}.bb-install-backup`);

      await expectInstallFailure(
        install(source, target),
        /rollback bundle already exists/u,
      );

      expect(await readNodePtyVersion(target)).toBe("1.1.0");
    });
  },
);
