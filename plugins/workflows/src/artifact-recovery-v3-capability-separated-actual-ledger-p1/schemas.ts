import { createHash } from "node:crypto";

export const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type RawReceipt = {
  version: 1;
  identity: string;
  command: {
    argv: string[];
    pid: number;
    startedNs: string;
    completedNs: string;
    exitCode: number;
    stdoutBase64: string;
    stderrBase64: string;
  };
  process: { pid: number; ppid: number };
  boundary: { typedBytesBase64: string };
  content: { stateBytes: number; stateSha256: string };
  physical: { issuedRootSha256: string };
};

export type ReopenObservation = {
  version: 1;
  identity: string;
  observer: { pid: number; ppid: number; handleNonce: string };
  content: { stateBytes: number; stateSha256: string };
};

const hex = (value: unknown, length: number): value is string =>
  typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);

export const parseRawReceipt = (bytes: Uint8Array): RawReceipt => {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (
    !record(value) ||
    !exactKeys(value, ["version", "identity", "command", "process", "boundary", "content", "physical"]) ||
    value.version !== 1 ||
    !hex(value.identity, 48) ||
    !record(value.command) ||
    !exactKeys(value.command, ["argv", "pid", "startedNs", "completedNs", "exitCode", "stdoutBase64", "stderrBase64"]) ||
    !Array.isArray(value.command.argv) ||
    !value.command.argv.every((part) => typeof part === "string") ||
    typeof value.command.pid !== "number" ||
    typeof value.command.startedNs !== "string" ||
    typeof value.command.completedNs !== "string" ||
    typeof value.command.exitCode !== "number" ||
    typeof value.command.stdoutBase64 !== "string" ||
    typeof value.command.stderrBase64 !== "string" ||
    !record(value.process) ||
    !exactKeys(value.process, ["pid", "ppid"]) ||
    typeof value.process.pid !== "number" ||
    typeof value.process.ppid !== "number" ||
    !record(value.boundary) ||
    !exactKeys(value.boundary, ["typedBytesBase64"]) ||
    typeof value.boundary.typedBytesBase64 !== "string" ||
    !record(value.content) ||
    !exactKeys(value.content, ["stateBytes", "stateSha256"]) ||
    typeof value.content.stateBytes !== "number" ||
    !hex(value.content.stateSha256, 64) ||
    !record(value.physical) ||
    !exactKeys(value.physical, ["issuedRootSha256"]) ||
    !hex(value.physical.issuedRootSha256, 64)
  ) {
    throw new Error("RAW_RECEIPT_SCHEMA_REJECTED");
  }
  return value as RawReceipt;
};

export const parseReopenObservation = (bytes: Uint8Array): ReopenObservation => {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (
    !record(value) ||
    !exactKeys(value, ["version", "identity", "observer", "content"]) ||
    value.version !== 1 ||
    !hex(value.identity, 48) ||
    !record(value.observer) ||
    !exactKeys(value.observer, ["pid", "ppid", "handleNonce"]) ||
    typeof value.observer.pid !== "number" ||
    typeof value.observer.ppid !== "number" ||
    !hex(value.observer.handleNonce, 32) ||
    !record(value.content) ||
    !exactKeys(value.content, ["stateBytes", "stateSha256"]) ||
    typeof value.content.stateBytes !== "number" ||
    !hex(value.content.stateSha256, 64)
  ) {
    throw new Error("REOPEN_OBSERVATION_SCHEMA_REJECTED");
  }
  return value as ReopenObservation;
};
