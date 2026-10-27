// Windows only. Usage: node scripts/verify-8dot3.mjs [directory-on-the-volume-to-test]
// Builds a throwaway workspace (default: under the OS temp dir), reads the 8.3 short names
// NTFS generated for `.git` and for a long-named protected directory, and asks the policy
// whether writes through those short names are refused. Exit code 1 if any alias is allowed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compilePolicy, evaluate } from '../src/policy.mjs';

if (process.platform !== 'win32') {
  console.log('verify-8dot3: Windows only; skipped.');
  process.exit(0);
}

const parent = process.argv[2] ? path.resolve(process.argv[2]) : os.tmpdir();
const ws = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'g861-8dot3-')));
try {
  const longName = 'protected-long-directory-name';
  fs.mkdirSync(path.join(ws, '.git'));
  fs.writeFileSync(path.join(ws, '.git', 'config'), '');
  fs.mkdirSync(path.join(ws, longName));
  fs.writeFileSync(path.join(ws, longName, 'secret.txt'), '');

  // `dir /x` prints the short name in the column before the long name (blank when none exists).
  const listing = execFileSync('cmd', ['/c', 'dir', '/a', '/x', ws], { encoding: 'utf8' });
  const shortOf = name => {
    const cols = listing.split(/\r?\n/).find(line => line.trimEnd().endsWith(` ${name}`))?.trim().split(/\s+/) ?? [];
    return cols.length >= 2 && cols.at(-2) !== '<DIR>' ? cols.at(-2) : null;
  };

  const policy = compilePolicy({
    schemaVersion: 1, workspace: ws, readRoots: [ws], writeRoots: [ws], protectedRoots: [path.join(ws, longName)],
    bindings: { zcode: { Write: { effect: 'write', pathKey: 'file_path' } }, dsh: {} },
  });
  const check = file => evaluate(policy, { host: 'zcode', tool: 'Write', input: { file_path: file } }).code;

  let leaked = false;
  for (const [name, file] of [['.git', 'config'], [longName, 'secret.txt']]) {
    const short = shortOf(name);
    console.log(`${name}: 8.3 short name = ${short ?? '(none on this volume)'}`);
    console.log(`  ${path.join(name, file)} -> ${check(path.join(ws, name, file))}`);
    if (short) {
      const code = check(path.join(ws, short, file));
      console.log(`  ${path.join(short, file)} -> ${code}`);
      if (code !== 'PROTECTED_PATH') leaked = true;
    }
  }
  console.log(leaked ? 'RESULT: alias bypass reproduced' : 'RESULT: no alias bypass on this volume');
  process.exitCode = leaked ? 1 : 0;
} finally {
  fs.rmSync(ws, { recursive: true, force: true });
}
