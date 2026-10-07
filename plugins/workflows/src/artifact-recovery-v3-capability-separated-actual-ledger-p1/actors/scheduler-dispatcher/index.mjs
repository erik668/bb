const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const keys = Object.keys(input).sort().join(",");
if (keys !== "command,identity,recorderRoot" || !/^[0-9a-f]{48}$/.test(input.identity)) {
  process.stderr.write("DISPATCH_CAPABILITY_INPUT_REJECTED");
  process.exit(64);
}
const injectionKeys = Object.keys(input.command.injection).sort().join(",");
if (injectionKeys !== "artifact,boundarySlot") {
  process.stderr.write("PUBLIC_INJECTION_SCHEMA_REJECTED");
  process.exit(65);
}
process.stdout.write(JSON.stringify({
  version: 1,
  identity: input.identity,
  recorderRoot: input.recorderRoot,
  command: {
    argv: input.command.argv,
    injection: input.command.injection,
  },
  dispatcher: { pid: process.pid, ppid: process.ppid },
}));

