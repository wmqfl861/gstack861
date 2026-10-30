// fs-utils — filesystem helpers shared by the redact/sealed ports
// (batch 23, Lane A).
//
// Upstream lineage: gstack lib/fs-utils.ts (27 lines, the whole file is
// mkdirpSync) at pinned submodule commit
// 5755601dac5d35ebd7dde181fdefe52a023c73d9. Ported verbatim; consumers in
// upstream are bin/gstack-redact install-prepush-hook and friends (the
// Lane B/C binaries import it from here).
//
// Divergence ledger (bun/TS → node ESM):
//   1. TypeScript erased: the `void` return and the
//      `(e as NodeJS.ErrnoException | null)` cast become plain JSDoc;
//      the `?.code` optional chain is kept verbatim. Nothing else changes.

import { mkdirSync, statSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { freeze } from './json.mjs';

/**
 * mkdir -p that tolerates the target directory already existing.
 *
 * Node's mkdirSync(dir, { recursive: true }) is a no-op when dir already
 * exists, but bun on Windows throws EEXIST in the same situation (#2635),
 * which crashed `gstack-redact install-prepush-hook` on any repo whose
 * .git/hooks already existed. Swallow EEXIST only when statSync confirms the
 * path is an existing directory; anything else - a regular file occupying the
 * path, a stat failure, a different errno - rethrows the original error, so a
 * real collision still fails loudly.
 *
 * @param {string} dir
 * @returns {void}
 */
export function mkdirpSync(dir) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    if (e?.code === 'EEXIST') {
      try {
        if (statSync(dir).isDirectory()) return;
      } catch {
        // stat failed - fall through and rethrow the original mkdir error
      }
    }
    throw e;
  }
}

const fail = code => { throw new Error(code); };
const statKind = stat => stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
const descriptorIdentity = stat => ({ dev: String(stat.dev), ino: String(stat.ino), kind: statKind(stat), nlink: String(stat.nlink) });
const identity = (name, stat) => ({ path: name, ...descriptorIdentity(stat) });
const validIdentity = entry => !!entry && ['file', 'directory'].includes(entry.kind)
  && ['dev', 'ino', 'nlink'].every(key => typeof entry[key] === 'string' && /^(0|[1-9][0-9]*)$/.test(entry[key]));
const sameNode = (a, b) => validIdentity(a) && validIdentity(b) && a.ino === b.ino && a.kind === b.kind
  && (a.kind !== 'file' || (a.nlink === '1' && b.nlink === '1'));
const sameIdentity = (a, b) => sameNode(a, b) && a.dev === b.dev;
const sameEntry = (a, b) => a.path === b.path && sameIdentity(a, b);
const needsDescriptor = entry => process.platform === 'win32' && entry.dev === '0';
const readonlyFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

// Paths may be rebased after an owned rename. Neither that nor directory child
// creation may discard the saved descriptor proof or normalize device bits.
export function samePlainIdentity(a, b) {
  if (!sameIdentity(a, b)) return false;
  if (!a.descriptor && !b.descriptor) return !needsDescriptor(a);
  return sameNode(a, a.descriptor) && sameNode(b, b.descriptor) && sameIdentity(a.descriptor, b.descriptor);
}

// Only path-to-fd binding has the Windows 64/32-bit API exception. Zero-device
// paths instead require the exact independent descriptor saved at capture.
function pathBindsDescriptor(entry, descriptor) {
  if (!sameNode(entry, descriptor)) return false;
  if (needsDescriptor(entry)) return sameIdentity(entry.descriptor, descriptor);
  return entry.dev === descriptor.dev || (process.platform === 'win32' && entry.dev !== '0'
    && BigInt.asUintN(32, BigInt(entry.dev)) === BigInt(descriptor.dev));
}

function plainLstat(name, options, code) {
  try { return fs.lstatSync(name, options); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') fail(code);
    throw error;
  }
}

function assertPathEntry(entry, code = 'PATH_CHANGED') {
  if (!validIdentity(entry) || typeof entry.path !== 'string') fail(code);
  const stat = plainLstat(entry.path, { bigint: true, throwIfNoEntry: false }, code);
  if (!stat || stat.isSymbolicLink() || !sameEntry(entry, identity(entry.path, stat))) fail(code);
}

function assertPathEntries(snapshot, code = 'PATH_CHANGED') {
  if (!snapshot || !Array.isArray(snapshot.entries) || !snapshot.entries.length || !Array.isArray(snapshot.missing)) fail(code);
  for (const entry of snapshot.entries) assertPathEntry(entry, code);
  for (const name of snapshot.missing) {
    if (typeof name !== 'string' || plainLstat(name, { throwIfNoEntry: false }, code)) fail(code);
  }
}

// The sweep's full original chain brackets these entry-local checks. Directory
// handles remain required; no failed open or unstable proof has a fallback.
function independentDescriptor(entry, capture = false) {
  const code = capture ? 'PATH_UNSAFE' : 'PATH_CHANGED';
  let fd, failed = false;
  try {
    assertPathEntry(entry);
    fd = fs.openSync(entry.path, readonlyFlags);
    const before = descriptorIdentity(fs.fstatSync(fd, { bigint: true }));
    if (!sameNode(entry, before) || (!capture && !sameIdentity(entry.descriptor, before))) fail(code);
    assertPathEntry(entry);
    const after = descriptorIdentity(fs.fstatSync(fd, { bigint: true }));
    if (!sameIdentity(before, after) || (!capture && !sameIdentity(entry.descriptor, after))) fail(code);
    return before;
  } catch {
    failed = true;
    fail(code);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); }
      catch { if (!failed) fail(code); }
    }
  }
}

