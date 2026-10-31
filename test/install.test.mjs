import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
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

test('installSkills refuses staging with mixed hosts or commits and writes nothing', t => {
  const root = base(t), target = path.join(root, 'target');
  const mixedHost = path.join(root, 'mixed-host');
  fs.mkdirSync(mixedHost);
  stage(mixedHost, 'alpha', ALPHA_V1);
  stage(mixedHost, 'beta', BETA_V1, { host: 'dsh' });
  assert.throws(() => installSkills({ staging: mixedHost, target, now: NOW }), /STAGING_INCONSISTENT/);
  assert.ok(!fs.existsSync(target), 'refused staging must leave the target uncreated');

  const mixedCommit = path.join(root, 'mixed-commit');
  fs.mkdirSync(mixedCommit);
  stage(mixedCommit, 'alpha', ALPHA_V1);
  stage(mixedCommit, 'beta', BETA_V1, { commit: 'c'.repeat(40) });
  assert.throws(() => installSkills({ staging: mixedCommit, target, now: NOW }), /STAGING_INCONSISTENT/);
  assert.ok(!fs.existsSync(target));
});

test('installSkills refuses staging manifests carrying an illegal host value', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1, { host: 'claude' });
  assert.throws(() => installSkills({ staging, target, now: NOW }), /STAGING_INCONSISTENT/);
  assert.ok(!fs.existsSync(target));
  const hostless = path.join(root, 'hostless');
  fs.mkdirSync(hostless);
  const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'alpha', 'manifest.json'), 'utf8'));
  delete manifest.host;
  fs.mkdirSync(path.join(hostless, 'alpha'));
  fs.copyFileSync(path.join(staging, 'alpha', 'SKILL.md'), path.join(hostless, 'alpha', 'SKILL.md'));
  fs.writeFileSync(path.join(hostless, 'alpha', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(() => installSkills({ staging: hostless, target, now: NOW }), /STAGING_INCONSISTENT/);
  assert.ok(!fs.existsSync(target));
});

test('installSkills preserves unproven temporary-prefix entries and touches nothing else', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  fs.mkdirSync(target);
  const orphan = path.join(target, '.gstack861-tmp-deadbeef-1111');
  fs.mkdirSync(orphan);
  fs.writeFileSync(path.join(orphan, 'SKILL.md'), 'half-written orphan');
  fs.writeFileSync(path.join(target, '.gstack861-tmp-2222'), 'a plain leftover file with our prefix');
  fs.mkdirSync(path.join(target, 'user-dir'));
  fs.writeFileSync(path.join(target, 'user-dir', 'keep.txt'), 'user data');
  fs.writeFileSync(path.join(target, 'user-file.txt'), 'user file');
  const result = installSkills({ staging, target, now: NOW });
  assert.deepEqual(result, { installed: ['alpha'], skipped: [], backedUp: [] });
  assert.equal(fs.readFileSync(path.join(orphan, 'SKILL.md'), 'utf8'), 'half-written orphan', 'a name alone cannot authorize recovery-file deletion');
  assert.equal(fs.readFileSync(path.join(target, '.gstack861-tmp-2222'), 'utf8'), 'a plain leftover file with our prefix');
  assert.equal(fs.readFileSync(path.join(target, 'user-dir', 'keep.txt'), 'utf8'), 'user data');
  assert.equal(fs.readFileSync(path.join(target, 'user-file.txt'), 'utf8'), 'user file');
  assert.deepEqual(fs.readdirSync(target).sort(), [REGISTRY, '.gstack861-tmp-2222', '.gstack861-tmp-deadbeef-1111', 'alpha', 'user-dir', 'user-file.txt']);
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
  // Root cause of the ubuntu-CI flake this loop fixes (run #40487111559, both children
  // "won"): the racer's whole critical section can elapse before the loser's poll first
  // runs, so the loser installs uncontested and the old single-shot assertion reported
  // a mutex violation that never happened. A contention marker distinguishes the cases:
  // loser-saw-the-lock + loser-won is a REAL product bug (hard fail); no contention
  // observed is an invalid attempt (retry with a wider window, then skip).
  const attempt = async skills => {
    const root = base(t), target = path.join(root, 'target');
    fs.mkdirSync(target);
    const big = 'G'.repeat(2 * 1024 * 1024);
    const sA = path.join(root, 'staging-a'), sB = path.join(root, 'staging-b');
    fs.mkdirSync(sA); fs.mkdirSync(sB);
    const names = Array.from({ length: skills }, (_, i) => `a${i + 1}`);
    for (const name of names) stage(sA, name, `${name}\n${big}`);
    stage(sB, 'beta', 'small competing batch');
    const readyA = path.join(root, 'ready-a'), readyB = path.join(root, 'ready-b');
    const sawLock = path.join(root, 'saw-lock');
    const moduleHref = JSON.stringify(new URL('../src/install.mjs', import.meta.url).href);
    const child = waitForLock => `import fs from 'node:fs';\n`
      + `import { installSkills } from ${moduleHref};\n`
      + `const [staging, target, ready, peer, lock, sawLock] = [process.argv[1], process.argv[2], process.argv[3], process.argv[4], process.argv[5], process.argv[6]];\n`
      + `fs.writeFileSync(ready, '');\n`
      + `const deadline = Date.now() + 15000;\n`
      + `while (!fs.existsSync(peer) && Date.now() < deadline) {}\n`
      + `if (!fs.existsSync(peer)) { process.stdout.write('PEER_TIMEOUT'); process.exit(3); }\n`
      + (waitForLock ? `while (!fs.existsSync(lock) && Date.now() < deadline) {}\n`
        + `if (fs.existsSync(lock)) fs.writeFileSync(sawLock, '');\n` : '')
      + `try { installSkills({ staging, target }); process.stdout.write('OK'); }\n`
      + `catch (error) { process.stdout.write(String(error && error.message)); process.exitCode = 2; }`;
    const spawn = (staging, ready, peer, waitForLock) => execute(process.execPath,
      ['--input-type=module', '-e', child(waitForLock), staging, target, ready, peer, path.join(target, LOCK), sawLock]);
    const results = await Promise.allSettled([
      spawn(sA, readyA, readyB, false),
      spawn(sB, readyB, readyA, true),
    ]);
    const ok = r => r.status === 'fulfilled' && r.value.stdout === 'OK';
    const losers = results.filter(r => r.status === 'rejected');
    return { results, names, big, target, contended: fs.existsSync(sawLock), winners: results.filter(ok).length, losers };
  };
  const outcome = winners => winners === 2 ? 'both-won' : winners === 1 ? 'one-won' : 'none-won';
  let last;
  for (const [i, skills] of [4, 8, 16, 32, 64].entries()) {
    last = await attempt(skills);
    if (outcome(last.winners) === 'both-won' && last.contended) {
      assert.fail('the loser observed the held lock yet both processes installed - real mutex failure');
    }
    if (outcome(last.winners) === 'both-won' && !last.contended) continue; // uncontested attempt, widen the window
    break; // one-won (the assertable case) or none-won (fail below)
  }
  if (outcome(last.winners) === 'both-won') {
    t.skip('no contention achievable this run (loser never observed the lock; mutex refusal itself is covered by the abandoned-lock test)');
    return;
  }
  const { results, names, big, target, losers } = last;
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason.stdout, 'INSTALL_BUSY');
  assert.equal(losers[0].reason.code, 2);
  const winnerIsRacer = results[0].status === 'fulfilled';
  assert.ok(winnerIsRacer, 'the process that acquired the lock first must be the winner');
  assert.deepEqual(readRegistry(target).skills, names
    .map(name => ({ name, sha256: textDigest(`${name}\n${big}`) })), 'registry must match the winner, no lost updates');
  assert.ok(!fs.existsSync(path.join(target, 'beta')), 'the refused batch must leave no orphan directory');
  assert.deepEqual(fs.readdirSync(target).sort(), [REGISTRY, ...names], 'no orphan directories and no leftover lock');
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

// --- Multi-file skills (optional manifest `files` map) --------------------------

const SCOPE_V1 = '# Scope\n\nLane A scope section v1.\n';
const SCOPE_V2 = '# Scope\n\nLane A scope section v2 (re-rendered).\n';
const LIMITS_V1 = '# Limits\n\nLane A limits section.\n';
const TEMPLATE_V1 = '# Report template\n\nTemplate body.\n';

// Multi-file staging fixture: stage() plus the listed auxiliary files written on
// disk; the manifest's files map records each file's real digest.
function stageMulti(staging, name, text, contents, overrides = {}) {
  const files = {};
  for (const [key, body] of Object.entries(contents)) {
    files[key] = textDigest(body);
    const dest = path.join(staging, name, ...key.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
  }
  stage(staging, name, text, { files, ...overrides });
  return files;
}

test('installSkills writes every listed file, records the files map in the registry, and uninstall removes it all', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  const files = stageMulti(staging, 'alpha', ALPHA_V1, {
    'sections/scope.md': SCOPE_V1,
    'sections/limits.md': LIMITS_V1,
    'templates/report.md': TEMPLATE_V1,
  });
  stage(staging, 'beta', BETA_V1); // a no-files skill rides along untouched
  assert.deepEqual(installSkills({ staging, target, now: NOW }), { installed: ['alpha', 'beta'], skipped: [], backedUp: [] });
  const dest = path.join(target, 'alpha');
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), ALPHA_V1);
  assert.equal(fs.readFileSync(path.join(dest, 'sections', 'scope.md'), 'utf8'), SCOPE_V1);
  assert.equal(fs.readFileSync(path.join(dest, 'sections', 'limits.md'), 'utf8'), LIMITS_V1);
  assert.equal(fs.readFileSync(path.join(dest, 'templates', 'report.md'), 'utf8'), TEMPLATE_V1);
  // manifest bytes copied verbatim from staging, not re-serialized
  assert.deepEqual(fs.readFileSync(path.join(dest, 'manifest.json')), fs.readFileSync(path.join(staging, 'alpha', 'manifest.json')));
  assert.deepEqual(readRegistry(target).skills, [
    { name: 'alpha', sha256: textDigest(ALPHA_V1), files },
    { name: 'beta', sha256: textDigest(BETA_V1) }, // no files map for a no-files skill
  ]);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dest, 'sections')).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(dest, 'templates')).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(dest, 'sections', 'scope.md')).mode & 0o777, 0o644);
  }
  assert.deepEqual(uninstallSkills({ target, now: NOW }), { uninstalled: ['alpha', 'beta'], backupsRemoved: 0 });
  assert.ok(!fs.existsSync(dest), 'uninstall removes the whole skill directory, listed files included');
  assert.ok(!fs.existsSync(path.join(target, 'beta')));
});

