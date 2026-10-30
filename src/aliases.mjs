import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { object, textDigest } from './json.mjs';
import { inside } from './policy.mjs';
import { inspectPlainPath, assertPlainPathUnchanged, readPlainFile } from './fs-utils.mjs';

const GENERATOR = 'gstack861';
const ALIAS = Object.freeze({ name: 'connect-chrome', canonical: 'open-gstack-browser' });
const SHA256 = /^[a-f0-9]{64}$/;
const RESERVED = new Set(['skill.md', 'manifest.json']);
const fail = code => { throw new Error(code); };
const blob = b => createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');
function inspect(file, kind, code, allowMissing = false) {
  try { return inspectPlainPath(file, { kind, allowMissing }); } catch { fail(code); }
}
function unchanged(snapshot, code) {
  try { assertPlainPathUnchanged(snapshot); } catch { fail(code); }
}
function readRegular(file, snapshots) {
  const snapshot = inspect(file, 'file', 'ALIAS_SOURCE_UNSAFE');
  let bytes;
  try { bytes = readPlainFile(snapshot); } catch { fail('ALIAS_SOURCE_UNSAFE'); }
  snapshots.push(snapshot);
  return bytes;
}

// Validate the complete map before reading any listed file or creating output.
// Top-level reserved prefixes also collide with SKILL.md/manifest.json files.
function listedFiles(source) {
  if (source.files === undefined) return [];
  if (!object(source.files)) fail('ALIAS_SOURCE_INVALID');
  const entries = Object.entries(source.files), lowered = [];
  for (const [key, hash] of entries) {
    const parts = key.split('/');
    if (parts.length > 4 || parts.some(p => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p))
      || RESERVED.has(parts[0].toLowerCase()) || typeof hash !== 'string' || !SHA256.test(hash)) fail('ALIAS_SOURCE_INVALID');
    const folded = key.toLowerCase();
    if (lowered.some(other => folded === other || folded.startsWith(`${other}/`) || other.startsWith(`${folded}/`))) fail('ALIAS_SOURCE_INVALID');
    lowered.push(folded);
  }
  return entries;
}
function renameFrontmatter(bytes) {
  // Latin-1 supplies one character per byte: splice the ASCII name token without
  // a UTF-8 round trip or rebuilding frontmatter line endings/whitespace.
  const text = bytes.toString('latin1');
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) fail('ALIAS_FRONTMATTER_INVALID');
  const names = [...m[1].matchAll(/^name:([^\r\n]*)\r?$/gm)];
  if (names.length !== 1 || names[0][1].trim() !== ALIAS.canonical) fail('ALIAS_CANONICAL_NAME_MISMATCH');
  const offset = text.indexOf('\n') + 1 + names[0].index + 5 + names[0][1].indexOf(ALIAS.canonical);
  return Buffer.concat([bytes.subarray(0, offset), Buffer.from(ALIAS.name), bytes.subarray(offset + ALIAS.canonical.length)]);
}

// Rebase only an expected created suffix, after checking the original existing
// ancestors. Directory nlink/mtime are deliberately not identity evidence.
function createdSuffix(previous) {
  unchanged({ ...previous, missing: [] }, 'STAGING_NOT_EMPTY');
  return inspect(previous.path, 'directory', 'STAGING_NOT_EMPTY');
}
function cleanup(files, directories) {
  for (const item of [...files].reverse()) {
    try {
      assertPlainPathUnchanged(item.snapshot);
      const bytes = readPlainFile(item.snapshot);
      // Same-inode user edits must survive too, not just replaced files.
      if (textDigest(bytes) !== item.sha256) continue;
      assertPlainPathUnchanged(item.snapshot);
      fs.unlinkSync(item.snapshot.path);
    } catch { /* changed/unowned/unremovable entries stay; preserve original error */ }
  }
  for (const snapshot of [...directories].reverse()) {
    try {
      assertPlainPathUnchanged(snapshot);
      // Never recurse: concurrent foreign files, even inside our alias, survive.
      fs.rmdirSync(snapshot.path);
    } catch { /* an occupied or replaced directory is no longer ours to remove */ }
  }
}

