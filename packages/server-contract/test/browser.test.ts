import { describe, expect, it } from "vitest";
import {
  browserControllerClientMessageSchema,
  browserSnapshotSchema,
} from "../src/api/browser.js";

const SNAPSHOT = {
  data: Buffer.from("jpeg").toString("base64"),
  height: 480,
  mimeType: "image/jpeg",
  tabId: "browser:test",
  threadId: "thread:test",
  url: "https://example.com/current",
  width: 640,
};

describe("browser contracts", () => {
  it("accepts only bounded HTTP(S) snapshot metadata", () => {
    expect(browserSnapshotSchema.safeParse(SNAPSHOT).success).toBe(true);
    expect(
      browserSnapshotSchema.safeParse({ ...SNAPSHOT, url: "file:///secret" })
        .success,
    ).toBe(false);
    expect(
      browserSnapshotSchema.safeParse({ ...SNAPSHOT, url: "javascript:x" })
        .success,
    ).toBe(false);
    expect(
      browserSnapshotSchema.safeParse({ ...SNAPSHOT, url: "not a url" })
        .success,
    ).toBe(false);
  });

  it("requires controller identity and generation on completion", () => {
    const completion = {
      commandId: "bcmd_test",
      controllerId: "controller:test",
      generation: 1,
      grantId: "bgr_test",
      outcome: { snapshot: SNAPSHOT, status: "success" },
      type: "browser-controller-complete",
    };
    expect(
      browserControllerClientMessageSchema.safeParse(completion).success,
    ).toBe(true);
    const { generation: _generation, ...withoutGeneration } = completion;
    expect(
      browserControllerClientMessageSchema.safeParse(withoutGeneration).success,
    ).toBe(false);
  });
});