test('installSkills refuses a tampered or missing listed file in staging with zero writes', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stageMulti(staging, 'alpha', ALPHA_V1, { 'sections/scope.md': SCOPE_V1 });
  stage(staging, 'beta', BETA_V1);
  fs.writeFileSync(path.join(staging, 'alpha', 'sections', 'scope.md'), `${SCOPE_V1}tampered`);
  assert.throws(() => installSkills({ staging, target, now: NOW }), /TAMPERED_STAGING/);
  assert.ok(!fs.existsSync(target), 'validation must fail before the target is even created');
  fs.unlinkSync(path.join(staging, 'alpha', 'sections', 'scope.md'));
  assert.throws(() => installSkills({ staging, target, now: NOW }), /TAMPERED_STAGING/, 'a missing listed file is the same refusal');
  assert.ok(!fs.existsSync(target));
});

test('a user-modified listed file refuses both uninstall and reinstall', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stageMulti(staging, 'alpha', ALPHA_V1, { 'sections/scope.md': SCOPE_V1, 'templates/report.md': TEMPLATE_V1 });
  installSkills({ staging, target, now: NOW });
  fs.writeFileSync(path.join(target, 'alpha', 'sections', 'scope.md'), `${SCOPE_V1}user note`);
  // classify's drift check uses the same registry-anchored proof as uninstall
  const restage = path.join(root, 'restage');
  fs.mkdirSync(restage);
  stageMulti(restage, 'alpha', ALPHA_V1, { 'sections/scope.md': SCOPE_V1, 'templates/report.md': TEMPLATE_V1 });
  assert.throws(() => installSkills({ staging: restage, target, now: NOW }), /USER_FILE_REFUSED/);
  assert.ok(!fs.existsSync(path.join(target, BACKUPS)), 'a user-edited skill never enters purgeable backups');
  assert.throws(() => uninstallSkills({ target, now: NOW }), /USER_FILE_REFUSED/);
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'sections', 'scope.md'), 'utf8'), `${SCOPE_V1}user note`, 'the user edit survives both refusals');
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'templates', 'report.md'), 'utf8'), TEMPLATE_V1);
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8'), ALPHA_V1);
});

test('uninstallSkills refuses an unlisted extra file inside a multi-file skill directory', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stageMulti(staging, 'alpha', ALPHA_V1, { 'sections/scope.md': SCOPE_V1 });
  installSkills({ staging, target, now: NOW });
  fs.writeFileSync(path.join(target, 'alpha', 'sections', 'notes.md'), 'user data');
  assert.throws(() => uninstallSkills({ target, now: NOW }), /USER_FILE_REFUSED/);
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'sections', 'notes.md'), 'utf8'), 'user data', 'the unlisted file survives');
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'sections', 'scope.md'), 'utf8'), SCOPE_V1);
  assert.ok(fs.existsSync(path.join(target, 'alpha', 'SKILL.md')), 'nothing is deleted on refusal');
});

test('uninstallSkills refuses a forged registry.files that disagrees with the target', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stageMulti(staging, 'alpha', ALPHA_V1, { 'sections/scope.md': SCOPE_V1, 'templates/report.md': TEMPLATE_V1 });
  installSkills({ staging, target, now: NOW });
  // The registry is the trust anchor: a scope digest the installed bytes cannot match
  // must refuse even though the directory itself is pristine.
  const forgedRegistry = JSON.parse(fs.readFileSync(registryFile(target), 'utf8'));
  forgedRegistry.skills[0].files['sections/scope.md'] = '0'.repeat(64);
  const forged = `${JSON.stringify(forgedRegistry, null, 2)}\n`;
  fs.writeFileSync(registryFile(target), forged);
  assert.throws(() => uninstallSkills({ target, now: NOW }), /USER_FILE_REFUSED/);
  assert.equal(fs.readFileSync(registryFile(target), 'utf8'), forged, 'the forged registry is left untouched');
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'sections', 'scope.md'), 'utf8'), SCOPE_V1);
  assert.ok(fs.existsSync(path.join(target, 'alpha', 'templates', 'report.md')));
});

test('installSkills does not skip a re-render that changed only listed files', t => {
  const root = base(t), target = path.join(root, 'target');
  const v1 = path.join(root, 'v1'), v2 = path.join(root, 'v2');
  fs.mkdirSync(v1); fs.mkdirSync(v2);
  stageMulti(v1, 'alpha', ALPHA_V1, { 'sections/scope.md': SCOPE_V1, 'templates/report.md': TEMPLATE_V1 });
  const filesV2 = stageMulti(v2, 'alpha', ALPHA_V1, { 'sections/scope.md': SCOPE_V2 }); // same SKILL.md digest; one section changed, one file dropped
  installSkills({ staging: v1, target, now: NOW });
  const result = installSkills({ staging: v2, target, now: NOW });
  assert.deepEqual(result, { installed: ['alpha'], skipped: [], backedUp: ['alpha'] }, 'a stale-files re-render must never be skipped');
  const dest = path.join(target, 'alpha');
  assert.equal(fs.readFileSync(path.join(dest, 'sections', 'scope.md'), 'utf8'), SCOPE_V2);
  assert.ok(!fs.existsSync(path.join(dest, 'templates')), 'a dropped listed file must not linger from the previous install');
  assert.deepEqual(readRegistry(target).skills, [{ name: 'alpha', sha256: textDigest(ALPHA_V1), files: filesV2 }]);
  const backupsRoot = path.join(target, BACKUPS);
  const [backup] = fs.readdirSync(backupsRoot);
  assert.match(backup, /^alpha-\d+$/);
  assert.equal(fs.readFileSync(path.join(backupsRoot, backup, 'sections', 'scope.md'), 'utf8'), SCOPE_V1, 'the replaced render survives in the backup');
  assert.equal(fs.readFileSync(path.join(backupsRoot, backup, 'templates', 'report.md'), 'utf8'), TEMPLATE_V1);
});

test('installSkills skips an identical multi-file reinstall byte-for-byte', t => {
  const root = base(t), target = path.join(root, 'target');
  const v1 = path.join(root, 'v1'), v2 = path.join(root, 'v2');
  fs.mkdirSync(v1); fs.mkdirSync(v2);
  const listed = ['SKILL.md', 'manifest.json', 'sections/scope.md', 'templates/report.md'];
  stageMulti(v1, 'alpha', ALPHA_V1, { 'sections/scope.md': SCOPE_V1, 'templates/report.md': TEMPLATE_V1 });
  stageMulti(v2, 'alpha', ALPHA_V1, { 'sections/scope.md': SCOPE_V1, 'templates/report.md': TEMPLATE_V1 });
  installSkills({ staging: v1, target, now: NOW });
  const before = listed.map(file => fs.statSync(path.join(target, 'alpha', ...file.split('/'))).mtimeMs);
  const registryBefore = fs.readFileSync(registryFile(target), 'utf8');
  const result = installSkills({ staging: v2, target, now: NOW });
  assert.deepEqual(result, { installed: [], skipped: ['alpha'], backedUp: [] });
  assert.deepEqual(listed.map(file => fs.statSync(path.join(target, 'alpha', ...file.split('/'))).mtimeMs), before, 'skipped skills must not be rewritten');
  assert.equal(fs.readFileSync(registryFile(target), 'utf8'), registryBefore);
  assert.ok(!fs.existsSync(path.join(target, BACKUPS)));
});

test('installSkills rejects reserved top-level names as files keys', t => {
  const root = base(t);
  let n = 0;
  for (const key of ['SKILL.md', 'skill.md', 'Manifest.json', 'MANIFEST.JSON']) {
    const staging = path.join(root, `staging-${n += 1}`), target = path.join(root, `target-${n}`);
    fs.mkdirSync(staging);
    // The listed files are deliberately not written to disk: shape validation must
    // reject the reserved key before any staging read happens.
    stage(staging, 'alpha', ALPHA_V1, { files: { [key]: textDigest('body') } });
    assert.throws(() => installSkills({ staging, target, now: NOW }), /STAGING_INVALID/, `key ${key} must be rejected`);
    assert.ok(!fs.existsSync(target));
  }
});

