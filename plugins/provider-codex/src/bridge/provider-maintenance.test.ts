import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetChatGptCloudflareCookiesForTests } from "../ai/chatgpt-fetch.js";
import {
  __testing,
  getCodexProviderHealth,
  getCodexProviderInstallationRun,
  getCodexProviderInstallationStatus,
  getCodexProviderUsage,
} from "./provider-maintenance.js";

function installationStatus() {
  return {
    executableName: "codex",
    executablePath: "/usr/local/bin/codex",
    installed: true,
    installSource: "npmGlobal" as const,
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    minimumSupportedVersion: "0.136.0",
    npmPackageName: "@openai/codex",
    npmGlobalPackageVersion: "1.0.0",
    installAction: {
      kind: "update" as const,
      label: "Update" as const,
      command: "codex update",
    },
    needsUpdate: true,
    versionUnsupported: false,
  };
}

describe("Codex provider maintenance", () => {
  it("normalizes subscription windows and plan labels at the plugin boundary", () => {
    expect(
      __testing.normalizeUsage(
        {
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 42.4,
              reset_at: 1_750_000_000,
              limit_window_seconds: 18_000,
            },
            secondary_window: {
              used_percent: 120,
              reset_at: null,
              limit_window_seconds: 604_800,
            },
          },
        },
        "codex@example.com",
      ),
    ).toEqual({
      status: "ok",
      accountEmail: "codex@example.com",
      planLabel: "Plus",
      windows: [
        {
          label: "Current session",
          usedPercent: 42,
          resetsAt: "2025-06-15T15:06:40.000Z",
        },
        { label: "Weekly limit", usedPercent: 100, resetsAt: null },
      ],
    });
  });

  it("owns the stricter CLI requirement for thread rewind", () => {
    expect(__testing.minimumSupportedVersionForRequirement()).toBe("0.136.0");
    expect(
      __testing.minimumSupportedVersionForRequirement("thread_rewind"),
    ).toBe("0.143.0");
  });

  it("resolves a fresh typed update plan and rejects a stale action", () => {
    expect(
      __testing.buildProviderInstallationRun(installationStatus(), "update"),
    ).toEqual({
      available: true,
      command: {
        command: "codex",
        args: ["update"],
        displayCommand: "codex update",
      },
      verification: { kind: "version_at_least", version: "1.1.0" },
    });
    expect(
      __testing.buildProviderInstallationRun(installationStatus(), "install"),
    ).toEqual({
      available: false,
      message: "Codex install is no longer available on this host.",
    });
  });
});

