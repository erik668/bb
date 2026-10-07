import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

const schema = JSON.parse(readFileSync(new URL("./result.schema.json", import.meta.url), "utf8"));
if (schema.$id !== "artifact-review-v3-host-foundation-lab-result-v1") {
  throw new Error("unexpected lab result schema identity");
}

const expectedEventTypes = [
  "barrier-received",
  "sigkill-sent",
  "child-exit",
  "observer-start:node",
  "observer-exit:node",
  "observer-start:sqlite3",
  "observer-exit:sqlite3",
];

const fail = (path, message) => {
  throw new TypeError(`${path}: ${message}`);
};

const object = (value, path) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value;
};

const exactKeys = (value, keys, path) => {
  object(value, path);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(path, `keys must be exactly ${expected.join(",")}`);
  }
};

const positiveInteger = (value, path) => {
  if (!Number.isInteger(value) || value <= 0) fail(path, "must be a positive integer");
};

const sha256 = (value, path) => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail(path, "must be a lowercase SHA-256 digest");
  }
};

const validateObservation = (value, path) => {
  exactKeys(value, ["tablePresent", "rowCount", "rows"], path);
  if (typeof value.tablePresent !== "boolean") fail(`${path}.tablePresent`, "must be boolean");
  if (!Number.isInteger(value.rowCount) || value.rowCount < 0) fail(`${path}.rowCount`, "must be nonnegative integer");
  if (!Array.isArray(value.rows) || value.rows.length !== value.rowCount) fail(`${path}.rows`, "must match rowCount");
  for (const [index, row] of value.rows.entries()) {
    exactKeys(row, ["id", "value"], `${path}.rows[${index}]`);
    positiveInteger(row.id, `${path}.rows[${index}].id`);
    if (row.value !== "committed") fail(`${path}.rows[${index}].value`, "must be committed");
  }
};

const validateIdentityMember = (value, path, snapshot) => {
  const keys = snapshot
    ? ["role", "sourcePath", "snapshotPath", "byteLength", "sourceSha256Before", "sourceSha256After", "snapshotSha256Before", "snapshotSha256After"]
    : ["role", "path", "byteLength", "sha256Before", "sha256After"];
  exactKeys(value, keys, path);
  if (typeof value.role !== "string" || value.role.length === 0) fail(`${path}.role`, "must be nonempty");
  if (!Number.isInteger(value.byteLength) || value.byteLength <= 0) fail(`${path}.byteLength`, "must be positive");
  if (snapshot) {
    if (typeof value.sourcePath !== "string" || typeof value.snapshotPath !== "string") fail(path, "paths must be strings");
    for (const key of ["sourceSha256Before", "sourceSha256After", "snapshotSha256Before", "snapshotSha256After"]) sha256(value[key], `${path}.${key}`);
  } else {
    if (typeof value.path !== "string") fail(`${path}.path`, "must be string");
    sha256(value.sha256Before, `${path}.sha256Before`);
    sha256(value.sha256After, `${path}.sha256After`);
  }
};