test('installSkills rejects malformed files maps, keys, and values', t => {
  const root = base(t);
  const badKeys = ['../escape.md', '/absolute.md', 'a\\b.md', 'a/b/c/d/e.md', '.hidden.md',
    'sections/.hidden.md', 'sections//x.md', 'sections/', 'a/./b.md', 'C:\\temp\\x.md'];
  let n = 0;
  for (const key of badKeys) {
    const staging = path.join(root, `staging-${n += 1}`), target = path.join(root, `target-${n}`);
    fs.mkdirSync(staging);
    stage(staging, 'alpha', ALPHA_V1, { files: { [key]: textDigest('body') } });
    assert.throws(() => installSkills({ staging, target, now: NOW }), /STAGING_INVALID/, `key ${key} must be rejected`);
    assert.ok(!fs.existsSync(target));
  }
  for (const files of ['nope', 42, [{ 'a.md': textDigest('body') }]]) {
    const staging = path.join(root, `staging-${n += 1}`), target = path.join(root, `target-${n}`);
    fs.mkdirSync(staging);
    stage(staging, 'alpha', ALPHA_V1, { files });
    assert.throws(() => installSkills({ staging, target, now: NOW }), /STAGING_INVALID/);
    assert.ok(!fs.existsSync(target));
  }
  for (const value of ['not-hex', 'a'.repeat(63), 42, null]) {
    const staging = path.join(root, `staging-${n += 1}`), target = path.join(root, `target-${n}`);
    fs.mkdirSync(staging);
    stage(staging, 'alpha', ALPHA_V1, { files: { 'sections/x.md': value } });
    assert.throws(() => installSkills({ staging, target, now: NOW }), /STAGING_INVALID/);
    assert.ok(!fs.existsSync(target));
  }
});

test('installSkills refuses files keys that collide case-insensitively with zero writes', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  // The listed files are deliberately not written to disk: the collision check is part
  // of manifest shape validation and must refuse before any staging file read.
  // POSIX nuance: a case pair like A.md/a.md previously installed successfully there
  // as two distinct files; refusing it is intentional cross-platform tightening (the
  // same manifest already collided on case-insensitive win32/apfs targets), not
  // merely an early EEXIST.
  stage(staging, 'alpha', ALPHA_V1, { files: { 'A.md': textDigest('body-a'), 'a.md': textDigest('body-b') } });
  assert.throws(() => installSkills({ staging, target, now: NOW }), /STAGING_INVALID/);
  assert.ok(!fs.existsSync(target), 'the refusal must happen before the target is even created');
});

test('installSkills refuses a files key that collides as a directory prefix of another', t => {
  const root = base(t);
  let n = 0;
  // A file `a` and a directory `a/` cannot coexist on any filesystem, so these pairs
  // are refused regardless of case sensitivity — the check is segment-wise (key + '/').
  for (const [keyA, keyB] of [['a', 'a/b.md'], ['sections', 'sections/x.md'], ['Sections', 'sections/x.md']]) {
    const staging = path.join(root, `staging-${n += 1}`), target = path.join(root, `target-${n}`);
    fs.mkdirSync(staging);
    stage(staging, 'alpha', ALPHA_V1, { files: { [keyA]: textDigest('body-a'), [keyB]: textDigest('body-b') } });
    assert.throws(() => installSkills({ staging, target, now: NOW }), /STAGING_INVALID/, `${keyA} + ${keyB} must collide`);
    assert.ok(!fs.existsSync(target));
  }
});

test('installSkills installs files keys that share a bare string prefix but no segment', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  // a.md and a.md2 share the literal string prefix "a.md" but no whole path segment:
  // the collision rule is segment-wise (key + '/'), never a bare startsWith, so both install.
  stageMulti(staging, 'alpha', ALPHA_V1, { 'a.md': 'plain body', 'a.md2': 'sibling body' });
  assert.deepEqual(installSkills({ staging, target, now: NOW }), { installed: ['alpha'], skipped: [], backedUp: [] });
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'a.md'), 'utf8'), 'plain body');
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'a.md2'), 'utf8'), 'sibling body');
});

test('uninstallSkills refuses a legacy files-less registry record over a files-bearing target', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stageMulti(staging, 'alpha', ALPHA_V1, { 'sections/scope.md': SCOPE_V1 });
  installSkills({ staging, target, now: NOW });
  // A registry written before multi-file support names no files while the target
  // carries them: the trust anchors disagree, so deletion is refused.
  const legacy = `${JSON.stringify({
    schemaVersion: 1, updatedAt: WHEN, skills: [{ name: 'alpha', sha256: textDigest(ALPHA_V1) }],
  }, null, 2)}\n`;
  fs.writeFileSync(registryFile(target), legacy);
  assert.throws(() => uninstallSkills({ target, now: NOW }), /USER_FILE_REFUSED/);
  assert.equal(fs.readFileSync(registryFile(target), 'utf8'), legacy, 'the registry is left untouched');
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'sections', 'scope.md'), 'utf8'), SCOPE_V1, 'nothing is deleted on refusal');
});

test('uninstallSkills refuses when a listed file is missing from the target', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stageMulti(staging, 'alpha', ALPHA_V1, { 'sections/scope.md': SCOPE_V1, 'templates/report.md': TEMPLATE_V1 });
  installSkills({ staging, target, now: NOW });
  fs.rmSync(path.join(target, 'alpha', 'sections'), { recursive: true });
  assert.throws(() => uninstallSkills({ target, now: NOW }), /USER_FILE_REFUSED/);
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8'), ALPHA_V1, 'nothing is deleted on refusal');
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'templates', 'report.md'), 'utf8'), TEMPLATE_V1);
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

// --- codex audit #2/#3/#4 regression battery ------------------------------------

test('registry lost + a user-added file refuses takeover; a pristine directory still recovers (audit #2)', t => {
  const root = base(t), s1 = path.join(root, 's1'), s2 = path.join(root, 's2'), target = path.join(root, 'target');
  fs.mkdirSync(s1); fs.mkdirSync(s2);
  // A files-bearing skill: the on-disk manifest then carries its own claims to verify
  // against once the registry is gone (a files-less manifest has nothing to check).
  const SCOPE = 'scope body';
  stageMulti(s1, 'alpha', ALPHA_V1, { 'sections/scope.md': SCOPE });
  installSkills({ staging: s1, target, now: NOW });
  fs.rmSync(registryFile(target));
  fs.writeFileSync(path.join(target, 'alpha', 'user-notes.txt'), 'user content');
  stageMulti(s2, 'alpha', ALPHA_V2, { 'sections/scope.md': SCOPE });
  // No registry record: classify validates the directory against the on-disk manifest's
  // OWN claims — the user file is not in them, so takeover is refused, never backed up.
  assert.throws(() => installSkills({ staging: s2, target, now: NOW }), /USER_FILE_REFUSED/);
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8'), ALPHA_V1, 'nothing moved on refusal');
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'user-notes.txt'), 'utf8'), 'user content', 'the user file stays');
  assert.ok(!fs.existsSync(path.join(target, BACKUPS)), 'no backup root was taken on refusal');
  // The recovery path survives: pristine + registry lost still backs up and replaces.
  fs.rmSync(path.join(target, 'alpha', 'user-notes.txt'));
  assert.deepEqual(installSkills({ staging: s2, target, now: NOW }), { installed: ['alpha'], skipped: [], backedUp: ['alpha'] });
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8'), ALPHA_V2);
  assert.equal(readRegistry(target).skills[0].sha256, textDigest(ALPHA_V2));
});

test('registry lost + user-added file refuses takeover for files-LESS skills too (audit #2, round 3)', t => {
  const root = base(t), s1 = path.join(root, 's1'), s2 = path.join(root, 's2'), target = path.join(root, 'target');
  fs.mkdirSync(s1); fs.mkdirSync(s2);
  stage(s1, 'alpha', ALPHA_V1); // no files map: the manifest's claim is "nothing beyond SKILL.md/manifest.json"
  installSkills({ staging: s1, target, now: NOW });
  fs.rmSync(registryFile(target));
  fs.writeFileSync(path.join(target, 'alpha', 'user-notes.txt'), 'user content');
  stage(s2, 'alpha', ALPHA_V2);
  assert.throws(() => installSkills({ staging: s2, target, now: NOW }), /USER_FILE_REFUSED/,
    'a files-less directory with an extra file is just as unowned as a files-bearing one');
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'user-notes.txt'), 'utf8'), 'user content', 'the user file survives');
  assert.ok(!fs.existsSync(path.join(target, BACKUPS)), 'nothing was moved into purgeable backups');
  // Pristine files-less recovery still works.
  fs.rmSync(path.join(target, 'alpha', 'user-notes.txt'));
  assert.deepEqual(installSkills({ staging: s2, target, now: NOW }).backedUp, ['alpha']);
});

test('a fault at the new-dir rename restores the moved backup and leaves the registry untouched (audit #3a)', t => {
  const root = base(t), s1 = path.join(root, 's1'), s2 = path.join(root, 's2'), target = path.join(root, 'target');
  fs.mkdirSync(s1); fs.mkdirSync(s2);
  stage(s1, 'alpha', ALPHA_V1);
  installSkills({ staging: s1, target, now: NOW });
  const before = fs.readFileSync(registryFile(target), 'utf8');
  stage(s2, 'alpha', ALPHA_V2);
  const real = fs.renameSync; let swaps = 0;
  fs.renameSync = function (src, dest, ...rest) {
    // The only rename landing ON target/alpha is temp -> final name; fail exactly it
    // (the old dir moves to the backups root first, a different destination).
    if (dest === path.join(target, 'alpha') && ++swaps === 1) throw Object.assign(new Error('EIO'), { code: 'EIO' });
    return real.call(this, src, dest, ...rest);
  };
  try { assert.throws(() => installSkills({ staging: s2, target, now: NOW }), /EIO/); } finally { fs.renameSync = real; }
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8'), ALPHA_V1, 'the moved-out backup is restored in place');
  assert.equal(fs.readFileSync(registryFile(target), 'utf8'), before, 'the registry never recorded the failed swap');
  assert.deepEqual(fs.readdirSync(path.join(target, BACKUPS)), [], 'no backup entry is left behind');
  assert.deepEqual(installSkills({ staging: s2, target, now: NOW }), { installed: ['alpha'], skipped: [], backedUp: ['alpha'] }, 'the target recovers cleanly');
});

