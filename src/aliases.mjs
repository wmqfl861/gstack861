import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { object, textDigest } from './json.mjs';

const GENERATOR = 'gstack861';
const ALIAS = Object.freeze({ name: 'connect-chrome', canonical: 'open-gstack-browser' });
const SHA256 = /^[a-f0-9]{64}$/;
const RESERVED = new Set(['skill.md', 'manifest.json']);
const fail = code => { throw new Error(code); };
const inside = (a, b) => { const r = path.relative(a, b); return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); };
const blob = b => createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');
// Resolve the existing prefix without creating anything, as stage-render does.
// Lexical comparisons alone miss overlap through an ancestor symlink/junction.
function realOutput(value) {
  const suffix = [];
  let current = value;
  for (;;) {
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat) {
      const real = fs.realpathSync.native(current);
      if (suffix.length && !fs.statSync(real).isDirectory()) fail('INVALID_STAGING');
      return path.join(real, ...suffix);
    }
    const parent = path.dirname(current);
    if (parent === current) fail('INVALID_STAGING');
    suffix.unshift(path.basename(current)); current = parent;
  }
}
function readRegular(file) {
  const s = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!s?.isFile() || s.isSymbolicLink() || s.nlink !== 1) fail('ALIAS_SOURCE_UNSAFE');
  return fs.readFileSync(file);
}
function renameFrontmatter(bytes) {
  // Latin-1 gives a one-byte index for metadata; never decode/re-encode the body.
  const text = bytes.toString('latin1');
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) fail('ALIAS_FRONTMATTER_INVALID');
  // The pinned renderer uses plain top-level keys. Refuse ambiguous YAML key
  // forms/merges instead of letting a second identity survive the rewrite.
  if (/^(?:["'?!&*]|<<[ \t]*:)/m.test(m[1])) fail('ALIAS_FRONTMATTER_INVALID');
  const names = [...m[1].matchAll(/^name[ \t]*:[^\r\n]*/gm)];
  if (names.length !== 1 || !/^name:[ \t]*open-gstack-browser[ \t]*$/.test(names[0][0])) fail('ALIAS_CANONICAL_NAME_MISMATCH');
  const start = text.indexOf('\n') + 1 + names[0].index + names[0][0].indexOf(ALIAS.canonical);
  return Buffer.concat([bytes.subarray(0, start), Buffer.from(ALIAS.name), bytes.subarray(start + ALIAS.canonical.length)]);
}

/** Build an independently installable, rewritten copy; never symlink a duplicate skill name. */
export function stageCommandAliases({ staging, output, host }) {
  if (![staging, output].every(x => typeof x === 'string' && path.isAbsolute(x) && !/[\x00-\x1f]/.test(x))) fail('ABSOLUTE_PATH_REQUIRED');
  if (!['zcode', 'dsh'].includes(host)) fail('INVALID_HOST');
  staging = path.resolve(staging); output = path.resolve(output);
  if (inside(staging, output) || inside(output, staging)) fail('OVERLAPPING_PATHS');
  const ss = fs.lstatSync(staging, { throwIfNoEntry: false });
  if (!ss?.isDirectory() || ss.isSymbolicLink()) fail('INVALID_STAGING');
  const os = fs.lstatSync(output, { throwIfNoEntry: false });
  if (os && (!os.isDirectory() || os.isSymbolicLink() || fs.readdirSync(output).length)) fail('STAGING_NOT_EMPTY');
  const realStaging = fs.realpathSync.native(staging), resolvedOutput = realOutput(output);
  if (inside(realStaging, resolvedOutput) || inside(resolvedOutput, realStaging)) fail('OVERLAPPING_PATHS');

  const sourceDir = path.join(staging, ALIAS.canonical);
  const ds = fs.lstatSync(sourceDir, { throwIfNoEntry: false });
  if (!ds?.isDirectory() || ds.isSymbolicLink()) fail('ALIAS_SOURCE_MISSING');
  const manifestBytes = readRegular(path.join(sourceDir, 'manifest.json'));
  let source;
  try { source = JSON.parse(manifestBytes.toString('utf8')); } catch { fail('ALIAS_SOURCE_INVALID'); }
  if (!object(source) || source.schemaVersion !== 1 || source.generator !== GENERATOR
    || source.name !== ALIAS.canonical || source.host !== host
    || typeof source.commit !== 'string' || !/^[a-f0-9]{40}$/.test(source.commit)
    || typeof source.sha256 !== 'string' || !SHA256.test(source.sha256)
    || (source.files !== undefined && !object(source.files))) fail('ALIAS_SOURCE_INVALID');
  const canonicalBytes = readRegular(path.join(sourceDir, 'SKILL.md'));
  if (textDigest(canonicalBytes) !== source.sha256) fail('ALIAS_SOURCE_TAMPERED');
  const aliasBytes = renameFrontmatter(canonicalBytes);
  const aux = [];
  const nodes = new Map(), fileKeys = [];
  // Preflight the entire files map before any write. These keys must also be
  // installable on case-insensitive filesystems, including directory prefixes.
  for (const [key, expected] of Object.entries(source.files ?? {})) {
    const parts = key.split('/');
    if (parts.length > 4 || RESERVED.has(parts[0].toLowerCase())
      || parts.some(p => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p))
      || typeof expected !== 'string' || !SHA256.test(expected)) fail('ALIAS_SOURCE_INVALID');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/'), folded = prefix.toLowerCase();
      if (nodes.has(folded) && nodes.get(folded) !== prefix) fail('ALIAS_SOURCE_INVALID');
      nodes.set(folded, prefix);
    }
    const folded = key.toLowerCase();
    if (fileKeys.some(other => other === folded || other.startsWith(`${folded}/`) || folded.startsWith(`${other}/`))) fail('ALIAS_SOURCE_INVALID');
    fileKeys.push(folded);
  }
  for (const [key, expected] of Object.entries(source.files ?? {})) {
    const parts = key.split('/');
    let current = sourceDir;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const s = fs.lstatSync(current, { throwIfNoEntry: false });
      if (!s || s.isSymbolicLink() || (i < parts.length - 1 ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)) fail('ALIAS_SOURCE_UNSAFE');
    }
    const bytes = fs.readFileSync(current);
    if (textDigest(bytes) !== expected) fail('ALIAS_SOURCE_TAMPERED');
    aux.push({ key, bytes });
  }
  const files = Object.fromEntries(aux.map(x => [x.key, textDigest(x.bytes)]));
  const aliasManifest = { ...source, name: ALIAS.name, source: `alias:${ALIAS.canonical}`,
    blob: blob(aliasBytes), sha256: textDigest(aliasBytes), files, aliasOf: ALIAS.canonical,
    status: 'generated-not-host-verified' };
  if (!os) fs.mkdirSync(output, { recursive: true, mode: 0o755 });
  const dest = path.join(output, ALIAS.name);
  let created = false;
  try {
    fs.mkdirSync(dest, { mode: 0o755 }); created = true;
    fs.writeFileSync(path.join(dest, 'SKILL.md'), aliasBytes, { flag: 'wx', mode: 0o644 });
    for (const item of aux) {
      const file = path.join(dest, ...item.key.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
      fs.writeFileSync(file, item.bytes, { flag: 'wx', mode: 0o644 });
    }
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(aliasManifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
  } catch (error) {
    // Only this call's new directory is ours to remove. Never recursively delete
    // an operator-supplied output or an entry whose mkdir failed.
    if (created) { try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* preserve original failure */ } }
    if (!os) { try { fs.rmdirSync(output); } catch { /* preserve nonempty output for recovery */ } }
    throw error;
  }
  return { schemaVersion: 1, host, output, aliases: [{ name: ALIAS.name, aliasOf: ALIAS.canonical, sha256: aliasManifest.sha256 }],
    note: 'Rewritten copy, not symlink; install separately. Not host-verified.' };
}
