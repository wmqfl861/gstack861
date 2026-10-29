import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { object, textDigest } from './json.mjs';

const GENERATOR = 'gstack861';
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_FILES = new Set(['skill.md', 'manifest.json']);
const HOSTS = ['zcode', 'dsh'];
const REGISTRY = '.gstack861-registry.json';
const BACKUPS = '.gstack861-backups';
const LOCK = '.gstack861-install.lock';
const TMP_PREFIX = '.gstack861-tmp-';
const OUR_BACKUP = /^[a-z0-9][a-z0-9-]*-\d{13,}$/;
const fail = code => { throw new Error(code); };
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * A listed-file key from the optional manifest/registry `files` map: a relative
 * POSIX sub-path whose every segment is `[A-Za-z0-9][A-Za-z0-9._-]*`, at most 4
 * segments deep, and never a reserved top-level name in any case. The segment
 * alphabet alone rejects `..` segments, absolute paths, backslashes and empty
 * segments; `__proto__`-style keys cannot pass either (must start alphanumeric).
 */
function listedKey(key) {
  if (typeof key !== 'string') return false;
  const segments = key.split('/');
  if (segments.length > 4 || RESERVED_FILES.has(key.toLowerCase())) return false;
  return segments.every(segment => FILE_SEGMENT.test(segment));
}

/** Key set + digest equality of two optional files maps (both normalized: empty means absent). */
const filesEqual = (a, b) => {
  const ka = a ? Object.keys(a) : [], kb = b ? Object.keys(b) : [];
  return ka.length === kb.length && ka.every(k => a[k] === b[k]);
};

function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { return null; }
}

const registryFile = target => path.join(target, REGISTRY);

/** Only a plain regular file counts; anything else at these reserved names is refused. */
function regularFile(filename) {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  return stat?.isFile() ? stat : null;
}

/** A staging leaf is trusted only when ALL ancestors beneath the skill directory
 * are plain directories. lstat on the leaf alone follows parent symlinks/junctions. */
