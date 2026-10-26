import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { object, textDigest } from './json.mjs';

const GENERATOR = 'gstack861';
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const REGISTRY = '.gstack861-registry.json';
const BACKUPS = '.gstack861-backups';
const fail = code => { throw new Error(code); };
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { return null; }
}

const registryFile = target => path.join(target, REGISTRY);

/** Only a plain regular file counts; anything else at these reserved names is refused. */
function regularFile(filename) {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  return stat?.isFile() ? stat : null;
}

/** Registry writes go through tmp + rename so readers never observe a torn file. */
function writeRegistry(target, skills, now) {
  const filename = path.join(target, REGISTRY);
  const temp = path.join(target, `${REGISTRY}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ schemaVersion: 1, updatedAt: now(), skills }, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    fs.renameSync(temp, filename);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

/** Parse and shape-check an existing registry; a corrupt or shadowed one is refused, never overwritten. */
function loadRegistry(target) {
  if (!regularFile(registryFile(target))) return [];
  const registry = readJson(registryFile(target));
  if (!object(registry) || registry.schemaVersion !== 1 || !Array.isArray(registry.skills)) fail('REGISTRY_INVALID');
  return registry.skills.map(entry => {
    if (!object(entry) || typeof entry.name !== 'string' || !NAME.test(entry.name)
      || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) fail('REGISTRY_INVALID');
    return { name: entry.name, sha256: entry.sha256 };
  });
}

/**
 * Phase 1a — verify every staging entry (structure, manifest fields, SKILL.md digest)
 * before a single byte is written anywhere. Sorted for deterministic result order.
 */
function stagingPlan(staging) {
  if (typeof staging !== 'string' || !path.isAbsolute(staging)) fail('INVALID_STAGING');
  const stat = fs.lstatSync(staging, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) fail('INVALID_STAGING');
  const entries = fs.readdirSync(staging, { withFileTypes: true }).sort((a, b) => byName({ name: a.name }, { name: b.name }));
  if (entries.length === 0) fail('NO_SKILLS');
  const plan = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail('STAGING_INVALID');
    const dir = path.join(staging, entry.name);
    const manifest = readJson(path.join(dir, 'manifest.json'));
    if (!object(manifest) || manifest.schemaVersion !== 1 || manifest.generator !== GENERATOR
      || typeof manifest.sha256 !== 'string' || !SHA256.test(manifest.sha256)
      || typeof manifest.commit !== 'string' || !COMMIT.test(manifest.commit)
      || manifest.name !== entry.name || !NAME.test(entry.name)) fail('STAGING_INVALID');
    const skillFile = path.join(dir, 'SKILL.md');
    const statSkill = regularFile(skillFile);
    if (!statSkill) fail('STAGING_INVALID');
    // Digest the raw Buffer: the staged copy is byte-exact, so verification must be too.
    if (textDigest(fs.readFileSync(skillFile)) !== manifest.sha256) fail('TAMPERED_STAGING');
    plan.push({ name: entry.name, dir, sha256: manifest.sha256 });
  }
  return plan;
}

/** Create the target when absent (0755); an existing target must be a plain directory. */
function prepareTarget(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) fail('INVALID_TARGET');
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) {
    fs.mkdirSync(target, { recursive: true, mode: 0o755 });
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('INVALID_TARGET');
}

/**
 * Phase 1b — resolve every target conflict before writing. An occupied name that is
 * not verifiably ours (no manifest / foreign generator / not a plain directory)
 * aborts the whole install with USER_FILE_REFUSED and zero files written.
 */
function classify(plan, target) {
  for (const item of plan) {
    const dest = path.join(target, item.name);
    const stat = fs.lstatSync(dest, { throwIfNoEntry: false });
    if (!stat) {
      item.action = 'install';
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('USER_FILE_REFUSED');
    const manifest = readJson(path.join(dest, 'manifest.json'));
    if (!object(manifest) || manifest.generator !== GENERATOR) fail('USER_FILE_REFUSED');
    item.action = manifest.sha256 === item.sha256 ? 'skip' : 'backup';
  }
}

export function installSkills({ staging, target, now = () => new Date().toISOString() }) {
  const plan = stagingPlan(staging);
  prepareTarget(target);
  const previous = loadRegistry(target);
  classify(plan, target);
  const installed = [], skipped = [], backedUp = [];
  const backupsRoot = path.join(target, BACKUPS);
  for (const item of plan) {
    if (item.action === 'skip') {
      skipped.push(item.name);
      continue;
    }
    if (item.action === 'backup') {
      fs.mkdirSync(backupsRoot, { recursive: true, mode: 0o755 });
      let stamp = Date.now();
      while (fs.existsSync(path.join(backupsRoot, `${item.name}-${stamp}`))) stamp += 1;
      fs.renameSync(path.join(target, item.name), path.join(backupsRoot, `${item.name}-${stamp}`));
      backedUp.push(item.name);
    }
    const dir = path.join(target, item.name);
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), fs.readFileSync(path.join(item.dir, 'SKILL.md')), { flag: 'wx', mode: 0o644 });
    fs.writeFileSync(path.join(dir, 'manifest.json'), fs.readFileSync(path.join(item.dir, 'manifest.json')), { flag: 'wx', mode: 0o644 });
    installed.push(item.name);
  }
  // Registry holds one entry per skill at its current sha256; this batch replaces older entries.
  const merged = new Map(previous.map(entry => [entry.name, entry]));
  for (const item of plan) merged.set(item.name, { name: item.name, sha256: item.sha256 });
  writeRegistry(target, [...merged.values()].sort(byName), now);
  return { installed, skipped, backedUp };
}

export function uninstallSkills({ target, purge = false, now = () => new Date().toISOString() }) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) fail('INVALID_TARGET');
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return { uninstalled: [], backupsRemoved: 0 };
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('INVALID_TARGET');
  if (!regularFile(registryFile(target))) return { uninstalled: [], backupsRemoved: 0 };
  const names = [];
  for (const entry of loadRegistry(target)) {
    if (!names.includes(entry.name)) names.push(entry.name);
  }
  // Phase 1 — every registered directory must be verifiably ours before anything is deleted.
  for (const name of names) {
    const dir = path.join(target, name);
    const dirStat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!dirStat || !dirStat.isDirectory() || dirStat.isSymbolicLink()) fail('USER_FILE_REFUSED');
    const manifest = readJson(path.join(dir, 'manifest.json'));
    if (!object(manifest) || manifest.generator !== GENERATOR) fail('USER_FILE_REFUSED');
  }
  // Phase 2 — delete, then rewrite the registry atomically.
  for (const name of names) fs.rmSync(path.join(target, name), { recursive: true });
  let backupsRemoved = 0;
  const backupsRoot = path.join(target, BACKUPS);
  if (purge) {
    const backupsStat = fs.lstatSync(backupsRoot, { throwIfNoEntry: false });
    if (backupsStat?.isDirectory() && !backupsStat.isSymbolicLink()) {
      backupsRemoved = fs.readdirSync(backupsRoot).length;
      fs.rmSync(backupsRoot, { recursive: true });
    }
  }
  writeRegistry(target, [], now);
  return { uninstalled: names, backupsRemoved };
}
