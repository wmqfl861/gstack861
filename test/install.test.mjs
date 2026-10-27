import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installSkills, uninstallSkills } from '../src/install.mjs';
import { textDigest } from '../src/json.mjs';

const execute = promisify(execFile);
const WHEN = '2026-10-26T00:00:00.000Z';
const NOW = () => WHEN;
const REGISTRY = '.gstack861-registry.json';
const BACKUPS = '.gstack861-backups';
const LOCK = '.gstack861-install.lock';
const ALPHA_V1 = 'alpha skill body v1';
const ALPHA_V2 = 'alpha skill body v2';
const BETA_V1 = 'beta skill body v1';

function base(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-install-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Hand-built staging fixtures matching the Task 2 manifest schema exactly;
// generate.mjs is deliberately not imported so the tasks stay independent.
function stage(staging, name, text, overrides = {}) {
  const dir = path.join(staging, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
  const manifest = {
    schemaVersion: 1, name, host: 'zcode', source: `${name}/SKILL.md`, blob: 'a'.repeat(40),
    commit: 'b'.repeat(40), sha256: textDigest(text), placeholders: [], indicators: [], needsReview: false,
    status: 'generated-not-host-verified', generator: 'gstack861', generatorVersion: '0.2.0',
    generatedAt: WHEN, ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

const registryFile = target => path.join(target, REGISTRY);
const readRegistry = target => JSON.parse(fs.readFileSync(registryFile(target), 'utf8'));

test('installSkills installs every staged skill into an empty target and writes the registry', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  stage(staging, 'beta', BETA_V1);
  const result = installSkills({ staging, target, now: NOW });
  assert.deepEqual(result, { installed: ['alpha', 'beta'], skipped: [], backedUp: [] });
  for (const [name, text] of [['alpha', ALPHA_V1], ['beta', BETA_V1]]) {
    assert.deepEqual(fs.readFileSync(path.join(target, name, 'SKILL.md')), Buffer.from(text, 'utf8'));
    assert.equal(textDigest(fs.readFileSync(path.join(target, name, 'SKILL.md'), 'utf8')), textDigest(text));
    // manifest copied verbatim from staging, not re-serialized
    assert.deepEqual(fs.readFileSync(path.join(target, name, 'manifest.json')), fs.readFileSync(path.join(staging, name, 'manifest.json')));
  }
  assert.deepEqual(readRegistry(target), {
    schemaVersion: 1, updatedAt: WHEN,
    skills: [{ name: 'alpha', sha256: textDigest(ALPHA_V1) }, { name: 'beta', sha256: textDigest(BETA_V1) }],
  });
  // no temp files left behind by the atomic registry write
  assert.deepEqual(fs.readdirSync(target).sort(), [REGISTRY, 'alpha', 'beta']);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(target).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(target, 'alpha')).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(target, 'alpha', 'SKILL.md')).mode & 0o777, 0o644);
    assert.equal(fs.statSync(path.join(target, 'alpha', 'manifest.json')).mode & 0o777, 0o644);
  }
});

test('installSkills skips identical reinstalls without touching existing files', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  stage(staging, 'beta', BETA_V1);
  installSkills({ staging, target, now: NOW });
  const before = ['alpha', 'beta'].flatMap(name => ['SKILL.md', 'manifest.json']
    .map(file => fs.statSync(path.join(target, name, file)).mtimeMs));
  const registryBefore = fs.readFileSync(registryFile(target), 'utf8');
  const result = installSkills({ staging, target, now: NOW });
  assert.deepEqual(result, { installed: [], skipped: ['alpha', 'beta'], backedUp: [] });
  const after = ['alpha', 'beta'].flatMap(name => ['SKILL.md', 'manifest.json']
    .map(file => fs.statSync(path.join(target, name, file)).mtimeMs));
  assert.deepEqual(after, before, 'skipped skills must not be rewritten');
  assert.equal(fs.readFileSync(registryFile(target), 'utf8'), registryBefore);
  assert.ok(!fs.existsSync(path.join(target, BACKUPS)), 'identical content must not create backups');
});