function stagingFile(dir, key) {
  const parts = key.split('/');
  let current = dir;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) return null;
    if (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) return null;
  }
  return current;
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
export function loadRegistry(target) {
  if (!regularFile(registryFile(target))) return [];
  const registry = readJson(registryFile(target));
  if (!object(registry) || registry.schemaVersion !== 1 || !Array.isArray(registry.skills)) fail('REGISTRY_INVALID');
  return registry.skills.map(entry => {
    if (!object(entry) || typeof entry.name !== 'string' || !NAME.test(entry.name)
      || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) fail('REGISTRY_INVALID');
    let files;
    if (entry.files !== undefined) {
      if (!object(entry.files)) fail('REGISTRY_INVALID');
      // listedKey-only by design: registry files maps can only originate from staging-validated manifests.
      for (const [key, value] of Object.entries(entry.files)) {
        if (!listedKey(key) || typeof value !== 'string' || !SHA256.test(value)) fail('REGISTRY_INVALID');
      }
      if (Object.keys(entry.files).length > 0) files = { ...entry.files };
    }
    return files ? { name: entry.name, sha256: entry.sha256, files } : { name: entry.name, sha256: entry.sha256 };
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
 * Backups-root refusal check, shared by install and its dry-run: an existing entry
 * must be a plain directory — never a symlink or junction. Creation is not its business.
 */
function checkBackupsRoot(target) {
  const stat = fs.lstatSync(path.join(target, BACKUPS), { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('USER_FILE_REFUSED');
  return stat;
}

/**
 * Backups-root safety: the refusal check above, creation when absent (0755), and a
 * final containment proof — once created/verified its real path must still resolve
 * inside the target so no rename can be redirected outside it.
 */
function prepareBackups(target) {
  const backupsRoot = path.join(target, BACKUPS);
  if (!checkBackupsRoot(target)) fs.mkdirSync(backupsRoot, { mode: 0o755 });
  const realTarget = fs.realpathSync(target);
  const realBackups = fs.realpathSync(backupsRoot);
  if (realBackups !== realTarget && !realBackups.startsWith(`${realTarget}${path.sep}`)) fail('USER_FILE_REFUSED');
  return backupsRoot;
}

/**
 * Phase 1a — verify every staging entry (structure, manifest fields, SKILL.md and
 * listed-file digests) before a single byte is written anywhere. All manifests must
 * also describe one coherent batch: a legal host and one shared host and commit,
 * else the whole install is refused with STAGING_INCONSISTENT (still zero writes —
 * this runs first). Sorted for deterministic result order.
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
    if (!stagingFile(dir, 'manifest.json')) fail('STAGING_INVALID');
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
    // The optional files map (auxiliary files like sections/scope.md) is shape-checked
    // here: a malformed map is a malformed manifest. An empty map means "no files".
    if (manifest.files !== undefined) {
      if (!object(manifest.files)) fail('STAGING_INVALID');
      for (const [key, value] of Object.entries(manifest.files)) {
        if (!listedKey(key) || typeof value !== 'string' || !SHA256.test(value)) fail('STAGING_INVALID');
      }
      // Cross-key collision pre-validation: two distinct keys of ONE files map that
      // meet after toLowerCase() — either exactly, or where one is a whole-segment
      // directory prefix of the other (key + '/', never a bare startsWith: a.md and
      // a.md2 coexist) — would write two files onto one path on case-insensitive
      // targets and shadow each other on case-sensitive ones. O(n²) over a small map.
      const lowered = Object.keys(manifest.files).map(key => key.toLowerCase());
      for (let i = 0; i < lowered.length; i++) {
        for (let j = i + 1; j < lowered.length; j++) {
          if (lowered[i] === lowered[j] || lowered[i].startsWith(`${lowered[j]}/`) || lowered[j].startsWith(`${lowered[i]}/`)) fail('STAGING_INVALID');
        }
      }
    }
    const files = manifest.files !== undefined && Object.keys(manifest.files).length > 0 ? { ...manifest.files } : undefined;
    const skillFile = path.join(dir, 'SKILL.md');
    const statSkill = stagingFile(dir, 'SKILL.md');
    if (!statSkill) fail('STAGING_INVALID');
    // Digest the raw Buffer: the staged copy is byte-exact, so verification must be too.
    const skillBytes = fs.readFileSync(skillFile);
    if (textDigest(skillBytes) !== manifest.sha256) fail('TAMPERED_STAGING');
    // Every listed file gets the same tamper proof: a plain regular file whose bytes
    // hash to the manifest's recorded digest; missing or mismatched is TAMPERED_STAGING.
    const filesBytes = new Map();
    if (files) {
      for (const key of Object.keys(files)) {
        const listed = path.join(dir, ...key.split('/'));
        if (!stagingFile(dir, key)) fail('TAMPERED_STAGING');
        const bytes = fs.readFileSync(listed);
        if (textDigest(bytes) !== files[key]) fail('TAMPERED_STAGING');
        filesBytes.set(key, bytes);
      }
    }
    // Write exactly the bytes that were verified: no second read, no staging TOCTOU.
    plan.push({ name: entry.name, dir, sha256: manifest.sha256, skillBytes, manifestBytes, files, filesBytes });
  }
  return plan;
}

/** Target-path validation shared by install and its dry-run: an existing target must be a plain directory (never a symlink or junction). Returns null when absent. */
function validateTarget(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) fail('INVALID_TARGET');
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('INVALID_TARGET');
  return stat ?? null;
}

/** Create the target when absent (0755); an existing target must be a plain directory. */
function prepareTarget(target) {
  if (!validateTarget(target)) fs.mkdirSync(target, { recursive: true, mode: 0o755 });
}

/**
 * Phase 1b — resolve every target conflict before writing. An occupied name that is
 * not verifiably ours (no manifest / foreign generator / not a plain directory)
 * aborts the whole install with USER_FILE_REFUSED and zero files written.
 */
function classify(plan, target, previous) {
  const recorded = new Map(previous.map(entry => [entry.name, entry]));
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
    // Registry lost (codex audit #2): the generator tag alone must NOT authorize takeover —
    // validate the directory against the on-disk manifest's OWN claims, so a user-added
    // file refuses instead of being purged later with the backup. This holds for
    // files-bearing AND files-less manifests (round 3: a files-less claim is "nothing
    // beyond SKILL.md/manifest.json", and an extra file violates it just the same).
    // A pristine directory still takeovers (recovery path).
    const record = recorded.get(item.name);
    if (record) verifyOwned(dest, record);
    else verifyOwned(dest, object(manifest.files) ? { sha256: manifest.sha256, files: manifest.files } : { sha256: manifest.sha256 });
    // Files-aware skip: an identical SKILL.md digest alone is not enough — the staged
    // files map (key set + digests) must also agree with the registry record (or,
    // without one, with the on-disk manifest's own map). Any disagreement routes to
    // backup-and-replace so a re-render never leaves stale files under a stale record.
    const known = record ? record.files : (object(manifest.files) ? manifest.files : undefined);
    item.action = manifest.sha256 === item.sha256 && filesEqual(known, item.files) ? 'skip' : 'backup';
  }
}

/**
 * The dry-run report: the read-only half of installSkills' validation chain. stagingPlan
 * has already run; here the target is validated without being created, the registry path
 * and registry are read, conflicts are classified, and a pending backup re-runs the
 * backups-root refusal check without creating the root. Every refusal still throws — a
 * dry-run never swallows them — and structurally nothing is written at all. The report
 * takes no install lock, so it never fails with INSTALL_BUSY and may read a registry
 * that a concurrent install is about to change (the report can be stale by design).
 */
function dryRunReport(plan, target) {
  validateTarget(target);
  assertRegistryPathSafe(target);
  const previous = loadRegistry(target);
  classify(plan, target, previous);
  if (plan.some(item => item.action === 'backup')) checkBackupsRoot(target);
  const wouldInstall = [], wouldSkip = [], wouldBackUp = [];
  for (const item of plan) {
    if (item.action === 'skip') wouldSkip.push(item.name);
    else {
      wouldInstall.push(item.name);
      if (item.action === 'backup') wouldBackUp.push(item.name);
    }
  }
  return { dryRun: true, wouldInstall, wouldSkip, wouldBackUp };
}

export function installSkills({ staging, target, now = () => new Date().toISOString(), dryRun = false }) {
  const plan = stagingPlan(staging);
  if (dryRun) return dryRunReport(plan, target);
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
        // Rollback state (codex audit #3): once the old directory has been moved into the
        // backups root, ANY later failure in this block (new-dir rename, registry commit)
        // restores it, so the documented backup-rollback claim holds under fault injection.
        let backupPath = null;
        try {
          fs.mkdirSync(temp, { mode: 0o755 });
          fs.writeFileSync(path.join(temp, 'SKILL.md'), item.skillBytes, { flag: 'wx', mode: 0o644 });
          fs.writeFileSync(path.join(temp, 'manifest.json'), item.manifestBytes, { flag: 'wx', mode: 0o644 });
          // Listed files land in freshly created subdirectories (0755) as plain wx files (0644).
          for (const [key, bytes] of item.filesBytes) {
            const listed = path.join(temp, ...key.split('/'));
            fs.mkdirSync(path.dirname(listed), { recursive: true, mode: 0o755 });
            fs.writeFileSync(listed, bytes, { flag: 'wx', mode: 0o644 });
          }
          if (item.action === 'backup') {
            let stamp = Date.now();
            while (fs.existsSync(path.join(backupsRoot, `${item.name}-${stamp}`))) stamp += 1;
            backupPath = path.join(backupsRoot, `${item.name}-${stamp}`);
            fs.renameSync(path.join(target, item.name), backupPath);
            backedUp.push(item.name);
          }
          fs.renameSync(temp, path.join(target, item.name));
          installed.push(item.name);
          // The registry entry carries the files map exactly when the manifest listed files.
          const entry = { name: item.name, sha256: item.sha256 };
          if (item.files) entry.files = item.files;
          merged.set(item.name, entry);
          // Commit each skill to the registry as soon as it is in place — a failure here
          // rolls the directory back too (registry and disk never disagree at rest).
          try {
            writeRegistry(target, [...merged.values()].sort(byName), now);
          } catch (error) {
            fs.rmSync(path.join(target, item.name), { recursive: true, force: true });
            merged.delete(item.name);
            installed.pop();
            throw error;
          }
        } catch (error) {
          // Restore the pre-install state: old dir back in place, no backup entry left.
          // Round 3 (audit #15): when the active directory could NOT be removed (e.g.
          // the new dir survived a failed registry-commit rollback), "target exists" is
          // NOT evidence the old version is in place — the backup may be the ONLY
          // surviving old copy, so it is kept, never deleted, in that state.
          if (backupPath !== null && fs.existsSync(backupPath) && !fs.existsSync(path.join(target, item.name))) {
            fs.renameSync(backupPath, path.join(target, item.name));
            backedUp.pop();
          }
          throw error;
        } finally {
          fs.rmSync(temp, { recursive: true, force: true });
        }
      } else {
        skipped.push(item.name);
        // A skipped skill keeps its recorded entry byte-for-byte; only an unrecorded
        // one (e.g. after the registry was lost) is newly committed to the registry.
        if (!merged.has(item.name)) {
          const entry = { name: item.name, sha256: item.sha256 };
          if (item.files) entry.files = item.files;
          merged.set(item.name, entry);
        }
        writeRegistry(target, [...merged.values()].sort(byName), now);
      }
    }
    return { installed, skipped, backedUp };
  });
}

