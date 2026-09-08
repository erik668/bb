import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const releaseRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(releaseRoot, '../..');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const release = JSON.parse(readFileSync(join(releaseRoot, 'RELEASE.json'), 'utf8'));
if (release.version !== 1 || !['harness', 'runtime'].includes(release.kind) || !Number.isSafeInteger(release.sourceFiles) || release.sourceFiles < 1 || !/^[a-f0-9]{64}$/.test(release.sourceManifestSha256) || !/^[a-f0-9]{40}$/.test(release.baseCommit)) {
  throw new Error('Invalid release descriptor');
}
if (process.argv.length > 3 || (release.kind === 'runtime' && process.argv.length !== 2) || (process.argv[2] && !isAbsolute(process.argv[2]))) {
  throw new Error('Usage: node releases/workflow-gates-v40/verify.mjs [ABSOLUTE_INSTALLED_PACKAGE_ROOT]; an override is supported only for the harness');
}
const manifestBytes = readFileSync(join(releaseRoot, 'SOURCE-MANIFEST.json'));
if (digest(manifestBytes) !== release.sourceManifestSha256) throw new Error('Release manifest hash differs');
const manifest = JSON.parse(manifestBytes);
if (!Array.isArray(manifest.files) || manifest.files.length !== release.sourceFiles) throw new Error('Invalid source inventory');
const packagePrefix = 'skills/workflow-gates/';
const packageRoot = process.argv[2] ?? join(repositoryRoot, 'skills/workflow-gates');
const expected = new Set();
for (const entry of manifest.files) {
  if (typeof entry.path !== 'string' || entry.path.startsWith('/') || entry.path.includes('\\') || entry.path.split('/').some((part) => ['', '.', '..', '.git'].includes(part)) || !/^[a-f0-9]{64}$/.test(entry.sha256) || expected.has(entry.path)) {
    throw new Error('Invalid or duplicate source entry');
  }
  if (release.kind === 'harness' && !entry.path.startsWith(packagePrefix)) throw new Error('Package scope escape');
  expected.add(entry.path);
  const path = release.kind === 'harness' ? join(packageRoot, entry.path.slice(packagePrefix.length)) : join(repositoryRoot, entry.path);
  if (!lstatSync(path).isFile() || digest(readFileSync(path)) !== entry.sha256) throw new Error(`Source mismatch: ${entry.path}`);
}
if (release.kind === 'harness') {
  const observed = new Set();
  function walk(directory, relative = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(directory, entry.name), name);
      else if (entry.isFile()) observed.add(`${packagePrefix}${name}`);
      else throw new Error(`Non-regular package entry: ${name}`);
    }
  }
  walk(packageRoot);
  if (observed.size !== expected.size || [...observed].some((path) => !expected.has(path))) throw new Error('Unexpected or missing package files');
}
execFileSync('git', ['merge-base', '--is-ancestor', release.baseCommit, 'HEAD'], { cwd: repositoryRoot, stdio: 'pipe' });
console.log(JSON.stringify({ verified: true, release: release.name, sourceFiles: expected.size, sourceManifestSha256: release.sourceManifestSha256, installedPackage: process.argv[2] ?? null }));
