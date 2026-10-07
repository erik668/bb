import { upsertInstalledPlugin } from "@bb/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHost,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

describe("public browser snapshot route", () => {
  let harness: TestAppHarness;
  let threadId: string;

  beforeEach(async () => {
    harness = await createTestAppHarness();
    const host = seedHost(harness.deps);
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
    });
    threadId = seedThread(harness.deps, {
      environmentId: environment.id,
      projectId: project.id,
    }).id;
  });

  afterEach(async () => {
    await harness?.cleanup();
  });

  async function snapshot(body: unknown): Promise<Response> {
    return await harness.app.request("/api/v1/browser/snapshots", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  }

  function enableBrowserControl(): void {
    upsertInstalledPlugin(harness.db, {
      activeArtifactId: null,
      enabled: true,
      exactResolution: { kind: "path" },
      id: "browser-control",
      provenance: { kind: "direct" },
      rootDir: "/tmp/browser-control",
      source: "path:/tmp/browser-control",
      sourceIntent: {
        canonicalPath: "/tmp/browser-control",
        kind: "path",
      },
      updateState: {
        availableCompatibleVersion: null,
        lastCheckAt: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      version: "0.0.0-test",
    });
  }

  it("keeps the route cut off while the built-in plugin is disabled", async () => {
    const response = await snapshot({ threadId });

    expect(response.status).toBe(404);
    await expect(readJson(response)).resolves.toMatchObject({
      code: "browser_control_disabled",
    });
  });

  it("parses the boundary and fails closed without a socket-owned grant", async () => {
    enableBrowserControl();

    const invalid = await snapshot({ threadId: 42 });
    expect(invalid.status).toBe(400);
    await expect(readJson(invalid)).resolves.toMatchObject({
      code: "invalid_request",
    });

    const disconnected = await snapshot({ threadId });
    expect(disconnected.status).toBe(409);
    await expect(readJson(disconnected)).resolves.toMatchObject({
      code: "browser_not_connected",
    });
  });

  it("does not expose controller grant lifecycle over the public API", async () => {
    const response = await harness.app.request("/api/v1/browser/grants", {
      body: JSON.stringify({
        controllerId: "controller:test",
        tabId: "browser:test",
        threadId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(404);
  });
});