/**
 * Uninstall ownership and classify drift share one proof, anchored entirely on the
 * REGISTRY record — never the target's own manifest. A recursive walk of the
 * directory must find exactly SKILL.md, manifest.json and the record's listed files
 * (path separators normalized to '/'), with every subdirectory on a listed file's
 * path; the manifest and SKILL.md bytes must still match the recorded sha256 and
 * every listed file must still hash to its recorded digest. A record without files
 * facing extra files on disk (or the reverse) is a trust-anchor disagreement and
 * refuses: a forged in-dir manifest must never nominate files for deletion. Any
 * drift — a user edit, an extra or missing file, a forged registry — refuses the
 * whole operation with zero deletions; only an already-absent directory returns false.
 */
function verifyOwned(dir, record) {
  const dirStat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!dirStat) return false; // already removed: nothing of ours is left to delete
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) fail('USER_FILE_REFUSED');
  const listed = record.files ? Object.keys(record.files) : [];
  const found = [], dirs = [];
  const walk = (rel, abs) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) fail('USER_FILE_REFUSED');
      if (entry.isDirectory()) {
        dirs.push(child);
        walk(child, path.join(abs, entry.name));
      } else found.push(child);
    }
  };
  walk('', dir);
  const expected = new Set(['SKILL.md', 'manifest.json', ...listed]);
  if (found.length !== expected.size || found.some(file => !expected.has(file))) fail('USER_FILE_REFUSED');
  // Cumulative prefixes of every listed file path (codex audit #4): `sections/deep/x.md`
  // allows BOTH `sections` and `sections/deep` — the walker reports accumulated relative
  // directories, so a single-segment set made legal multi-segment files un-reinstallable.
  const onPath = new Set();
  for (const key of listed) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i += 1) onPath.add(parts.slice(0, i).join('/'));
  }
  if (dirs.some(dir => !onPath.has(dir))) fail('USER_FILE_REFUSED'); // no empty or stray subdirectories
  const manifest = readJson(path.join(dir, 'manifest.json'));
  if (!object(manifest) || manifest.generator !== GENERATOR || manifest.sha256 !== record.sha256) fail('USER_FILE_REFUSED');
  if (textDigest(fs.readFileSync(path.join(dir, 'SKILL.md'))) !== record.sha256) fail('USER_FILE_REFUSED');
  for (const key of listed) {
    if (textDigest(fs.readFileSync(path.join(dir, ...key.split('/')))) !== record.files[key]) fail('USER_FILE_REFUSED');
  }
  return true;
}

