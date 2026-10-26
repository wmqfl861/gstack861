import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { compilePolicy } from '../src/policy.mjs';

export function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-')));
  const workspace = path.join(base, 'workspace with spaces');
  const src = path.join(workspace, 'src');
  const locked = path.join(workspace, 'locked');
  const outside = path.join(base, 'outside');
  for (const dir of [src, locked, outside, path.join(workspace, '.git')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(src, 'a.txt'), 'original');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'fixture-only');
  const raw = {
    schemaVersion: 1, workspace, readRoots: [workspace], writeRoots: [src], protectedRoots: [locked],
    bindings: {
      zcode: { Read: { effect: 'read', pathKey: 'file_path' }, Write: { effect: 'write', pathKey: 'file_path' }, Edit: { effect: 'write', pathKey: 'file_path' } },
      // Explicit test bindings, not a claim about installed DSH tool names.
      dsh: { read_file: { effect: 'read', pathKey: 'path' }, write_file: { effect: 'write', pathKey: 'path' } },
    },
  };
  const policyPath = path.join(base, 'policy.json');
  fs.writeFileSync(policyPath, JSON.stringify(raw), { mode: 0o600 });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, workspace, src, locked, outside, raw, policyPath, policy: compilePolicy(raw) };
}
