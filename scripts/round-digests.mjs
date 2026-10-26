import fs from 'node:fs';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

// Usage: node scripts/round-digests.mjs <output.json> <previous.json> <changed-path>...
// Digests are computed over repository blob content (LF) via git ls-tree/show,
// independent of platform line-ending conversion. Changed paths are exempt from
// the cross-check against the previous round; everything else must match exactly.
const [output, previous, ...changed] = process.argv.slice(2);
if (!output || !previous) {
  console.error('Usage: node scripts/round-digests.mjs <output.json> <previous.json> <changed-path>...');
  process.exit(1);
}

const files = ['bin/gstack861.mjs', 'package.json', 'scripts/check.mjs', 'src/adapters/dsh.mjs', 'src/adapters/zcode.mjs',
  'src/approvals.mjs', 'src/generate.mjs', 'src/install.mjs', 'src/inventory.mjs', 'src/json.mjs', 'src/policy.mjs',
  'src/tasks.mjs', 'test/adapters.test.mjs', 'test/approvals.test.mjs', 'test/generate.test.mjs', 'test/helpers.mjs',
  'test/install.test.mjs', 'test/inventory.test.mjs', 'test/json.test.mjs', 'test/policy.test.mjs',
  'test/tasks.test.mjs', 'upstream.lock.json'];

const gitBlobs = {};
for (const line of execSync('git ls-tree -r HEAD', { encoding: 'utf8' }).split('\n').filter(Boolean)) {
  const m = /^\d+ blob ([a-f0-9]{40})\t(.+)$/.exec(line);
  if (m) gitBlobs[m[2]] = m[1];
}
for (const f of files) if (!gitBlobs[f]) { console.error(`MISSING_FROM_HEAD: ${f}`); process.exit(1); }

const testedFiles = files.map(p => ({
  path: p,
  gitBlobSha1: gitBlobs[p],
  sha256: crypto.createHash('sha256').update(execSync(`git show HEAD:${p}`, { maxBuffer: 16 * 1024 * 1024 })).digest('hex'),
}));

const orig = JSON.parse(fs.readFileSync(previous, 'utf8'));
let ok = true;
for (const f of testedFiles) {
  const o = (orig.testedFiles ?? []).find(x => x.path === f.path);
  if (o && !changed.includes(f.path) && (o.gitBlobSha1 !== f.gitBlobSha1 || o.sha256 !== f.sha256)) {
    ok = false;
    console.log('MISMATCH vs previous round:', f.path);
  }
}
if (!ok) process.exit(1);
console.log(`unchanged files match previous round (${previous}) exactly`);

const doc = JSON.parse(fs.readFileSync(output, 'utf8'));
doc.testedFiles = testedFiles;
doc.digestMethod = 'git ls-tree/show at HEAD commit (repository blob bytes, LF); independent of platform autocrlf';
fs.writeFileSync(output, JSON.stringify(doc, null, 2) + '\n');
console.log('rewritten with repository-blob digests for', testedFiles.length, 'files');
