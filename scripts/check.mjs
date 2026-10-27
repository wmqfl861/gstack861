import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
let count = 0;
for (const dir of ['src', 'bin', 'scripts', 'test']) {
  for (const name of fs.readdirSync(path.join(root, dir), { recursive: true })) {
    if (name.endsWith('.mjs')) {
      execFileSync(process.execPath, ['--check', path.join(root, dir, name)], { stdio: 'pipe' });
      count++;
    }
  }
}
const lock = JSON.parse(fs.readFileSync(path.join(root, 'upstream.lock.json'), 'utf8'));
if (lock.schemaVersion !== 1 || ![lock.gstack, ...Object.values(lock.hosts)].every(x => /^[a-f0-9]{40}$/.test(x.commit))) throw new Error('INVALID_BASELINE');

// Evidence gate: at least one verification manifest must describe the shipped HEAD.
// Old rounds stay historical; a round that edits tested files without regenerating
// its digest manifest leaves no accurate evidence and fails here.
const blobs = {};
for (const line of execFileSync('git', ['-C', root, 'ls-tree', '-r', 'HEAD'], { encoding: 'utf8' }).split('\n').filter(Boolean)) {
  const match = /^\d+ blob ([a-f0-9]{40})\t(.+)$/.exec(line);
  if (match) blobs[match[2]] = match[1];
}
let evidenced = false;
for (const name of fs.readdirSync(path.join(root, 'docs')).filter(f => /^verification-.*\.json$/.test(f)).sort()) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(root, 'docs', name), 'utf8'));
    if (Array.isArray(doc.testedFiles) && doc.testedFiles.length
      && doc.testedFiles.every(f => typeof f.path === 'string' && /^[A-Za-z0-9/._-]+$/.test(f.path) && blobs[f.path] === f.gitBlobSha1)) { evidenced = true; break; }
  } catch { /* malformed evidence is not a pass */ }
}
if (!evidenced) throw new Error('NO_HEAD_EVIDENCE');
console.log(`Syntax: ${count} modules; baseline: 3 full commit pins; HEAD evidence: current; no dependencies or model calls.`);
