import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { object, textDigest } from './json.mjs';
import { inspectPlainPath, assertPlainPathUnchanged, readPlainFile } from './fs-utils.mjs';
import { inside } from './policy.mjs';

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

const noop = () => {};

function inspect(filename, kind, code, allowMissing = false, guard = noop) {
  guard();
  let snapshot;
  try { snapshot = inspectPlainPath(filename, { kind, allowMissing }); }
  catch { guard(); fail(code); }
  guard();
  return snapshot;
}

function unchanged(snapshot, code, guard = noop) {
  guard();
  try { assertPlainPathUnchanged(snapshot); }
  catch { guard(); fail(code); }
  guard();
}

function readFile(snapshot, code, guard = noop) {
  guard();
  let bytes;
  try { bytes = readPlainFile(snapshot); }
  catch { guard(); fail(code); }
  guard();
  return bytes;
}

function readJson(filename, guard = noop) {
  const bytes = readFile(inspect(filename, 'file', 'USER_FILE_REFUSED', false, guard), 'USER_FILE_REFUSED', guard);
  try { return JSON.parse(bytes.toString('utf8')); } catch { return null; }
}

const registryFile = target => path.join(target, REGISTRY);

/** Refresh an expected created suffix only after proving its original ancestors. */
function createdPath(before, kind, code, guard) {
  unchanged({ ...before, missing: [] }, code, guard);
  return inspect(before.path, kind, code, false, guard);
}

function makeDirectory(before, code, guard, recursive = false) {
  unchanged(before, code, guard);
  fs.mkdirSync(before.path, { recursive, mode: 0o755 });
  return createdPath(before, 'directory', code, guard);
}

/** A created file remains ours only while its verified bytes match our write. */
function assertCreatedContents(snapshot, guard) {
  if (!Buffer.isBuffer(snapshot.expectedBytes)
    || !readFile(snapshot, 'USER_FILE_REFUSED', guard).equals(snapshot.expectedBytes)) fail('USER_FILE_REFUSED');
}

/** Only successfully created resources with unchanged identity/content are cleanup candidates. */
function cleanCreated(resources, guard) {
  for (const snapshot of [...resources].reverse()) {
    try {
      unchanged(snapshot, 'USER_FILE_REFUSED', guard);
      if (snapshot.entries.at(-1).kind === 'file') assertCreatedContents(snapshot, guard);
    } catch { continue; } // Changed or unreadable resources remain for operator recovery.
    try {
      if (snapshot.entries.at(-1).kind === 'file') fs.unlinkSync(snapshot.path);
      else fs.rmdirSync(snapshot.path);
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    }
  }
}

function writeCreated(filename, bytes, guard, resources) {
  const before = inspect(filename, 'file', 'USER_FILE_REFUSED', true, guard);
  if (before.exists) fail('USER_FILE_REFUSED');
  unchanged(before, 'USER_FILE_REFUSED', guard);
  const expectedBytes = Buffer.from(bytes);
  fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o644 });
  resources.push({ ...createdPath(before, 'file', 'USER_FILE_REFUSED', guard), expectedBytes });
}

/** A rename keeps the original leaf identity, never a newly adopted replacement. */
function movedPath(before, filename, guard) {
  const after = inspect(filename, before.entries.at(-1).kind, 'USER_FILE_REFUSED', false, guard);
  const expected = { ...before.entries.at(-1), path: after.path };
  const moved = { ...after, entries: [...after.entries.slice(0, -1), expected] };
  unchanged(moved, 'USER_FILE_REFUSED', guard);
  return before.expectedBytes === undefined ? moved : { ...moved, expectedBytes: before.expectedBytes };
}

/** Registry writes go through tmp + rename so readers never observe a torn file. */
function writeRegistry(target, skills, now, guard, registry) {
  const filename = registryFile(target);
  const temp = path.join(target, `${REGISTRY}.${randomUUID()}.tmp`);
  const resources = [];
  try {
    const bytes = `${JSON.stringify({ schemaVersion: 1, updatedAt: now(), skills }, null, 2)}\n`;
    unchanged(registry.snapshot, 'USER_FILE_REFUSED', guard);
    writeCreated(temp, bytes, guard, resources);
    unchanged(registry.snapshot, 'USER_FILE_REFUSED', guard);
    unchanged(resources[0], 'USER_FILE_REFUSED', guard);
    fs.renameSync(temp, filename);
    registry.snapshot = movedPath(resources[0], filename, guard);
    resources.length = 0;
  } finally { cleanCreated(resources, guard); }
}