/** Build an independently installable, rewritten copy; never symlink a duplicate skill name. */
export function stageCommandAliases({ staging, output, host }) {
  if (![staging, output].every(x => typeof x === 'string' && path.isAbsolute(x))) fail('ABSOLUTE_PATH_REQUIRED');
  if (!['zcode', 'dsh'].includes(host)) fail('INVALID_HOST');
  const stagingSnapshot = inspect(staging, 'directory', 'INVALID_STAGING');
  let outputSnapshot = inspect(output, 'directory', 'STAGING_NOT_EMPTY', true);
  staging = stagingSnapshot.path; output = outputSnapshot.path;
  if (inside(stagingSnapshot.realPath, outputSnapshot.realPath) || inside(outputSnapshot.realPath, stagingSnapshot.realPath)) fail('OVERLAPPING_PATHS');
  if (outputSnapshot.exists && fs.readdirSync(output).length) fail('STAGING_NOT_EMPTY');

  const sourceDir = path.join(staging, ALIAS.canonical);
  const sourceSnapshot = inspect(sourceDir, 'directory', 'ALIAS_SOURCE_UNSAFE', true);
  if (!sourceSnapshot.exists) fail('ALIAS_SOURCE_MISSING');
  const sources = [stagingSnapshot, sourceSnapshot];
  const manifestBytes = readRegular(path.join(sourceDir, 'manifest.json'), sources);
  let source;
  try { source = JSON.parse(manifestBytes.toString('utf8')); } catch { fail('ALIAS_SOURCE_INVALID'); }
  if (!object(source) || source.schemaVersion !== 1 || source.generator !== GENERATOR
    || source.name !== ALIAS.canonical || source.host !== host
    || typeof source.commit !== 'string' || !/^[a-f0-9]{40}$/.test(source.commit)
    || typeof source.sha256 !== 'string' || !SHA256.test(source.sha256)) fail('ALIAS_SOURCE_INVALID');
  const listed = listedFiles(source);
  const canonicalBytes = readRegular(path.join(sourceDir, 'SKILL.md'), sources);
  if (textDigest(canonicalBytes) !== source.sha256) fail('ALIAS_SOURCE_TAMPERED');
  const aliasBytes = renameFrontmatter(canonicalBytes);
  const aux = [];
  for (const [key, expected] of listed) {
    const bytes = readRegular(path.join(sourceDir, ...key.split('/')), sources);
    if (textDigest(bytes) !== expected) fail('ALIAS_SOURCE_TAMPERED');
    aux.push({ key, bytes });
  }
  const files = Object.fromEntries(aux.map(x => [x.key, textDigest(x.bytes)]));
  const aliasManifest = { ...source, name: ALIAS.name, source: `alias:${ALIAS.canonical}`,
    blob: blob(aliasBytes), sha256: textDigest(aliasBytes), files, aliasOf: ALIAS.canonical,
    status: 'generated-not-host-verified' };
  for (const snapshot of sources) unchanged(snapshot, 'ALIAS_SOURCE_UNSAFE');
  unchanged(outputSnapshot, 'STAGING_NOT_EMPTY');

  const createdFiles = [], createdDirectories = [];
  const checkDirectories = () => {
    unchanged(outputSnapshot, 'STAGING_NOT_EMPTY');
    for (const snapshot of createdDirectories) unchanged(snapshot, 'STAGING_NOT_EMPTY');
  };
  const mkdir = previous => {
    for (const snapshot of createdDirectories) unchanged(snapshot, 'STAGING_NOT_EMPTY');
    unchanged(previous, 'STAGING_NOT_EMPTY');
    fs.mkdirSync(previous.path, { mode: 0o755 });
    const snapshot = createdSuffix(previous);
    createdDirectories.push(snapshot);
    return snapshot;
  };
  const write = (filename, bytes) => {
    checkDirectories();
    const previous = inspect(filename, 'file', 'STAGING_NOT_EMPTY', true);
    if (previous.exists) fail('STAGING_NOT_EMPTY');
    unchanged(previous, 'STAGING_NOT_EMPTY');
    // Open wx separately so even a partial write is bound to our created fd and
    // cleanup never adopts an EEXIST collision owned by another writer.
    const fd = fs.openSync(filename, 'wx', 0o644);
    let snapshot;
    try {
      unchanged({ ...previous, missing: [] }, 'STAGING_NOT_EMPTY');
      snapshot = inspect(filename, 'file', 'STAGING_NOT_EMPTY');
      const actual = fs.fstatSync(fd, { bigint: true }), expected = snapshot.entries.at(-1);
      if (!actual.isFile() || actual.nlink !== 1n || String(actual.dev) !== expected.dev || String(actual.ino) !== expected.ino) fail('STAGING_NOT_EMPTY');
      fs.writeFileSync(fd, bytes);
      unchanged(snapshot, 'STAGING_NOT_EMPTY');
      createdFiles.push({ snapshot, sha256: textDigest(bytes) });
    } catch (error) {
      if (snapshot) {
        try {
          const actual = fs.fstatSync(fd, { bigint: true }), expected = snapshot.entries.at(-1);
          if (actual.isFile() && actual.nlink === 1n && String(actual.dev) === expected.dev && String(actual.ino) === expected.ino) {
            unchanged(snapshot, 'STAGING_NOT_EMPTY');
            const partial = readPlainFile(snapshot);
            // Only our expected prefix is attributable to a partial write;
            // never adopt arbitrary bytes another writer put into the file.
            if (partial.length <= bytes.length && partial.equals(bytes.subarray(0, partial.length))) {
              createdFiles.push({ snapshot, sha256: textDigest(partial) });
            }
          }
        } catch { /* failed identity proof leaves the file for explicit recovery */ }
      }
      throw error;
    } finally { fs.closeSync(fd); }
  };
  try {
    if (!outputSnapshot.exists) {
      // Create every missing directory individually so each mkdir is anchored to
      // the original identities and cleanup owns only successful creations.
      for (const directory of outputSnapshot.missing) {
        unchanged({ ...outputSnapshot, missing: [] }, 'STAGING_NOT_EMPTY');
        mkdir(inspect(directory, 'directory', 'STAGING_NOT_EMPTY', true));
      }
      outputSnapshot = createdSuffix(outputSnapshot);
    }
    checkDirectories();
    if (fs.readdirSync(output).length) fail('STAGING_NOT_EMPTY');
    const dest = path.join(output, ALIAS.name);
    mkdir(inspect(dest, 'directory', 'STAGING_NOT_EMPTY', true));
    write(path.join(dest, 'SKILL.md'), aliasBytes);
    for (const item of aux) {
      checkDirectories();
      const parts = item.key.split('/');
      let parent = dest;
      for (const part of parts.slice(0, -1)) {
        parent = path.join(parent, part);
        const snapshot = inspect(parent, 'directory', 'STAGING_NOT_EMPTY', true);
        if (!snapshot.exists) mkdir(snapshot);
        else {
          const entry = snapshot.entries.at(-1);
          const ours = createdDirectories.find(directory => {
            const known = directory.entries.at(-1);
            return known.dev === entry.dev && known.ino === entry.ino && known.kind === entry.kind;
          });
          if (!ours) fail('STAGING_NOT_EMPTY');
          unchanged(ours, 'STAGING_NOT_EMPTY');
        }
      }
      write(path.join(dest, ...parts), item.bytes);
    }
    write(path.join(dest, 'manifest.json'), Buffer.from(JSON.stringify(aliasManifest, null, 2) + '\n'));
    checkDirectories();
    for (const item of createdFiles) {
      let bytes;
      try { bytes = readPlainFile(item.snapshot); } catch { fail('STAGING_NOT_EMPTY'); }
      if (textDigest(bytes) !== item.sha256) fail('STAGING_NOT_EMPTY');
    }
  } catch (error) { cleanup(createdFiles, createdDirectories); throw error; }
  return { schemaVersion: 1, host, output, aliases: [{ name: ALIAS.name, aliasOf: ALIAS.canonical, sha256: aliasManifest.sha256 }],
    note: 'Rewritten copy, not symlink; install separately. Not host-verified.' };
}
