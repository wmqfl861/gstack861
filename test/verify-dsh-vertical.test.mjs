// Offline unit tests for scripts/verify-dsh-vertical.mjs (batch 12 lane).
//
// The verifier's KEYED path (real DSH tasks) is executed only by the
// coordinator with DEEPSEEK_API_KEY; these tests never launch DSH. They pin
// the pure helpers — prompt builders + the 200-char cap, marker-line
// unguessability, verdict parsers, the policy/profile composition (including
// the ROOT_OUTSIDE_WORKSPACE trap the review caught: a skillsDir staged
// outside the workspace cannot be covered by readRoots) — and run the fixture
// builder through the real offline chain (render tree → stageRender →
// installSkills), so what the keyed run mounts is exactly what these tests
// prove installable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { compilePolicy } from '../src/policy.mjs';
import { loadRegistry } from '../src/install.mjs';
import * as plugin from '../src/adapters/dsh-skills.mjs';
import {
  PROMPT_MAX_CHARS, MARKER_TAG, ALLOW_CONTENT,
  buildMarkerLine, buildSkillsPrompt, buildAllowPrompt, checkPromptCap,
  parseGstackCodes, verdictSkills, verdictAllow,
  buildSkillsFixture, policyJson, patchLayerYml, composeProfileLayer,
  freshAllowTarget, assertAbsent,
} from '../scripts/verify-dsh-vertical.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function base(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-vsh-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A realistic throwaway root shape (same depth as the script's own mkdtemp) so
// the allow prompt exercises a real absolute path length, not a toy one.
function workspaceFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g861-dsh-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  return { root, workspace, src: path.join(workspace, 'src') };
}

test('PROMPT_MAX_CHARS is the mandated 200-char hard cap', () => {
  assert.equal(PROMPT_MAX_CHARS, 200);
});

test('buildSkillsPrompt references the skill by name and the marker tag, within the cap', () => {
  const prompt = buildSkillsPrompt({ skillName: 'review' });
  assert.ok(prompt.includes('skill review'), 'names the skill as the index lists it');
  assert.ok(prompt.includes(MARKER_TAG), 'points at the marker tag');
  assert.ok(checkPromptCap(prompt, 'skills') === prompt);
  assert.ok(prompt.length <= PROMPT_MAX_CHARS);
});

test('buildAllowPrompt stays within the cap for a realistic temp path and names the content', (t) => {
  const { src } = workspaceFixture(t);
  const target = freshAllowTarget(src);
  const prompt = buildAllowPrompt({ targetPath: target });
  assert.ok(prompt.includes(target.split(path.sep).join('/')), 'absolute forward-slash path');
  assert.ok(prompt.includes(ALLOW_CONTENT), 'fixed content in prompt');
  checkPromptCap(prompt, 'allow');
});

test('checkPromptCap passes at exactly 200 and throws PROMPT_TOO_LONG beyond it', () => {
  assert.equal(checkPromptCap('x'.repeat(200), 'edge').length, 200);
  assert.throws(() => checkPromptCap('x'.repeat(201), 'edge'), /PROMPT_TOO_LONG/);
});

test('marker lines are unguessable: two builds differ and both carry the tag', () => {
  const a = buildMarkerLine();
  const b = buildMarkerLine();
  assert.notEqual(a, b);
  assert.ok(a.startsWith(`${MARKER_TAG}-`) && b.startsWith(`${MARKER_TAG}-`));
  assert.ok(a.length > MARKER_TAG.length + 8, 'random payload beyond the tag');
});

test('parseGstackCodes dedupes gstack861: codes and ignores lowercase lookalikes', () => {
  assert.deepEqual(parseGstackCodes('x gstack861:OUTSIDE_SCOPE gstack861:OUTSIDE_SCOPE y gstack861:INVALID_PATH_OR_CALL gstack861:not-a-code'),
    ['gstack861:OUTSIDE_SCOPE', 'gstack861:INVALID_PATH_OR_CALL']);
  assert.deepEqual(parseGstackCodes('clean output'), []);
});

test('verdictSkills passes only on the verbatim marker line and zero guard codes', () => {
  const markerLine = buildMarkerLine();
  const ok = verdictSkills({ output: `intro\n${markerLine}\ntail`, markerLine });
  assert.equal(ok.ok, true);
  assert.equal(verdictSkills({ output: 'intro only', markerLine }).ok, false);
  assert.equal(verdictSkills({ output: markerLine.toUpperCase(), markerLine }).ok, false, 'case-mangled is not verbatim');
  const denied = verdictSkills({ output: `${markerLine}\ngstack861:OUTSIDE_SCOPE`, markerLine });
  assert.equal(denied.ok, false);
  assert.ok(/gstack861/.test(denied.reason));
});

test('verdictAllow demands file present, content exact, zero guard codes', (t) => {
  const root = base(t);
  const target = freshAllowTarget(root);
  assert.equal(verdictAllow({ targetPath: target, output: 'done' }).ok, false, 'file never created');
  fs.writeFileSync(target, ALLOW_CONTENT);
  assert.equal(verdictAllow({ targetPath: target, output: 'done' }).ok, true);
  fs.writeFileSync(target, 'wrong');
  const wrong = verdictAllow({ targetPath: target, output: 'done' });
  assert.equal(wrong.ok, false);
  assert.ok(/content/.test(wrong.reason));
  fs.writeFileSync(target, ALLOW_CONTENT);
  const denied = verdictAllow({ targetPath: target, output: 'gstack861:OUTSIDE_SCOPE' });
  assert.equal(denied.ok, false);
  assert.ok(/gstack861/.test(denied.reason));
});

