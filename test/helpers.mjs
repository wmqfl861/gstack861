import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
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

/** Minimal pinned-upstream lookalike for generate/install CLI tests (same shape as inventory fixtures). */
export function repository(t) {
  const f = fixture(t), root = path.join(f.base, 'upstream'); fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  const files = {
    'review/SKILL.md': 'generated copy', 'review/SKILL.md.tmpl': 'AskUserQuestion {{TOOLS}} claude -p test',
    'investigate/SKILL.md': 'investigate first', '.agents/skills/gstack-review/SKILL.md': 'foreign render',
  };
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text);
  }
  git('add', '.');
  git('-c', 'user.name=gstack861 test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  return { ...f, root, commit: git('rev-parse', 'HEAD') };
}
