import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { object, textDigest } from './json.mjs';

const GENERATOR = 'gstack861';
const ALIAS = Object.freeze({ name: 'connect-chrome', canonical: 'open-gstack-browser' });
const fail = code => { throw new Error(code); };
const inside = (a, b) => { const r = path.relative(a, b); return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); };
const blob = b => createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');
function readRegular(file) {
  const s = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!s?.isFile() || s.isSymbolicLink() || s.nlink !== 1) fail('ALIAS_SOURCE_UNSAFE');
  return fs.readFileSync(file);
}
function renameFrontmatter(bytes) {
  const text = bytes.toString('utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) fail('ALIAS_FRONTMATTER_INVALID');
  const lines = m[1].split(/\r?\n/);
  const names = lines.filter(x => /^name:\s*/.test(x));
  if (names.length !== 1 || names[0].slice(5).trim() !== ALIAS.canonical) fail('ALIAS_CANONICAL_NAME_MISMATCH');
  const front = lines.map(x => /^name:\s*/.test(x) ? `name: ${ALIAS.name}` : x).join('\n');
  const end = m[0].endsWith('\n') ? 1 : 0;
  return Buffer.from(text.slice(0, m.index) + `---\n${front}\n---` + text.slice(m[0].length - end), 'utf8');
}

/** Build an independently installable, rewritten copy; never symlink a duplicate skill name. */
export function stageCommandAliases({ staging, output, host }) {
  if (![staging, output].every(x => typeof x === 'string' && path.isAbsolute(x))) fail('ABSOLUTE_PATH_REQUIRED');
  if (!['zcode', 'dsh'].includes(host)) fail('INVALID_HOST');
  staging = path.resolve(staging); output = path.resolve(output);
  if (inside(staging, output) || inside(output, staging)) fail('OVERLAPPING_PATHS');
  const ss = fs.lstatSync(staging, { throwIfNoEntry: false });
  if (!ss?.isDirectory() || ss.isSymbolicLink()) fail('INVALID_STAGING');
  const os = fs.lstatSync(output, { throwIfNoEntry: false });
  if (os && (!os.isDirectory() || os.isSymbolicLink() || fs.readdirSync(output).length)) fail('STAGING_NOT_EMPTY');

  const sourceDir = path.join(staging, ALIAS.canonical);
  const ds = fs.lstatSync(sourceDir, { throwIfNoEntry: false });
  if (!ds?.isDirectory() || ds.isSymbolicLink()) fail('ALIAS_SOURCE_MISSING');
  const manifestBytes = readRegular(path.join(sourceDir, 'manifest.json'));
  let source;
  try { source = JSON.parse(manifestBytes.toString('utf8')); } catch { fail('ALIAS_SOURCE_INVALID'); }
  if (!object(source) || source.schemaVersion !== 1 || source.generator !== GENERATOR
    || source.name !== ALIAS.canonical || source.host !== host
    || !/^[a-f0-9]{40}$/.test(source.commit) || !/^[a-f0-9]{64}$/.test(source.sha256)
    || !object(source.files ?? {})) fail('ALIAS_SOURCE_INVALID');
  const canonicalBytes = readRegular(path.join(sourceDir, 'SKILL.md'));
  if (textDigest(canonicalBytes) !== source.sha256) fail('ALIAS_SOURCE_TAMPERED');
  const aliasBytes = renameFrontmatter(canonicalBytes);
  const aux = [];
  for (const [key, expected] of Object.entries(source.files ?? {})) {
    const parts = key.split('/');
    if (parts.length > 4 || parts.some(p => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p))) fail('ALIAS_SOURCE_INVALID');
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
  try {
    const dest = path.join(output, ALIAS.name); fs.mkdirSync(dest, { mode: 0o755 });
    fs.writeFileSync(path.join(dest, 'SKILL.md'), aliasBytes, { flag: 'wx', mode: 0o644 });
    for (const item of aux) {
      const file = path.join(dest, ...item.key.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
      fs.writeFileSync(file, item.bytes, { flag: 'wx', mode: 0o644 });
    }
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(aliasManifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
  } catch (error) { fs.rmSync(output, { recursive: true, force: true }); throw error; }
  return { schemaVersion: 1, host, output, aliases: [{ name: ALIAS.name, aliasOf: ALIAS.canonical, sha256: aliasManifest.sha256 }],
    note: 'Rewritten copy, not symlink; install separately. Not host-verified.' };
}
