import { readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, sep, join, extname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const helper = fileURLToPath(
  new URL("./packaged-runtime-probe.mjs", import.meta.url),
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize(value[key])]),
    );
  return value;
}
function fail(code, detail) {
  throw Object.assign(new Error(detail), { gateCode: code });
}
function object(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("|") === [...keys].sort().join("|")
  );
}
const string = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  !value.includes("\0");
const absolute = (value) => string(value) && isAbsolute(value);
function contained(root, path) {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    fail("PATH_OUTSIDE_ARTIFACT", `Path escapes declared root: ${path}`);
}
function real(path, directory = false) {
  const result = realpathSync(path);
  const stats = statSync(result);
  if (!(directory ? stats.isDirectory() : stats.isFile()))
    fail(
      "REQUEST_INVALID",
      `Expected ${directory ? "directory" : "regular file"}: ${path}`,
    );
  return result;
}
function file(path, roots = []) {
  const resolved = real(path);
  for (const root of roots) contained(root, resolved);
  return { realpath: resolved, sha256: digest(readFileSync(resolved)) };
}
function runtimeValid(runtime) {
  return (
    object(runtime, [
      "family",
      "version",
      "nodeVersion",
      "electronVersion",
      "moduleAbi",
      "platform",
      "arch",
    ]) &&
    ["node", "electron"].includes(runtime.family) &&
    /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(runtime.version) &&
    typeof runtime.version === "string" &&
    typeof runtime.nodeVersion === "string" &&
    /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(runtime.nodeVersion) &&
    typeof runtime.moduleAbi === "string" &&
    /^\d+$/.test(runtime.moduleAbi) &&
    ["darwin", "linux"].includes(runtime.platform) &&
    ["arm64", "x64"].includes(runtime.arch) &&
    (runtime.family === "electron"
      ? runtime.electronVersion === runtime.version
      : runtime.electronVersion === null &&
        runtime.version === runtime.nodeVersion)
  );
}
function matches(runtime, expected) {
  return Object.keys(expected).every((key) => runtime[key] === expected[key]);
}

