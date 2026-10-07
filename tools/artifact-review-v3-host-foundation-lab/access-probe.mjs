import { readFileSync } from "node:fs";

const [path] = process.argv.slice(2);
if (!path) process.exit(64);
readFileSync(path);

