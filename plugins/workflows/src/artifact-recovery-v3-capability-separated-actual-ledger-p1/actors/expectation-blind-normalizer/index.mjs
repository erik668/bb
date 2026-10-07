import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (input.defectiveProbePath) {
  readFileSync(input.defectiveProbePath);
}
if (input.descriptorPath) {
  readFileSync(input.descriptorPath);
}
const allowed = ["identity", "rawReceiptBase64", "reopenObservationBase64"];
if (Object.keys(input).sort().join(",") !== allowed.sort().join(",")) {
  process.stderr.write("NORMALIZER_INPUT_REJECTED");
  process.exit(64);
}
const raw = JSON.parse(Buffer.from(input.rawReceiptBase64, "base64").toString("utf8"));
const reopen = JSON.parse(Buffer.from(input.reopenObservationBase64, "base64").toString("utf8"));
const actual = {
  version: 1,
  identity: input.identity,
  boundaryTypedBytesBase64: raw.boundary.typedBytesBase64,
  commandExitCode: raw.command.exitCode,
  stateBytes: reopen.content.stateBytes,
  stateSha256: reopen.content.stateSha256,
  consistent: raw.content.stateSha256 === reopen.content.stateSha256,
};
const bytes = Buffer.from(JSON.stringify(actual));
process.stdout.write(JSON.stringify({
  actualBase64: bytes.toString("base64"),
  digest: createHash("sha256").update(bytes).digest("hex"),
  pid: process.pid,
}));

