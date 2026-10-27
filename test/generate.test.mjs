import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { generateSkills, blobHash } from '../src/generate.mjs';
import { textDigest } from '../src/json.mjs';

const WHEN = '2026-10-26T00:00:00.000Z';
const NOW = () => WHEN;
// The one authoritative version: manifests must echo whatever package.json says,
// not a second literal maintained by hand in the generator.
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// Byte-exactness fixture: the trailing 0xff is invalid UTF-8, so a lossy UTF-8
// round-trip through git show would replace it and fail the digest/byte checks.
const INVESTIGATE = Buffer.concat([Buffer.from('investigate first'), Buffer.from([0xff])]);

function base(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-generate-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Same committed fixture shape as test/inventory.test.mjs: template wins for
// `review`, plain file for `investigate`, foreign render excluded.
function repository(t) {
  const root = path.join(base(t), 'upstream');
  fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  const files = {
    'review/SKILL.md': 'generated copy',
    'review/SKILL.md.tmpl': 'AskUserQuestion {{TOOLS}} claude -p test',
    'investigate/SKILL.md': INVESTIGATE,
    '.agents/skills/gstack-review/SKILL.md': 'foreign render',
  };
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text);
  }
  git('add', '.');
  git('-c', 'user.name=gstack861 test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  return { root, base: path.dirname(root), commit: git('rev-parse', 'HEAD') };
}