export function validateCrashResult(result) {
  exactKeys(result, ["schemaVersion", "phase", "barrier", "databasePath", "childPid", "childExit", "events", "observers", "runtimeClosure"], "result");
  if (result.schemaVersion !== 1) fail("result.schemaVersion", "must equal 1");
  if (!["pre-commit", "post-commit-pre-close"].includes(result.phase)) fail("result.phase", "unsupported phase");
  if (result.barrier !== result.phase) fail("result.barrier", "must equal phase");
  if (typeof result.databasePath !== "string" || result.databasePath.length === 0) fail("result.databasePath", "must be nonempty");
  if (!isAbsolute(result.databasePath)) fail("result.databasePath", "must be absolute");
  positiveInteger(result.childPid, "result.childPid");
  exactKeys(result.childExit, ["code", "signal"], "result.childExit");
  if (result.childExit.code !== null || result.childExit.signal !== "SIGKILL") fail("result.childExit", "must be confirmed SIGKILL");

  if (!Array.isArray(result.events) || result.events.length !== expectedEventTypes.length) fail("result.events", "unexpected cardinality");
  result.events.forEach((event, index) => {
    const expectedType = expectedEventTypes[index];
    const keys = expectedType.startsWith("observer-") ? ["sequence", "type", "pid"] : expectedType === "barrier-received" ? ["sequence", "type", "childPid", "phase"] : expectedType === "child-exit" ? ["sequence", "type", "childPid", "code", "signal"] : ["sequence", "type", "childPid"];
    exactKeys(event, keys, `result.events[${index}]`);
    if (event.sequence !== index || event.type !== expectedType) fail(`result.events[${index}]`, "sequence or type mismatch");
  });
  if (result.events[0].childPid !== result.childPid || result.events[0].phase !== result.phase) fail("result.events[0]", "barrier identity mismatch");
  if (result.events[1].childPid !== result.childPid) fail("result.events[1]", "SIGKILL identity mismatch");
  if (
    result.events[2].childPid !== result.childPid ||
    result.events[2].code !== result.childExit.code ||
    result.events[2].signal !== result.childExit.signal
  ) fail("result.events[2]", "child exit identity mismatch");

  exactKeys(result.observers, ["node", "sqlite3"], "result.observers");
  const observerPids = [];
  for (const kind of ["node", "sqlite3"]) {
    const observer = result.observers[kind];
    exactKeys(observer, ["pid", "actual"], `result.observers.${kind}`);
    positiveInteger(observer.pid, `result.observers.${kind}.pid`);
    observerPids.push(observer.pid);
    validateObservation(observer.actual, `result.observers.${kind}.actual`);
  }
  if (new Set([result.childPid, ...observerPids]).size !== 3) fail("result.observers", "process identities must be distinct");
  if (result.events[3].pid !== result.observers.node.pid || result.events[4].pid !== result.observers.node.pid) fail("result.events", "node observer identity mismatch");
  if (result.events[5].pid !== result.observers.sqlite3.pid || result.events[6].pid !== result.observers.sqlite3.pid) fail("result.events", "sqlite3 observer identity mismatch");
  if (JSON.stringify(result.observers.node.actual) !== JSON.stringify(result.observers.sqlite3.actual)) fail("result.observers", "independent observations disagree");
  const expectedObservation = result.phase === "pre-commit"
    ? { tablePresent: false, rowCount: 0, rows: [] }
    : { tablePresent: true, rowCount: 1, rows: [{ id: 1, value: "committed" }] };
  if (JSON.stringify(result.observers.node.actual) !== JSON.stringify(expectedObservation)) fail("result.observers", "observation does not match the crash phase");

  exactKeys(result.runtimeClosure, ["runtimeRoot", "stable", "members", "controllers", "executables"], "result.runtimeClosure");
  if (result.runtimeClosure.stable !== true) fail("result.runtimeClosure.stable", "must be true");
  if (!isAbsolute(result.runtimeClosure.runtimeRoot)) fail("result.runtimeClosure.runtimeRoot", "must be absolute");
  if (!Array.isArray(result.runtimeClosure.members) || result.runtimeClosure.members.length !== 3) fail("result.runtimeClosure.members", "must contain three snapshots");
  if (!Array.isArray(result.runtimeClosure.controllers) || result.runtimeClosure.controllers.length !== 4) fail("result.runtimeClosure.controllers", "must contain four live controllers");
  if (!Array.isArray(result.runtimeClosure.executables) || result.runtimeClosure.executables.length !== 2) fail("result.runtimeClosure.executables", "must contain two executables");
  result.runtimeClosure.members.forEach((member, index) => validateIdentityMember(member, `result.runtimeClosure.members[${index}]`, true));
  [...result.runtimeClosure.controllers, ...result.runtimeClosure.executables].forEach((member, index) => validateIdentityMember(member, `result.runtimeClosure.live[${index}]`, false));
  const roles = (members) => members.map((member) => member.role).sort();
  if (JSON.stringify(roles(result.runtimeClosure.members)) !== JSON.stringify(["child", "node", "sqlite3"])) fail("result.runtimeClosure.members", "unexpected roles");
  if (JSON.stringify(roles(result.runtimeClosure.controllers)) !== JSON.stringify(["parentRunner", "resultSchema", "resultValidator", "runtimeClosure"])) fail("result.runtimeClosure.controllers", "unexpected roles");
  if (JSON.stringify(roles(result.runtimeClosure.executables)) !== JSON.stringify(["node", "sqlite3"])) fail("result.runtimeClosure.executables", "unexpected roles");
  for (const member of result.runtimeClosure.members) {
    const relativeSnapshot = relative(result.runtimeClosure.runtimeRoot, member.snapshotPath);
    if (relativeSnapshot.startsWith("..") || isAbsolute(relativeSnapshot)) fail(`result.runtimeClosure.members.${member.role}`, "snapshot escapes runtime root");
    if (new Set([member.sourceSha256Before, member.sourceSha256After, member.snapshotSha256Before, member.snapshotSha256After]).size !== 1) fail(`result.runtimeClosure.members.${member.role}`, "byte identity drift");
  }
  for (const member of [...result.runtimeClosure.controllers, ...result.runtimeClosure.executables]) {
    if (member.sha256Before !== member.sha256After) fail(`result.runtimeClosure.${member.role}`, "byte identity drift");
  }
  return result;
}
