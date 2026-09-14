import { availableParallelism } from "node:os";
import { describe, expect, it } from "vitest";
import {
  generateBundlesInWorkers,
  parseBundleConcurrency,
} from "./bundle-workers.mjs";

describe("bundle concurrency arguments", () => {
  it("retains the default CPU count capped by the output count", () => {
    expect(parseBundleConcurrency([], 16)).toBe(
      Math.min(16, availableParallelism()),
    );
    expect(parseBundleConcurrency([], 1)).toBe(1);
  });

  it("accepts either CLI value form and caps explicit concurrency", () => {
    expect(parseBundleConcurrency(["--concurrency=1"], 16)).toBe(1);
    expect(parseBundleConcurrency(["--concurrency", "2"], 16)).toBe(2);
    expect(parseBundleConcurrency(["--concurrency=99"], 16)).toBe(16);
  });

  it.each([
    "",
    "0",
    "-1",
    "1.5",
    "NaN",
    "Infinity",
    "1e2",
    " 2",
    "9007199254740992",
  ])("rejects invalid explicit concurrency %j", (value) => {
    expect(() =>
      parseBundleConcurrency([`--concurrency=${value}`], 16),
    ).toThrow("--concurrency must be a positive safe integer");
  });

  it.each([
    ["--concurrency"],
    ["--workers=1"],
    ["1"],
    ["--concurrency=1", "--concurrency=2"],
  ])("rejects malformed arguments %j", (...args) => {
    expect(() => parseBundleConcurrency(args, 16)).toThrow();
  });
});

function workerUrl(source) {
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

const trackedWorker = workerUrl(`
  import { parentPort, workerData } from "node:worker_threads";
  const { name, state, delay, fail, waitFor = 0 } = workerData.entry;
  const counts = new Int32Array(state);
  const active = Atomics.add(counts, 0, 1) + 1;
  Atomics.add(counts, 2, 1);
  Atomics.notify(counts, 2);
  let peak = Atomics.load(counts, 1);
  while (active > peak) {
    const previous = Atomics.compareExchange(counts, 1, peak, active);
    if (previous === peak) break;
    peak = previous;
  }
  process.on("exit", () => {
    Atomics.sub(counts, 0, 1);
    Atomics.add(counts, 3, 1);
  });
  let started = Atomics.load(counts, 2);
  while (started < waitFor) {
    Atomics.wait(counts, 2, started);
    started = Atomics.load(counts, 2);
  }
  parentPort.postMessage(name);
  setTimeout(() => {
    if (fail) throw new Error("bundle failed after message");
  }, delay);
`);

describe("bundle worker lifetime", () => {
  it.each([1, 2])(
    "bounds live workers to %i through exit and preserves result order",
    async (concurrency) => {
      const counts = new Int32Array(
        new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT),
      );
      const entries = ["first", "second", "third"].map((name, index) => ({
        name,
        state: counts.buffer,
        delay: index === 0 ? 100 : 30,
        fail: false,
      }));
      await expect(
        generateBundlesInWorkers(trackedWorker, entries, concurrency),
      ).resolves.toEqual(["first", "second", "third"]);
      expect(Atomics.load(counts, 0)).toBe(0);
      expect(Atomics.load(counts, 1)).toBeLessThanOrEqual(concurrency);
      expect(Atomics.load(counts, 2)).toBe(3);
      expect(Atomics.load(counts, 3)).toBe(3);
    },
  );

  it("does not start queued work after a failure at concurrency one", async () => {
    const counts = new Int32Array(
      new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT),
    );
    const entries = [
      { name: "failing", state: counts.buffer, delay: 10, fail: true },
      { name: "queued", state: counts.buffer, delay: 0, fail: false },
    ];
    await expect(
      generateBundlesInWorkers(trackedWorker, entries, 1),
    ).rejects.toThrow("bundle failed after message");
    expect(Atomics.load(counts, 0)).toBe(0);
    expect(Atomics.load(counts, 2)).toBe(1);
    expect(Atomics.load(counts, 3)).toBe(1);
  });

  it("stops queued work and drains active workers after a concurrent failure", async () => {
    const counts = new Int32Array(
      new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT),
    );
    const entries = [
      {
        name: "failing",
        state: counts.buffer,
        delay: 10,
        fail: true,
        waitFor: 2,
      },
      {
        name: "active",
        state: counts.buffer,
        delay: 200,
        fail: false,
        waitFor: 2,
      },
      { name: "queued", state: counts.buffer, delay: 0, fail: false },
    ];
    await expect(
      generateBundlesInWorkers(trackedWorker, entries, 2),
    ).rejects.toThrow("bundle failed after message");
    expect(Atomics.load(counts, 0)).toBe(0);
    expect(Atomics.load(counts, 2)).toBe(2);
    expect(Atomics.load(counts, 3)).toBe(2);
  });

  it("rejects a nonzero exit even after a result message", async () => {
    const url = workerUrl(`
      import { parentPort } from "node:worker_threads";
      parentPort.postMessage("premature");
      setTimeout(() => process.exit(7), 20);
    `);
    await expect(generateBundlesInWorkers(url, ["entry"], 1)).rejects.toThrow(
      "bundle worker exited with 7",
    );
  });

  it.each(["process.exit(0)", 'throw new Error("early failure")'])(
    "rejects a worker that produces no result: %s",
    async (source) => {
      await expect(
        generateBundlesInWorkers(workerUrl(source), ["entry"], 1),
      ).rejects.toThrow();
    },
  );
});