test('blobHash computes git blob object ids and separates mismatched buffers', t => {
  const r = repository(t);
  const git = (file, input) => execFileSync('git', ['-C', r.root, ...file], { stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }) }).toString().trim();
  // The known blob: what the manifest pins for investigate/SKILL.md at HEAD.
  const known = git(['rev-parse', 'HEAD:investigate/SKILL.md']);
  assert.match(known, /^[a-f0-9]{40}$/);
  assert.equal(blobHash(INVESTIGATE), known, 'blobHash must equal the git blob object id');
  // A mismatched buffer (one extra byte) must not equal the known blob...
  const mutated = Buffer.concat([INVESTIGATE, Buffer.from(' tampered')]);
  assert.notEqual(blobHash(mutated), known);
  // ...and must itself hash to the correct git id for its own bytes (oracle: hash-object).
  assert.equal(blobHash(mutated), git(['hash-object', '--stdin'], mutated));
  // Length-header semantics: the digest depends on the byte length, not just content words.
  assert.equal(blobHash(Buffer.alloc(0)), git(['hash-object', '--stdin'], Buffer.alloc(0)));
});
test('generateSkills writes verbatim SKILL.md copies and exact manifests', t => {
  const r = repository(t), staging = path.join(r.base, 'staging');
  const result = generateSkills({ upstream: r.root, commit: r.commit, staging, host: 'zcode', now: NOW });
  assert.deepEqual(Object.keys(result).sort(), ['generated', 'host', 'needsReview', 'schemaVersion', 'skills', 'staging']);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.host, 'zcode');
  assert.equal(result.staging, staging);
  assert.equal(result.generated, 2);
  assert.equal(result.needsReview, 1);
  const git = (...args) => execFileSync('git', ['-C', r.root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const investigate = INVESTIGATE, review = 'AskUserQuestion {{TOOLS}} claude -p test';
  assert.deepEqual(result.skills, [
    { name: 'investigate', source: 'investigate/SKILL.md', blob: git('rev-parse', 'HEAD:investigate/SKILL.md'),
      commit: r.commit, sha256: textDigest(investigate), placeholders: [], needsReview: false },
    { name: 'review', source: 'review/SKILL.md.tmpl', blob: git('rev-parse', 'HEAD:review/SKILL.md.tmpl'),
      commit: r.commit, sha256: textDigest(review), placeholders: ['TOOLS'], needsReview: true },
  ]);
  // staged bytes must equal `git show HEAD:<source>` byte for byte
  const show = file => execFileSync('git', ['-C', r.root, 'show', `HEAD:${file}`], { stdio: ['pipe', 'pipe', 'pipe'] });
  assert.deepEqual(fs.readFileSync(path.join(staging, 'investigate', 'SKILL.md')), show('investigate/SKILL.md'));
  assert.deepEqual(fs.readFileSync(path.join(staging, 'review', 'SKILL.md')), show('review/SKILL.md.tmpl'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(staging, 'investigate', 'manifest.json'), 'utf8')), {
    schemaVersion: 1, name: 'investigate', host: 'zcode', source: 'investigate/SKILL.md',
    blob: result.skills[0].blob, commit: r.commit, sha256: textDigest(investigate), placeholders: [], indicators: [],
    needsReview: false, status: 'generated-not-host-verified', generator: 'gstack861', generatorVersion: VERSION, generatedAt: WHEN,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(staging, 'review', 'manifest.json'), 'utf8')), {
    schemaVersion: 1, name: 'review', host: 'zcode', source: 'review/SKILL.md.tmpl',
    blob: result.skills[1].blob, commit: r.commit, sha256: textDigest(review), placeholders: ['TOOLS'],
    indicators: ['claude-reference', 'host-interaction', 'template-resolvers'], needsReview: true,
    status: 'generated-not-host-verified', generator: 'gstack861', generatorVersion: VERSION, generatedAt: WHEN,
  });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(staging, 'review', 'SKILL.md')).mode & 0o777, 0o644);
    assert.equal(fs.statSync(path.join(staging, 'review', 'manifest.json')).mode & 0o777, 0o644);
  }
});
test('generateSkills accepts a pre-created empty staging directory and records the requested host', t => {
  const r = repository(t), staging = path.join(r.base, 'empty-staging');
  fs.mkdirSync(staging);
  const result = generateSkills({ upstream: r.root, commit: r.commit, staging, host: 'dsh', now: NOW });
  assert.equal(result.host, 'dsh');
  assert.equal(result.generated, 2);
  for (const name of ['investigate', 'review']) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(staging, name, 'manifest.json'), 'utf8')).host, 'dsh');
  }
});
test('generateSkills refuses a non-empty or non-directory staging path', t => {
  const r = repository(t), staging = path.join(r.base, 'busy');
  fs.mkdirSync(staging); fs.writeFileSync(path.join(staging, 'leftover.txt'), 'occupied');
  assert.throws(() => generateSkills({ upstream: r.root, commit: r.commit, staging, host: 'zcode', now: NOW }), /STAGING_NOT_EMPTY/);
  const asFile = path.join(r.base, 'staging-as-file');
  fs.writeFileSync(asFile, 'not a directory');
  assert.throws(() => generateSkills({ upstream: r.root, commit: r.commit, staging: asFile, host: 'zcode', now: NOW }), /STAGING_NOT_EMPTY/);
});
test('generateSkills refuses staging and upstream that contain each other', t => {
  const r = repository(t), inside = path.join(r.root, 'nested-staging');
  assert.throws(() => generateSkills({ upstream: r.root, commit: r.commit, staging: inside, host: 'zcode', now: NOW }), /OVERLAPPING_PATHS/);
  assert.ok(!fs.existsSync(inside), 'overlap must be refused before creating anything inside upstream');
  assert.throws(() => generateSkills({ upstream: r.root, commit: r.commit, staging: r.base, host: 'zcode', now: NOW }), /OVERLAPPING_PATHS/);
});
test('generateSkills refuses unknown or missing hosts', t => {
  const r = repository(t), staging = path.join(r.base, 'staging');
  assert.throws(() => generateSkills({ upstream: r.root, commit: r.commit, staging, host: 'claude', now: NOW }), /INVALID_HOST/);
  assert.throws(() => generateSkills({ upstream: r.root, commit: r.commit, staging, now: NOW }), /INVALID_HOST/);
  assert.ok(!fs.existsSync(staging), 'invalid host must not create staging output');
});
test('generateSkills inherits upstream inventory refusals before writing staging', t => {
  const r = repository(t), staging = path.join(r.base, 'staging');
  fs.writeFileSync(path.join(r.root, 'untracked'), 'drift');
  assert.throws(() => generateSkills({ upstream: r.root, commit: r.commit, staging, host: 'zcode', now: NOW }), /UPSTREAM_DIRTY/);
  assert.ok(!fs.existsSync(staging), 'dirty upstream must not leave staged output');
  const other = path.join(r.base, 'other-staging');
  assert.throws(() => generateSkills({ upstream: r.root, commit: 'a'.repeat(40), staging: other, host: 'zcode', now: NOW }), /COMMIT_MISMATCH/);
  assert.ok(!fs.existsSync(other));
});
// Codex probe 09 regression fixture: two commits where the newer one changes beta.
// generateSkills must read skill bytes at the verified pinned commit, so HEAD
// moving between inventory() and the reads cannot swap in unpinned content.
function pinnedRepository(t) {
  const root = path.join(base(t), 'upstream');
  fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  for (const name of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, 'SKILL.md'), `${name} pinned`);
  }
  git('add', '.');
  git('-c', 'user.name=gstack861 test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'pinned');
  const commit = git('rev-parse', 'HEAD');
  const pinnedBetaBlob = git('rev-parse', `${commit}:beta/SKILL.md`);
  fs.writeFileSync(path.join(root, 'beta', 'SKILL.md'), 'beta newer');
  git('add', '.');
  git('-c', 'user.name=gstack861 test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'newer beta');
  const newer = git('rev-parse', 'HEAD');
  git('checkout', commit); // generation runs from the pinned checkout
  return { root, base: path.dirname(root), commit, newer, pinnedBetaBlob };
}

test('generateSkills stages pinned-commit bytes even when HEAD moves mid-run', t => {
  const r = pinnedRepository(t), staging = path.join(r.base, 'staging');
  const git = (...args) => execFileSync('git', ['-C', r.root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  let switched = false;
  // Mirrors the audited probe: after inventory() verified the pin, HEAD moves to the newer commit.
  const now = () => { if (!switched) { switched = true; git('checkout', r.newer); } return WHEN; };
  const result = generateSkills({ upstream: r.root, commit: r.commit, staging, host: 'zcode', now });
  assert.equal(git('rev-parse', 'HEAD'), r.newer, 'the race fixture must actually have moved HEAD');
  const beta = result.skills.find(s => s.name === 'beta');
  assert.equal(beta.commit, r.commit);
  assert.equal(beta.blob, r.pinnedBetaBlob);
  assert.equal(beta.sha256, textDigest('beta pinned'));
  assert.equal(fs.readFileSync(path.join(staging, 'beta', 'SKILL.md'), 'utf8'), 'beta pinned');
  const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'beta', 'manifest.json'), 'utf8'));
  assert.equal(manifest.commit, r.commit);
  assert.equal(manifest.blob, r.pinnedBetaBlob);
  assert.equal(manifest.sha256, textDigest('beta pinned'));
});
test('generateSkills refuses relative or missing paths', t => {
  const r = repository(t);
  assert.throws(() => generateSkills({ upstream: 'upstream', commit: r.commit, staging: path.join(r.base, 's1'), host: 'zcode', now: NOW }), /INVALID_UPSTREAM/);
  assert.throws(() => generateSkills({ upstream: path.join(r.base, 'missing'), commit: r.commit, staging: path.join(r.base, 's2'), host: 'zcode', now: NOW }), /INVALID_UPSTREAM/);
  assert.throws(() => generateSkills({ upstream: r.root, commit: r.commit, staging: 'relative-staging', host: 'zcode', now: NOW }), /INVALID_STAGING/);
});
