import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { inspectPackagedRuntime } from "../scripts/packaged-runtime-preflight.mjs";

const hash = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const runtime = {
  family: "node",
  version: process.versions.node,
  nodeVersion: process.versions.node,
  electronVersion: null,
  moduleAbi: process.versions.modules,
  platform: process.platform,
  arch: process.arch,
};
function fixture(t, source = "module.exports = {};", name = "node-pty") {
  const temp = mkdtempSync(join(tmpdir(), "packaged-gate-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const artifactRoot = join(temp, "artifact");
  const root = join(artifactRoot, "modules", name);
  mkdirSync(root, { recursive: true });
  const entry = join(root, "index.cjs");
  const metadata = join(root, "package.json");
  writeFileSync(
    metadata,
    JSON.stringify({ name, version: "1.0.0", main: "index.cjs" }),
  );
  writeFileSync(entry, source);
  const lockfile = join(temp, "lock.json");
  writeFileSync(lockfile, "{}");
  const native = join(root, "binding.node");
  writeFileSync(native, "synthetic native identity");
  const request = {
    artifactRoot,
    executable: process.execPath,
    expected: {
      family: "node",
      version: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    modules: [{ name, root }],
    lockfile,
  };
  return { temp, root, entry, metadata, native, request };
}
function synthetic(transform = (response) => response, observer = () => {}) {
  return {
    spawnSync(executable, argv, options) {
      const payload = JSON.parse(options.input);
      observer(payload, options);
      const response = { version: 1, ok: true, runtime: { ...runtime } };
      if (payload.phase === "load") {
        response.module = payload.module.name;
        const realpath = join(payload.module.root, "binding.node");
        response.native = [{ realpath, sha256: hash(realpath) }];
      }
      return {
        status: 0,
        signal: null,
        stderr: "",
        stdout: JSON.stringify(transform(response, payload)),
      };
    },
  };
}

test("closed requests reject unknown, missing, malformed and duplicate fields before subprocess", (t) => {
  const f = fixture(t);
  const invalid = [
    null,
    {},
    { ...f.request, extra: true },
    { ...f.request, modules: [] },
    { ...f.request, executable: "relative" },
    { ...f.request, expected: { ...f.request.expected, version: "v24.0.0" } },
    { ...f.request, modules: [{ ...f.request.modules[0], extra: 1 }] },
    { ...f.request, modules: [f.request.modules[0], f.request.modules[0]] },
    { ...f.request, modules: [{ name: "", root: f.root }] },
    { ...f.request, lockfile: f.root },
  ];
  for (const request of invalid) {
    const result = inspectPackagedRuntime(request, {
      spawnSync() {
        assert.fail("must not execute");
      },
    });
    assert.equal(result.passed, false);
    assert.equal(result.blocker.code, "REQUEST_INVALID");
  }
});

test("actual Node mismatch precedes module side effects and reports measured runtime", (t) => {
  const f = fixture(t);
  const marker = join(f.temp, "marker");
  writeFileSync(
    f.entry,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');`,
  );
  for (const expected of [
    { ...f.request.expected, version: "0.0.0" },
    { ...f.request.expected, family: "electron" },
    { ...f.request.expected, arch: process.arch === "arm64" ? "x64" : "arm64" },
  ]) {
    const result = inspectPackagedRuntime({ ...f.request, expected });
    assert.equal(result.blocker.code, "RUNTIME_IDENTITY_MISMATCH");
    assert.equal(result.runtime.nodeVersion, process.versions.node);
    assert.equal(result.runtime.moduleAbi, process.versions.modules);
    assert.equal(existsSync(marker), false);
  }
});

test("actual fresh loader preserves lazy SQLite error and runs its constructor", (t) => {
  const f = fixture(t, "", "better-sqlite3");
  const marker = join(f.temp, "marker");
  writeFileSync(
    f.entry,
    `module.exports = class { constructor(path) { require('node:assert/strict').equal(path, ':memory:'); require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes'); throw Object.assign(new Error('lazy binding failed'), {code:'ERR_DLOPEN_FAILED'}); } };`,
  );
  const result = inspectPackagedRuntime(f.request);
  assert.equal(result.blocker.code, "NATIVE_LOAD_FAILED");
  assert.equal(result.error.module, "better-sqlite3");
  assert.equal(result.error.code, "ERR_DLOPEN_FAILED");
  assert.equal(existsSync(marker), true);
});

test("SQLite query and close run but a JS-only import cannot pass", (t) => {
  const f = fixture(t, "", "better-sqlite3");
  const marker = join(f.temp, "closed");
  writeFileSync(
    f.entry,
    `module.exports = class { prepare(sql) { require('node:assert/strict').equal(sql, 'SELECT 1 AS probe'); return {get(){ return {probe:1}; }}; } close() { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes'); } };`,
  );
  const result = inspectPackagedRuntime(f.request);
  assert.equal(result.blocker.code, "NATIVE_LOAD_FAILED");
  assert.equal(result.error.code, "NATIVE_NOT_LOADED");
  assert.equal(existsSync(marker), true);
});

test("actual node-pty import does not call spawn and rejects missing native evidence", (t) => {
  const f = fixture(
    t,
    'module.exports = {spawn(){throw new Error("spawn must not run");}};',
  );
  const result = inspectPackagedRuntime(f.request);
  assert.equal(result.error.code, "NATIVE_NOT_LOADED");
  writeFileSync(f.entry, 'require("./missing.node");');
  assert.equal(
    inspectPackagedRuntime(f.request).error.code,
    "MODULE_NOT_FOUND",
  );
  writeFileSync(f.entry, 'require("./binding.node");');
  assert.equal(
    inspectPackagedRuntime(f.request).error.code,
    "ERR_DLOPEN_FAILED",
  );
});

test("selected root, metadata and entrypoint symlink escapes are rejected", (t) => {
  const f = fixture(t);
  const outside = join(f.temp, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(f.request.artifactRoot, "escaped"));
  assert.equal(
    inspectPackagedRuntime({
      ...f.request,
      modules: [
        { name: "node-pty", root: join(f.request.artifactRoot, "escaped") },
      ],
    }).blocker.code,
    "PATH_OUTSIDE_ARTIFACT",
  );
  for (const path of [f.metadata, f.entry]) {
    const bytes = readFileSync(path);
    const target = join(outside, "file");
    writeFileSync(target, bytes);
    rmSync(path);
    symlinkSync(target, path);
    assert.equal(
      inspectPackagedRuntime(f.request).blocker.code,
      "PATH_OUTSIDE_ARTIFACT",
    );
    rmSync(path);
    writeFileSync(path, bytes);
  }
});

test("subprocess environment and bounds are fixed and failures use typed codes", (t) => {
  const f = fixture(t);
  for (const failure of [
    { error: { code: "ETIMEDOUT" } },
    { status: 1, stderr: "anything" },
    { status: 0, stdout: "{" },
    { status: 0, stdout: "x".repeat(65537) },
    { status: 0, stdout: "{}", stderr: "x".repeat(65537) },
  ]) {
    const result = inspectPackagedRuntime(f.request, {
      spawnSync(executable, argv, options) {
        assert.equal(options.timeout, 10000);
        assert.equal(options.maxBuffer, 65536);
        assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
        assert.equal("NODE_OPTIONS" in options.env, false);
        assert.equal("NODE_TEST_CONTEXT" in options.env, false);
        assert.equal(options.killSignal, "SIGKILL");
        return failure;
      },
    });
    assert.equal(result.blocker.code, "RUNTIME_PROBE_FAILED");
  }
});

test("actual malformed executable output is rejected", (t) => {
  const f = fixture(t);
  const executable = join(f.temp, "bad-protocol");
  writeFileSync(executable, "#!/bin/sh\nprintf malformed", { mode: 0o755 });
  assert.equal(
    inspectPackagedRuntime({ ...f.request, executable }).blocker.code,
    "RUNTIME_PROBE_FAILED",
  );
});

test("protocol rejects malformed tuples and untrusted native paths", (t) => {
  const f = fixture(t);
  const controls = [
    (r) => ({ ...r, unexpected: 1 }),
    (r) => ({ ...r, runtime: { ...r.runtime, moduleAbi: 123 } }),
    (r, p) => (p.phase === "load" ? { ...r, module: "other" } : r),
    (r, p) => (p.phase === "load" ? { ...r, native: [] } : r),
    (r, p) =>
      p.phase === "load"
        ? {
            ...r,
            native: [{ realpath: "relative.node", sha256: "a".repeat(64) }],
          }
        : r,
  ];
  for (const control of controls)
    assert.equal(
      inspectPackagedRuntime(f.request, synthetic(control)).blocker.code,
      "RUNTIME_PROBE_FAILED",
    );
  const outside = join(f.temp, "outside.node");
  writeFileSync(outside, "native");
  const result = inspectPackagedRuntime(
    f.request,
    synthetic((r, p) =>
      p.phase === "load"
        ? { ...r, native: [{ realpath: outside, sha256: hash(outside) }] }
        : r,
    ),
  );
  assert.equal(result.blocker.code, "PATH_OUTSIDE_ARTIFACT");
  const sibling = join(f.request.artifactRoot, "sibling.node");
  writeFileSync(sibling, "native");
  assert.equal(
    inspectPackagedRuntime(
      f.request,
      synthetic((r, p) =>
        p.phase === "load"
          ? { ...r, native: [{ realpath: sibling, sha256: hash(sibling) }] }
          : r,
      ),
    ).blocker.code,
    "PATH_OUTSIDE_ARTIFACT",
  );
});

test("input drift is detected around both phases including failed subprocesses", (t) => {
  const f = fixture(t);
  for (const phase of ["runtime", "load"]) {
    for (const path of [f.entry, f.metadata, f.request.lockfile]) {
      const before = readFileSync(path);
      const result = inspectPackagedRuntime(
        f.request,
        synthetic(undefined, (payload) => {
          if (payload.phase === phase)
            writeFileSync(path, Buffer.concat([before, Buffer.from(" ")]));
        }),
      );
      assert.equal(result.blocker.code, "INPUT_CHANGED");
      writeFileSync(path, before);
    }
  }
  const result = inspectPackagedRuntime(f.request, {
    spawnSync() {
      writeFileSync(f.request.lockfile, "changed");
      return { status: 1 };
    },
  });
  assert.equal(result.blocker.code, "INPUT_CHANGED");
});

test("actual module mutation of lockfile fails despite structured loader failure", (t) => {
  const f = fixture(t);
  writeFileSync(
    f.entry,
    `require('node:fs').writeFileSync(${JSON.stringify(f.request.lockfile)}, 'changed'); throw Object.assign(new Error('failed'), {code:'TEST'});`,
  );
  assert.equal(inspectPackagedRuntime(f.request).blocker.code, "INPUT_CHANGED");
});

test("synthetic native success binds typed bytes and is insensitive to object key ordering", (t) => {
  const f = fixture(t);
  const first = inspectPackagedRuntime(f.request, synthetic());
  assert.equal(first.passed, true);
  assert.equal(first.lockfile.kind, "lockfile");
  assert.equal(first.modules[0].native[0].sha256, hash(f.native));
  assert.equal(first.runtime.executable.sha256, hash(process.execPath));
  const reordered = Object.fromEntries(Object.entries(f.request).reverse());
  reordered.expected = Object.fromEntries(
    Object.entries(f.request.expected).reverse(),
  );
  assert.equal(
    inspectPackagedRuntime(reordered, synthetic()).identitySha256,
    first.identitySha256,
  );
  for (const path of [f.native, f.request.lockfile]) {
    const before = readFileSync(path);
    writeFileSync(path, "different bytes");
    const changed = inspectPackagedRuntime(f.request, synthetic());
    assert.equal(changed.passed, true);
    assert.notEqual(changed.identitySha256, first.identitySha256);
    writeFileSync(path, before);
  }
  writeFileSync(
    f.metadata,
    JSON.stringify({ name: "node-pty", version: "2.0.0", main: "index.cjs" }),
  );
  assert.notEqual(
    inspectPackagedRuntime(f.request, synthetic()).identitySha256,
    first.identitySha256,
  );
  const abi = inspectPackagedRuntime(
    f.request,
    synthetic((r) => ({ ...r, runtime: { ...r.runtime, moduleAbi: "999" } })),
  );
  assert.equal(abi.passed, true);
  assert.notEqual(abi.identitySha256, first.identitySha256);
});

test("same-named distinct package copies load separately and reordered selections preserve identity", (t) => {
  const f = fixture(t);
  const second = join(f.request.artifactRoot, "second");
  mkdirSync(second);
  for (const [name, source] of [
    ["package.json", f.metadata],
    ["index.cjs", f.entry],
    ["binding.node", f.native],
  ])
    writeFileSync(join(second, name), readFileSync(source));
  const request = {
    ...f.request,
    modules: [...f.request.modules, { name: "node-pty", root: second }],
  };
  let loads = 0;
  const result = inspectPackagedRuntime(
    request,
    synthetic(undefined, (p) => {
      if (p.phase === "load") loads++;
    }),
  );
  assert.equal(result.passed, true);
  assert.equal(loads, 2);
  assert.equal(
    inspectPackagedRuntime(
      { ...request, modules: [...request.modules].reverse() },
      synthetic(),
    ).identitySha256,
    result.identitySha256,
  );
});

test("actual subprocess control measures the executable even with an injected boundary", (t) => {
  const f = fixture(t);
  let phases = 0;
  const result = inspectPackagedRuntime(f.request, {
    spawnSync(...args) {
      phases++;
      return spawnSync(...args);
    },
  });
  assert.equal(phases, 2);
  assert.equal(result.runtime.family, "node");
  assert.equal(result.error.code, "NATIVE_NOT_LOADED");
});
