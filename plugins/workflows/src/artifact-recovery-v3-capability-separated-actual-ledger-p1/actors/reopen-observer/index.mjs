import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (Object.keys(input).sort().join(",") !== "identity,recorderRoot") {
  process.stderr.write("CAPABILITY_INPUT_REJECTED");
  process.exit(64);
}
const bytes = readFileSync(join(input.recorderRoot, `${input.identity}.bin`));
process.stdout.write(JSON.stringify({
  version: 1,
  identity: input.identity,
  observer: { pid: process.pid, ppid: process.ppid, handleNonce: randomBytes(16).toString("hex") },
  content: {
    stateBytes: bytes.byteLength,
    stateSha256: createHash("sha256").update(bytes).digest("hex"),
  },
}));

