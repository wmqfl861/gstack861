import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stageDshProfile } from '../src/dsh-profile.mjs';
import { verifyDshProfile } from '../src/dsh-verify.mjs';
import { installSkills } from '../src/install.mjs';
import { textDigest } from '../src/json.mjs';

const cli = fileURLToPath(new URL('../bin/gstack861.mjs', import.meta.url));
const realAdapter = fileURLToPath(new URL('../src/adapters/dsh.mjs', import.meta.url));

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g861-dsh-verify-')));
  const workspace = path.join(root, 'workspace'), outside = path.join(root, 'private');
  fs.mkdirSync(workspace); fs.mkdirSync(outside);
  const skills = path.join(workspace, '.dsh', 'skills'); fs.mkdirSync(skills, { recursive: true });
  const policy = path.join(outside, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, workspace, readRoots: [workspace], writeRoots: [], protectedRoots: [], bindings: { zcode: {}, dsh: {} } }), { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace, skills, policy, adapter: realAdapter, output: path.join(root, 'profile') };
}
function installOneSkill(f) {
  const staging = path.join(f.root, 'staging'), name = 'gstack-verify-probe';
  const body = '---\nname: gstack-verify-probe\ndescription: Probe.\n---\nBody.\n';
  fs.mkdirSync(path.join(staging, name), { recursive: true });
  fs.writeFileSync(path.join(staging, name, 'SKILL.md'), body);
  fs.writeFileSync(path.join(staging, name, 'manifest.json'), JSON.stringify({ schemaVersion: 1, name, host: 'dsh', generator: 'gstack861', commit: 'a'.repeat(40), sha256: textDigest(body) }));
  installSkills({ staging, target: f.skills });
}
function snapshot(root) {
  const entries = [];
  const walk = (file, relative) => {
    const st = fs.lstatSync(file, { throwIfNoEntry: false }); if (!st) return;
    entries.push(relative + ':' + (st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : createHash('sha256').update(fs.readFileSync(file)).digest('hex')));
    if (st.isDirectory() && !st.isSymbolicLink()) for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name), relative + '/' + name);
  };
  walk(root, '');
  return entries;
}
const options = f => ({ output: f.output, policyPath: f.policy, adapterPath: f.adapter, skillsDir: f.skills });
const check = (result, id) => result.checks.find(entry => entry.id === id);

test('verifies a staged profile as ready without touching the tree', t => {
  const f = fixture(t); installOneSkill(f); stageDshProfile(options(f));
  const before = snapshot(f.root);
  const result = verifyDshProfile(options(f));
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.checks.map(c => c.id + ':' + c.status), ['structure:ok', 'shims:ok', 'policy:ok', 'skills:ok']);
  assert.deepEqual(snapshot(f.root), before, 'verification is read-only');
});

test('refuses a broken policy with a policy check failure and no writes', t => {
  const f = fixture(t); installOneSkill(f); stageDshProfile(options(f));
  fs.writeFileSync(f.policy, '{');
  const before = snapshot(f.root);
  const result = verifyDshProfile(options(f));
  assert.equal(result.status, 'not-ready');
  assert.equal(check(result, 'policy').status, 'not-ok');
  assert.ok(check(result, 'policy').detail.length > 0, 'diagnostic carries the loader failure');
  assert.deepEqual(snapshot(f.root), before);
});

test('refuses a tampered skill with a skills check failure and no writes', t => {
  const f = fixture(t); installOneSkill(f); stageDshProfile(options(f));
  fs.appendFileSync(path.join(f.skills, 'gstack-verify-probe', 'SKILL.md'), 'tampered');
  const result = verifyDshProfile(options(f));
  assert.equal(result.status, 'not-ready');
  assert.equal(check(result, 'skills').status, 'not-ok');
  assert.match(check(result, 'skills').detail, /DSH_VERIFY_SKILL_TAMPERED/);
});

test('refuses a missing skills shim with a structure check failure', t => {
  const f = fixture(t); installOneSkill(f); stageDshProfile(options(f));
  fs.rmSync(path.join(f.output, 'plugins', 'gstack861-skills', 'index.mjs'));
  const result = verifyDshProfile(options(f));
  assert.equal(result.status, 'not-ready');
  assert.equal(check(result, 'structure').status, 'not-ok');
  assert.equal(check(result, 'shims').status, 'not-ok');
});

test('refuses a corrupted package.json with a structure check failure', t => {
  const f = fixture(t); installOneSkill(f); stageDshProfile(options(f));
  fs.writeFileSync(path.join(f.output, 'package.json'), '{');
  const result = verifyDshProfile(options(f));
  assert.equal(result.status, 'not-ready');
  assert.equal(check(result, 'structure').status, 'not-ok');
});

test('refuses a shim rebound to a decoy module with a shims check failure', t => {
  const f = fixture(t); installOneSkill(f); stageDshProfile(options(f));
  const decoy = path.join(f.root, 'decoy.mjs');
  fs.writeFileSync(decoy, 'export const name="decoy",inject=[],apply=()=>{};\n');
  const shim = path.join(f.output, 'plugins', 'gstack861-guard', 'index.mjs');
  fs.writeFileSync(shim, `export { name, inject, apply } from ${JSON.stringify(new URL('file:///' + decoy.replace(/\\/g, '/')).href)};\n`);
  const before = snapshot(f.root);
  const result = verifyDshProfile(options(f));
  assert.equal(result.status, 'not-ready');
  assert.equal(check(result, 'shims').status, 'not-ok');
  assert.match(check(result, 'shims').detail, /DSH_VERIFY_SHIM_BINDING/);
  assert.deepEqual(snapshot(f.root), before, 'verification stays read-only on refusal');
});

test('CLI prints readiness JSON and exits nonzero only when not ready', t => {
  const f = fixture(t); installOneSkill(f); stageDshProfile(options(f));
  const args = ['dsh-profile-verify', '--output', f.output, '--policy', f.policy, '--adapter', f.adapter, '--skills', f.skills];
  const run = extra => spawnSync(process.execPath, [cli, ...args, ...extra], { encoding: 'utf8', timeout: 45000 });
  let r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).status, 'ready');
  fs.writeFileSync(f.policy, '{');
  r = run([]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /DSH_PROFILE_NOT_READY/);
  assert.equal(JSON.parse(r.stdout).status, 'not-ready');
});
