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
const identity = (name, stat, kind) => ({ path: name, dev: String(stat.dev), ino: String(stat.ino), kind, nlink: String(stat.nlink) });
const sameEntry = (a, b) => a.path === b.path && a.dev === b.dev && a.ino === b.ino && a.kind === b.kind
  && (a.kind !== 'file' || (a.nlink === '1' && b.nlink === '1'));

// Strict setup paths differ from policy targets: links are refused before native
// normalization. Rechecks detect observed replacements, not hostile final-syscall races.
export function inspectPlainPath(value, { kind, allowMissing = false } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) fail('ABSOLUTE_PATH_REQUIRED');
  if (!['file', 'directory'].includes(kind) || typeof allowMissing !== 'boolean') fail('PATH_UNSAFE');
  if (value.split(/[\\/]/).includes('..')) fail('PATH_UNSAFE');
  // Node lstat on an extended drive root can fail as EISDIR ('C:'). Inspect
  // its ordinary local spelling before resolving the same native identity.
  if (process.platform === 'win32' && /^\\\\\?\\[A-Za-z]:\\/.test(value)) value = value.slice(4);
  const filename = path.resolve(value), root = path.parse(filename).root;
  const parts = filename.slice(root.length).split(path.sep).filter(Boolean);
  const names = [root];
  for (const part of parts) names.push(path.join(names.at(-1), part));
  const entries = [], missing = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i], expected = i === names.length - 1 ? kind : 'directory';
    if (missing.length) { missing.push(name); continue; }
    const stat = fs.lstatSync(name, { bigint: true, throwIfNoEntry: false });
    if (!stat) {
      if (!allowMissing || i === 0) fail('PATH_UNSAFE');
      missing.push(name);
      continue;
    }
    if (stat.isSymbolicLink() || (expected === 'directory' ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) fail('PATH_UNSAFE');
    entries.push(identity(name, stat, expected));
  }
  const existing = entries.at(-1).path;
  const real = fs.realpathSync.native(existing);
  const realPath = missing.length ? path.join(real, path.relative(existing, filename)) : real;
  return freeze({ path: filename, realPath, exists: missing.length === 0, entries, missing });
}

// Missing suffixes remain absent unless the caller explicitly refreshes only that
// suffix after an expected mkdir. Directory nlink/mtime are not identity evidence.
export function assertPlainPathUnchanged(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.entries) || !Array.isArray(snapshot.missing)) fail('PATH_CHANGED');
  try {
    for (const entry of snapshot.entries) {
      const stat = fs.lstatSync(entry.path, { bigint: true });
      const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
      if (stat.isSymbolicLink() || !sameEntry(entry, identity(entry.path, stat, kind))) fail('PATH_CHANGED');
    }
    for (const name of snapshot.missing) {
      if (fs.lstatSync(name, { throwIfNoEntry: false })) fail('PATH_CHANGED');
    }
  } catch { fail('PATH_CHANGED'); }
}

export function readPlainFile(snapshot) {
  if (!snapshot?.exists || snapshot.entries?.at(-1)?.kind !== 'file') fail('PATH_UNSAFE');
  assertPlainPathUnchanged(snapshot);
  const fd = fs.openSync(snapshot.path, 'r');
  try {
    const expected = snapshot.entries.at(-1);
    const verify = () => {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isFile() || !sameEntry(expected, identity(snapshot.path, stat, 'file'))) fail('PATH_CHANGED');
    };
    verify();
    const bytes = fs.readFileSync(fd);
    verify();
    assertPlainPathUnchanged(snapshot);
    return bytes;
  } finally { fs.closeSync(fd); }
}