/**
 * The read-only listing both purge paths share: backup entries the real purge would
 * remove — only our own <name>-<13-digit-ms-timestamp> directories whose manifest
 * still proves our generator AND exact file contents. User archives and edited entries stay,
 * uncounted — ownership for deletion is proven by content, not by name alone.
 */
function purgeableEntries(backupsRoot) {
  const purgeable = [];
  for (const entry of fs.readdirSync(backupsRoot)) {
    if (!OUR_BACKUP.test(entry)) continue;
    const dir = path.join(backupsRoot, entry);
    try {
      if (!stagingFile(dir, 'manifest.json')) continue;
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const manifest = readJson(path.join(dir, 'manifest.json'));
      if (!object(manifest) || manifest.generator !== GENERATOR || !SHA256.test(manifest.sha256 ?? '')) continue;
      if (manifest.files !== undefined && (!object(manifest.files) || Object.entries(manifest.files).some(([key, hash]) => !listedKey(key) || typeof hash !== 'string' || !SHA256.test(hash)))) continue;
      // Backups can be edited after creation. A generator tag authorizes neither
      // deleting added notes nor removing modified skills or auxiliary files.
      if (verifyOwned(dir, { sha256: manifest.sha256, files: manifest.files })) purgeable.push(entry);
    } catch { /* unreadable or changed backup: preserve it, never count it as purgeable */ }
  }
  return purgeable;
}