test('a fault at the registry commit rolls the skill directory back too (audit #3b)', t => {
  const root = base(t), s1 = path.join(root, 's1'), s2 = path.join(root, 's2'), target = path.join(root, 'target');
  fs.mkdirSync(s1); fs.mkdirSync(s2);
  stage(s1, 'alpha', ALPHA_V1); stage(s1, 'beta', BETA_V1);
  installSkills({ staging: s1, target, now: NOW });
  const before = fs.readFileSync(registryFile(target), 'utf8');
  stage(s2, 'alpha', ALPHA_V2); stage(s2, 'beta', 'beta skill body v2');
  const real = fs.writeFileSync; let registryWrites = 0;
  fs.writeFileSync = function (file, ...rest) {
    // writeRegistry is temp+rename: failing the first registry temp write is atomic.
    if (String(file).includes(REGISTRY) && String(file).endsWith('.tmp') && ++registryWrites === 1) {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    }
    return real.call(this, file, ...rest);
  };
  try { assert.throws(() => installSkills({ staging: s2, target, now: NOW }), /EIO/); } finally { fs.writeFileSync = real; }
  // Registry and disk never disagree at rest: everything is exactly the pre-install state.
  assert.equal(fs.readFileSync(registryFile(target), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8'), ALPHA_V1);
  assert.equal(fs.readFileSync(path.join(target, 'beta', 'SKILL.md'), 'utf8'), BETA_V1);
  assert.deepEqual(fs.readdirSync(path.join(target, BACKUPS)), []);
  assert.deepEqual(installSkills({ staging: s2, target, now: NOW }).backedUp.sort(), ['alpha', 'beta'], 'the target recovers cleanly');
});

test('a combined fault (commit fails AND the rollback delete fails) keeps the old version in the backup (audit #15)', t => {
  const root = base(t), s1 = path.join(root, 's1'), s2 = path.join(root, 's2'), target = path.join(root, 'target');
  fs.mkdirSync(s1); fs.mkdirSync(s2);
  stage(s1, 'alpha', ALPHA_V1);
  installSkills({ staging: s1, target, now: NOW });
  stage(s2, 'alpha', ALPHA_V2);
  const realWrite = fs.writeFileSync, realRm = fs.rmSync;
  let registryWrites = 0, rmBlocked = false;
  fs.writeFileSync = function (file, ...rest) {
    if (String(file).includes(REGISTRY) && String(file).endsWith('.tmp') && ++registryWrites === 1) {
      rmBlocked = true; // arm the second fault only inside the window the first one opens
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    }
    return realWrite.call(this, file, ...rest);
  };
  fs.rmSync = function (target_, ...rest) {
    if (rmBlocked && String(target_) === path.join(target, 'alpha')) {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); // the new dir cannot be removed
    }
    return realRm.call(this, target_, ...rest);
  };
  try {
    assert.throws(() => installSkills({ staging: s2, target, now: NOW }), /EIO|EPERM/);
  } finally { fs.writeFileSync = realWrite; fs.rmSync = realRm; }
  // The active directory is the unverifiable NEW version, so the OLD version must
  // survive somewhere — here, in the backup the rollback was forbidden to delete.
  const backups = fs.readdirSync(path.join(target, BACKUPS)).filter(name => name.startsWith('alpha-'));
  assert.equal(backups.length, 1, 'the old version survives in exactly one backup entry');
  assert.equal(fs.readFileSync(path.join(target, BACKUPS, backups[0], 'SKILL.md'), 'utf8'), ALPHA_V1,
    'the surviving backup holds the pre-install version');
});

test('multi-segment listed files survive the reinstall and uninstall lifecycle (audit #4)', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  const DEEP = 'deep file body';
  stageMulti(staging, 'alpha', ALPHA_V1, { 'sections/deep/nested/detail.md': DEEP, 'templates/report.md': 'template body' });
  installSkills({ staging, target, now: NOW });
  // The skip path re-runs verifyOwned: every ACCUMULATED directory (sections,
  // sections/deep, sections/deep/nested) must be legal on-path, or reinstall refuses.
  assert.deepEqual(installSkills({ staging, target, now: NOW }), { installed: [], skipped: ['alpha'], backedUp: [] });
  const reStaged = path.join(root, 'staging-v2'); fs.mkdirSync(reStaged);
  stageMulti(reStaged, 'alpha', ALPHA_V2, { 'sections/deep/nested/detail.md': DEEP, 'templates/report.md': 'template body' });
  assert.deepEqual(installSkills({ staging: reStaged, target, now: NOW }), { installed: ['alpha'], skipped: [], backedUp: ['alpha'] });
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'sections', 'deep', 'nested', 'detail.md'), 'utf8'), DEEP);
  assert.deepEqual(uninstallSkills({ target, now: NOW }).uninstalled, ['alpha']);
  assert.ok(!fs.existsSync(path.join(target, 'alpha')), 'the whole multi-level tree is removed');
});

// --- install --dry-run (read-only report) ---------------------------------------

const CLI = fileURLToPath(new URL('../bin/gstack861.mjs', import.meta.url));

test('installSkills dry-run reports a fresh install (multi-file skill included) and writes nothing', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stageMulti(staging, 'alpha', ALPHA_V1, { 'sections/scope.md': SCOPE_V1, 'templates/report.md': TEMPLATE_V1 });
  stage(staging, 'beta', BETA_V1);
  const result = installSkills({ staging, target, now: NOW, dryRun: true });
  assert.deepEqual(result, { dryRun: true, wouldInstall: ['alpha', 'beta'], wouldSkip: [], wouldBackUp: [] });
  assert.ok(!fs.existsSync(target), 'dry-run must not create the target');
  assert.ok(!fs.existsSync(path.join(target, LOCK)), 'dry-run must not take the install lock');
  assert.ok(!fs.existsSync(registryFile(target)), 'dry-run must not write a registry');
  // the prediction stays actionable: a real install right after works unchanged
  assert.deepEqual(installSkills({ staging, target, now: NOW }), { installed: ['alpha', 'beta'], skipped: [], backedUp: [] });
});

test('installSkills dry-run over an installed target reports wouldSkip and writes nothing', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  stageMulti(staging, 'beta', BETA_V1, { 'sections/scope.md': SCOPE_V1 });
  installSkills({ staging, target, now: NOW });
  const registryBefore = fs.readFileSync(registryFile(target), 'utf8');
  const result = installSkills({ staging, target, now: NOW, dryRun: true });
  assert.deepEqual(result, { dryRun: true, wouldInstall: [], wouldSkip: ['alpha', 'beta'], wouldBackUp: [] });
  assert.equal(fs.readFileSync(registryFile(target), 'utf8'), registryBefore, 'the registry must not be rewritten');
  assert.ok(!fs.existsSync(path.join(target, LOCK)), 'no lock may be taken');
  assert.ok(!fs.existsSync(path.join(target, BACKUPS)), 'identical content must not create backups');
});

test('installSkills dry-run reports drift as wouldBackUp plus wouldInstall without writing', t => {
  const root = base(t), target = path.join(root, 'target');
  const v1 = path.join(root, 'v1'), v2 = path.join(root, 'v2');
  fs.mkdirSync(v1); fs.mkdirSync(v2);
  stage(v1, 'alpha', ALPHA_V1);
  stage(v1, 'beta', BETA_V1);
  stage(v2, 'alpha', ALPHA_V2); // same batch, one drifted skill
  stage(v2, 'beta', BETA_V1);
  installSkills({ staging: v1, target, now: NOW });
  const registryBefore = fs.readFileSync(registryFile(target), 'utf8');
  const result = installSkills({ staging: v2, target, now: NOW, dryRun: true });
  assert.deepEqual(result, { dryRun: true, wouldInstall: ['alpha'], wouldSkip: ['beta'], wouldBackUp: ['alpha'] });
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8'), ALPHA_V1, 'the drift skill must stay v1');
  assert.equal(fs.readFileSync(registryFile(target), 'utf8'), registryBefore, 'the registry must not be rewritten');
  assert.ok(!fs.existsSync(path.join(target, BACKUPS)), 'no backups root may be created');
});

test('installSkills dry-run still throws TAMPERED_STAGING and writes nothing', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stageMulti(staging, 'alpha', ALPHA_V1, { 'sections/scope.md': SCOPE_V1 });
  fs.writeFileSync(path.join(staging, 'alpha', 'sections', 'scope.md'), `${SCOPE_V1}tampered`);
  assert.throws(() => installSkills({ staging, target, now: NOW, dryRun: true }), /TAMPERED_STAGING/, 'a dry-run never swallows refusals');
  assert.ok(!fs.existsSync(target), 'a refused dry-run must not create the target');
});

test('installSkills dry-run takes no lock, so a held one never reports INSTALL_BUSY', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  fs.mkdirSync(target);
  const lock = path.join(target, LOCK);
  fs.mkdirSync(lock);
  const result = installSkills({ staging, target, now: NOW, dryRun: true });
  assert.deepEqual(result, { dryRun: true, wouldInstall: ['alpha'], wouldSkip: [], wouldBackUp: [] });
  assert.ok(fs.existsSync(lock), 'the foreign lock must be left untouched');
  assert.ok(!fs.existsSync(path.join(target, 'alpha')), 'no skill may be written');
  assert.ok(!fs.existsSync(registryFile(target)), 'no registry may be written');
});

