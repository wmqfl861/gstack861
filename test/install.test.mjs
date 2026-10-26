import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installSkills, uninstallSkills } from '../src/install.mjs';
import { textDigest } from '../src/json.mjs';

const WHEN = '2026-10-26T00:00:00.000Z';
const NOW = () => WHEN;
const REGISTRY = '.gstack861-registry.json';
const BACKUPS = '.gstack861-backups';
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
    sha256: textDigest(text), placeholders: [], indicators: [], needsReview: false,
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

  const noSkill = path.join(root, 'no-skill-md');
  fs.mkdirSync(noSkill);
  stage(noSkill, 'alpha', ALPHA_V1);
  fs.unlinkSync(path.join(noSkill, 'alpha', 'SKILL.md'));
  assert.throws(() => installSkills({ staging: noSkill, target: path.join(root, 't4'), now: NOW }), /STAGING_INVALID/);

  for (const name of ['t0', 't1', 't2', 't3', 't4']) {
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
