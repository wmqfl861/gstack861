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
console.log(`Syntax: ${count} modules; baseline: 3 full commit pins; no dependencies or model calls.`);
