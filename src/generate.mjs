import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inventory } from './inventory.mjs';
import { textDigest } from './json.mjs';

const HOSTS = ['zcode', 'dsh'];
const GENERATOR = 'gstack861';
// Single-sourced from package.json so manifests can never disagree with the release version.
const GENERATOR_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// Committed source bytes only, never executed. Buffer output (no encoding) keeps the
// staged copy byte-exact: a UTF-8 round-trip would be lossy for non-UTF-8 bytes.
function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 15000 });
}

function contains(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Git blob object id: sha1 over `blob <byteLength>\0<bytes>` — the same id
 * `git rev-parse <commit>:<path>` reports for a committed file.
 */
export function blobHash(buffer) {
  return createHash('sha1')
    .update(Buffer.from(`blob ${buffer.length}\0`, 'utf8'))
    .update(buffer)
    .digest('hex');
}

/** Stage verbatim committed skill copies; never execute upstream setup or skill code. */
export function generateSkills({ upstream, commit, staging, host, now = () => new Date().toISOString() }) {
  if (!path.isAbsolute(upstream) || !fs.statSync(upstream, { throwIfNoEntry: false })?.isDirectory()) throw new Error('INVALID_UPSTREAM');
  if (!HOSTS.includes(host)) throw new Error('INVALID_HOST');
  if (!path.isAbsolute(staging)) throw new Error('INVALID_STAGING');
  if (contains(upstream, staging) || contains(staging, upstream)) throw new Error('OVERLAPPING_PATHS');
  const existing = fs.lstatSync(staging, { throwIfNoEntry: false });
  if (existing && (!existing.isDirectory() || fs.readdirSync(staging).length > 0)) throw new Error('STAGING_NOT_EMPTY');
  // Re-run inventory ourselves: dirty trees and commit drift are refused here,
  // before any staging byte is written (inherits UPSTREAM_DIRTY / UPSTREAM_COMMIT_MISMATCH / NO_SOURCE_SKILLS).
  const inv = inventory(upstream, commit);
  if (!existing) fs.mkdirSync(staging, { recursive: true, mode: 0o755 });
  const skills = [];
  let needsReview = 0;
  for (const skill of inv.skills) {
    // Pinned read: the verified commit, not HEAD, which may drift after inventory().
    const bytes = git(upstream, 'show', `${inv.commit}:${skill.source}`);
    // Metadata only: a decoded copy feeds placeholder detection; staged bytes and digest stay raw.
    const text = bytes.toString('utf8');
    const placeholders = [...new Set([...text.matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1]))].sort();
    const dir = path.join(staging, skill.name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), bytes, { flag: 'wx', mode: 0o644 });
    // Post-write self-check: the bytes now on disk must still be exactly the committed
    // blob the manifest is about to pin; any drift aborts with BLOB_MISMATCH.
    if (blobHash(fs.readFileSync(path.join(dir, 'SKILL.md'))) !== skill.blob) throw new Error('BLOB_MISMATCH');
    const manifest = {
      schemaVersion: 1, name: skill.name, host, source: skill.source, blob: skill.blob,
      commit: inv.commit, sha256: textDigest(bytes), placeholders, indicators: skill.indicators,
      needsReview: skill.indicators.length > 0, status: 'generated-not-host-verified',
      generator: GENERATOR, generatorVersion: GENERATOR_VERSION, generatedAt: now(),
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    if (manifest.needsReview) needsReview += 1;
    skills.push({ name: skill.name, source: skill.source, blob: skill.blob, commit: manifest.commit, sha256: manifest.sha256, placeholders, needsReview: manifest.needsReview });
  }
  return { schemaVersion: 1, host, staging, generated: skills.length, needsReview, skills };
}
