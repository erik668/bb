import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { pluginSdkAliasFor } from "../../../src/services/plugins/plugin-runtime.js";

describe("pluginSdkAliasFor", () => {
  it.each(["@get-bb/plugin-sdk", "@bb/plugin-sdk"])(
    "loads %s/host through Jiti without appending a subpath to the root bundle",
    async (specifier) => {
      const root = mkdtempSync(join(tmpdir(), "plugin-sdk-host-alias-"));
      try {
        const runtime = join(root, "plugin-sdk-runtime.js");
        writeFileSync(runtime, "export const location = 'root';");
        writeFileSync(join(root, "plugin-sdk-host-runtime.js"), "export const location = 'host';");
        const entry = join(root, "plugin.ts");
        writeFileSync(entry, `export { location } from '${specifier}/host';`);
        const jiti = createJiti(import.meta.url, { moduleCache: false, alias: pluginSdkAliasFor(runtime) });
        expect(await jiti.import(entry)).toMatchObject({ location: "host" });
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  );
  it("resolves the pre-rename specifier to the same SDK runtime bundle", () => {
    const alias = pluginSdkAliasFor("/srv/plugin-sdk-runtime.js");

    expect(alias["@get-bb/plugin-sdk"]).toBe("/srv/plugin-sdk-runtime.js");
    expect(alias["@bb/plugin-sdk"]).toBe("/srv/plugin-sdk-runtime.js");
  });
});
