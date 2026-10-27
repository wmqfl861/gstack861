import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { object, textDigest } from './json.mjs';

const GENERATOR = 'gstack861';
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const HOSTS = ['zcode', 'dsh'];
const REGISTRY = '.gstack861-registry.json';
const BACKUPS = '.gstack861-backups';
const LOCK = '.gstack861-install.lock';
const TMP_PREFIX = '.gstack861-tmp-';
const OUR_BACKUP = /^[a-z0-9][a-z0-9-]*-\d{13,}$/;
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
 * Mutual exclusion for every install/uninstall mutation: one writer per target, ever.
 * The lock directory is never auto-cleared — a leftover one means an operator must
 * look before removing it, mirroring the ApprovalStore.transition lock semantics.
 */
function withInstallLock(target, body) {
  const lock = path.join(target, LOCK);
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { fail('INSTALL_BUSY'); }
  try {
    return body();
  } finally {
    fs.rmdirSync(lock);
  }
}

/**
 * Validation-phase guard: anything other than a plain regular file at the registry
 * path (a directory, a symlink/reparse point) refuses the whole install before a
 * single skill byte is written — no partial installs, no silent link replacement.
 */
function assertRegistryPathSafe(target) {
  const stat = fs.lstatSync(registryFile(target), { throwIfNoEntry: false });
  if (stat && !stat.isFile()) fail('USER_FILE_REFUSED');
}

/**
 * Backups-root safety: an existing entry must be a plain directory (never a symlink
 * or junction), and once created/verified its real path must still resolve inside the
 * target so no rename can be redirected outside it.
 */
function prepareBackups(target) {
  const backupsRoot = path.join(target, BACKUPS);
  const stat = fs.lstatSync(backupsRoot, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('USER_FILE_REFUSED');
  if (!stat) fs.mkdirSync(backupsRoot, { mode: 0o755 });
  const realTarget = fs.realpathSync(target);
  const realBackups = fs.realpathSync(backupsRoot);
  if (realBackups !== realTarget && !realBackups.startsWith(`${realTarget}${path.sep}`)) fail('USER_FILE_REFUSED');
  return backupsRoot;
}

/**
 * Phase 1a — verify every staging entry (structure, manifest fields, SKILL.md digest)
 * before a single byte is written anywhere. All manifests must also describe one
 * coherent batch: a legal host and one shared host and commit, else the whole install
 * is refused with STAGING_INCONSISTENT (still zero writes — this runs first).
 * Sorted for deterministic result order.
 */
function stagingPlan(staging) {
  if (typeof staging !== 'string' || !path.isAbsolute(staging)) fail('INVALID_STAGING');
  const stat = fs.lstatSync(staging, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) fail('INVALID_STAGING');
  const entries = fs.readdirSync(staging, { withFileTypes: true }).sort((a, b) => byName({ name: a.name }, { name: b.name }));
  if (entries.length === 0) fail('NO_SKILLS');
  const plan = [];
  let batchHost, batchCommit;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail('STAGING_INVALID');
    const dir = path.join(staging, entry.name);
    // Read the manifest once: these exact bytes are both validated and later installed.
    let manifestBytes = null, manifest = null;
    try { manifestBytes = fs.readFileSync(path.join(dir, 'manifest.json')); manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { manifest = null; }
    if (!object(manifest) || manifest.schemaVersion !== 1 || manifest.generator !== GENERATOR
      || typeof manifest.sha256 !== 'string' || !SHA256.test(manifest.sha256)
      || typeof manifest.commit !== 'string' || !COMMIT.test(manifest.commit)
      || manifest.name !== entry.name || !NAME.test(entry.name)) fail('STAGING_INVALID');
    if (!HOSTS.includes(manifest.host)) fail('STAGING_INCONSISTENT');
    if (batchHost === undefined) batchHost = manifest.host;
    else if (manifest.host !== batchHost) fail('STAGING_INCONSISTENT');
    if (batchCommit === undefined) batchCommit = manifest.commit;
    else if (manifest.commit !== batchCommit) fail('STAGING_INCONSISTENT');
    const skillFile = path.join(dir, 'SKILL.md');
    const statSkill = regularFile(skillFile);
    if (!statSkill) fail('STAGING_INVALID');
    // Digest the raw Buffer: the staged copy is byte-exact, so verification must be too.
    const skillBytes = fs.readFileSync(skillFile);
    if (textDigest(skillBytes) !== manifest.sha256) fail('TAMPERED_STAGING');
    // Write exactly the bytes that were verified: no second read, no staging TOCTOU.
    plan.push({ name: entry.name, dir, sha256: manifest.sha256, skillBytes, manifestBytes });
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
function classify(plan, target, previous) {
  const recorded = new Map(previous.map(entry => [entry.name, entry.sha256]));
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
    // Same proof as uninstall: a user-edited or extended skill is never moved into purgeable backups.
    if (recorded.has(item.name)) verifyOwned(dest, recorded.get(item.name));
    item.action = manifest.sha256 === item.sha256 ? 'skip' : 'backup';
  }
}

export function installSkills({ staging, target, now = () => new Date().toISOString() }) {
  const plan = stagingPlan(staging);
  prepareTarget(target);
  return withInstallLock(target, () => {
    // Inside the lock only: clear temp entries a previously crashed run may have left
    // (build-beside-then-rename orphans). The TMP_PREFIX namespace is exclusively ours;
    // every other entry in the target is never touched by this sweep.
    for (const name of fs.readdirSync(target)) {
      if (name.startsWith(TMP_PREFIX)) fs.rmSync(path.join(target, name), { recursive: true, force: true });
    }
    assertRegistryPathSafe(target);
    // Read-modify-write inside the lock: a concurrent installer can never lose updates.
    const previous = loadRegistry(target);
    classify(plan, target, previous);
    const backupsRoot = plan.some(item => item.action === 'backup') ? prepareBackups(target) : null;
    const installed = [], skipped = [], backedUp = [];
    const merged = new Map(previous.map(entry => [entry.name, entry]));
    for (const item of plan) {
      if (item.action !== 'skip') {
        // Build the new directory completely beside the old one, then swap with renames:
        // a failure leaves either the old skill or the new one in place, never a half-written dir.
        const temp = path.join(target, `${TMP_PREFIX}${randomUUID()}`);
        try {
          fs.mkdirSync(temp, { mode: 0o755 });
          fs.writeFileSync(path.join(temp, 'SKILL.md'), item.skillBytes, { flag: 'wx', mode: 0o644 });
          fs.writeFileSync(path.join(temp, 'manifest.json'), item.manifestBytes, { flag: 'wx', mode: 0o644 });
          if (item.action === 'backup') {
            let stamp = Date.now();
            while (fs.existsSync(path.join(backupsRoot, `${item.name}-${stamp}`))) stamp += 1;
            fs.renameSync(path.join(target, item.name), path.join(backupsRoot, `${item.name}-${stamp}`));
            backedUp.push(item.name);
          }
          fs.renameSync(temp, path.join(target, item.name));
        } finally {
          fs.rmSync(temp, { recursive: true, force: true });
        }
        installed.push(item.name);
      } else skipped.push(item.name);
      // Commit each skill to the registry as soon as it is in place.
      merged.set(item.name, { name: item.name, sha256: item.sha256 });
      writeRegistry(target, [...merged.values()].sort(byName), now);
    }
    return { installed, skipped, backedUp };
  });
}

/**
 * Uninstall ownership is proven by content, not markers: a directory may only be
 * deleted when its manifest is parseable and generated by us at the registry's
 * recorded sha256, the SKILL.md bytes still hash to that same sha256, and the
 * directory holds nothing besides those two files. Any drift — a user edit, an
 * extra file, a forged registry — refuses the entire uninstall with zero deletions.
 */
function verifyOwned(dir, sha256) {
  const dirStat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!dirStat) return false; // already removed: nothing of ours is left to delete
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) fail('USER_FILE_REFUSED');
  const entries = fs.readdirSync(dir).sort();
  if (entries.length !== 2 || entries[0] !== 'SKILL.md' || entries[1] !== 'manifest.json') fail('USER_FILE_REFUSED');
  const manifest = readJson(path.join(dir, 'manifest.json'));
  if (!object(manifest) || manifest.generator !== GENERATOR || manifest.sha256 !== sha256) fail('USER_FILE_REFUSED');
  if (textDigest(fs.readFileSync(path.join(dir, 'SKILL.md'))) !== sha256) fail('USER_FILE_REFUSED');
  return true;
}

