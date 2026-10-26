import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inventory } from '../src/inventory.mjs';
import { fixture } from './helpers.mjs';

function repository(t, empty = false) {
  const f = fixture(t), root = path.join(f.base, 'upstream'); fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  const files = empty ? { 'README.md': 'fixture' } : {
    'review/SKILL.md': 'generated copy', 'review/SKILL.md.tmpl': 'AskUserQuestion {{TOOLS}} claude -p test',
    'investigate/SKILL.md': 'investigate first', '.agents/skills/gstack-review/SKILL.md': 'foreign render',
  };
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text);
  }
  git('add', '.');
  git('-c', 'user.name=gstack861 test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  return { root, commit: git('rev-parse', 'HEAD') };
}
test('inventory deduplicates templates and excludes other-host renders', t => {
  const r = repository(t), result = inventory(r.root, r.commit);
  assert.equal(result.skills.length, 2);
  assert.equal(result.skills[1].source, 'review/SKILL.md.tmpl');
  assert.deepEqual(result.skills[1].indicators, ['claude-reference', 'host-interaction', 'template-resolvers']);
  assert.equal(result.skills[1].zcode, 'planned');
  assert.equal(result.fullParity, false);
  assert.match(result.skills[1].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(inventory(r.root, r.commit), result);
});
test('inventory refuses wrong or abbreviated baseline commits', t => {
  const r = repository(t);
  assert.throws(() => inventory(r.root, 'a'.repeat(40)), /COMMIT_MISMATCH/);
  assert.throws(() => inventory(r.root, r.commit.slice(0, 7)), /FULL_COMMIT/);
});
test('inventory refuses dirty upstream and untracked additions', t => {
  const r = repository(t);
  fs.writeFileSync(path.join(r.root, 'untracked'), 'changed');
  assert.throws(() => inventory(r.root, r.commit), /UPSTREAM_DIRTY/);
});
test('empty source inventory is not a vacuous parity pass', t => {
  const r = repository(t, true);
  assert.throws(() => inventory(r.root, r.commit), /NO_SOURCE_SKILLS/);
});