if (process.platform === 'win32') {
  test('installSkills dry-run refuses a junction target with INVALID_TARGET and writes nothing through it', t => {
    const root = base(t), staging = path.join(root, 'staging');
    fs.mkdirSync(staging);
    stage(staging, 'alpha', ALPHA_V1);
    const realTarget = path.join(root, 'real-target');
    fs.mkdirSync(realTarget);
    const junction = path.join(root, 'target-link');
    fs.symlinkSync(realTarget, junction, 'junction');
    assert.throws(() => installSkills({ staging, target: junction, now: NOW, dryRun: true }), /INVALID_TARGET/);
    assert.deepEqual(fs.readdirSync(realTarget), [], 'nothing may be written through the junction');
  });

  test('installSkills dry-run refuses a junction at the backups root without creating anything', t => {
    const root = base(t), target = path.join(root, 'target');
    const v1 = path.join(root, 'v1'), v2 = path.join(root, 'v2');
    fs.mkdirSync(v1); fs.mkdirSync(v2);
    stage(v1, 'alpha', ALPHA_V1);
    stage(v2, 'alpha', ALPHA_V2);
    installSkills({ staging: v1, target, now: NOW });
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(target, BACKUPS), 'junction');
    assert.throws(() => installSkills({ staging: v2, target, now: NOW, dryRun: true }), /USER_FILE_REFUSED/);
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing may be written outside the target through the junction');
    assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8'), ALPHA_V1, 'the drift skill must stay v1');
  });
}

if (process.platform !== 'win32') {
  test('installSkills dry-run refuses a symlinked target with INVALID_TARGET and writes nothing through it', t => {
    const root = base(t), staging = path.join(root, 'staging');
    fs.mkdirSync(staging);
    stage(staging, 'alpha', ALPHA_V1);
    const realTarget = path.join(root, 'real-target');
    fs.mkdirSync(realTarget);
    const linkedTarget = path.join(root, 'target-link');
    fs.symlinkSync(realTarget, linkedTarget);
    assert.throws(() => installSkills({ staging, target: linkedTarget, now: NOW, dryRun: true }), /INVALID_TARGET/);
    assert.deepEqual(fs.readdirSync(realTarget), [], 'nothing may be written through the symlink');
  });

  test('installSkills dry-run refuses a symlink at the backups root without creating anything', t => {
    const root = base(t), target = path.join(root, 'target');
    const v1 = path.join(root, 'v1'), v2 = path.join(root, 'v2');
    fs.mkdirSync(v1); fs.mkdirSync(v2);
    stage(v1, 'alpha', ALPHA_V1);
    stage(v2, 'alpha', ALPHA_V2);
    installSkills({ staging: v1, target, now: NOW });
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(target, BACKUPS));
    assert.throws(() => installSkills({ staging: v2, target, now: NOW, dryRun: true }), /USER_FILE_REFUSED/);
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing may be written outside the target through the symlink');
    assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8'), ALPHA_V1, 'the drift skill must stay v1');
  });
}

test('install --dry-run prints the report and creates nothing', async t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  const run = await execute(process.execPath, [CLI, 'install', '--staging', staging, '--target', target, '--dry-run']);
  assert.deepEqual(JSON.parse(run.stdout), { dryRun: true, wouldInstall: ['alpha'], wouldSkip: [], wouldBackUp: [] });
  assert.ok(!fs.existsSync(target), 'the CLI dry-run must not create the target');
});

test('install --dry-run keeps ABSOLUTE_PATH_REQUIRED for a relative target', async t => {
  const root = base(t), staging = path.join(root, 'staging');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  await assert.rejects(execute(process.execPath, [CLI, 'install', '--staging', staging, '--target', 'relative-target', '--dry-run']),
    error => error.code === 1 && /ABSOLUTE_PATH_REQUIRED/.test(error.stderr));
});

// --- uninstall --dry-run (read-only report) --------------------------------------

test('uninstallSkills dry-run reports the full uninstall set and mutates nothing', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stageMulti(staging, 'alpha', ALPHA_V1, { 'sections/scope.md': SCOPE_V1 });
  stage(staging, 'beta', BETA_V1);
  installSkills({ staging, target, now: NOW });
  fs.mkdirSync(path.join(target, 'not-ours'));
  fs.writeFileSync(path.join(target, 'not-ours', 'SKILL.md'), 'user content');
  const registryBefore = fs.readFileSync(registryFile(target), 'utf8');
  const result = uninstallSkills({ target, now: NOW, dryRun: true });
  assert.deepEqual(result, { dryRun: true, wouldUninstall: ['alpha', 'beta'], wouldPurge: [] });
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8'), ALPHA_V1, 'the dry-run must delete nothing');
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'sections', 'scope.md'), 'utf8'), SCOPE_V1);
  assert.equal(fs.readFileSync(path.join(target, 'beta', 'SKILL.md'), 'utf8'), BETA_V1);
  assert.equal(fs.readFileSync(path.join(target, 'not-ours', 'SKILL.md'), 'utf8'), 'user content');
  assert.equal(fs.readFileSync(registryFile(target), 'utf8'), registryBefore, 'the registry must not be rewritten');
  // the prediction stays actionable: a real uninstall right after works unchanged
  assert.deepEqual(uninstallSkills({ target, now: NOW }), { uninstalled: ['alpha', 'beta'], backupsRemoved: 0 });
  assert.equal(fs.readFileSync(path.join(target, 'not-ours', 'SKILL.md'), 'utf8'), 'user content');
});

test('uninstallSkills dry-run counts a registered skill whose directory is already gone', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  stage(staging, 'beta', BETA_V1);
  installSkills({ staging, target, now: NOW });
  fs.rmSync(path.join(target, 'beta'), { recursive: true });
  const registryBefore = fs.readFileSync(registryFile(target), 'utf8');
  const result = uninstallSkills({ target, now: NOW, dryRun: true });
  assert.deepEqual(result, { dryRun: true, wouldUninstall: ['alpha', 'beta'], wouldPurge: [] }, 'the absent dir still counts, mirroring the real return');
  assert.ok(fs.existsSync(path.join(target, 'alpha')), 'the dry-run must delete nothing');
  assert.equal(fs.readFileSync(registryFile(target), 'utf8'), registryBefore);
});

test('uninstallSkills dry-run refuses drift exactly like the real run and removes nothing', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  stage(staging, 'beta', BETA_V1);
  installSkills({ staging, target, now: NOW });
  const registryBefore = fs.readFileSync(registryFile(target), 'utf8');
  fs.writeFileSync(path.join(target, 'alpha', 'SKILL.md'), `${ALPHA_V1}\nuser note`);
  assert.throws(() => uninstallSkills({ target, now: NOW, dryRun: true }), /USER_FILE_REFUSED/, 'a dry-run never swallows refusals');
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8'), `${ALPHA_V1}\nuser note`, 'the user edit must survive');
  assert.equal(fs.readFileSync(path.join(target, 'beta', 'SKILL.md'), 'utf8'), BETA_V1, 'two-phase: the other skill survives too');
  assert.equal(fs.readFileSync(registryFile(target), 'utf8'), registryBefore, 'the registry must be left untouched');
});

test('uninstallSkills dry-run with purge lists the drift backup and the emptied root', t => {
  const root = base(t), target = path.join(root, 'target');
  const v1 = path.join(root, 'v1'), v2 = path.join(root, 'v2');
  fs.mkdirSync(v1); fs.mkdirSync(v2);
  stage(v1, 'alpha', ALPHA_V1);
  stage(v2, 'alpha', ALPHA_V2);
  installSkills({ staging: v1, target, now: NOW });
  installSkills({ staging: v2, target, now: NOW });
  const backupsRoot = path.join(target, BACKUPS);
  const [backup] = fs.readdirSync(backupsRoot);
  assert.match(backup, /^alpha-\d+$/);
  const registryBefore = fs.readFileSync(registryFile(target), 'utf8');
  const result = uninstallSkills({ target, purge: true, now: NOW, dryRun: true });
  assert.deepEqual(result, { dryRun: true, wouldUninstall: ['alpha'], wouldPurge: [backup], wouldEmptyBackupsRoot: true });
  assert.deepEqual(fs.readdirSync(backupsRoot), [backup], 'the dry-run must not remove the backup');
  assert.equal(fs.readFileSync(path.join(target, 'alpha', 'SKILL.md'), 'utf8'), ALPHA_V2, 'the skill must stay installed');
  assert.equal(fs.readFileSync(registryFile(target), 'utf8'), registryBefore);
});

