import { describe, expect, it } from "vitest";
import { resolveDevAppLoopbackUrl } from "./dev-app-loopback.js";

describe("resolveDevAppLoopbackUrl", () => {
  it.each([
    "http://sawyer.localhost:8787",
    "https://sawyer.getbb.app",
    "https://sawyer.connect.example.com",
  ])("targets Vite for source-development pairing %s", (serverUrl) => {
    expect(resolveDevAppLoopbackUrl(serverUrl, "11001")).toBe(
      "http://127.0.0.1:11001",
    );
  });

  it.each([undefined, "", "0", "65536", "1.5", "not-a-port"])(
    "keeps the backend origin when the development port is %s",
    (port) => {
      expect(resolveDevAppLoopbackUrl("https://sawyer.getbb.app", port)).toBeNull();
    },
  );

  it.each([
    undefined,
    "",
    "not-a-url",
    "http://sawyer.getbb.app",
    "ftp://sawyer.getbb.app",
  ])("does not select Vite for unsupported pairing %s", (serverUrl) => {
    expect(resolveDevAppLoopbackUrl(serverUrl, "11001")).toBeNull();
  });
});
