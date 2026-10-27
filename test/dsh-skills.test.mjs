import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installSkills } from '../src/install.mjs';
import { textDigest } from '../src/json.mjs';
import * as plugin from '../src/adapters/dsh-skills.mjs';

const { apply } = plugin;
const WHEN = '2026-10-27T00:00:00.000Z';
const NOW = () => WHEN;
const REGISTRY = '.gstack861-registry.json';
// Both frontmatter forms the index must handle: with and without a description line.
const ALPHA_BODY = '---\nname: alpha\ndescription: Run the review workflow before merging.\n---\n\nalpha skill body\n';
const ALPHA_DESCRIPTION = 'Run the review workflow before merging.';
const BETA_BODY = '---\nname: beta\n---\n\nbeta skill body without a description line\n';

function base(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-dsh-skills-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Hand-built staging fixture matching install.mjs's manifest schema exactly
// (same convention as test/install.test.mjs; generate.mjs deliberately not imported).
function stage(staging, name, text, overrides = {}) {
  const dir = path.join(staging, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
  const manifest = {
    schemaVersion: 1, name, host: 'dsh', source: `${name}/SKILL.md`, blob: 'a'.repeat(40),
    commit: 'b'.repeat(40), sha256: textDigest(text), placeholders: [], indicators: [], needsReview: false,
    status: 'generated-not-host-verified', generator: 'gstack861', generatorVersion: '0.2.0',
    generatedAt: WHEN, ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** A real loaded dir built through the real install chain: staging -> installSkills -> target + registry. */
function loadedDir(root) {
  const staging = path.join(root, 'staging'), target = path.join(root, 'target');
  fs.mkdirSync(staging);
  stage(staging, 'alpha', ALPHA_BODY);
  stage(staging, 'beta', BETA_BODY);
  installSkills({ staging, target, now: NOW });
  return target;
}

/** Fake systemPrompt service: records every section() call and returns a sentinel disposer. */
function fakeCtx() {
  const sections = [];
  const dispose = () => {};
  return { sections, dispose, ctx: { systemPrompt: { section(arg) { sections.push(arg); return dispose; } } } };
}

test('the plugin declares the pinned Cordis surface: single systemPrompt inject', () => {
  assert.equal(plugin.name, 'gstack861-skills');
  assert.deepEqual(plugin.inject, ['systemPrompt']);
});

test('apply indexes installed skills as a gstack861:skills section and returns its disposer', t => {
  const root = base(t), target = loadedDir(root);
  const f = fakeCtx();
  assert.equal(apply(f.ctx, { skillsDir: target }), f.dispose, 'the section disposer must be returned');
  assert.equal(f.sections.length, 1);
  const { name, order, interpolate, text } = f.sections[0];
  assert.equal(name, 'gstack861:skills');
  assert.equal(order, 3050);
  assert.equal(interpolate, false);
  assert.match(text, /read the full SKILL\.md at its path with your file tools/, 'the header must tell the model how to expand an entry');
  assert.ok(text.includes(`- alpha | ${ALPHA_DESCRIPTION} | ${path.join(target, 'alpha', 'SKILL.md')}`));
  // The no-description form stays listed, with an empty description field.
  assert.ok(text.includes(`- beta |  | ${path.join(target, 'beta', 'SKILL.md')}`));
});

test('apply refuses activation when ctx.systemPrompt.section is unavailable', t => {
  const root = base(t), target = loadedDir(root);
  const f = fakeCtx();
  assert.throws(() => apply({}, { skillsDir: target }), /DSH_SYSTEM_PROMPT_SECTION_REQUIRED/);
  assert.throws(() => apply({ systemPrompt: {} }, { skillsDir: target }), /DSH_SYSTEM_PROMPT_SECTION_REQUIRED/);
  assert.equal(f.sections.length, 0);
});

test('apply refuses a missing, relative or nonexistent skillsDir', t => {
  const root = base(t), target = loadedDir(root);
  const f = fakeCtx();
  assert.throws(() => apply(f.ctx, {}), /SKILLS_DIR_REQUIRED/);
  assert.throws(() => apply(f.ctx, { skillsDir: 'relative/skills' }), /INVALID_SKILLS_DIR/);
  assert.throws(() => apply(f.ctx, { skillsDir: path.join(root, 'missing') }), /INVALID_SKILLS_DIR/);
  assert.equal(f.sections.length, 0);
});

test('apply refuses a corrupt or missing registry with zero sections', t => {
  const root = base(t), target = loadedDir(root);
  const f = fakeCtx();
  const registry = path.join(target, REGISTRY);
  fs.writeFileSync(registry, '{');
  assert.throws(() => apply(f.ctx, { skillsDir: target }), /REGISTRY_INVALID/);
  fs.unlinkSync(registry);
  assert.throws(() => apply(f.ctx, { skillsDir: target }), /REGISTRY_MISSING/);
  assert.equal(f.sections.length, 0);
});

// Every single-skill structural failure refuses the whole plugin (no partial index).
test('apply refuses any single damaged skill with zero sections injected', t => {
  const cases = [
    ['SKILL.md missing', function missingSkillMd(target) { fs.unlinkSync(path.join(target, 'alpha', 'SKILL.md')); }, /SKILL_INVALID/],
    ['SKILL.md digest drift against the registry record', function tamperedSkillMd(target) {
      fs.appendFileSync(path.join(target, 'alpha', 'SKILL.md'), 'tampered\n');
    }, /SKILL_TAMPERED/],
    ['skill directory missing', function missingDir(target) {
      fs.renameSync(path.join(target, 'alpha'), path.join(path.dirname(target), 'alpha-gone'));
    }, /SKILL_INVALID/],
    ['manifest corrupt', function corruptManifest(target) {
      fs.writeFileSync(path.join(target, 'alpha', 'manifest.json'), '{');
    }, /SKILL_INVALID/],
    ['manifest name mismatch', function mismatchedManifestName(target) {
      const file = path.join(target, 'alpha', 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, `${JSON.stringify({ ...manifest, name: 'not-alpha' }, null, 2)}\n`);
    }, /SKILL_INVALID/],
  ];
  for (const [label, mutate, pattern] of cases) {
    const root = base(t), target = loadedDir(root);
    const f = fakeCtx();
    mutate(target);
    assert.throws(() => apply(f.ctx, { skillsDir: target }), pattern, label);
    assert.equal(f.sections.length, 0, label);
  }
});
