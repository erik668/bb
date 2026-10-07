import { readFileSync } from "node:fs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const seal = JSON.parse(readFileSync(input.sealPath, "utf8"));
if (!Array.isArray(seal.members) || !input.privateMap[input.identity]) {
  process.stderr.write("ADJUDICATION_AUTHORITY_REJECTED");
  process.exit(64);
}
process.stdout.write(JSON.stringify({
  identity: input.identity,
  sealedRoot: input.sealedRoot,
  actualDigest: input.actualDigest,
  judgment: input.privateMap[input.identity],
  pid: process.pid,
}));

