import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const releaseRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(releaseRoot, '../..');
const hash = value => createHash('sha256').update(value).digest('hex');
const read = name => JSON.parse(readFileSync(join(releaseRoot, name)));
const release = read('RELEASE.json');
assert.equal(release.version, 1);
assert.equal(release.release, 'workflow-gates-v46');
assert.ok(['harness', 'runtime'].includes(release.kind));
assert.ok(process.argv.length <= 3);
const installed = process.argv[2];
assert.ok(!installed || (release.kind === 'harness' && isAbsolute(installed)), 'Optional argument is an absolute installed helper root (harness only)');
const safe = path => {
  assert.equal(typeof path, 'string');
  assert.ok(!isAbsolute(path) && !path.includes('\\') && path.split('/').every(x => x && !['.', '..', '.git', 'node_modules'].includes(x)), `Unsafe path: ${path}`);
};
function verifyRows(rows, root) {
  const seen = new Set();
  for (const row of rows) {
    safe(row.path); assert.match(row.sha256, /^[a-f0-9]{64}$/);
    assert.ok(!seen.has(row.path)); seen.add(row.path);
    const target = join(root, row.path);
    assert.ok(lstatSync(target).isFile(), `Not a regular file: ${row.path}`);
    assert.equal(hash(readFileSync(target)), row.sha256, `Identity mismatch: ${row.path}`);
  }
}
const manifestBytes = readFileSync(join(releaseRoot, 'SOURCE-MANIFEST.json'));
assert.equal(hash(manifestBytes), release.sourceManifestSha256);
const manifest = JSON.parse(manifestBytes);
verifyRows(manifest.files, repositoryRoot);
verifyRows(release.evidence, releaseRoot);
assert.equal(release.qualification.fullHelper.pass, 1138);
assert.equal(release.qualification.fullHelper.fail, 0);
assert.equal(release.qualification.fullHelper.skipped, 1);
assert.equal(release.qualification.busyManagerApplication, true);
assert.equal(release.qualification.publicSettlement, true);
assert.equal(release.qualification.brokerMode, 'shadow');
assert.equal(release.qualification.brokerPromotion, false);
let helperFiles = null, runtimeFiles = null;
if (release.kind === 'harness') {
  const rows = manifest.files.filter(x => x.path.startsWith('skills/workflow-gates/')).map(x => ({path:x.path.slice('skills/workflow-gates/'.length), sha256:x.sha256}));
  helperFiles = rows.length; assert.equal(helperFiles, 399);
  assert.equal(hash(JSON.stringify(rows)), release.provenance.helperSha256);
  const helperRoot = installed || join(repositoryRoot, 'skills/workflow-gates');
  verifyRows(rows, helperRoot);
  const observed = [];
  function walk(root, prefix = '') {
    for (const item of readdirSync(root, {withFileTypes:true})) {
      if (!prefix && ['node_modules', '.git'].includes(item.name)) continue;
      const name = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) walk(join(root, item.name), name);
      else {assert.ok(item.isFile(), `Unexpected source entry: ${name}`); observed.push(name);}
    }
  }
  walk(helperRoot); assert.deepEqual(observed.sort(), rows.map(x => x.path).sort());
  const mappingBytes = readFileSync(join(releaseRoot, 'PRODUCT-MAP.json'));
  assert.equal(hash(mappingBytes), release.productMapSha256);
  const mapping = JSON.parse(mappingBytes).files;
  assert.equal(mapping.length, 412);
  assert.equal(hash(JSON.stringify(mapping.map(x => ({path:x.originalPath, sha256:x.sha256})))), release.provenance.productSha256);
  for (const row of mapping) {
    safe(row.originalPath); safe(row.path);
    assert.ok(['bb','claude-harness'].includes(row.repository));
    if (row.repository === 'claude-harness') assert.equal(hash(readFileSync(join(repositoryRoot, row.path))), row.sha256);
  }
  const original = read('ORIGINAL-FULL-RECEIPT.json');
  assert.equal(original.sourceSha256, release.provenance.helperSha256);
  assert.equal(original.exitCode, 0); assert.equal(original.wholeSourceStable, true);
  assert.deepEqual(original.files, rows);
  assert.equal(read('ORIGINAL-RESULT.json').finalE2EQualified, true);
  assert.equal(read('ORIGINAL-E2E.json').passedBeforeCleanupAndSemanticAudit, true);
  assert.equal(read('COMPARISON.json').preregistered60SecondsAnd20PercentGatePassed, false);
} else {
  const bytes = readFileSync(join(releaseRoot, 'RUNTIME-SOURCE-MANIFEST.json'));
  assert.equal(hash(bytes), release.runtimeSourceManifestSha256);
  const rows = JSON.parse(bytes).files; runtimeFiles = rows.length;
  assert.equal(runtimeFiles, 5859); verifyRows(rows, repositoryRoot);
  assert.equal(release.deltaFilesSinceV40, 17);
  assert.equal(release.hostDaemonProtocolVersion, 184);
}
const publication = read('PUBLICATION-MANIFEST.json');
verifyRows(publication.files, repositoryRoot);
const smoke = read('PUBLICATION-SMOKE.json');
assert.equal(smoke.passed, true); assert.equal(smoke.sourceStable, true);
console.log(JSON.stringify({verified:true, release:release.release, kind:release.kind, sourceFiles:manifest.files.length,
  helperFiles,runtimeFiles,installedPackage:installed||null,publicationFiles:publication.files.length,
  nativeCalls:0,checksExecuted:0,qualification:'Exact source and compact retained evidence; not installation, live replay, broker promotion or fleet qualification.'}));