test('installSkills refuses a foreign target entry and writes nothing at all', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  stage(staging, 'beta', BETA_V1);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'beta'), 'a plain file occupying the name');
  assert.throws(() => installSkills({ staging, target, now: NOW }), /USER_FILE_REFUSED/);
  assert.ok(!fs.existsSync(path.join(target, 'alpha')), 'two-phase validation must leave zero files written');
  assert.ok(!fs.existsSync(registryFile(target)));
  assert.ok(!fs.existsSync(path.join(target, BACKUPS)));

  // Same refusal when the squatter is a directory whose manifest is not ours.
  const staging2 = path.join(root, 'staging2'), target2 = path.join(root, 'target2');
  fs.mkdirSync(staging2);
  stage(staging2, 'gamma', 'gamma body');
  fs.mkdirSync(target2);
  fs.mkdirSync(path.join(target2, 'gamma'));
  fs.writeFileSync(path.join(target2, 'gamma', 'SKILL.md'), 'someone else wrote this');
  fs.writeFileSync(path.join(target2, 'gamma', 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, generator: 'not-us', sha256: textDigest('someone else wrote this') })}\n`);
  assert.throws(() => installSkills({ staging: staging2, target: target2, now: NOW }), /USER_FILE_REFUSED/);
  assert.equal(fs.readFileSync(path.join(target2, 'gamma', 'SKILL.md'), 'utf8'), 'someone else wrote this');
  assert.ok(!fs.existsSync(registryFile(target2)));
});

test('installSkills refuses tampered staging with zero writes', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  stage(staging, 'beta', BETA_V1);
  fs.writeFileSync(path.join(staging, 'beta', 'SKILL.md'), `${BETA_V1} tampered`);
  assert.throws(() => installSkills({ staging, target, now: NOW }), /TAMPERED_STAGING/);
  assert.ok(!fs.existsSync(target), 'validation must fail before the target is even created');
});

test('installSkills backs up version drift and installs the new content', t => {
  const root = base(t), target = path.join(root, 'target');
  const v1 = path.join(root, 'staging-v1'), v2 = path.join(root, 'staging-v2');
  fs.mkdirSync(v1); fs.mkdirSync(v2);
  stage(v1, 'alpha', ALPHA_V1);
  stage(v2, 'alpha', ALPHA_V2);
  installSkills({ staging: v1, target, now: NOW });
  const result = installSkills({ staging: v2, target, now: NOW });
  assert.deepEqual(result, { installed: ['alpha'], skipped: [], backedUp: ['alpha'] });
  const backupsRoot = path.join(target, BACKUPS);
  const entries = fs.readdirSync(backupsRoot);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^alpha-\d+$/);
  assert.equal(fs.readFileSync(path.join(backupsRoot, entries[0], 'SKILL.md'), 'utf8'), ALPHA_V1);
  assert.equal(readRegistry(target).skills[0].sha256, textDigest(ALPHA_V2));
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8'), ALPHA_V2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'alpha', 'manifest.json'), 'utf8')).sha256, textDigest(ALPHA_V2));
});

test('installSkills merges successive installs into one registry', t => {
  const root = base(t), target = path.join(root, 'target');
  const s1 = path.join(root, 's1'), s2 = path.join(root, 's2');
  fs.mkdirSync(s1); fs.mkdirSync(s2);
  stage(s1, 'alpha', ALPHA_V1);
  stage(s2, 'beta', BETA_V1);
  assert.deepEqual(installSkills({ staging: s1, target, now: NOW }), { installed: ['alpha'], skipped: [], backedUp: [] });
  assert.deepEqual(installSkills({ staging: s2, target, now: NOW }), { installed: ['beta'], skipped: [], backedUp: [] });
  assert.deepEqual(readRegistry(target).skills, [
    { name: 'alpha', sha256: textDigest(ALPHA_V1) }, { name: 'beta', sha256: textDigest(BETA_V1) },
  ]);
  // version drift through a later install keeps the registry at one entry per skill
  const s3 = path.join(root, 's3');
  fs.mkdirSync(s3);
  stage(s3, 'alpha', ALPHA_V2);
  installSkills({ staging: s3, target, now: NOW });
  assert.deepEqual(readRegistry(target).skills, [
    { name: 'alpha', sha256: textDigest(ALPHA_V2) }, { name: 'beta', sha256: textDigest(BETA_V1) },
  ]);
});

test('installSkills refuses empty staging and malformed staging entries', t => {
  const root = base(t);
  const empty = path.join(root, 'empty');
  fs.mkdirSync(empty);
  assert.throws(() => installSkills({ staging: empty, target: path.join(root, 't0'), now: NOW }), /NO_SKILLS/);

  const noManifest = path.join(root, 'no-manifest');
  fs.mkdirSync(noManifest);
  fs.mkdirSync(path.join(noManifest, 'alpha'));
  fs.writeFileSync(path.join(noManifest, 'alpha', 'SKILL.md'), ALPHA_V1);
  assert.throws(() => installSkills({ staging: noManifest, target: path.join(root, 't1'), now: NOW }), /STAGING_INVALID/);

  const foreign = path.join(root, 'foreign-generator');
  fs.mkdirSync(foreign);
  stage(foreign, 'alpha', ALPHA_V1, { generator: 'someone-else' });
  assert.throws(() => installSkills({ staging: foreign, target: path.join(root, 't2'), now: NOW }), /STAGING_INVALID/);

  const mismatch = path.join(root, 'name-mismatch');
  fs.mkdirSync(mismatch);
  stage(mismatch, 'alpha', ALPHA_V1, { name: 'beta' });
  assert.throws(() => installSkills({ staging: mismatch, target: path.join(root, 't3'), now: NOW }), /STAGING_INVALID/);

  const badCommit = path.join(root, 'bad-commit');
  fs.mkdirSync(badCommit);
  stage(badCommit, 'alpha', ALPHA_V1, { commit: 'not-a-full-commit' });
  assert.throws(() => installSkills({ staging: badCommit, target: path.join(root, 't5'), now: NOW }), /STAGING_INVALID/);

  const noSkill = path.join(root, 'no-skill-md');
  fs.mkdirSync(noSkill);
  stage(noSkill, 'alpha', ALPHA_V1);
  fs.unlinkSync(path.join(noSkill, 'alpha', 'SKILL.md'));
  assert.throws(() => installSkills({ staging: noSkill, target: path.join(root, 't4'), now: NOW }), /STAGING_INVALID/);

  for (const name of ['t0', 't1', 't2', 't3', 't4', 't5']) {
    assert.ok(!fs.existsSync(path.join(root, name)), `${name} must not be created by a refused install`);
  }
});

test('installSkills refuses invalid staging and target paths', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  const asFile = path.join(root, 'as-file');
  fs.writeFileSync(asFile, 'not a directory');
  assert.throws(() => installSkills({ staging: 'relative-staging', target, now: NOW }), /INVALID_STAGING/);
  assert.throws(() => installSkills({ staging: path.join(root, 'missing'), target, now: NOW }), /INVALID_STAGING/);
  assert.throws(() => installSkills({ staging: asFile, target, now: NOW }), /INVALID_STAGING/);
  assert.throws(() => installSkills({ staging, target: 'relative-target', now: NOW }), /INVALID_TARGET/);
  assert.throws(() => installSkills({ staging, target: asFile, now: NOW }), /INVALID_TARGET/);
  assert.ok(!fs.existsSync(target), 'path refusals must not create the target');
  if (process.platform !== 'win32') {
    const linkedStaging = path.join(root, 'staging-link');
    fs.symlinkSync(staging, linkedStaging);
    assert.throws(() => installSkills({ staging: linkedStaging, target, now: NOW }), /INVALID_STAGING/);
    const realTarget = path.join(root, 'real-target');
    fs.mkdirSync(realTarget);
    const linkedTarget = path.join(root, 'target-link');
    fs.symlinkSync(realTarget, linkedTarget);
    assert.throws(() => installSkills({ staging, target: linkedTarget, now: NOW }), /INVALID_TARGET/);
  }
});

test('uninstallSkills removes only registry skills and keeps foreign directories', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  stage(staging, 'beta', BETA_V1);
  installSkills({ staging, target, now: NOW });
  fs.mkdirSync(path.join(target, 'not-ours'));
  fs.writeFileSync(path.join(target, 'not-ours', 'SKILL.md'), 'user content');
  const result = uninstallSkills({ target, now: NOW });
  assert.deepEqual(result, { uninstalled: ['alpha', 'beta'], backupsRemoved: 0 });
  assert.ok(!fs.existsSync(path.join(target, 'alpha')));
  assert.ok(!fs.existsSync(path.join(target, 'beta')));
  assert.equal(fs.readFileSync(path.join(target, 'not-ours', 'SKILL.md'), 'utf8'), 'user content');
  assert.deepEqual(readRegistry(target), { schemaVersion: 1, updatedAt: WHEN, skills: [] });
  // uninstalling again returns empty and touches nothing
  assert.deepEqual(uninstallSkills({ target, now: NOW }), { uninstalled: [], backupsRemoved: 0 });
  assert.equal(fs.readFileSync(path.join(target, 'not-ours', 'SKILL.md'), 'utf8'), 'user content');
});

test('uninstallSkills purge removes backup directories and reports the count', t => {
  const root = base(t), target = path.join(root, 'target');
  const v1 = path.join(root, 'v1'), v2 = path.join(root, 'v2');
  fs.mkdirSync(v1); fs.mkdirSync(v2);
  stage(v1, 'alpha', ALPHA_V1);
  stage(v2, 'alpha', ALPHA_V2);
  installSkills({ staging: v1, target, now: NOW });
  installSkills({ staging: v2, target, now: NOW });
  assert.equal(fs.readdirSync(path.join(target, BACKUPS)).length, 1);
  const result = uninstallSkills({ target, purge: true, now: NOW });
  assert.deepEqual(result, { uninstalled: ['alpha'], backupsRemoved: 1 });
  assert.ok(!fs.existsSync(path.join(target, BACKUPS)));
  assert.deepEqual(readRegistry(target).skills, []);
});

test('uninstallSkills aborts with zero deletions when the registry names a foreign directory', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  installSkills({ staging, target, now: NOW });
  fs.mkdirSync(path.join(target, 'foreign'));
  fs.writeFileSync(path.join(target, 'foreign', 'SKILL.md'), 'user content');
  const forged = `${JSON.stringify({
    schemaVersion: 1, updatedAt: WHEN,
    skills: [{ name: 'alpha', sha256: textDigest(ALPHA_V1) }, { name: 'foreign', sha256: '0'.repeat(64) }],
  }, null, 2)}\n`;
  fs.writeFileSync(registryFile(target), forged);
  assert.throws(() => uninstallSkills({ target, now: NOW }), /USER_FILE_REFUSED/);
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8'), ALPHA_V1, 'own skill must survive the aborted uninstall');
  assert.equal(fs.readFileSync(path.join(target, 'foreign', 'SKILL.md'), 'utf8'), 'user content');
  assert.equal(fs.readFileSync(registryFile(target), 'utf8'), forged, 'registry must be left untouched');
});

test('uninstallSkills returns empty results without a registry', t => {
  const root = base(t), target = path.join(root, 'target');
  fs.mkdirSync(target);
  fs.mkdirSync(path.join(target, 'stray'));
  fs.writeFileSync(path.join(target, 'stray', 'SKILL.md'), 'user content');
  assert.deepEqual(uninstallSkills({ target, now: NOW }), { uninstalled: [], backupsRemoved: 0 });
  assert.equal(fs.readFileSync(path.join(target, 'stray', 'SKILL.md'), 'utf8'), 'user content');
  assert.ok(!fs.existsSync(registryFile(target)), 'uninstall must not invent a registry');
});

// --- Codex-audit regression hardening -----------------------------------------

test('uninstallSkills refuses a user-modified SKILL.md and deletes nothing anywhere', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  stage(staging, 'beta', BETA_V1);
  installSkills({ staging, target, now: NOW });
  const registryBefore = fs.readFileSync(registryFile(target), 'utf8');
  fs.writeFileSync(path.join(target, 'alpha', 'SKILL.md'), `${ALPHA_V1}\nuser note`);
  assert.throws(() => uninstallSkills({ target, now: NOW }), /USER_FILE_REFUSED/);
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8'), `${ALPHA_V1}\nuser note`, 'user-modified file must survive');
  assert.equal(fs.readFileSync(path.join(target, 'beta', 'SKILL.md'), 'utf8'), BETA_V1, 'two-phase: other skills survive too');
  assert.equal(fs.readFileSync(registryFile(target), 'utf8'), registryBefore, 'registry must be left untouched');
});

test('uninstallSkills refuses an extra user file inside a skill directory', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  installSkills({ staging, target, now: NOW });
  fs.writeFileSync(path.join(target, 'alpha', 'notes.txt'), 'user data');
  assert.throws(() => uninstallSkills({ target, now: NOW }), /USER_FILE_REFUSED/);
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'notes.txt'), 'utf8'), 'user data');
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8'), ALPHA_V1);
  assert.ok(fs.existsSync(path.join(target, 'alpha', 'manifest.json')));
});

test('uninstallSkills refuses a forged registry even with a bare generator marker manifest', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  installSkills({ staging, target, now: NOW });
  // Foreign directory whose manifest merely claims our generator; the forged registry
  // records a sha256 that disagrees with the directory's own manifest and bytes.
  fs.mkdirSync(path.join(target, 'evil'));
  fs.writeFileSync(path.join(target, 'evil', 'SKILL.md'), 'foreign body');
  const evilManifest = `${JSON.stringify({
    schemaVersion: 1, generator: 'gstack861', sha256: textDigest('foreign body'),
  }, null, 2)}\n`;
  fs.writeFileSync(path.join(target, 'evil', 'manifest.json'), evilManifest);
  const forged = `${JSON.stringify({
    schemaVersion: 1, updatedAt: WHEN,
    skills: [{ name: 'alpha', sha256: textDigest(ALPHA_V1) }, { name: 'evil', sha256: 'c'.repeat(64) }],
  }, null, 2)}\n`;
  fs.writeFileSync(registryFile(target), forged);
  assert.throws(() => uninstallSkills({ target, now: NOW }), /USER_FILE_REFUSED/);
  assert.equal(fs.readFileSync(path.join(target, 'evil', 'SKILL.md'), 'utf8'), 'foreign body', 'foreign directory must survive verbatim');
  assert.equal(fs.readFileSync(path.join(target, 'evil', 'manifest.json'), 'utf8'), evilManifest);
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8'), ALPHA_V1, 'own skill must also survive the abort');
  assert.equal(fs.readFileSync(registryFile(target), 'utf8'), forged);
});

if (process.platform === 'win32') {
  test('installSkills refuses a junction at the backups path and writes nothing outside the target', t => {
    const root = base(t), target = path.join(root, 'target');
    const v1 = path.join(root, 'v1'), v2 = path.join(root, 'v2');
    fs.mkdirSync(v1); fs.mkdirSync(v2);
    stage(v1, 'alpha', ALPHA_V1);
    stage(v2, 'alpha', ALPHA_V2);
    installSkills({ staging: v1, target, now: NOW });
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(target, BACKUPS), 'junction');
    const registryBefore = fs.readFileSync(registryFile(target), 'utf8');
    assert.throws(() => installSkills({ staging: v2, target, now: NOW }), /USER_FILE_REFUSED/);
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing may be written outside the target through the junction');
    assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8'), ALPHA_V1, 'drift install must not proceed');
    assert.equal(fs.readFileSync(registryFile(target), 'utf8'), registryBefore);
    assert.ok(!fs.existsSync(path.join(target, LOCK)), 'the lock must be released on refusal');
  });
}

if (process.platform !== 'win32') {
  test('installSkills refuses a symlink at the backups path and writes nothing outside the target', t => {
    const root = base(t), target = path.join(root, 'target');
    const v1 = path.join(root, 'v1'), v2 = path.join(root, 'v2');
    fs.mkdirSync(v1); fs.mkdirSync(v2);
    stage(v1, 'alpha', ALPHA_V1);
    stage(v2, 'alpha', ALPHA_V2);
    installSkills({ staging: v1, target, now: NOW });
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(target, BACKUPS));
    const registryBefore = fs.readFileSync(registryFile(target), 'utf8');
    assert.throws(() => installSkills({ staging: v2, target, now: NOW }), /USER_FILE_REFUSED/);
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing may be written outside the target through the symlink');
    assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8'), ALPHA_V1);
    assert.equal(fs.readFileSync(registryFile(target), 'utf8'), registryBefore);
    assert.ok(!fs.existsSync(path.join(target, LOCK)), 'the lock must be released on refusal');
  });
}

test('installSkills refuses a directory at the registry path with zero writes', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  fs.mkdirSync(target);
  fs.mkdirSync(registryFile(target));
  fs.writeFileSync(path.join(registryFile(target), 'keep.txt'), 'user data');
  assert.throws(() => installSkills({ staging, target, now: NOW }), /USER_FILE_REFUSED/);
  assert.equal(fs.readFileSync(path.join(registryFile(target), 'keep.txt'), 'utf8'), 'user data', 'the squatter directory must survive verbatim');
  assert.ok(!fs.existsSync(path.join(target, 'alpha')), 'no skill file may be written');
  assert.ok(!fs.existsSync(path.join(target, BACKUPS)));
  assert.deepEqual(fs.readdirSync(target).sort(), [REGISTRY], 'the lock must be released, nothing else may appear');
});

if (process.platform !== 'win32') {
  test('installSkills refuses a symlink at the registry path and leaves it in place', t => {
    const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
    fs.mkdirSync(staging);
    stage(staging, 'alpha', ALPHA_V1);
    fs.mkdirSync(target);
    const victim = path.join(root, 'victim-registry.json');
    fs.writeFileSync(victim, 'someone else data');
    fs.symlinkSync(victim, registryFile(target));
    assert.throws(() => installSkills({ staging, target, now: NOW }), /USER_FILE_REFUSED/);
    assert.ok(fs.lstatSync(registryFile(target)).isSymbolicLink(), 'the symlink itself must not be replaced');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'someone else data');
    assert.ok(!fs.existsSync(path.join(target, 'alpha')), 'no skill file may be written');
  });
}

test('a stale install lock fails closed with INSTALL_BUSY and is never auto-cleared', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  fs.mkdirSync(target);
  const lock = path.join(target, LOCK);
  fs.mkdirSync(lock);
  assert.throws(() => installSkills({ staging, target, now: NOW }), /INSTALL_BUSY/);
  assert.throws(() => uninstallSkills({ target, now: NOW }), /INSTALL_BUSY/, 'uninstall shares the same lock');
  assert.ok(fs.existsSync(lock), 'a stale lock is never removed automatically');
  assert.ok(!fs.existsSync(path.join(target, 'alpha')), 'no skill file may be written while the lock is held');
  assert.ok(!fs.existsSync(registryFile(target)));
  fs.rmdirSync(lock);
  assert.deepEqual(installSkills({ staging, target, now: NOW }), { installed: ['alpha'], skipped: [], backedUp: [] });
});

test('two real processes racing one install: exactly one wins, the other gets INSTALL_BUSY', async t => {
  const root = base(t), target = path.join(root, 'target');
  fs.mkdirSync(target);
  // The first child installs four large skills so its lock-held window is long and
  // observable; the second child waits until the lock is really held, then races in
  // with its own batch — the exact two-writer scenario that used to lose registry
  // updates and orphan skill directories.
  const big = 'G'.repeat(2 * 1024 * 1024);
  const sA = path.join(root, 'staging-a'), sB = path.join(root, 'staging-b');
  fs.mkdirSync(sA); fs.mkdirSync(sB);
  for (const name of ['a1', 'a2', 'a3', 'a4']) stage(sA, name, `${name}\n${big}`);
  stage(sB, 'beta', 'small competing batch');
  const readyA = path.join(root, 'ready-a'), readyB = path.join(root, 'ready-b');
  const moduleHref = JSON.stringify(new URL('../src/install.mjs', import.meta.url).href);
  const child = waitForLock => `import fs from 'node:fs';\n`
    + `import { installSkills } from ${moduleHref};\n`
    + `const [staging, target, ready, peer, lock] = [process.argv[1], process.argv[2], process.argv[3], process.argv[4], process.argv[5]];\n`
    + `fs.writeFileSync(ready, '');\n`
    + `const deadline = Date.now() + 15000;\n`
    + `while (!fs.existsSync(peer) && Date.now() < deadline) {}\n`
    + `if (!fs.existsSync(peer)) { process.stdout.write('PEER_TIMEOUT'); process.exit(3); }\n`
    + (waitForLock ? `while (!fs.existsSync(lock) && Date.now() < deadline) {}\n` : '')
    + `try { installSkills({ staging, target }); process.stdout.write('OK'); }\n`
    + `catch (error) { process.stdout.write(String(error && error.message)); process.exitCode = 2; }`;
  const spawn = (staging, ready, peer, waitForLock) => execute(process.execPath,
    ['--input-type=module', '-e', child(waitForLock), staging, target, ready, peer, path.join(target, LOCK)]);
  const results = await Promise.allSettled([
    spawn(sA, readyA, readyB, false),
    spawn(sB, readyB, readyA, true),
  ]);
  const winners = results.filter(r => r.status === 'fulfilled' && r.value.stdout === 'OK');
  const losers = results.filter(r => r.status === 'rejected');
  assert.equal(winners.length, 1, 'exactly one process may install');
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason.stdout, 'INSTALL_BUSY');
  assert.equal(losers[0].reason.code, 2);
  const winnerIsRacer = results[0].status === 'fulfilled';
  assert.ok(winnerIsRacer, 'the process that acquired the lock first must be the winner');
  assert.deepEqual(readRegistry(target).skills, ['a1', 'a2', 'a3', 'a4']
    .map(name => ({ name, sha256: textDigest(`${name}\n${big}`) })), 'registry must match the winner, no lost updates');
  assert.ok(!fs.existsSync(path.join(target, 'beta')), 'the refused batch must leave no orphan directory');
  assert.deepEqual(fs.readdirSync(target).sort(), [REGISTRY, 'a1', 'a2', 'a3', 'a4'], 'no orphan directories and no leftover lock');
});

test('uninstallSkills purge keeps user entries that do not match the backup naming scheme', t => {
  const root = base(t), target = path.join(root, 'target');
  const v1 = path.join(root, 'v1'), v2 = path.join(root, 'v2');
  fs.mkdirSync(v1); fs.mkdirSync(v2);
  stage(v1, 'alpha', ALPHA_V1);
  stage(v2, 'alpha', ALPHA_V2);
  installSkills({ staging: v1, target, now: NOW });
  installSkills({ staging: v2, target, now: NOW });
  const backupsRoot = path.join(target, BACKUPS);
  fs.mkdirSync(path.join(backupsRoot, 'user-archive'));
  fs.writeFileSync(path.join(backupsRoot, 'user-archive', 'SKILL.md'), 'user archive');
  fs.writeFileSync(path.join(backupsRoot, 'keeper.txt'), 'user file');
  const result = uninstallSkills({ target, purge: true, now: NOW });
  assert.deepEqual(result, { uninstalled: ['alpha'], backupsRemoved: 1 });
  assert.deepEqual(fs.readdirSync(backupsRoot).sort(), ['keeper.txt', 'user-archive'], 'non-matching user entries must survive purge');
  assert.equal(fs.readFileSync(path.join(backupsRoot, 'user-archive', 'SKILL.md'), 'utf8'), 'user archive');
  assert.deepEqual(readRegistry(target).skills, []);
});

test('uninstallSkills purge keeps user directories whose suffix is not a 13-digit timestamp', t => {
  const root = base(t), target = path.join(root, 'target');
  const v1 = path.join(root, 'v1'), v2 = path.join(root, 'v2');
  fs.mkdirSync(v1); fs.mkdirSync(v2);
  stage(v1, 'alpha', ALPHA_V1);
  stage(v2, 'alpha', ALPHA_V2);
  installSkills({ staging: v1, target, now: NOW });
  installSkills({ staging: v2, target, now: NOW });
  const backupsRoot = path.join(target, BACKUPS);
  fs.mkdirSync(path.join(backupsRoot, 'notes-2024'));
  fs.writeFileSync(path.join(backupsRoot, 'notes-2024', 'SKILL.md'), 'user notes');
  const result = uninstallSkills({ target, purge: true, now: NOW });
  assert.deepEqual(result, { uninstalled: ['alpha'], backupsRemoved: 1 }, 'only the real drift backup may be counted');
  assert.equal(fs.readFileSync(path.join(backupsRoot, 'notes-2024', 'SKILL.md'), 'utf8'), 'user notes', 'user directory with a short numeric suffix must survive purge');
});

test('uninstallSkills purge keeps timestamp-named backups whose manifest is not verifiably ours', t => {
  const root = base(t), target = path.join(root, 'target');
  const v1 = path.join(root, 'v1'), v2 = path.join(root, 'v2');
  fs.mkdirSync(v1); fs.mkdirSync(v2);
  stage(v1, 'alpha', ALPHA_V1);
  stage(v2, 'alpha', ALPHA_V2);
  installSkills({ staging: v1, target, now: NOW });
  installSkills({ staging: v2, target, now: NOW });
  const backupsRoot = path.join(target, BACKUPS);
  const corrupt = path.join(backupsRoot, 'alpha-1761453400000');
  fs.mkdirSync(corrupt);
  fs.writeFileSync(path.join(corrupt, 'SKILL.md'), 'body');
  fs.writeFileSync(path.join(corrupt, 'manifest.json'), '{ not json');
  const foreign = path.join(backupsRoot, 'beta-1761453400001');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'SKILL.md'), 'body');
  fs.writeFileSync(path.join(foreign, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, generator: 'not-us' }, null, 2)}\n`);
  const result = uninstallSkills({ target, purge: true, now: NOW });
  assert.deepEqual(result, { uninstalled: ['alpha'], backupsRemoved: 1 }, 'unverifiable backups must not be counted');
  assert.equal(fs.readFileSync(path.join(corrupt, 'manifest.json'), 'utf8'), '{ not json', 'corrupt-manifest backup must survive verbatim');
  assert.equal(fs.readFileSync(path.join(foreign, 'manifest.json'), 'utf8'), `${JSON.stringify({ schemaVersion: 1, generator: 'not-us' }, null, 2)}\n`, 'foreign-generator backup must survive verbatim');
});