export function uninstallSkills({ target, purge = false, now = () => new Date().toISOString() }) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) fail('INVALID_TARGET');
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return { uninstalled: [], backupsRemoved: 0 };
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('INVALID_TARGET');
  return withInstallLock(target, () => {
    if (!regularFile(registryFile(target))) return { uninstalled: [], backupsRemoved: 0 };
    const recorded = new Map();
    for (const entry of loadRegistry(target)) {
      if (!recorded.has(entry.name)) recorded.set(entry.name, entry.sha256);
    }
    // Phase 1 — every registered directory must still be entirely ours before anything is deleted.
    const present = [...recorded].filter(([name, sha256]) => verifyOwned(path.join(target, name), sha256)).map(([name]) => name);
    // Phase 2 — delete, then rewrite the registry atomically.
    for (const name of present) fs.rmSync(path.join(target, name), { recursive: true });
    let backupsRemoved = 0;
    const backupsRoot = path.join(target, BACKUPS);
    if (purge) {
      const backupsStat = fs.lstatSync(backupsRoot, { throwIfNoEntry: false });
      if (backupsStat?.isDirectory() && !backupsStat.isSymbolicLink()) {
        // Only our own <name>-<13-digit-ms-timestamp> backup directories whose manifest
        // still proves our generator; user archives and tampered entries always stay,
        // uncounted — ownership for deletion is proven by content, not by name alone.
        for (const entry of fs.readdirSync(backupsRoot)) {
          if (!OUR_BACKUP.test(entry)) continue;
          const manifest = readJson(path.join(backupsRoot, entry, 'manifest.json'));
          if (!object(manifest) || manifest.generator !== GENERATOR) continue;
          fs.rmSync(path.join(backupsRoot, entry), { recursive: true });
          backupsRemoved += 1;
        }
        if (fs.readdirSync(backupsRoot).length === 0) fs.rmdirSync(backupsRoot);
      }
    }
    writeRegistry(target, [], now);
    return { uninstalled: [...recorded.keys()], backupsRemoved };
  });
}
