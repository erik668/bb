import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

if (input.action === "append") {
  const bytes = Buffer.from(input.bytesBase64, "base64");
  const identity = digest(bytes);
  const path = join(input.recorderRoot, identity);
  writeFileSync(path, bytes, { flag: "wx" });
  process.stdout.write(JSON.stringify({ identity, byteLength: bytes.byteLength, pid: process.pid }));
} else if (input.action === "seal") {
  const members = readdirSync(input.recorderRoot)
    .filter((name) => /^[0-9a-f]{64}$/.test(name))
    .sort()
    .map((name) => ({ name, digest: digest(readFileSync(join(input.recorderRoot, name))) }));
  const bytes = Buffer.from(JSON.stringify({ version: 1, members }));
  const root = digest(bytes);
  writeFileSync(join(input.recorderRoot, root), bytes, { flag: "wx" });
  process.stdout.write(JSON.stringify({ root, byteLength: bytes.byteLength, pid: process.pid }));
} else {
  process.stderr.write("RECORDER_ACTION_REJECTED");
  process.exit(64);
}