function fileDescriptorIdentity(fd) {
  try { return descriptorIdentity(fs.fstatSync(fd, { bigint: true })); }
  catch { fail('PATH_CHANGED'); }
}

// Strict setup paths differ from policy targets: links are refused before native
// normalization. Rechecks detect observed replacements, not hostile final-syscall races.
export function inspectPlainPath(value, { kind, allowMissing = false } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) fail('ABSOLUTE_PATH_REQUIRED');
  if (!['file', 'directory'].includes(kind) || typeof allowMissing !== 'boolean') fail('PATH_UNSAFE');
  if (value.split(/[\\/]/).includes('..')) fail('PATH_UNSAFE');
  // Node lstat on an extended drive root can fail as EISDIR ('C:'). Inspect
  // its ordinary local spelling before resolving the same native identity.
  if (process.platform === 'win32' && /^\\\\\?\\[A-Za-z]:\\/.test(value)) value = value.slice(4);
  try {
    const filename = path.resolve(value), root = path.parse(filename).root;
    const parts = filename.slice(root.length).split(path.sep).filter(Boolean);
    const names = [root];
    for (const part of parts) names.push(path.join(names.at(-1), part));
    const entries = [], missing = [];
    for (let i = 0; i < names.length; i++) {
      const name = names[i], expected = i === names.length - 1 ? kind : 'directory';
      if (missing.length) { missing.push(name); continue; }
      const stat = plainLstat(name, { bigint: true, throwIfNoEntry: false }, 'PATH_UNSAFE');
      if (!stat) {
        if (!allowMissing || i === 0) fail('PATH_UNSAFE');
        missing.push(name);
        continue;
      }
      if (stat.isSymbolicLink() || (expected === 'directory' ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) fail('PATH_UNSAFE');
      entries.push(identity(name, stat));
    }
    const snapshot = { path: filename, entries, missing };
    const witnesses = entries.filter(needsDescriptor);
    if (witnesses.length) {
      assertPathEntries(snapshot, 'PATH_UNSAFE');
      for (const entry of witnesses) entry.descriptor = independentDescriptor(entry, true);
      assertPathEntries(snapshot, 'PATH_UNSAFE');
    }
    const existing = entries.at(-1).path;
    const real = fs.realpathSync.native(existing);
    const realPath = missing.length ? path.join(real, path.relative(existing, filename)) : real;
    // Recheck the original entries, including every saved ancestor witness,
    // after all capture opens and native path resolution have completed.
    if (witnesses.length) assertPlainPathUnchanged(snapshot);
    return freeze({ path: filename, realPath, exists: missing.length === 0, entries, missing });
  } catch (error) {
    if (error?.code) throw error;
    fail('PATH_UNSAFE');
  }
}

// Missing suffixes remain absent unless the caller explicitly refreshes only that
// suffix after an expected mkdir. Directory nlink/mtime are not identity evidence.
export function assertPlainPathUnchanged(snapshot) {
  assertPathEntries(snapshot);
  for (const entry of snapshot.entries) {
    if (needsDescriptor(entry) || entry.descriptor) independentDescriptor(entry);
  }
  assertPathEntries(snapshot);
}

// The fd belongs to the caller, including after refusal. Temporary pathname
// witnesses belong to this helper and always close in independentDescriptor.
export function assertPlainFileDescriptor(snapshot, fd) {
  if (!snapshot?.exists || snapshot.entries?.at(-1)?.kind !== 'file') fail('PATH_UNSAFE');
  assertPlainPathUnchanged(snapshot);
  const entry = snapshot.entries.at(-1);
  if (entry.path !== snapshot.path || snapshot.missing.length) fail('PATH_CHANGED');
  const before = fileDescriptorIdentity(fd);
  if (!pathBindsDescriptor(entry, before)) fail('PATH_CHANGED');
  if (needsDescriptor(entry) && !sameIdentity(before, independentDescriptor(entry))) fail('PATH_CHANGED');
  assertPlainPathUnchanged(snapshot);
  const after = fileDescriptorIdentity(fd);
  if (!sameIdentity(before, after) || !pathBindsDescriptor(entry, after)) fail('PATH_CHANGED');
}

export function readPlainFile(snapshot) {
  if (!snapshot?.exists || snapshot.entries?.at(-1)?.kind !== 'file') fail('PATH_UNSAFE');
  assertPlainPathUnchanged(snapshot);
  let fd, failed = false;
  try {
    try { fd = fs.openSync(snapshot.path, readonlyFlags); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error?.code)) fail('PATH_CHANGED');
      throw error;
    }
    assertPlainFileDescriptor(snapshot, fd);
    const before = fileDescriptorIdentity(fd);
    const bytes = fs.readFileSync(fd);
    assertPlainFileDescriptor(snapshot, fd);
    if (!sameIdentity(before, fileDescriptorIdentity(fd))) fail('PATH_CHANGED');
    assertPlainPathUnchanged(snapshot);
    return bytes;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); }
      catch (error) { if (!failed) throw error; }
    }
  }
}
