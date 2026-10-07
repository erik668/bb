import { describe, expect, it } from "vitest";
import { createPluginDevLoop } from "./plugin-dev-loop.js";

describe("plugin development loop shutdown", () => {
  it("drains accepted work and rejects a final event after intake closes", async () => {
    let releaseFirstReload: (() => void) | undefined;
    const firstReloadStarted = new Promise<void>((resolve) => {
      releaseFirstReload = resolve;
    });
    let continueFirstReload: (() => void) | undefined;
    const firstReloadCanFinish = new Promise<void>((resolve) => {
      continueFirstReload = resolve;
    });
    let reloads = 0;
    const loop = createPluginDevLoop({
      pluginId: "fixture",
      hasApp: false,
      hasHost: false,
      buildApp: async () => {},
      buildHost: async () => {},
      reloadPlugin: async () => {
        reloads += 1;
        releaseFirstReload?.();
        await firstReloadCanFinish;
      },
      log: () => {},
    });

    const firstChange = loop.handleChange("first.ts");
    loop.closeIntake();
    const draining = loop.settled();
    await firstReloadStarted;
    const finalChange = loop.handleChange("final.ts");
    continueFirstReload?.();
    await draining;

    await expect(firstChange).resolves.toBe(true);
    await expect(finalChange).resolves.toBe(false);
    expect(reloads).toBe(1);
  });
});
