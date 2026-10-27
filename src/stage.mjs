import fs from 'node:fs';
import path from 'node:path';
import { object, textDigest } from './json.mjs';
import { blobHash } from './generate.mjs';

const HOSTS = ['zcode', 'dsh'];
const GENERATOR = 'gstack861';
// Single-sourced from package.json so manifests can never disagree with the release version.
const GENERATOR_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const SHA256 = /^[a-f0-9]{64}$/;
// Same grammar installSkills enforces on staging dir names: staged dirs must be
// consumable by the existing install chain without a second translation.
const NAME = /^[a-z0-9][a-z0-9-]*$/;
// Per-segment grammar for files keys (mirrors the install-side rules): no `..`,
// no separators, no leading punctuation, bounded depth. Reserved output names
// are never valid keys — case-insensitively, so a render tree cannot smuggle
// in a second "skill.md" that would collide on case-insensitive filesystems.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_DEPTH = 4;
const RESERVED = new Set(['skill.md', 'manifest.json']);
const fail = code => { throw new Error(code); };
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function contains(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Inventory name -> rendered dir, mirroring the upstream renderer exactly
// (scripts/render-upstream.mjs, gen-skill-docs.ts): already-prefixed names pass
// through (`gstack-upgrade` renders as dir `gstack-upgrade`), everything else
// gets `gstack-` prepended. Forward mapping only — de-prefixing rendered dir
// names would corrupt the set comparison for passthrough skills.
export function renderedDir(name) {
  return name.startsWith('gstack-') ? name : `gstack-${name}`;
}

// Lock pin by default; GSTACK861_TEST_COMMIT overrides for fixtures only and
// announces itself on stderr exactly like the generate CLI path (validated
// first: a malformed override never announces anything).
function resolveCommit(env = process.env) {
  const override = env.GSTACK861_TEST_COMMIT;
  const commit = override ?? JSON.parse(fs.readFileSync(new URL('../upstream.lock.json', import.meta.url), 'utf8')).gstack.commit;
  if (!/^[a-f0-9]{40}$/.test(commit)) fail('FULL_COMMIT_REQUIRED');
  if (override !== undefined) process.stderr.write(`gstack861: TEST_COMMIT_OVERRIDE active (${commit.slice(0, 12)})\n`);
  return commit;
}

function assertSubPath(segments) {
  if (segments.length > MAX_DEPTH) fail('RENDER_TREE_INVALID');
  for (const segment of segments) {
    if (segment === '..' || !SEGMENT.test(segment) || RESERVED.has(segment.toLowerCase())) fail('RENDER_TREE_INVALID');
  }
}

/**
 * Recursive auxiliary-file walk of one rendered skill dir: everything except
 * the top-level SKILL.md, as POSIX relative sub-paths. Refuses empty
 * subdirectories (the renderer never emits them), non-regular entries and any
 * path outside the files-key grammar. Sorted for deterministic manifest order.
 */
function walkAux(dir, prefix = []) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => byString(a.name, b.name));
  for (const entry of entries) {
    if (prefix.length === 0 && entry.name === 'SKILL.md') continue; // the skill body itself
    const segments = [...prefix, entry.name];
    if (entry.isDirectory()) {
      const nested = walkAux(path.join(dir, entry.name), segments);
      if (nested.length === 0) fail('RENDER_TREE_INVALID'); // empty subdir = torn or hand-edited tree
      files.push(...nested);
      continue;
    }
    if (!entry.isFile()) fail('RENDER_TREE_INVALID'); // symlinks and specials never stage
    assertSubPath(segments);
    files.push({ rel: segments.join('/'), bytes: fs.readFileSync(path.join(dir, entry.name)) });
  }
  return files;
}

/**
 * Read and fully verify one rendered skill dir against its expected SKILL.md
 * digest: byte-exact sha256, AUTO-GENERATED banner, zero unresolved
 * placeholders, then the recursive auxiliary walk. Pure read — no staging byte
 * is written until every dir has passed this.
 */
function readRenderedSkill(skillsRoot, dirName, name, expectedSha256) {
  const skillFile = path.join(skillsRoot, dirName, 'SKILL.md');
  const stat = fs.lstatSync(skillFile, { throwIfNoEntry: false });
  if (!stat?.isFile()) fail('RENDER_TREE_INVALID');
  const bytes = fs.readFileSync(skillFile);
  if (textDigest(bytes) !== expectedSha256) fail('RENDER_TREE_INVALID');
  const text = bytes.toString('utf8'); // metadata checks only; staged bytes stay raw
  if (!text.includes('AUTO-GENERATED')) fail('RENDER_TREE_INVALID');
  if (/\{\{[^}]*\}\}/.test(text)) fail('RENDER_TREE_INVALID');
  const aux = walkAux(path.join(skillsRoot, dirName));
  const files = {};
  for (const { rel, bytes: fileBytes } of aux) files[rel] = textDigest(fileBytes);
  return { name, bytes, sha256: expectedSha256, files, aux };
}