/** Parse and shape-check an existing registry; a corrupt or shadowed one is refused, never overwritten. */
export function loadRegistry(target) {
  const snapshot = validateTarget(target);
  const guard = () => unchanged(snapshot, 'INVALID_TARGET');
  return registryEntries(assertRegistryPathSafe(target, guard), guard);
}

function registryEntries(snapshot, guard) {
  if (!snapshot.exists) return [];
  const bytes = readFile(snapshot, 'USER_FILE_REFUSED', guard);
  let registry;
  try { registry = JSON.parse(bytes.toString('utf8')); } catch { fail('REGISTRY_INVALID'); }
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
function withInstallLock(target, guard, body) {
  const lock = path.join(target, LOCK);
  guard();
  try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { guard(); fail('INSTALL_BUSY'); }
  // A failed post-create identity check leaves the original lock for recovery;
  // it must never remove a lock reached through a replaced target ancestor.
  const snapshot = inspect(lock, 'directory', 'USER_FILE_REFUSED', false, guard);
  const lockedGuard = () => unchanged(snapshot, 'USER_FILE_REFUSED', guard);
  try { return body(lockedGuard); }
  finally { cleanCreated([snapshot], guard); }
}

/**
 * Validation-phase guard: anything other than a plain regular file at the registry
 * path (a directory, a symlink/reparse point) refuses the whole install before a
 * single skill byte is written — no partial installs, no silent link replacement.
 */
function assertRegistryPathSafe(target, guard) {
  return inspect(registryFile(target), 'file', 'USER_FILE_REFUSED', true, guard);
}

/** Backups use the same full-chain checks in real runs and zero-write previews. */
function checkBackupsRoot(target, guard) {
  return inspect(path.join(target, BACKUPS), 'directory', 'USER_FILE_REFUSED', true, guard);
}

function prepareBackups(target, guard) {
  const before = checkBackupsRoot(target, guard);
  const snapshot = before.exists ? before : makeDirectory(before, 'USER_FILE_REFUSED', guard);
  const targetSnapshot = inspect(target, 'directory', 'INVALID_TARGET', false, guard);
  if (!inside(targetSnapshot.realPath, snapshot.realPath)) fail('USER_FILE_REFUSED');
  return snapshot;
}

/**
 * Phase 1a — verify every staging entry (structure, manifest fields, SKILL.md and
 * listed-file digests) before a single byte is written anywhere. All manifests must
 * also describe one coherent batch: a legal host and one shared host and commit,
 * else the whole install is refused with STAGING_INCONSISTENT (still zero writes —
 * this runs first). Sorted for deterministic result order.
 */
function stagingPlan(staging, targetGuard) {
  const root = inspect(staging, 'directory', 'INVALID_STAGING', false, targetGuard);
  staging = root.path;
  const rootGuard = () => unchanged(root, 'INVALID_STAGING', targetGuard);
  rootGuard();
  const entries = fs.readdirSync(staging, { withFileTypes: true }).sort((a, b) => byName({ name: a.name }, { name: b.name }));
  rootGuard();
  if (entries.length === 0) fail('NO_SKILLS');
  const plan = [];
  let batchHost, batchCommit;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail('STAGING_INVALID');
    const dir = path.join(staging, entry.name);
    const directory = inspect(dir, 'directory', 'STAGING_INVALID', false, rootGuard);
    const sourceGuard = () => unchanged(directory, 'STAGING_INVALID', targetGuard);
    // Read verified descriptors once: these exact bytes are later installed.
    const manifestFile = inspect(path.join(dir, 'manifest.json'), 'file', 'STAGING_INVALID', false, sourceGuard);
    const manifestBytes = readFile(manifestFile, 'STAGING_INVALID', sourceGuard);
    let manifest;
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { manifest = null; }
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
    const skill = inspect(path.join(dir, 'SKILL.md'), 'file', 'STAGING_INVALID', false, sourceGuard);
    // Digest the raw Buffer: the staged copy is byte-exact, so verification must be too.
    const skillBytes = readFile(skill, 'STAGING_INVALID', sourceGuard);
    if (textDigest(skillBytes) !== manifest.sha256) fail('TAMPERED_STAGING');
    // Every listed file gets the same tamper proof: a plain regular file whose bytes
    // hash to the manifest's recorded digest; missing or mismatched is TAMPERED_STAGING.
    const filesBytes = new Map();
    if (files) {
      for (const key of Object.keys(files)) {
        const listed = inspect(path.join(dir, ...key.split('/')), 'file', 'TAMPERED_STAGING', false, sourceGuard);
        const bytes = readFile(listed, 'TAMPERED_STAGING', sourceGuard);
        if (textDigest(bytes) !== files[key]) fail('TAMPERED_STAGING');
        filesBytes.set(key, bytes);
      }
    }
    // Write exactly the bytes that were verified: no second read, no staging TOCTOU.
    plan.push({ name: entry.name, dir, sha256: manifest.sha256, skillBytes, manifestBytes, files, filesBytes });
  }
  return plan;
}