describe("Codex credential health and usage", () => {
  const tempDirs: string[] = [];
  let homeDir: string;

  function base64UrlJson(value: object): string {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
  }

  function createAccessToken(args: {
    accountId: string;
    email: string;
    expSeconds: number;
  }): string {
    const payload = {
      exp: args.expSeconds,
      email: args.email,
      "https://api.openai.com/auth": { chatgpt_account_id: args.accountId },
    };
    return `${base64UrlJson({ alg: "none", typ: "JWT" })}.${base64UrlJson(payload)}.sig`;
  }

  async function writeAuthJson(contents: string): Promise<void> {
    const codexHome = path.join(homeDir, ".codex");
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(path.join(codexHome, "auth.json"), contents);
  }

  function writeChatGptAuth(accessToken: string): Promise<void> {
    return writeAuthJson(
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: accessToken, refresh_token: "refresh" },
      }),
    );
  }

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-codex-maint-"));
    tempDirs.push(homeDir);
    const binDir = path.join(homeDir, "bin");
    await fs.mkdir(binDir);
    await fs.writeFile(
      path.join(binDir, "codex"),
      '#!/bin/sh\necho "codex-cli 0.150.0"\n',
      { mode: 0o755 },
    );
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetChatGptCloudflareCookiesForTests();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => fs.rm(dir, { force: true, recursive: true })),
    );
  });

  it("reports unauthenticated when auth.json is missing", async () => {
    await expect(getCodexProviderHealth()).resolves.toEqual({
      supported: true,
      health: {
        status: "unauthenticated",
        statusMessage: null,
        accountEmail: null,
        planLabel: null,
        installedVersion: "0.150.0",
        minimumSupportedVersion: "0.136.0",
        canInstall: true,
        canUpdate: true,
        loginCommand: "codex login",
      },
    });
    await expect(getCodexProviderUsage()).resolves.toEqual({
      supported: true,
      usage: { status: "unauthenticated" },
    });
  });

  it("cache-only maintenance preserves local health and version gates with zero npm or usage refreshes", async () => {
    vi.stubEnv("BB_CODEX_MAINTENANCE_POLICY", "cache-only");
    const attempted = path.join(homeDir, "npm-attempted");
    await fs.writeFile(
      path.join(homeDir, "bin/npm"),
      `#!/bin/sh\ntouch '${attempted}'\nexit 99\n`,
      { mode: 0o755 },
    );
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    await writeAuthJson(
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test" }),
    );
    await expect(getCodexProviderInstallationStatus()).resolves.toMatchObject({
      installed: true,
      currentVersion: "0.150.0",
      latestVersion: null,
      npmGlobalPackageVersion: null,
      installAction: null,
      versionUnsupported: false,
    });
    await expect(getCodexProviderHealth()).resolves.toMatchObject({
      health: { status: "ready", canInstall: false, canUpdate: false },
    });
    await expect(getCodexProviderUsage()).resolves.toEqual({
      supported: false,
    });
    for (const action of ["install", "update"] as const) {
      await expect(
        getCodexProviderInstallationRun(action),
      ).resolves.toMatchObject({ available: false });
    }
    await fs.writeFile(
      path.join(homeDir, "bin/codex"),
      '#!/bin/sh\necho "codex-cli 0.135.0"\n',
    );
    await expect(
      getCodexProviderInstallationStatus("thread_rewind"),
    ).resolves.toMatchObject({
      versionUnsupported: true,
      minimumSupportedVersion: "0.143.0",
      installAction: null,
    });
    await expect(getCodexProviderHealth()).resolves.toMatchObject({
      health: { status: "unsupported_version" },
    });
    await fs.writeFile(
      path.join(homeDir, "bin/codex"),
      '#!/bin/sh\necho "unparseable"\n',
    );
    await expect(getCodexProviderInstallationStatus()).resolves.toMatchObject({
      installed: true,
      currentVersion: null,
      versionUnsupported: true,
      installAction: null,
    });
    await expect(getCodexProviderHealth()).resolves.toMatchObject({
      health: { status: "unknown" },
    });
    await fs.unlink(path.join(homeDir, "bin/codex"));
    vi.stubEnv("PATH", path.join(homeDir, "bin"));
    await expect(getCodexProviderInstallationStatus()).resolves.toMatchObject({
      installed: false,
      installAction: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(fs.stat(attempted)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("an invalid maintenance policy fails before external commands or network access", async () => {
    vi.stubEnv("BB_CODEX_MAINTENANCE_POLICY", "cache-onyl");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getCodexProviderInstallationStatus()).rejects.toThrow();
    await expect(getCodexProviderInstallationRun("install")).rejects.toThrow();
    await expect(getCodexProviderHealth()).rejects.toThrow();
    await expect(getCodexProviderUsage()).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports expired when the ChatGPT access token has passed its exp", async () => {
    await writeChatGptAuth(
      createAccessToken({
        accountId: "account-123",
        email: "codex@example.com",
        expSeconds: Math.floor(Date.now() / 1000) - 60,
      }),
    );

    await expect(getCodexProviderHealth()).resolves.toMatchObject({
      health: {
        status: "expired",
        accountEmail: "codex@example.com",
        installedVersion: "0.150.0",
      },
    });
    await expect(getCodexProviderUsage()).resolves.toEqual({
      supported: true,
      usage: { status: "expired" },
    });
  });

  it("treats API-key auth as ready with no subscription usage to report", async () => {
    await writeAuthJson(
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test" }),
    );

    await expect(getCodexProviderHealth()).resolves.toMatchObject({
      health: { status: "ready", accountEmail: null },
    });
    await expect(getCodexProviderUsage()).resolves.toEqual({
      supported: true,
      usage: {
        status: "error",
        message:
          "Codex is authenticated with an API key, which has no subscription usage limits.",
        planLabel: null,
        accountEmail: null,
      },
    });
  });

  it("surfaces an auth.json that is not JSON as unknown health, not as unauthenticated", async () => {
    await writeAuthJson("{not json");

    await expect(getCodexProviderHealth()).resolves.toMatchObject({
      supported: true,
      health: { status: "unknown", statusMessage: expect.any(String) },
    });
    await expect(getCodexProviderUsage()).resolves.toMatchObject({
      supported: true,
      usage: { status: "error", message: expect.any(String) },
    });
  });

  it("fetches usage with the ChatGPT token and retries once through a Cloudflare challenge", async () => {
    const accessToken = createAccessToken({
      accountId: "account-123",
      email: "codex@example.com",
      expSeconds: Math.floor(Date.now() / 1000) + 3600,
    });
    await writeChatGptAuth(accessToken);
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(
        new Response("challenge", {
          status: 403,
          headers: {
            "cf-mitigated": "challenge",
            "set-cookie": "__cf_bm=cloudflare-cookie; Path=/; Secure; HttpOnly",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 10,
                reset_at: 1_750_000_000,
                limit_window_seconds: 18_000,
              },
            },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCodexProviderUsage()).resolves.toEqual({
      supported: true,
      usage: {
        status: "ok",
        accountEmail: "codex@example.com",
        planLabel: "Plus",
        windows: [
          {
            label: "Current session",
            usedPercent: 10,
            resetsAt: "2025-06-15T15:06:40.000Z",
          },
        ],
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = fetchMock.mock.calls[0] ?? [];
    const [retryUrl, retryInit] = fetchMock.mock.calls[1] ?? [];
    expect(firstUrl).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(retryUrl).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(new Headers(firstInit?.headers).get("cookie")).toBeNull();
    const retryHeaders = new Headers(retryInit?.headers);
    expect(retryHeaders.get("cookie")).toBe("__cf_bm=cloudflare-cookie");
    expect(retryHeaders.get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(retryHeaders.get("chatgpt-account-id")).toBe("account-123");
  });
});