test('uninstallSkills tolerates a registered skill the user already deleted', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  stage(staging, 'beta', BETA_V1);
  installSkills({ staging, target, now: NOW });
  fs.rmSync(path.join(target, 'beta'), { recursive: true });
  const result = uninstallSkills({ target, now: NOW });
  assert.ok(result.uninstalled.includes('alpha'));
  assert.ok(!fs.existsSync(path.join(target, 'alpha')));
  assert.deepEqual(readRegistry(target).skills, []);
});

test('installSkills refuses to move a user-edited skill into purgeable backups', t => {
  const root = base(t), s1 = path.join(root, 's1'), s2 = path.join(root, 's2'), target = path.join(root, 'target');
  fs.mkdirSync(s1); fs.mkdirSync(s2);
  stage(s1, 'alpha', ALPHA_V1);
  installSkills({ staging: s1, target, now: NOW });
  fs.writeFileSync(path.join(target, 'alpha', 'SKILL.md'), `${ALPHA_V1}\nmy local rules`);
  stage(s2, 'alpha', ALPHA_V2);
  assert.throws(() => installSkills({ staging: s2, target, now: NOW }), /USER_FILE_REFUSED/);
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8'), `${ALPHA_V1}\nmy local rules`);
  assert.ok(!fs.existsSync(path.join(target, BACKUPS)));
});