/** Full lexical ancestor validation shared by install, uninstall and dry-runs. */
function validateTarget(target) {
  return inspect(target, 'directory', 'INVALID_TARGET', true);
}

/** Node rechecks reject observed swaps, not a swap inside the final OS syscall. */
function prepareTarget(snapshot) {
  unchanged(snapshot, 'INVALID_TARGET');
  if (snapshot.exists) return snapshot;
  return makeDirectory(snapshot, 'INVALID_TARGET', noop, true);
}

/**
 * Phase 1b — resolve every target conflict before writing. An occupied name that is
 * not verifiably ours (no manifest / foreign generator / not a plain directory)
 * aborts the whole install with USER_FILE_REFUSED and zero files written.
 */
function classify(plan, target, previous, guard) {
  const recorded = new Map(previous.map(entry => [entry.name, entry]));
  for (const item of plan) {
    const dest = path.join(target, item.name);
    const snapshot = inspect(dest, 'directory', 'USER_FILE_REFUSED', true, guard);
    if (!snapshot.exists) {
      item.destination = snapshot;
      item.action = 'install';
      continue;
    }
    const manifest = readJson(path.join(dest, 'manifest.json'), guard);
    if (!object(manifest) || manifest.generator !== GENERATOR) fail('USER_FILE_REFUSED');
    // Same proof as uninstall: a user-edited or extended skill is never moved into purgeable backups.
    // Registry lost (codex audit #2): the generator tag alone must NOT authorize takeover —
    // validate the directory against the on-disk manifest's OWN claims, so a user-added
    // file refuses instead of being purged later with the backup. This holds for
    // files-bearing AND files-less manifests (round 3: a files-less claim is "nothing
    // beyond SKILL.md/manifest.json", and an extra file violates it just the same).
    // A pristine directory still takeovers (recovery path).
    const record = recorded.get(item.name);
    item.record = record ?? (object(manifest.files) ? { sha256: manifest.sha256, files: manifest.files } : { sha256: manifest.sha256 });
    item.destination = verifyOwned(dest, item.record, guard);
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
function dryRunReport(plan, target, guard) {
  guard();
  const registry = assertRegistryPathSafe(target, guard);
  const previous = registryEntries(registry, guard);
  classify(plan, target, previous, guard);
  if (plan.some(item => item.action === 'backup')) checkBackupsRoot(target, guard);
  guard();
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
  let targetSnapshot = validateTarget(target);
  target = targetSnapshot.path;
  const targetGuard = () => unchanged(targetSnapshot, 'INVALID_TARGET');
  const plan = stagingPlan(staging, targetGuard);
  if (dryRun) return dryRunReport(plan, target, targetGuard);
  targetSnapshot = prepareTarget(targetSnapshot);
  return withInstallLock(target, targetGuard, guard => {
    const registry = { snapshot: assertRegistryPathSafe(target, guard) };
    // Read-modify-write inside the lock: concurrent installers cannot lose updates.
    const previous = registryEntries(registry.snapshot, guard);
    classify(plan, target, previous, guard);
    const backups = plan.some(item => item.action === 'backup') ? prepareBackups(target, guard) : null;
    const backupGuard = () => unchanged(backups, 'USER_FILE_REFUSED', guard);
    const installed = [], skipped = [], backedUp = [];
    const merged = new Map(previous.map(entry => [entry.name, entry]));
    for (const item of plan) {
      const dest = path.join(target, item.name);
      if (item.action !== 'skip') {
        // Build beside the old directory; every cleanup entry is recorded only
        // after successful exclusive creation and a checked identity capture.
        const temp = path.join(target, `${TMP_PREFIX}${randomUUID()}`);
        const resources = [];
        let backup = null;
        try {
          const tempSnapshot = makeDirectory(inspect(temp, 'directory', 'USER_FILE_REFUSED', true, guard), 'USER_FILE_REFUSED', guard);
          resources.push(tempSnapshot);
          const tempGuard = () => unchanged(tempSnapshot, 'USER_FILE_REFUSED', guard);
          writeCreated(path.join(temp, 'SKILL.md'), item.skillBytes, tempGuard, resources);
          writeCreated(path.join(temp, 'manifest.json'), item.manifestBytes, tempGuard, resources);
          for (const [key, bytes] of item.filesBytes) {
            const listed = path.join(temp, ...key.split('/'));
            const before = inspect(path.dirname(listed), 'directory', 'USER_FILE_REFUSED', true, tempGuard);
            if (!before.exists) {
              makeDirectory(before, 'USER_FILE_REFUSED', tempGuard, true);
              for (const created of before.missing) resources.push(inspect(created, 'directory', 'USER_FILE_REFUSED', false, tempGuard));
            }
            writeCreated(listed, bytes, tempGuard, resources);
          }
          if (item.action === 'backup') {
            let stamp = Date.now(), slot;
            do { slot = inspect(path.join(backups.path, `${item.name}-${stamp++}`), 'directory', 'USER_FILE_REFUSED', true, backupGuard); }
            while (slot.exists);
            unchangedOwned(item.destination, guard);
            unchanged(slot, 'USER_FILE_REFUSED', backupGuard);
            fs.renameSync(dest, slot.path);
            backup = movedPath(item.destination, slot.path, backupGuard);
            backedUp.push(item.name);
          } else unchanged(item.destination, 'USER_FILE_REFUSED', guard);
          for (const snapshot of resources) unchanged(snapshot, 'USER_FILE_REFUSED', tempGuard);
          const absent = inspect(dest, 'directory', 'USER_FILE_REFUSED', true, guard);
          if (absent.exists) fail('USER_FILE_REFUSED');
          unchanged(absent, 'USER_FILE_REFUSED', tempGuard);
          fs.renameSync(temp, dest);
          const moved = resources.map(snapshot => movedPath(snapshot, path.join(dest, path.relative(temp, snapshot.path)), guard));
          const record = { name: item.name, sha256: item.sha256, ...(item.files ? { files: item.files } : {}) };
          const active = { ...moved[0], tree: moved, record };
          installed.push(item.name);
          merged.set(item.name, record);
          try {
            unchangedOwned(active, guard);
            writeRegistry(target, [...merged.values()].sort(byName), now, guard, registry);
          } catch (error) {
            // Delete only the still-identical installed tree. If rollback cannot
            // remove it, the backup remains the surviving original version.
            unchangedOwned(active, guard);
            fs.rmSync(dest, { recursive: true, force: true });
            merged.delete(item.name);
            installed.pop();
            throw error;
          }
        } catch (error) {
          if (backup !== null) {
            unchanged(backup, 'USER_FILE_REFUSED', backupGuard);
            const vacant = inspect(dest, 'directory', 'USER_FILE_REFUSED', true, guard);
            if (!vacant.exists) {
              unchanged(vacant, 'USER_FILE_REFUSED', backupGuard);
              fs.renameSync(backup.path, dest);
              movedPath(backup, dest, guard);
              backedUp.pop();
            }
          }
          throw error;
        } finally { cleanCreated(resources, guard); }
      } else {
        unchangedOwned(item.destination, guard);
        skipped.push(item.name);
        // Preserve existing records; registry-loss recovery can add a verified one.
        if (!merged.has(item.name)) {
          merged.set(item.name, { name: item.name, sha256: item.sha256, ...(item.files ? { files: item.files } : {}) });
        }
        writeRegistry(target, [...merged.values()].sort(byName), now, guard, registry);
      }
    }
    guard();
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
function verifyOwned(dir, record, guard = noop) {
  const directory = inspect(dir, 'directory', 'USER_FILE_REFUSED', true, guard);
  if (!directory.exists) return false; // already removed: nothing of ours is left to delete
  const directoryGuard = () => unchanged(directory, 'USER_FILE_REFUSED', guard);
  const listed = record.files ? Object.keys(record.files) : [];
  const found = [], dirs = [], snapshots = [directory];
  const walk = (rel, abs) => {
    const current = abs === dir ? directory : inspect(abs, 'directory', 'USER_FILE_REFUSED', false, directoryGuard);
    if (abs !== dir) snapshots.push(current);
    const currentGuard = () => unchanged(current, 'USER_FILE_REFUSED', directoryGuard);
    currentGuard();
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    currentGuard();
    for (const entry of entries) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) fail('USER_FILE_REFUSED');
      if (entry.isDirectory()) {
        dirs.push(child);
        walk(child, path.join(abs, entry.name));
      } else {
        found.push(child);
        snapshots.push(inspect(path.join(abs, entry.name), 'file', 'USER_FILE_REFUSED', false, currentGuard));
      }
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
  const bytes = key => {
    const snapshot = snapshots.find(item => item.path === path.join(dir, ...key.split('/')));
    return readFile(snapshot, 'USER_FILE_REFUSED', directoryGuard);
  };
  let manifest;
  try { manifest = JSON.parse(bytes('manifest.json').toString('utf8')); }
  catch (error) { directoryGuard(); if (error.message === 'USER_FILE_REFUSED') throw error; fail('USER_FILE_REFUSED'); }
  if (!object(manifest) || manifest.generator !== GENERATOR || manifest.sha256 !== record.sha256) fail('USER_FILE_REFUSED');
  if (textDigest(bytes('SKILL.md')) !== record.sha256) fail('USER_FILE_REFUSED');
  for (const key of listed) {
    if (textDigest(bytes(key)) !== record.files[key]) fail('USER_FILE_REFUSED');
  }
  for (const snapshot of snapshots) unchanged(snapshot, 'USER_FILE_REFUSED', guard);
  return { ...directory, tree: snapshots, record };
}

function unchangedOwned(owned, guard) {
  for (const snapshot of owned.tree) {
    unchanged(snapshot, 'USER_FILE_REFUSED', guard);
    if (snapshot.expectedBytes !== undefined) assertCreatedContents(snapshot, guard);
  }
  // Identity alone does not detect new siblings or in-place content edits.
  if (!verifyOwned(owned.path, owned.record, guard)) fail('USER_FILE_REFUSED');
}

/**
 * The read-only listing both purge paths share: backup entries the real purge would
 * remove — only our own <name>-<13-digit-ms-timestamp> directories whose manifest
 * still proves our generator AND exact file contents. User archives and edited entries stay,
 * uncounted — ownership for deletion is proven by content, not by name alone.
 */
function purgeableEntries(backups, guard) {
  const purgeable = [];
  const backupGuard = () => unchanged(backups, 'USER_FILE_REFUSED', guard);
  backupGuard();
  const entries = fs.readdirSync(backups.path);
  backupGuard();
  for (const entry of entries) {
    if (!OUR_BACKUP.test(entry)) continue;
    const dir = path.join(backups.path, entry);
    try {
      const manifest = readJson(path.join(dir, 'manifest.json'), backupGuard);
      if (!object(manifest) || manifest.generator !== GENERATOR || !SHA256.test(manifest.sha256 ?? '')) continue;
      if (manifest.files !== undefined && (!object(manifest.files) || Object.entries(manifest.files).some(([key, hash]) => !listedKey(key) || typeof hash !== 'string' || !SHA256.test(hash)))) continue;
      // Preserve edited/unreadable archives. A tag or timestamp is never ownership.
      const owned = verifyOwned(dir, { sha256: manifest.sha256, files: manifest.files }, backupGuard);
      if (owned) purgeable.push({ name: entry, owned });
    } catch { backupGuard(); /* changed backup: preserve it, never count it */ }
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
function uninstallDryRunReport(target, purge, guard) {
  const registry = assertRegistryPathSafe(target, guard);
  if (!registry.exists) return { dryRun: true, wouldUninstall: [], wouldPurge: [] };
  const recorded = new Map();
  for (const entry of registryEntries(registry, guard)) {
    if (!recorded.has(entry.name)) recorded.set(entry.name, entry);
  }
  for (const [name, entry] of recorded) verifyOwned(path.join(target, name), entry, guard);
  const report = { dryRun: true, wouldUninstall: [...recorded.keys()], wouldPurge: [] };
  if (purge) {
    const backups = checkBackupsRoot(target, guard);
    if (backups.exists) {
      report.wouldPurge = purgeableEntries(backups, guard).map(entry => entry.name);
      unchanged(backups, 'USER_FILE_REFUSED', guard);
      if (fs.readdirSync(backups.path).length === report.wouldPurge.length) report.wouldEmptyBackupsRoot = true;
      unchanged(backups, 'USER_FILE_REFUSED', guard);
    }
  }
  unchanged(registry, 'USER_FILE_REFUSED', guard);
  guard();
  return report;
}

export function uninstallSkills({ target, purge = false, dryRun = false, now = () => new Date().toISOString() }) {
  const snapshot = validateTarget(target);
  target = snapshot.path;
  const targetGuard = () => unchanged(snapshot, 'INVALID_TARGET');
  if (!snapshot.exists) {
    targetGuard();
    return dryRun ? { dryRun: true, wouldUninstall: [], wouldPurge: [] } : { uninstalled: [], backupsRemoved: 0 };
  }
  if (dryRun) return uninstallDryRunReport(target, purge, targetGuard);
  return withInstallLock(target, targetGuard, guard => {
    const registry = { snapshot: assertRegistryPathSafe(target, guard) };
    if (!registry.snapshot.exists) return { uninstalled: [], backupsRemoved: 0 };
    const recorded = new Map();
    for (const entry of registryEntries(registry.snapshot, guard)) {
      if (!recorded.has(entry.name)) recorded.set(entry.name, entry);
    }
    // Validate the entire batch before deletions, then compare saved identities
    // again at each mutation. A fresh scan never authorizes a replacement tree.
    const present = [];
    for (const [name, entry] of recorded) {
      const owned = verifyOwned(path.join(target, name), entry, guard);
      if (owned) present.push(owned);
    }
    const backups = purge ? checkBackupsRoot(target, guard) : null;
    const archives = backups?.exists ? purgeableEntries(backups, guard) : [];
    const backupGuard = () => unchanged(backups, 'USER_FILE_REFUSED', guard);
    for (const owned of present) {
      unchanged(registry.snapshot, 'USER_FILE_REFUSED', guard);
      unchangedOwned(owned, guard);
      fs.rmSync(owned.path, { recursive: true });
    }
    let backupsRemoved = 0;
    if (backups?.exists) {
      for (const entry of archives) {
        unchangedOwned(entry.owned, backupGuard);
        fs.rmSync(entry.owned.path, { recursive: true });
        backupsRemoved += 1;
      }
      backupGuard();
      if (fs.readdirSync(backups.path).length === 0) {
        backupGuard();
        fs.rmdirSync(backups.path);
      }
    }
    writeRegistry(target, [], now, guard, registry);
    return { uninstalled: [...recorded.keys()], backupsRemoved };
  });
}
