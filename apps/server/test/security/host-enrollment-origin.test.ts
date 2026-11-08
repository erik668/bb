import { hostDaemonEnrollKeyResponseSchema } from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  startTestServer,
  type RunningTestServer,
} from "../helpers/test-app.js";

let server: RunningTestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("loopback host enrollment browser boundary", () => {
  it.each([
    { origin: "https://attacker.example", contentType: "text/plain" },
    { origin: "https://attacker.example", contentType: "application/json" },
    { origin: "null", contentType: "text/plain" },
    { origin: "null", contentType: "application/json" },
  ])(
    "rejects $origin with $contentType without invalidating a pending key",
    async ({ origin, contentType }) => {
      server = await startTestServer();
      const hostId = "host_pending_enrollment";
      const pending = await server.deps.machineAuth.issueHostEnrollKey({
        hostId,
        enrollSource: "loopback",
      });

      const response = await fetch(
        new URL("/internal/hosts/enroll-key", server.baseUrl),
        {
          method: "POST",
          headers: { origin, "content-type": contentType },
          body: JSON.stringify({ hostId }),
        },
      );

      expect(response.status).toBe(403);
      expect(await readJson(response)).toMatchObject({
        code: "forbidden_origin",
      });
      await expect(
        server.deps.machineAuth.enrollHost({ hostId, token: pending.key }),
      ).resolves.toMatchObject({ metadata: { hostId } });
    },
  );

  it.each([
    {
      origin: "https://attacker.example",
      status: 403,
      code: "forbidden_origin",
    },
    { origin: undefined, status: 415, code: "unsupported_media_type" },
  ])(
    "rejects a simple malformed body with origin $origin before parsing",
    async ({ origin, status, code }) => {
      server = await startTestServer();
      const headers: Record<string, string> = { "content-type": "text/plain" };
      if (origin !== undefined) headers.origin = origin;

      const response = await fetch(
        new URL("/internal/hosts/enroll-key", server.baseUrl),
        { method: "POST", headers, body: "{" },
      );

      expect(response.status).toBe(status);
      expect(await readJson(response)).toMatchObject({ code });
    },
  );

  it.each(["absent", "same-origin"])(
    "keeps JSON enrollment working with an %s Origin",
    async (origin) => {
      server = await startTestServer();
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (origin === "same-origin") headers.origin = server.baseUrl;
      const hostId = "host_allowed_enrollment";

      const response = await fetch(
        new URL("/internal/hosts/enroll-key", server.baseUrl),
        { method: "POST", headers, body: JSON.stringify({ hostId }) },
      );

      expect(response.status).toBe(201);
      const issued = hostDaemonEnrollKeyResponseSchema.parse(
        await readJson(response),
      );
      expect(issued.hostId).toBe(hostId);
      await expect(
        server.deps.machineAuth.enrollHost({ hostId, token: issued.enrollKey }),
      ).resolves.toMatchObject({ metadata: { hostId } });
    },
  );
});