test('freshAllowTarget lands in the given dir and assertAbsent is falsifiable', (t) => {
  const src = path.join(base(t), 'src');
  fs.mkdirSync(src);
  const target = freshAllowTarget(src);
  assert.equal(path.dirname(target), src);
  assert.ok(path.basename(target).endsWith('.txt'));
  assert.doesNotThrow(() => assertAbsent(target, 'pre-launch'));
  fs.writeFileSync(target, 'x');
  assert.throws(() => assertAbsent(target, 'pre-launch'), /ALREADY_EXISTS/);
});

test('buildSkillsFixture produces an installable store inside the workspace with the marker on disk', (t) => {
  const root = base(t);
  const other = base(t);
  const fixture = buildSkillsFixture(root);
  const again = buildSkillsFixture(other);
  assert.equal(fixture.skillsDir, path.join(root, 'workspace', 'skills'), 'store staged INSIDE the workspace');
  const records = loadRegistry(fixture.skillsDir).map(entry => entry.name).sort();
  assert.deepEqual(records, ['gstack', 'plan', 'review']);
  const text = fs.readFileSync(fixture.skillFile, 'utf8');
  assert.ok(text.includes(fixture.markerLine), 'marker line verbatim in the chosen SKILL.md');
  assert.notEqual(again.markerLine, fixture.markerLine, 'each fixture gets a fresh unguessable marker');
});

test('the plugin index over the fixture exposes path and description but never the marker', (t) => {
  const root = base(t);
  const { skillsDir, skillFile, markerLine } = buildSkillsFixture(root);
  const sections = [];
  const ctx = { systemPrompt: { section(arg) { sections.push(arg); return () => {}; } } };
  plugin.apply(ctx, { skillsDir });
  const index = sections[0].text;
  assert.ok(index.includes('review |'), 'index lists the chosen skill by name');
  assert.ok(index.includes(skillFile), 'index points at the absolute SKILL.md path (native separators)');
  assert.ok(!index.includes(markerLine), 'the marker must only be obtainable by really reading the file');
});

test('policyJson compiles with the mandated roots (skills INSIDE the workspace)', (t) => {
  const { workspace, src } = workspaceFixture(t);
  const policy = compilePolicy(policyJson({ workspace, readRoots: [workspace], writeRoots: [src] }));
  assert.equal(policy.workspace, fs.realpathSync.native(workspace));
  assert.equal(policy.writeRoots.length, 1);
  assert.ok(policy.bindings.dsh.write, 'write binding (pipeline-observed file_path)');
  assert.ok(policy.bindings.dsh.read, 'read binding for the skills task');
});

test('the review trap: a skillsDir outside the workspace cannot be covered by readRoots', (t) => {
  const root = base(t);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  const outsideStore = path.join(root, 'skills-outside'); // pre-batch-12 placement mistake
  fs.mkdirSync(outsideStore);
  assert.throws(() => compilePolicy(policyJson({ workspace, readRoots: [workspace, outsideStore], writeRoots: [path.join(workspace, 'src')] })),
    /ROOT_OUTSIDE_WORKSPACE/);
});

test('patchLayerYml composes BOTH plugin entries with their configs', () => {
  const yml = patchLayerYml({ policyPath: 'C:/x/policy.json', skillsDir: 'C:/w/skills' });
  assert.ok(yml.includes('- id: gstack861-guard'));
  assert.ok(yml.includes("name: 'gstack861-guard'"));
  assert.ok(yml.includes('policyPath: \'C:/x/policy.json\''));
  assert.ok(yml.includes('- id: gstack861-skills'));
  assert.ok(yml.includes("name: 'gstack861-skills'"));
  assert.ok(yml.includes('skillsDir: \'C:/w/skills\''));
});

test('composeProfileLayer writes both shims plus the patch onto a seeded profile', (t) => {
  const root = base(t);
  const profileDir = path.join(root, 'home', 'profiles', 'seeded');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify({ name: 'seeded', version: '0.0.0', type: 'module' }, null, 2)}\n`);
  composeProfileLayer(profileDir, repoRoot, { policyPath: path.join(root, 'policy.json'), skillsDir: path.join(root, 'workspace', 'skills') });
  const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['gstack861-guard', 'gstack861-skills']);
  const patch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.includes('gstack861-guard') && patch.includes('gstack861-skills'));
  const guardShim = fs.readFileSync(path.join(profileDir, 'node_modules', 'gstack861-guard', 'index.mjs'), 'utf8');
  const skillsShim = fs.readFileSync(path.join(profileDir, 'node_modules', 'gstack861-skills', 'index.mjs'), 'utf8');
  assert.ok(guardShim.includes('adapters/dsh.mjs'), 'guard shim re-exports the guard adapter');
  assert.ok(skillsShim.includes('adapters/dsh-skills.mjs'), 'skills shim re-exports the skills plugin');
});
