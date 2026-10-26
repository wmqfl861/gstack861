import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { inventory } from './inventory.mjs';
import { textDigest } from './json.mjs';

const HOSTS = ['zcode', 'dsh'];
const GENERATOR = 'gstack861';
const GENERATOR_VERSION = '0.2.0';

// Same wrapper style as src/inventory.mjs: committed source text only, never executed.
function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 15000 });
}

function contains(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
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
    const text = git(upstream, 'show', `HEAD:${skill.source}`);
    const placeholders = [...new Set([...text.matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1]))].sort();
    const dir = path.join(staging, skill.name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), text, { flag: 'wx', mode: 0o644 });
    const manifest = {
      schemaVersion: 1, name: skill.name, host, source: skill.source, blob: skill.blob,
      sha256: textDigest(text), placeholders, indicators: skill.indicators,
      needsReview: skill.indicators.length > 0, status: 'generated-not-host-verified',
      generator: GENERATOR, generatorVersion: GENERATOR_VERSION, generatedAt: now(),
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    if (manifest.needsReview) needsReview += 1;
    skills.push({ name: skill.name, source: skill.source, blob: skill.blob, sha256: manifest.sha256, placeholders, needsReview: manifest.needsReview });
  }
  return { schemaVersion: 1, host, staging, generated: skills.length, needsReview, skills };
}