export function inspectPackagedRuntime(request, boundary = {}) {
  const receipt = {
    version: 1,
    kind: "bb-packaged-native-runtime",
    passed: false,
  };
  try {
    if (
      !object(request, [
        "artifactRoot",
        "executable",
        "expected",
        "modules",
        "lockfile",
      ]) ||
      !absolute(request.artifactRoot) ||
      !absolute(request.executable) ||
      !absolute(request.lockfile) ||
      !object(request.expected, ["family", "version", "platform", "arch"]) ||
      !["node", "electron"].includes(request.expected.family) ||
      typeof request.expected.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(request.expected.version) ||
      !["darwin", "linux"].includes(request.expected.platform) ||
      !["arm64", "x64"].includes(request.expected.arch) ||
      !Array.isArray(request.modules) ||
      request.modules.length < 1 ||
      request.modules.length > 8 ||
      request.modules.some(
        (module) =>
          !object(module, ["name", "root"]) ||
          !["better-sqlite3", "node-pty"].includes(module.name) ||
          !absolute(module.root),
      )
    ) {
      fail(
        "REQUEST_INVALID",
        "Request must match the closed packaged runtime contract",
      );
    }
    receipt.expected = { ...request.expected };
    const artifact = real(request.artifactRoot, true);
    const snapshots = [];
    const snapshot = (path, roots = []) => {
      const identity = file(path, roots);
      snapshots.push({ path, roots, identity });
      return identity;
    };
    const executable = snapshot(request.executable);
    const lockfile = { kind: "lockfile", ...snapshot(request.lockfile) };
    const roots = new Set();
    const modules = request.modules.map((module) => {
      const root = real(module.root, true);
      contained(artifact, root);
      if (roots.has(root)) fail("REQUEST_INVALID", "Duplicate module root");
      roots.add(root);
      const metadata = snapshot(join(root, "package.json"), [artifact, root]);
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(metadata.realpath, "utf8"));
      } catch {
        fail("REQUEST_INVALID", `Invalid package metadata: ${module.name}`);
      }
      if (pkg.name !== module.name || !string(pkg.version))
        fail(
          "REQUEST_INVALID",
          `Package name/version mismatch: ${module.name}`,
        );
      let entry;
      try {
        entry = createRequire(join(root, "package.json")).resolve(root);
      } catch (error) {
        fail(
          "NATIVE_LOAD_FAILED",
          `${module.name}: ${error.code ?? "RESOLUTION_FAILED"}: ${String(error.message).slice(0, 1000)}`,
        );
      }
      const entrypoint = snapshot(entry, [artifact, root]);
      return {
        name: module.name,
        version: pkg.version,
        root,
        metadata,
        entrypoint,
      };
    });
    const unchanged = () => {
      for (const item of snapshots) {
        try {
          if (
            canonical(file(item.path, item.roots)) !== canonical(item.identity)
          )
            fail("INPUT_CHANGED", `Input changed: ${item.path}`);
        } catch {
          fail(
            "INPUT_CHANGED",
            `Input changed or became inaccessible: ${item.path}`,
          );
        }
      }
      for (let i = 0; i < modules.length; i++) {
        try {
          if (
            real(request.modules[i].root, true) !== modules[i].root ||
            real(request.artifactRoot, true) !== artifact
          )
            fail("INPUT_CHANGED", "Root changed");
        } catch {
          fail("INPUT_CHANGED", "Artifact or module root changed");
        }
      }
    };
    const run = (payload) => {
      unchanged();
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
      delete env.NODE_OPTIONS;
      delete env.NODE_TEST_CONTEXT;
      let result;
      try {
        result = (boundary.spawnSync ?? spawnSync)(
          executable.realpath,
          [helper],
          {
            input: JSON.stringify(payload),
            encoding: "utf8",
            env,
            timeout: 10000,
            maxBuffer: 65536,
            windowsHide: true,
            killSignal: "SIGKILL",
          },
        );
      } catch (error) {
        unchanged();
        fail(
          "RUNTIME_PROBE_FAILED",
          `Subprocess threw: ${String(error.code ?? "UNKNOWN").slice(0, 100)}`,
        );
      }
      unchanged();
      if (
        !result ||
        result.error ||
        result.status !== 0 ||
        result.signal ||
        typeof result.stdout !== "string" ||
        Buffer.byteLength(result.stdout) > 65536 ||
        (result.stderr != null &&
          (typeof result.stderr !== "string" ||
            Buffer.byteLength(result.stderr) > 65536))
      ) {
        fail(
          "RUNTIME_PROBE_FAILED",
          `Subprocess failed: ${String(result?.error?.code ?? result?.signal ?? result?.status ?? "INVALID_RESULT").slice(0, 100)}`,
        );
      }
      let response;
      try {
        response = JSON.parse(result.stdout);
      } catch {
        fail("RUNTIME_PROBE_FAILED", "Malformed subprocess JSON");
      }
      if (
        !response ||
        response.version !== 1 ||
        !runtimeValid(response.runtime) ||
        typeof response.ok !== "boolean"
      )
        fail("RUNTIME_PROBE_FAILED", "Invalid subprocess protocol");
      receipt.runtime = { ...response.runtime, executable };
      if (!matches(response.runtime, receipt.expected))
        fail(
          "RUNTIME_IDENTITY_MISMATCH",
          "Measured runtime does not match expected tuple",
        );
      if (
        payload.phase === "load" &&
        canonical(response.runtime) !== canonical(payload.runtime)
      )
        fail("RUNTIME_IDENTITY_MISMATCH", "Runtime changed between phases");
      if (!response.ok) {
        if (
          !object(response, ["version", "ok", "runtime", "error"]) ||
          !object(response.error, ["module", "code", "detail"]) ||
          response.error.module !== (payload.module?.name ?? null) ||
          !(response.error.code === null || string(response.error.code)) ||
          typeof response.error.detail !== "string" ||
          response.error.detail.length > 2048
        )
          fail("RUNTIME_PROBE_FAILED", "Invalid subprocess error");
        receipt.module = response.error.module;
        receipt.error = response.error;
        if (response.error.code === "INPUT_CHANGED")
          fail("INPUT_CHANGED", response.error.detail);
        fail(
          "NATIVE_LOAD_FAILED",
          `${response.error.module}: ${response.error.code ?? "UNKNOWN"}: ${response.error.detail}`,
        );
      }
      if (payload.phase === "runtime") {
        if (!object(response, ["version", "ok", "runtime"]))
          fail("RUNTIME_PROBE_FAILED", "Unexpected runtime fields");
      } else {
        if (
          !object(response, ["version", "ok", "runtime", "module", "native"]) ||
          response.module !== payload.module.name ||
          !Array.isArray(response.native) ||
          response.native.length < 1 ||
          response.native.length > 128
        )
          fail("RUNTIME_PROBE_FAILED", "Invalid native evidence");
        const seen = new Set();
        for (const native of response.native) {
          if (
            !object(native, ["realpath", "sha256"]) ||
            !absolute(native.realpath) ||
            typeof native.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(native.sha256) ||
            extname(native.realpath) !== ".node" ||
            seen.has(native.realpath)
          )
            fail("RUNTIME_PROBE_FAILED", "Malformed native identity");
          seen.add(native.realpath);
          const observed = snapshot(native.realpath, [
            artifact,
            payload.module.root,
          ]);
          if (canonical(observed) !== canonical(native))
            fail("INPUT_CHANGED", "Native identity changed after load");
        }
      }
      return response;
    };
    const measured = run({ phase: "runtime" }).runtime;
    for (const module of modules) {
      const response = run({
        phase: "load",
        expected: receipt.expected,
        runtime: measured,
        module,
        artifactRoot: artifact,
      });
      module.native = response.native.sort((a, b) =>
        a.realpath.localeCompare(b.realpath),
      );
    }
    unchanged();
    modules.sort((a, b) => a.root.localeCompare(b.root));
    receipt.lockfile = lockfile;
    receipt.modules = modules;
    receipt.identitySha256 = digest(
      canonical({ runtime: receipt.runtime, lockfile, modules }),
    );
    receipt.passed = true;
  } catch (error) {
    receipt.blocker = {
      code: error?.gateCode ?? "REQUEST_INVALID",
      detail: String(error?.message ?? error).slice(0, 2048),
    };
  }
  return receipt;
}