test('an I/O failure mid-install leaves every skill whole and the target recoverable', t => {
  const root = base(t), s1 = path.join(root, 's1'), s2 = path.join(root, 's2'), target = path.join(root, 'target');
  fs.mkdirSync(s1); fs.mkdirSync(s2);
  stage(s1, 'alpha', ALPHA_V1); stage(s1, 'beta', BETA_V1);
  installSkills({ staging: s1, target, now: NOW });
  stage(s2, 'alpha', ALPHA_V2); stage(s2, 'beta', 'beta skill body v2');
  const real = fs.writeFileSync; let writes = 0;
  fs.writeFileSync = function (file, ...rest) {
    if (String(file).endsWith(`${path.sep}SKILL.md`) && ++writes === 2) throw Object.assign(new Error('EIO'), { code: 'EIO' });
    return real.call(this, file, ...rest);
  };
  try { assert.throws(() => installSkills({ staging: s2, target, now: NOW }), /EIO/); } finally { fs.writeFileSync = real; }
  // beta is still the complete v1 skill (never half-written), and both directions recover.
  assert.deepEqual(fs.readdirSync(path.join(target, 'beta')).sort(), ['SKILL.md', 'manifest.json']);
  assert.equal(fs.readFileSync(path.join(target, 'beta', 'SKILL.md'), 'utf8'), BETA_V1);
  assert.deepEqual(installSkills({ staging: s2, target, now: NOW }).installed, ['beta']);
  assert.deepEqual(uninstallSkills({ target, now: NOW }).uninstalled.sort(), ['alpha', 'beta']);
});
