import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

async function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--root" || argv[2] !== "--paths-file") throw new Error("ENCODER_ARGV_INVALID");
  const root = resolve(argv[1]);
  if (root !== argv[1]) throw new Error("ENCODER_ROOT_MUST_BE_ABSOLUTE");
  const pathsFile = resolve(argv[3]);
  if (pathsFile !== argv[3]) throw new Error("ENCODER_PATHS_FILE_MUST_BE_ABSOLUTE");
  const paths = (await readFile(pathsFile, "utf8")).split("\n").filter(Boolean);
  if (!Array.isArray(paths) || paths.length === 0 || new Set(paths).size !== paths.length) throw new Error("ENCODER_PATH_SET_INVALID");
  return { root, paths };
}

const { root, paths } = await parseArgs(process.argv.slice(2));
const records = [];
for (const path of [...paths].sort((left, right) => left.localeCompare(right))) {
  if (!/^[a-z0-9][a-z0-9./_-]*$/.test(path) || path.includes("..")) throw new Error(`ENCODER_PATH_INVALID:${path}`);
  const absolute = resolve(root, path);
  if (!absolute.startsWith(`${root}${sep}`)) throw new Error(`ENCODER_PATH_ESCAPE:${path}`);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`ENCODER_MEMBER_NOT_REGULAR:${path}`);
  const bytes = await readFile(absolute);
  records.push({ path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
}
process.stdout.write(JSON.stringify(records));
