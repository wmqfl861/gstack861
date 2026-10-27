import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inventory } from '../src/inventory.mjs';
import { textDigest } from '../src/json.mjs';
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
test('inventory reads the verified commit even when HEAD moves after the dirty check', t => {
  const f = fixture(t), root = path.join(f.base, 'upstream'); fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const commitFiles = (...args) => git('-c', 'user.name=gstack861 test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', ...args);
  git('init', '--initial-branch=main');
  fs.mkdirSync(path.join(root, 'review'));
  fs.writeFileSync(path.join(root, 'review', 'SKILL.md'), 'pinned review body');
  git('add', '.');
  commitFiles('-m', 'pinned');
  const pinned = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'review', 'SKILL.md'), 'newer review body');
  git('add', '.');
  commitFiles('-m', 'newer');
  const newer = git('rev-parse', 'HEAD');
  git('checkout', pinned); // verification starts from the pinned checkout
  let switched = false;
  const result = inventory(root, pinned, {
    betweenSteps: () => { switched = true; git('checkout', newer); }, // HEAD drifts after the dirty check
  });
  assert.ok(switched, 'the betweenSteps hook must actually run');
  assert.equal(git('rev-parse', 'HEAD'), newer, 'the fixture must really have moved HEAD mid-run');
  assert.equal(result.commit, pinned);
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].name, 'review');
  assert.equal(result.skills[0].source, 'review/SKILL.md');
  assert.equal(result.skills[0].sha256, textDigest('pinned review body'), 'content must come from the pinned commit, not HEAD');
});
