import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADAPTER_COUNTS,
  ARCHITECTURE_CAPSULES,
  CATEGORY_COUNTS,
  CONTROL_CLASSES,
  PREFREEZE_ACCOUNTING,
  SDK_SURFACES,
  buildSchedule,
} from "./contract.js";
import { actorPackagePaths, executeKnownBadCapsule } from "./launcher.js";
import { encodeManifestA } from "./manifest-encoder-a.js";
import { admitNoTerminalNewline, encodeManifestB } from "./manifest-encoder-b.js";
import { parseRawReceipt, sha256 } from "./schemas.js";

describe("P1 frozen accounting and closed capabilities", () => {
  it("owns exactly the frozen schedule, controls, SDK surfaces, capsules, and actor packages", () => {
    const schedule = buildSchedule();
    expect(PREFREEZE_ACCOUNTING).toEqual({
      stimuli: 134,
      controls: 17,
      sdkRows: 30,
      architectureCapsules: 6,
      actorPackages: 6,
    });
    expect(Object.fromEntries(Object.keys(CATEGORY_COUNTS).map((category) => [
      category,
      schedule.filter((row) => row.category === category).length,
    ]))).toEqual(CATEGORY_COUNTS);
    expect(Object.fromEntries(Object.keys(ADAPTER_COUNTS).map((adapter) => [
      adapter,
      schedule.filter((row) => row.adapter === adapter).length,
    ]))).toEqual(ADAPTER_COUNTS);
    expect(schedule.filter((row) => row.category === "sdk").map((row) => row.namedSurface)).toEqual(SDK_SURFACES);
    expect(new Set(SDK_SURFACES).size).toBe(30);
    expect(CONTROL_CLASSES).toHaveLength(17);
    expect(new Set(ARCHITECTURE_CAPSULES.map((capsule) => capsule.control)).size).toBe(6);
    expect(ARCHITECTURE_CAPSULES.every((capsule) => CONTROL_CLASSES.includes(capsule.control))).toBe(true);
    expect(actorPackagePaths()).toHaveLength(6);
    expect(actorPackagePaths().every((path) => existsSync(path))).toBe(true);
  });

  it("rejects semantic fields from the additionalProperties=false raw receipt union", () => {
    const raw = {
      version: 1,
      identity: "a".repeat(48),
      command: {
        argv: [],
        pid: 1,
        startedNs: "1",
        completedNs: "2",
        exitCode: 0,
        stdoutBase64: "",
        stderrBase64: "",
      },
      process: { pid: 1, ppid: 1 },
      boundary: { typedBytesBase64: "" },
      content: { stateBytes: 0, stateSha256: "b".repeat(64) },
      physical: { issuedRootSha256: "c".repeat(64) },
      scenario: "unavailable bait",
    };
    expect(() => parseRawReceipt(Buffer.from(JSON.stringify(raw)))).toThrow("RAW_RECEIPT_SCHEMA_REJECTED");
    const schema = JSON.parse(readFileSync(resolve(import.meta.dirname, "raw-receipt.schema.json"), "utf8"));
    expect(schema.oneOf[0].additionalProperties).toBe(false);
  });
});

describe("P1 black-box architecture capsules", () => {
  for (const capsule of ARCHITECTURE_CAPSULES) {
    it(`uniquely kills ${capsule.faultClass}`, () => {
      const result = executeKnownBadCapsule(capsule.faultClass);
      expect(result).toMatchObject({
        faultClass: capsule.faultClass,
        killCode: capsule.killCode,
        ordinaryPath: true,
      });
      expect(result.observerEvidence).toMatch(/^[A-Z_]+:|^[0-9]+:|^[0-9a-f]{64}$/);
      expect(new Set(Object.values(result.processIds)).size).toBe(6);
      if (capsule.faultClass === "stimulus-derived-normalization") {
        expect(result.legitimateDigestInvariant).toBe(true);
      }
    });
  }

  it("assigns exactly one behavioral kill code to every capsule", () => {
    expect(new Set(ARCHITECTURE_CAPSULES.map((capsule) => capsule.killCode)).size).toBe(6);
  });
});

describe("P1 independent manifest encoders", () => {
  it("produce identical canonical bytes and kill a real terminal-newline mutant", () => {
    const input = {
      seam: "prefreeze-proof-admission-v1",
      members: [
        { digest: sha256("first"), bytes: 5 },
        { digest: sha256("second"), bytes: 6 },
      ],
      counts: PREFREEZE_ACCOUNTING,
    };
    const first = encodeManifestA(input);
    const second = encodeManifestB(input);
    expect(first.equals(second)).toBe(true);
    expect(first.at(-1)).not.toBe(10);
    expect(() => admitNoTerminalNewline(Buffer.concat([first, Buffer.from("\n")]))).toThrow(
      "TERMINAL_NEWLINE_MUTANT_KILLED",
    );
  });
});