/**
 * Convert a CI render output tree plus its render-manifest into a staging dir
 * the existing installSkills consumes. Every refusal below is decided before
 * a single staging byte is written; staged skill dirs land under their
 * inventory names (the root router included, as `gstack`).
 */
export function stageRender({ rendered, manifestFile, host, staging, now = () => new Date().toISOString() }) {
  if (!HOSTS.includes(host)) fail('INVALID_HOST');
  if (typeof rendered !== 'string' || !path.isAbsolute(rendered)) fail('INVALID_RENDERED');
  const renderedStat = fs.lstatSync(rendered, { throwIfNoEntry: false });
  if (!renderedStat?.isDirectory()) fail('INVALID_RENDERED');
  if (typeof staging !== 'string' || !path.isAbsolute(staging)) fail('INVALID_STAGING');
  if (contains(rendered, staging) || contains(staging, rendered)) fail('OVERLAPPING_PATHS');
  // Render manifest: any read or parse problem is the same refusal.
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { manifest = null; }
  if (!object(manifest) || manifest.schemaVersion !== 1 || manifest.host !== host) fail('RENDER_MANIFEST_INVALID');
  if (!object(manifest.skills)) fail('RENDER_MANIFEST_INVALID');
  const names = Object.keys(manifest.skills);
  if (names.length === 0) fail('RENDER_MANIFEST_INVALID');
  for (const name of names) {
    // `gstack` is the reserved root router name; anything install cannot address
    // as a staging dir name is refused here rather than staged unusably.
    if (!NAME.test(name) || name === 'gstack') fail('RENDER_MANIFEST_INVALID');
    if (typeof manifest.skills[name] !== 'string' || !SHA256.test(manifest.skills[name])) fail('RENDER_MANIFEST_INVALID');
  }
  if (!object(manifest.root) || Object.keys(manifest.root).sort().join(',') !== 'path,sha256'
    || manifest.root.path !== 'gstack/SKILL.md' || !SHA256.test(manifest.root.sha256)) fail('RENDER_MANIFEST_INVALID');
  const expectedDirs = names.map(renderedDir);
  if (new Set(expectedDirs).size !== names.length) fail('RENDER_MANIFEST_INVALID'); // two names, one rendered dir
  // Staging: same convention as generate — absolute, and either absent or empty.
  const existing = fs.lstatSync(staging, { throwIfNoEntry: false });
  if (existing && (!existing.isDirectory() || fs.readdirSync(staging).length > 0)) fail('STAGING_NOT_EMPTY');
  // Tree scan: set equality in RENDERED-DIR space (forward mapping only, above).
  // Anything that is not a plain directory at the skills root fails the same check.
  const skillsRoot = path.join(rendered, `.${host}`, 'skills');
  let entries;
  try { entries = fs.readdirSync(skillsRoot, { withFileTypes: true }); }
  catch { fail('RENDER_TREE_INVALID'); }
  const treeDirs = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory()) fail('RENDER_TREE_INVALID'); // stray file or symlink at the skills root
    treeDirs.add(entry.name);
  }
  const expected = new Set(expectedDirs);
  const missing = [...expected].filter(dir => !treeDirs.has(dir));
  const extra = [...treeDirs].filter(dir => !expected.has(dir) && dir !== 'gstack');
  if (!treeDirs.has('gstack') || missing.length > 0 || extra.length > 0) fail('RENDER_TREE_INVALID');
  // FULL validation of every skill and the root before the write phase starts.
  const plan = names.slice().sort(byString).map(name => readRenderedSkill(skillsRoot, renderedDir(name), name, manifest.skills[name]));
  const rootSkill = readRenderedSkill(skillsRoot, 'gstack', 'gstack', manifest.root.sha256);
  const commit = resolveCommit();
  // Write phase: bytes verbatim, wx everywhere, manifests last per skill dir.
  if (!existing) fs.mkdirSync(staging, { recursive: true, mode: 0o755 });
  const stagedSkills = [...plan, rootSkill].sort((a, b) => byString(a.name, b.name));
  for (const skill of stagedSkills) {
    const dir = path.join(staging, skill.name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), skill.bytes, { flag: 'wx', mode: 0o644 });
    for (const { rel, bytes } of skill.aux) {
      const target = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 });
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({
      schemaVersion: 1, name: skill.name, host, source: `render:.${host}`, blob: blobHash(skill.bytes),
      sha256: skill.sha256, commit, files: skill.files, placeholders: [], indicators: [], needsReview: false,
      status: 'rendered-experimental', generator: GENERATOR, generatorVersion: GENERATOR_VERSION, generatedAt: now(),
    }, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  }
  return {
    schemaVersion: 1, host, staging,
    staged: plan.length, // manifest skills; the root router is reported separately
    files: stagedSkills.reduce((sum, skill) => sum + skill.aux.length, 0),
    root: { name: 'gstack', sha256: manifest.root.sha256, files: rootSkill.aux.length },
  };
}
