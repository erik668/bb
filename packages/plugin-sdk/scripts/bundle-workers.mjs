import { availableParallelism } from "node:os";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";

export function parseBundleConcurrency(args, outputCount) {
  const { values } = parseArgs({
    args,
    options: { concurrency: { type: "string", multiple: true } },
  });
  if (values.concurrency === undefined) {
    return Math.min(outputCount, availableParallelism());
  }
  if (values.concurrency.length !== 1) {
    throw new Error("--concurrency must be specified only once");
  }
  const value = values.concurrency[0];
  const concurrency = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(concurrency)) {
    throw new Error("--concurrency must be a positive safe integer");
  }
  return Math.min(outputCount, concurrency);
}

export async function generateBundlesInWorkers(
  workerUrl,
  entries,
  concurrency,
) {
  const queue = entries.map((entry, index) => ({ entry, index }));
  const generated = new Array(entries.length);
  let failure = null;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
      while (failure === null) {
        const next = queue.shift();
        if (next === undefined) return;
        try {
          generated[next.index] = await generateInWorker(workerUrl, next.entry);
        } catch (error) {
          failure ??= error;
        }
      }
    }),
  );
  if (failure !== null) throw failure;
  return generated;
}

function generateInWorker(workerUrl, entry) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: { entry } });
    let result;
    let failure = null;
    worker.once("message", (message) => {
      result = message;
    });
    worker.once("error", (error) => {
      failure = error;
    });
    worker.once("exit", (code) => {
      if (failure !== null) {
        reject(failure);
      } else if (code !== 0) {
        reject(new Error(`bundle worker exited with ${code}`));
      } else if (typeof result !== "string") {
        reject(new Error("bundle worker exited without a string result"));
      } else {
        resolve(result);
      }
    });
  });
}