test('uninstallSkills dry-run with purge leaves user archives and unverifiable backups unlisted and in place', t => {
  const root = base(t), target = path.join(root, 'target');
  const v1 = path.join(root, 'v1'), v2 = path.join(root, 'v2');
  fs.mkdirSync(v1); fs.mkdirSync(v2);
  stage(v1, 'alpha', ALPHA_V1);
  stage(v2, 'alpha', ALPHA_V2);
  installSkills({ staging: v1, target, now: NOW });
  installSkills({ staging: v2, target, now: NOW });
  const backupsRoot = path.join(target, BACKUPS);
  const [backup] = fs.readdirSync(backupsRoot);
  fs.mkdirSync(path.join(backupsRoot, 'user-archive'));
  fs.writeFileSync(path.join(backupsRoot, 'user-archive', 'SKILL.md'), 'user archive');
  fs.writeFileSync(path.join(backupsRoot, 'keeper.txt'), 'user file');
  const corrupt = path.join(backupsRoot, 'alpha-1761453400000');
  fs.mkdirSync(corrupt);
  fs.writeFileSync(path.join(corrupt, 'SKILL.md'), 'body');
  fs.writeFileSync(path.join(corrupt, 'manifest.json'), '{ not json');
  const foreign = path.join(backupsRoot, 'beta-1761453400001');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'SKILL.md'), 'body');
  fs.writeFileSync(path.join(foreign, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, generator: 'not-us' }, null, 2)}\n`);
  const result = uninstallSkills({ target, purge: true, now: NOW, dryRun: true });
  assert.deepEqual(result, { dryRun: true, wouldUninstall: ['alpha'], wouldPurge: [backup] }, 'only the verifiably-own backup may be listed, and the root would not be emptied');
  assert.deepEqual(fs.readdirSync(backupsRoot).sort(),
    ['alpha-1761453400000', backup, 'beta-1761453400001', 'keeper.txt', 'user-archive'].sort(), 'every entry must survive the dry-run');
  assert.equal(fs.readFileSync(path.join(corrupt, 'manifest.json'), 'utf8'), '{ not json', 'the corrupt-manifest backup must survive verbatim');
  assert.equal(fs.readFileSync(path.join(foreign, 'manifest.json'), 'utf8'), `${JSON.stringify({ schemaVersion: 1, generator: 'not-us' }, null, 2)}\n`, 'the foreign-generator backup must survive verbatim');
  assert.equal(fs.readFileSync(path.join(backupsRoot, 'user-archive', 'SKILL.md'), 'utf8'), 'user archive');
});

test('uninstallSkills dry-run on an absent target returns the empty report without throwing', t => {
  const root = base(t), target = path.join(root, 'target');
  assert.deepEqual(uninstallSkills({ target, now: NOW, dryRun: true }), { dryRun: true, wouldUninstall: [], wouldPurge: [] });
  assert.ok(!fs.existsSync(target), 'the dry-run must not create the target');
});

test('uninstallSkills dry-run without a registry returns the empty report without inventing one', t => {
  const root = base(t), target = path.join(root, 'target');
  fs.mkdirSync(target);
  fs.mkdirSync(path.join(target, 'stray'));
  fs.writeFileSync(path.join(target, 'stray', 'SKILL.md'), 'user content');
  assert.deepEqual(uninstallSkills({ target, now: NOW, dryRun: true }), { dryRun: true, wouldUninstall: [], wouldPurge: [] });
  assert.equal(fs.readFileSync(path.join(target, 'stray', 'SKILL.md'), 'utf8'), 'user content');
  assert.ok(!fs.existsSync(registryFile(target)), 'the dry-run must not invent a registry');
});

test('uninstallSkills dry-run takes no lock, so a stale one never reports INSTALL_BUSY', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  installSkills({ staging, target, now: NOW });
  const lock = path.join(target, LOCK);
  fs.mkdirSync(lock);
  const registryBefore = fs.readFileSync(registryFile(target), 'utf8');
  const result = uninstallSkills({ target, now: NOW, dryRun: true });
  assert.deepEqual(result, { dryRun: true, wouldUninstall: ['alpha'], wouldPurge: [] });
  assert.ok(fs.existsSync(lock), 'the stale lock must be left untouched');
  assert.ok(fs.existsSync(path.join(target, 'alpha')), 'no skill may be deleted');
  assert.equal(fs.readFileSync(registryFile(target), 'utf8'), registryBefore, 'the registry must not be rewritten');
});

if (process.platform === 'win32') {
  test('uninstallSkills dry-run refuses a junction target with INVALID_TARGET and writes nothing through it', t => {
    const root = base(t), staging = path.join(root, 'staging');
    fs.mkdirSync(staging);
    stage(staging, 'alpha', ALPHA_V1);
    const realTarget = path.join(root, 'real-target');
    installSkills({ staging, target: realTarget, now: NOW });
    const registryBefore = fs.readFileSync(registryFile(realTarget), 'utf8');
    const junction = path.join(root, 'target-link');
    fs.symlinkSync(realTarget, junction, 'junction');
    assert.throws(() => uninstallSkills({ target: junction, now: NOW, dryRun: true }), /INVALID_TARGET/);
    assert.ok(fs.existsSync(path.join(realTarget, 'alpha')), 'nothing may be removed through the junction');
    assert.equal(fs.readFileSync(path.join(realTarget, 'alpha', 'SKILL.md'), 'utf8'), ALPHA_V1);
    assert.equal(fs.readFileSync(registryFile(realTarget), 'utf8'), registryBefore);
  });
}

if (process.platform !== 'win32') {
  test('uninstallSkills dry-run refuses a symlinked target with INVALID_TARGET and writes nothing through it', t => {
    const root = base(t), staging = path.join(root, 'staging');
    fs.mkdirSync(staging);
    stage(staging, 'alpha', ALPHA_V1);
    const realTarget = path.join(root, 'real-target');
    installSkills({ staging, target: realTarget, now: NOW });
    const registryBefore = fs.readFileSync(registryFile(realTarget), 'utf8');
    const linkedTarget = path.join(root, 'target-link');
    fs.symlinkSync(realTarget, linkedTarget);
    assert.throws(() => uninstallSkills({ target: linkedTarget, now: NOW, dryRun: true }), /INVALID_TARGET/);
    assert.ok(fs.existsSync(path.join(realTarget, 'alpha')), 'nothing may be removed through the symlink');
    assert.equal(fs.readFileSync(path.join(realTarget, 'alpha', 'SKILL.md'), 'utf8'), ALPHA_V1);
    assert.equal(fs.readFileSync(registryFile(realTarget), 'utf8'), registryBefore);
  });
}

test('uninstall --dry-run prints the report and removes nothing', async t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_V1);
  installSkills({ staging, target, now: NOW });
  const registryBefore = fs.readFileSync(registryFile(target), 'utf8');
  const run = await execute(process.execPath, [CLI, 'uninstall', '--target', target, '--dry-run']);
  assert.deepEqual(JSON.parse(run.stdout), { dryRun: true, wouldUninstall: ['alpha'], wouldPurge: [] });
  assert.ok(fs.existsSync(path.join(target, 'alpha')), 'the CLI dry-run must not remove the skill');
  assert.equal(fs.readFileSync(registryFile(target), 'utf8'), registryBefore, 'the CLI dry-run must not rewrite the registry');
});

test('uninstall --dry-run --purge prints the combined report without touching anything', async t => {
  const root = base(t), target = path.join(root, 'target');
  const v1 = path.join(root, 'v1'), v2 = path.join(root, 'v2');
  fs.mkdirSync(v1); fs.mkdirSync(v2);
  stage(v1, 'alpha', ALPHA_V1);
  stage(v2, 'alpha', ALPHA_V2);
  installSkills({ staging: v1, target, now: NOW });
  installSkills({ staging: v2, target, now: NOW });
  const [backup] = fs.readdirSync(path.join(target, BACKUPS));
  const run = await execute(process.execPath, [CLI, 'uninstall', '--target', target, '--dry-run', '--purge']);
  assert.deepEqual(JSON.parse(run.stdout), { dryRun: true, wouldUninstall: ['alpha'], wouldPurge: [backup], wouldEmptyBackupsRoot: true });
  assert.deepEqual(fs.readdirSync(path.join(target, BACKUPS)), [backup], 'the drift backup must survive');
  assert.ok(fs.existsSync(path.join(target, 'alpha')), 'the skill must stay installed');
});

// --- I1: strict shared installer paths and observed swaps -----------------------

const directoryLink = (physical, view) => fs.symlinkSync(physical, view, process.platform === 'win32' ? 'junction' : 'dir');

// Capture bytes, identities and modification times; reads may change access time.
function installTree(root) {
  const result = [];
  const walk = filename => {
    const stat = fs.lstatSync(filename, { bigint: true });
    const name = path.relative(root, filename);
    result.push([name, String(stat.dev), String(stat.ino), String(stat.mtimeNs),
      stat.isSymbolicLink() ? fs.readlinkSync(filename) : stat.isFile() ? fs.readFileSync(filename).toString('hex') : 'directory']);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const child of fs.readdirSync(filename).sort()) walk(path.join(filename, child));
    }
  };
  walk(root);
  return result;
}

for (const operation of ['install', 'uninstall']) {
  for (const dryRun of [false, true]) {
    for (const exists of [false, true]) {
      test(`I1 ${operation}${dryRun ? ' dry-run' : ''} refuses a linked ancestor above a ${exists ? 'present' : 'missing'} target before any writes`, t => {
        const root = base(t), staging = path.join(root, 'staging'), physical = path.join(root, 'physical'), view = path.join(root, 'view');
        stage(staging, 'alpha', ALPHA_V1);
        fs.mkdirSync(physical);
        if (exists) installSkills({ staging, target: path.join(physical, 'skills'), now: NOW });
        directoryLink(physical, view);
        const target = path.join(view, 'skills'), before = installTree(root);
        assert.throws(() => operation === 'install'
          ? installSkills({ staging, target, dryRun, now: NOW })
          : uninstallSkills({ target, dryRun, purge: true, now: NOW }), /^Error: INVALID_TARGET$/);
        assert.deepEqual(installTree(root), before, 'refusal must precede lock, registry access and directory creation');
      });
    }
  }
}

if (process.platform === 'win32') {
  test('I1 extended namespace spelling cannot hide a target ancestor junction', t => {
    const root = base(t), staging = path.join(root, 'staging'), physical = path.join(root, 'physical'), view = path.join(root, 'view');
    stage(staging, 'alpha', ALPHA_V1);
    fs.mkdirSync(physical);
    directoryLink(physical, view);
    const target = path.toNamespacedPath(path.join(view, 'skills')), before = installTree(root);
    for (const dryRun of [false, true]) {
      assert.throws(() => installSkills({ staging, target, dryRun, now: NOW }), /^Error: INVALID_TARGET$/);
      assert.throws(() => uninstallSkills({ target, dryRun, now: NOW }), /^Error: INVALID_TARGET$/);
    }
    assert.deepEqual(installTree(root), before);
  });

  test('I1 plain extended namespace paths retain the normal install and uninstall lifecycle', t => {
    const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'skills');
    stage(staging, 'alpha', ALPHA_V1);
    assert.deepEqual(installSkills({ staging: path.toNamespacedPath(staging), target: path.toNamespacedPath(target), now: NOW }),
      { installed: ['alpha'], skipped: [], backedUp: [] });
    assert.deepEqual(uninstallSkills({ target, now: NOW }), { uninstalled: ['alpha'], backupsRemoved: 0 });
  });
}

for (const dryRun of [false, true]) {
  for (const linkAt of ['ancestor', 'root', 'skill', 'auxiliary']) {
    test(`I1 install${dryRun ? ' dry-run' : ''} refuses a staging ${linkAt} directory link`, t => {
      const root = base(t), physical = path.join(root, 'physical'), target = path.join(root, 'target');
      const source = path.join(physical, 'staging');
      stageMulti(source, 'alpha', ALPHA_V1, { 'sections/scope.md': SCOPE_V1 });
      let staging = source;
      if (linkAt === 'ancestor') {
        directoryLink(physical, path.join(root, 'view'));
        staging = path.join(root, 'view', 'staging');
      } else if (linkAt === 'root') {
        staging = path.join(root, 'view');
        directoryLink(source, staging);
      } else {
        const original = path.join(source, 'alpha', ...(linkAt === 'auxiliary' ? ['sections'] : []));
        const parked = path.join(root, 'parked');
        fs.renameSync(original, parked);
        directoryLink(parked, original);
      }
      const before = installTree(root);
      const code = linkAt === 'ancestor' || linkAt === 'root' ? /^Error: INVALID_STAGING$/
        : linkAt === 'skill' ? /^Error: STAGING_INVALID$/ : /^Error: TAMPERED_STAGING$/;
      assert.throws(() => installSkills({ staging, target, dryRun, now: NOW }), code);
      assert.deepEqual(installTree(root), before);
    });
  }
  for (const filename of ['manifest.json', 'SKILL.md', 'sections/scope.md']) {
    test(`I1 install${dryRun ? ' dry-run' : ''} refuses a multiply linked staging ${filename}`, t => {
      const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
      stageMulti(staging, 'alpha', ALPHA_V1, { 'sections/scope.md': SCOPE_V1 });
      fs.linkSync(path.join(staging, 'alpha', ...filename.split('/')), path.join(root, 'external-link'));
      const before = installTree(root);
      assert.throws(() => installSkills({ staging, target, dryRun, now: NOW }),
        filename.includes('/') ? /^Error: TAMPERED_STAGING$/ : /^Error: STAGING_INVALID$/);
      assert.deepEqual(installTree(root), before);
    });
  }
}

test('I1 missing target suffix previews write nothing and a real multi-file lifecycle still succeeds', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'new', 'nested', 'skills');
  stageMulti(staging, 'alpha', ALPHA_V1, { 'sections/deep/scope.md': SCOPE_V1 });
  const before = installTree(root);
  assert.deepEqual(installSkills({ staging, target, dryRun: true, now: NOW }),
    { dryRun: true, wouldInstall: ['alpha'], wouldSkip: [], wouldBackUp: [] });
  assert.deepEqual(uninstallSkills({ target, dryRun: true, now: NOW }), { dryRun: true, wouldUninstall: [], wouldPurge: [] });
  assert.deepEqual(uninstallSkills({ target, now: NOW }), { uninstalled: [], backupsRemoved: 0 });
  assert.deepEqual(installTree(root), before);
  assert.deepEqual(installSkills({ staging, target, now: NOW }), { installed: ['alpha'], skipped: [], backedUp: [] });
  assert.deepEqual(installSkills({ staging, target, now: NOW }), { installed: [], skipped: ['alpha'], backedUp: [] });
  const installed = installTree(root);
  assert.deepEqual(uninstallSkills({ target, dryRun: true, now: NOW }), { dryRun: true, wouldUninstall: ['alpha'], wouldPurge: [] });
  assert.deepEqual(installTree(root), installed);
  assert.deepEqual(uninstallSkills({ target, now: NOW }), { uninstalled: ['alpha'], backupsRemoved: 0 });
});

// Swaps happen after an observed read/create has returned, leaving a later check
// an opportunity to refuse. These fixtures do not claim final-syscall atomicity.
for (const replacement of ['junction', 'plain']) {
  for (const dryRun of [false, true]) {
    test(`I1 install${dryRun ? ' dry-run' : ''} rejects a ${replacement} target ancestor replacement observed during staging reads`, t => {
      const root = base(t), staging = path.join(root, 'staging'), parent = path.join(root, 'parent'), parked = path.join(root, 'parked');
      const foreign = path.join(root, 'foreign'), target = path.join(parent, 'skills');
      stage(staging, 'alpha', ALPHA_V1);
      fs.mkdirSync(parent); fs.mkdirSync(foreign);
      fs.writeFileSync(path.join(foreign, 'operator.txt'), 'preserve');
      const real = fs.readdirSync; let swapped = false;
      fs.readdirSync = function (filename, ...args) {
        const result = real.call(this, filename, ...args);
        if (!swapped && filename === staging) {
          swapped = true;
          fs.renameSync(parent, parked);
          if (replacement === 'junction') directoryLink(foreign, parent);
          else fs.renameSync(foreign, parent);
        }
        return result;
      };
      try {
        assert.throws(() => installSkills({ staging, target, dryRun, now: NOW }), /^Error: INVALID_TARGET$/);
      } finally { fs.readdirSync = real; }
      assert.equal(swapped, true);
      assert.deepEqual(fs.readdirSync(replacement === 'junction' ? foreign : parent), ['operator.txt']);
      assert.deepEqual(fs.readdirSync(parked), []);
    });

    test(`I1 uninstall${dryRun ? ' dry-run' : ''} rejects a ${replacement} ancestor replacement observed during ownership reads`, t => {
      const root = base(t), staging = path.join(root, 'staging'), parent = path.join(root, 'parent'), parked = path.join(root, 'parked');
      const foreign = path.join(root, 'foreign'), target = path.join(parent, 'skills');
      stage(staging, 'alpha', ALPHA_V1);
      installSkills({ staging, target, now: NOW });
      fs.cpSync(parent, foreign, { recursive: true });
      const before = installTree(foreign), real = fs.readdirSync; let swapped = false;
      fs.readdirSync = function (filename, ...args) {
        const result = real.call(this, filename, ...args);
        if (!swapped && filename === path.join(target, 'alpha')) {
          swapped = true;
          fs.renameSync(parent, parked);
          if (replacement === 'junction') directoryLink(foreign, parent);
          else fs.renameSync(foreign, parent);
        }
        return result;
      };
      try {
        assert.throws(() => uninstallSkills({ target, dryRun, now: NOW }), /^Error: INVALID_TARGET$/);
      } finally { fs.readdirSync = real; }
      assert.equal(swapped, true);
      assert.deepEqual(installTree(replacement === 'junction' ? foreign : parent), before);
      assert.equal(fs.readFileSync(path.join(parked, 'skills', 'alpha', 'SKILL.md'), 'utf8'), ALPHA_V1);
    });
  }
}

test('I1 target creation must not refresh away an existing ancestor replacement', t => {
  const root = base(t), staging = path.join(root, 'staging'), parent = path.join(root, 'parent'), target = path.join(parent, 'new', 'skills');
  stage(staging, 'alpha', ALPHA_V1);
  fs.mkdirSync(parent);
  const real = fs.mkdirSync; let swapped = false;
  fs.mkdirSync = function (filename, ...args) {
    const result = real.call(this, filename, ...args);
    if (!swapped && filename === target) {
      swapped = true;
      fs.renameSync(parent, path.join(root, 'parked'));
      real(target, { recursive: true });
      fs.writeFileSync(path.join(parent, 'operator.txt'), 'preserve');
    }
    return result;
  };
  try { assert.throws(() => installSkills({ staging, target, now: NOW }), /^Error: INVALID_TARGET$/); }
  finally { fs.mkdirSync = real; }
  assert.equal(swapped, true);
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(fs.readFileSync(path.join(parent, 'operator.txt'), 'utf8'), 'preserve');
});

test('I1 an ancestor swap after lock creation preserves the replacement lock and target', t => {
  const root = base(t), staging = path.join(root, 'staging'), parent = path.join(root, 'parent'), target = path.join(parent, 'skills');
  stage(staging, 'alpha', ALPHA_V1);
  fs.mkdirSync(target, { recursive: true });
  const real = fs.mkdirSync; let swapped = false;
  fs.mkdirSync = function (filename, ...args) {
    const result = real.call(this, filename, ...args);
    if (!swapped && filename === path.join(target, LOCK)) {
      swapped = true;
      fs.renameSync(parent, path.join(root, 'parked'));
      real(path.join(target, LOCK), { recursive: true });
      fs.writeFileSync(path.join(target, LOCK, 'operator.txt'), 'preserve');
    }
    return result;
  };
  try { assert.throws(() => installSkills({ staging, target, now: NOW }), /^Error: INVALID_TARGET$/); }
  finally { fs.mkdirSync = real; }
  assert.equal(swapped, true);
  assert.deepEqual(fs.readdirSync(target), [LOCK]);
  assert.equal(fs.readFileSync(path.join(target, LOCK, 'operator.txt'), 'utf8'), 'preserve');
});

test('I1 staging ancestor replacement during a manifest read refuses before target creation', t => {
  const root = base(t), parent = path.join(root, 'parent'), staging = path.join(parent, 'staging'), target = path.join(root, 'target');
  stage(staging, 'alpha', ALPHA_V1);
  const replacement = path.join(root, 'replacement');
  fs.cpSync(parent, replacement, { recursive: true });
  const real = fs.readFileSync; let swapped = false;
  fs.readFileSync = function (filename, ...args) {
    const result = real.call(this, filename, ...args);
    // readPlainFile uses a verified fd; the old reader uses the pathname.
    if (!swapped && (typeof filename === 'number' || filename === path.join(staging, 'alpha', 'manifest.json'))) {
      swapped = true;
      fs.renameSync(parent, path.join(root, 'parked'));
      fs.renameSync(replacement, parent);
    }
    return result;
  };
  try { assert.throws(() => installSkills({ staging, target, now: NOW }), /^Error: STAGING_INVALID$/); }
  finally { fs.readFileSync = real; }
  assert.equal(swapped, true);
  assert.equal(fs.existsSync(target), false);
});

test('I1 failed temp mkdir preserves a colliding operator directory', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  stage(staging, 'alpha', ALPHA_V1);
  const real = fs.mkdirSync; let collision;
  fs.mkdirSync = function (filename, ...args) {
    if (!collision && path.dirname(filename) === target && path.basename(filename).startsWith('.gstack861-tmp-')) {
      collision = filename;
      real(filename);
      fs.writeFileSync(path.join(filename, 'operator.txt'), 'preserve');
    }
    return real.call(this, filename, ...args);
  };
  try { assert.throws(() => installSkills({ staging, target, now: NOW }), /EEXIST/); }
  finally { fs.mkdirSync = real; }
  assert.ok(collision);
  assert.equal(fs.readFileSync(path.join(collision, 'operator.txt'), 'utf8'), 'preserve');
  assert.equal(fs.existsSync(registryFile(target)), false);
});

test('I1 failed temp write cleans only invocation-owned files and preserves an operator sibling', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  stage(staging, 'alpha', ALPHA_V1);
  const real = fs.writeFileSync; let temp;
  fs.writeFileSync = function (filename, ...args) {
    if (!temp && path.basename(filename) === 'manifest.json' && path.basename(path.dirname(filename)).startsWith('.gstack861-tmp-')) {
      temp = path.dirname(filename);
      real(path.join(temp, 'operator.txt'), 'preserve');
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    }
    return real.call(this, filename, ...args);
  };
  try { assert.throws(() => installSkills({ staging, target, now: NOW }), /EIO/); }
  finally { fs.writeFileSync = real; }
  assert.ok(temp);
  assert.deepEqual(fs.readdirSync(temp), ['operator.txt']);
  assert.equal(fs.readFileSync(path.join(temp, 'operator.txt'), 'utf8'), 'preserve');
  assert.equal(fs.existsSync(registryFile(target)), false);
});

// R2: identical inode/device does not prove that generated contents are still ours.
for (const edited of [false, true]) {
  test(`R2 manifest write failure ${edited ? 'preserves an in-place operator edit to' : 'cleans the unchanged generated'} SKILL.md`, t => {
    const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
    stage(staging, 'alpha', ALPHA_V1);
    const real = fs.writeFileSync; let temp, original;
    fs.writeFileSync = function (filename, ...args) {
      if (!temp && path.basename(filename) === 'manifest.json' && path.basename(path.dirname(filename)).startsWith('.gstack861-tmp-')) {
        temp = path.dirname(filename);
        const skill = path.join(temp, 'SKILL.md');
        original = fs.lstatSync(skill, { bigint: true });
        assert.equal(fs.readFileSync(skill, 'utf8'), ALPHA_V1, 'edit only a completed generated file');
        if (edited) {
          real(skill, 'OPERATOR DATA');
          const after = fs.lstatSync(skill, { bigint: true });
          assert.equal(after.dev, original.dev);
          assert.equal(after.ino, original.ino, 'the operator edit must preserve the generated inode');
        }
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      }
      return real.call(this, filename, ...args);
    };
    try { assert.throws(() => installSkills({ staging, target, now: NOW }), error => error.code === 'EIO'); }
    finally { fs.writeFileSync = real; }
    assert.ok(temp, 'inject at the later temporary manifest write');
    if (edited) {
      assert.equal(fs.existsSync(temp), true, 'retain the nonempty parent of operator data');
      assert.deepEqual(fs.readdirSync(temp), ['SKILL.md']);
      const skill = path.join(temp, 'SKILL.md'), after = fs.lstatSync(skill, { bigint: true });
      assert.equal(after.dev, original.dev);
      assert.equal(after.ino, original.ino);
      assert.equal(fs.readFileSync(skill, 'utf8'), 'OPERATOR DATA');
      assert.deepEqual(fs.readdirSync(target), [path.basename(temp)]);
    } else {
      assert.equal(fs.existsSync(temp), false, 'remove generated bytes and the now-empty temporary directory');
      assert.deepEqual(fs.readdirSync(target), []);
    }
    assert.equal(fs.existsSync(path.join(target, 'alpha')), false);
    assert.equal(fs.existsSync(registryFile(target)), false);
    assert.equal(fs.existsSync(path.join(target, LOCK)), false);
  });
}

test('R2 cleanup preserves a completed file when its verified contents cannot be read', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  stage(staging, 'alpha', ALPHA_V1);
  const realWrite = fs.writeFileSync, realRead = fs.readFileSync;
  let temp, original, refused = false;
  fs.writeFileSync = function (filename, ...args) {
    if (!temp && path.basename(filename) === 'manifest.json' && path.basename(path.dirname(filename)).startsWith('.gstack861-tmp-')) {
      temp = path.dirname(filename);
      original = fs.lstatSync(path.join(temp, 'SKILL.md'), { bigint: true });
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    }
    return realWrite.call(this, filename, ...args);
  };
  fs.readFileSync = function (filename, ...args) {
    if (original && typeof filename === 'number') {
      const stat = fs.fstatSync(filename, { bigint: true });
      // The Windows runner splits path/handle devices (lstat 0 vs fstat nonzero),
      // so the recorded original is identified by inode, the identity both APIs
      // preserve; the temporary directory holds exactly this one file.
      if (stat.ino === original.ino) {
        refused = true;
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
    }
    return realRead.call(this, filename, ...args);
  };
  try { assert.throws(() => installSkills({ staging, target, now: NOW }), error => error.code === 'EIO'); }
  finally { fs.writeFileSync = realWrite; fs.readFileSync = realRead; }
  assert.ok(temp);
  assert.equal(fs.existsSync(temp), true, 'unreadable ownership evidence cannot authorize deletion');
  assert.deepEqual(fs.readdirSync(temp), ['SKILL.md']);
  assert.equal(fs.readFileSync(path.join(temp, 'SKILL.md'), 'utf8'), ALPHA_V1);
  assert.equal(fs.lstatSync(path.join(temp, 'SKILL.md'), { bigint: true }).ino, original.ino);
  assert.equal(refused, true, 'cleanup must read the original file through a verified descriptor');
  assert.deepEqual(fs.readdirSync(target), [path.basename(temp)]);
  assert.equal(fs.existsSync(path.join(target, 'alpha')), false);
  assert.equal(fs.existsSync(registryFile(target)), false);
  assert.equal(fs.existsSync(path.join(target, LOCK)), false);
});

test('R2 moved file content proof rejects an in-place manifest edit at the existing install verification', t => {
  const root = base(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  stage(staging, 'alpha', ALPHA_V1);
  const dest = path.join(target, 'alpha'), real = fs.renameSync;
  let original, edited;
  fs.renameSync = function (source, filename, ...args) {
    const result = real.call(this, source, filename, ...args);
    if (!original && filename === dest && path.basename(source).startsWith('.gstack861-tmp-')) {
      const manifestFile = path.join(dest, 'manifest.json');
      original = fs.lstatSync(manifestFile, { bigint: true });
      // Keep generator and all digest fields valid: the retained exact-byte proof
      // must catch a metadata-only edit that the older ownership check accepts.
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      edited = `${JSON.stringify({ ...manifest, status: 'OPERATOR DATA' })}\n`;
      fs.writeFileSync(manifestFile, edited);
      const after = fs.lstatSync(manifestFile, { bigint: true });
      assert.equal(after.dev, original.dev);
      assert.equal(after.ino, original.ino);
    }
    return result;
  };
  try { assert.throws(() => installSkills({ staging, target, now: NOW }), /^Error: USER_FILE_REFUSED$/); }
  finally { fs.renameSync = real; }
  assert.ok(original, 'edit the manifest after the temporary directory rename');
  const manifestFile = path.join(dest, 'manifest.json'), after = fs.lstatSync(manifestFile, { bigint: true });
  assert.equal(after.dev, original.dev);
  assert.equal(after.ino, original.ino);
  assert.equal(fs.readFileSync(manifestFile, 'utf8'), edited, 'rollback must preserve the changed installed file');
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), ALPHA_V1);
  assert.deepEqual(fs.readdirSync(target), ['alpha']);
  assert.equal(fs.existsSync(registryFile(target)), false);
  assert.equal(fs.existsSync(path.join(target, LOCK)), false);
});
