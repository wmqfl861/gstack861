import fs from 'node:fs';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const files = ['bin/gstack861.mjs', 'package.json', 'scripts/check.mjs', 'src/adapters/dsh.mjs', 'src/adapters/zcode.mjs',
  'src/approvals.mjs', 'src/inventory.mjs', 'src/json.mjs', 'src/policy.mjs', 'test/adapters.test.mjs',
  'test/approvals.test.mjs', 'test/helpers.mjs', 'test/inventory.test.mjs', 'test/json.test.mjs',
  'test/policy.test.mjs', 'upstream.lock.json'];

const gitBlobs = {};
for (const line of execSync('git ls-tree -r HEAD', { encoding: 'utf8' }).split('\n').filter(Boolean)) {
  const m = /^\d+ blob ([a-f0-9]{40})\t(.+)$/.exec(line);
  if (m) gitBlobs[m[2]] = m[1];
}

// Digests are computed over repository blob content (LF), not the working copy,
// so they are independent of platform line-ending conversion.
const testedFiles = files.map(p => ({
  path: p,
  gitBlobSha1: gitBlobs[p],
  sha256: crypto.createHash('sha256').update(execSync(`git show HEAD:${p}`, { maxBuffer: 16 * 1024 * 1024 })).digest('hex'),
}));

const orig = JSON.parse(fs.readFileSync('docs/verification-2026-10-26.json', 'utf8'));
const changed = ['test/policy.test.mjs', 'bin/gstack861.mjs', 'package.json'];
let ok = true;
for (const f of testedFiles) {
  const o = orig.testedFiles.find(x => x.path === f.path);
  if (o && !changed.includes(f.path) && (o.gitBlobSha1 !== f.gitBlobSha1 || o.sha256 !== f.sha256)) {
    ok = false;
    console.log('MISMATCH vs round1:', f.path);
  }
}
if (!ok) process.exit(1);
console.log('unchanged files match round 1 digests exactly');

const doc = JSON.parse(fs.readFileSync('docs/verification-2026-10-26-windows.json', 'utf8'));
doc.testedFiles = testedFiles;
doc.digestMethod = 'git ls-tree/show at HEAD commit (repository blob bytes, LF); independent of platform autocrlf';
fs.writeFileSync('docs/verification-2026-10-26-windows.json', JSON.stringify(doc, null, 2) + '\n');
console.log('rewritten with repository-blob digests for', testedFiles.length, 'files');
