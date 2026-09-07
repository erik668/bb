import { readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { relative, isAbsolute, sep, extname } from "node:path";

const require = createRequire(import.meta.url);
const runtime = {
  family: process.versions.electron ? "electron" : "node",
  version: process.versions.electron ?? process.versions.node,
  nodeVersion: process.versions.node,
  electronVersion: process.versions.electron ?? null,
  moduleAbi: process.versions.modules,
  platform: process.platform,
  arch: process.arch,
};
let request;
function inside(root, path) {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw Object.assign(new Error(`Native path escapes root: ${path}`), {
      code: "PATH_OUTSIDE_ARTIFACT",
    });
}
function identity(path) {
  const resolved = realpathSync(path);
  inside(request.artifactRoot, resolved);
  inside(request.module.root, resolved);
  if (!statSync(resolved).isFile())
    throw Object.assign(new Error("Native path is not a regular file"), {
      code: "INVALID_NATIVE_FILE",
    });
  return {
    realpath: resolved,
    sha256: createHash("sha256").update(readFileSync(resolved)).digest("hex"),
  };
}
try {
  request = JSON.parse(readFileSync(0, "utf8"));
  if (request.phase === "runtime") {
    process.stdout.write(JSON.stringify({ version: 1, ok: true, runtime }));
  } else if (request.phase === "load") {
    if (
      !Object.keys(request.expected).every(
        (key) => runtime[key] === request.expected[key],
      ) ||
      !Object.keys(runtime).every(
        (key) => runtime[key] === request.runtime[key],
      )
    )
      throw Object.assign(new Error("Runtime mismatch before load"), {
        code: "RUNTIME_IDENTITY_MISMATCH",
      });
    const entry = identity(request.module.entrypoint.realpath);
    if (entry.sha256 !== request.module.entrypoint.sha256)
      throw Object.assign(new Error("Entrypoint changed before load"), {
        code: "INPUT_CHANGED",
      });
    const loaded = new Map();
    const dlopen = process.dlopen;
    process.dlopen = function (module, filename, ...args) {
      const before = identity(filename);
      const result = Reflect.apply(dlopen, this, [module, filename, ...args]);
      const after = identity(filename);
      if (before.sha256 !== after.sha256 || before.realpath !== after.realpath)
        throw Object.assign(new Error("Native file changed during load"), {
          code: "INPUT_CHANGED",
        });
      loaded.set(after.realpath, after);
      return result;
    };
    const imported = require(request.module.entrypoint.realpath);
    if (request.module.name === "better-sqlite3") {
      const Database = imported.default ?? imported;
      const database = new Database(":memory:");
      try {
        if (database.prepare("SELECT 1 AS probe").get()?.probe !== 1)
          throw Object.assign(new Error("SQLite query failed"), {
            code: "SQLITE_PROBE_FAILED",
          });
      } finally {
        database.close();
      }
    }
    const native = [];
    for (const path of Object.keys(require.cache)) {
      if (extname(path) !== ".node") continue;
      const observed = identity(path);
      if (
        !loaded.has(observed.realpath) ||
        loaded.get(observed.realpath).sha256 !== observed.sha256
      )
        throw Object.assign(
          new Error("Native cache lacks matching load evidence"),
          { code: "INVALID_NATIVE_CACHE" },
        );
      if (!native.some((item) => item.realpath === observed.realpath))
        native.push(observed);
    }
    if (native.length === 0)
      throw Object.assign(
        new Error("No native cache entry loaded in package"),
        { code: "NATIVE_NOT_LOADED" },
      );
    process.stdout.write(
      JSON.stringify({
        version: 1,
        ok: true,
        runtime,
        module: request.module.name,
        native,
      }),
    );
  } else {
    throw Object.assign(new Error("Invalid probe phase"), {
      code: "PROTOCOL_INVALID",
    });
  }
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      version: 1,
      ok: false,
      runtime,
      error: {
        module: request?.module?.name ?? null,
        code:
          typeof error?.code === "string" ? error.code.slice(0, 4096) : null,
        detail: String(error?.message ?? error).slice(0, 2048),
      },
    }),
  );
}