/**
 * The dry-run report: the read-only half of uninstallSkills' chain, inserted after
 * the target validation and pointedly before the install lock. It mirrors the real
 * sequence — registry presence, load + dedupe, phase-1 verifyOwned over every record
 * (drift still refuses; an already-absent directory just verifies false and still
 * counts, exactly like the real return) — then lists what a real run would remove
 * instead of removing it, and with purge also lists the backup entries the real
 * purge would delete and whether the backups root would then be rmdir'd empty. No
 * lock is taken, so a live or stale one never fails the report with INSTALL_BUSY,
 * and the report may describe a registry a concurrent writer is about to change
 * (stale by design, like install's dry-run).
 */
function uninstallDryRunReport(target, purge) {
  if (!regularFile(registryFile(target))) return { dryRun: true, wouldUninstall: [], wouldPurge: [] };
  const recorded = new Map();
  for (const entry of loadRegistry(target)) {
    if (!recorded.has(entry.name)) recorded.set(entry.name, entry);
  }
  for (const [name, entry] of recorded) verifyOwned(path.join(target, name), entry);
  const report = { dryRun: true, wouldUninstall: [...recorded.keys()], wouldPurge: [] };
  if (purge) {
    const backupsRoot = path.join(target, BACKUPS);
    const backupsStat = fs.lstatSync(backupsRoot, { throwIfNoEntry: false });
    if (backupsStat?.isDirectory() && !backupsStat.isSymbolicLink()) {
      report.wouldPurge = purgeableEntries(backupsRoot);
      // The real purge rmdir's the root exactly when nothing would remain in it.
      if (fs.readdirSync(backupsRoot).length === report.wouldPurge.length) report.wouldEmptyBackupsRoot = true;
    }
  }
  return report;
}

export function uninstallSkills({ target, purge = false, dryRun = false, now = () => new Date().toISOString() }) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) fail('INVALID_TARGET');
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return dryRun ? { dryRun: true, wouldUninstall: [], wouldPurge: [] } : { uninstalled: [], backupsRemoved: 0 };
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('INVALID_TARGET');
  if (dryRun) return uninstallDryRunReport(target, purge);
  return withInstallLock(target, () => {
    if (!regularFile(registryFile(target))) return { uninstalled: [], backupsRemoved: 0 };
    const recorded = new Map();
    for (const entry of loadRegistry(target)) {
      if (!recorded.has(entry.name)) recorded.set(entry.name, entry);
    }
    // Phase 1 — every registered directory must still be entirely ours before anything is deleted.
    const present = [...recorded].filter(([name, entry]) => verifyOwned(path.join(target, name), entry)).map(([name]) => name);
    // Phase 2 — delete, then rewrite the registry atomically.
    for (const name of present) fs.rmSync(path.join(target, name), { recursive: true });
    let backupsRemoved = 0;
    const backupsRoot = path.join(target, BACKUPS);
    if (purge) {
      const backupsStat = fs.lstatSync(backupsRoot, { throwIfNoEntry: false });
      if (backupsStat?.isDirectory() && !backupsStat.isSymbolicLink()) {
        for (const entry of purgeableEntries(backupsRoot)) {
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
