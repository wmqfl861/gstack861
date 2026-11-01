import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stageCommandAliases } from '../src/aliases.mjs';
import { installSkills, uninstallSkills, loadRegistry } from '../src/install.mjs';
import { stageDshProfile } from '../src/dsh-profile.mjs';
import { planZcodeConfig, planZcodeUninstall, applyZcodeConfigPlan, ZCODE_RECEIPT_FILE } from '../src/zcode-profile.mjs';
import { textDigest } from '../src/json.mjs';

// These are real file lifecycles with the exact path-device behavior observed in
// Windows CI injected into metadata only. Actual runner evidence remains separate.
const repo = fileURLToPath(new URL('../', import.meta.url));
const cloneStat = (stat, changes) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, changes);
function zeroPathDevices(t) {
  const original = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (...args) => {
    const stat = original(...args);
    return stat && cloneStat(stat, { dev: args[1]?.bigint ? 0n : 0 });
  });
}
function changedDescriptor(t, predicate, active) {
  const open = fs.openSync, close = fs.closeSync, fstat = fs.fstatSync, paths = new Map();
  t.mock.method(fs, 'openSync', (...args) => { const fd = open(...args); paths.set(fd, String(args[0])); return fd; });
  t.mock.method(fs, 'closeSync', (...args) => { const result = close(...args); paths.delete(args[0]); return result; });
  t.mock.method(fs, 'fstatSync', (...args) => {
    const stat = fstat(...args);
    if (args[1]?.bigint && active() && predicate(paths.get(args[0]))) return cloneStat(stat, { dev: stat.dev + 1n });
    return stat;
  });
}
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'g861-win-id-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), skills = path.join(workspace, 'skills');
  fs.mkdirSync(skills, { recursive: true });
  const policy = path.join(root, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, workspace, readRoots: [workspace], writeRoots: [workspace], protectedRoots: [], bindings: { zcode: {}, dsh: {} } }), { mode: 0o600 });
  return { root, workspace, skills, policy };
}
function canonicalStage(root, label, body = 'source body', aux = { 'sections/guide.md': 'guide' }) {
  const staging = path.join(root, label), dir = path.join(staging, 'open-gstack-browser');
  fs.mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from('---\nname: open-gstack-browser\ndescription: fixture\n---\n' + body + '\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), bytes);
  for (const [name, content] of Object.entries(aux)) {
    const file = path.join(dir, ...name.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, generator: 'gstack861', name: 'open-gstack-browser', host: 'dsh', commit: 'a'.repeat(40), sha256: textDigest(bytes), files: Object.fromEntries(Object.entries(aux).map(([name, content]) => [name, textDigest(content)])) }));
  return { staging, bytes };
}
const zcodeOptions = f => ({ workspace: f.workspace, nodePath: process.execPath, cliPath: path.join(repo, 'bin/gstack861.mjs'), policyPath: f.policy });
const readConfig = f => JSON.parse(fs.readFileSync(path.join(f.workspace, '.zcode/config.json'), 'utf8'));

if (process.platform === 'win32') {
  test('Windows zero-device alias stage binds exclusive output descriptors and preserves canonical bytes', t => {
    const f = fixture(t), source = canonicalStage(f.root, 'source'), output = path.join(f.root, 'alias'); zeroPathDevices(t);
    stageCommandAliases({ staging: source.staging, output, host: 'dsh' });
    assert.match(fs.readFileSync(path.join(output, 'connect-chrome/SKILL.md'), 'utf8'), /^---\nname: connect-chrome\n/);
    assert.deepEqual(fs.readFileSync(path.join(source.staging, 'open-gstack-browser/SKILL.md')), source.bytes);
    assert.equal(fs.readFileSync(path.join(output, 'connect-chrome/sections/guide.md'), 'utf8'), 'guide');
  });

  test('Windows zero-device canonical and alias survive registry and tree moves, backups and purge', t => {
    const f = fixture(t), source = canonicalStage(f.root, 'source'), output = path.join(f.root, 'alias'); zeroPathDevices(t);
    stageCommandAliases({ staging: source.staging, output, host: 'dsh' });
    installSkills({ staging: source.staging, target: f.skills }); installSkills({ staging: output, target: f.skills });
    assert.deepEqual(installSkills({ staging: output, target: f.skills }).skipped, ['connect-chrome']);
    const newer = canonicalStage(f.root, 'source-v2', 'changed source');
    assert.deepEqual(installSkills({ staging: newer.staging, target: f.skills }).backedUp, ['open-gstack-browser']);
    assert.deepEqual(loadRegistry(f.skills).map(x => x.name), ['connect-chrome', 'open-gstack-browser']);
    const removed = uninstallSkills({ target: f.skills, purge: true });
    assert.deepEqual(removed.uninstalled, ['connect-chrome', 'open-gstack-browser']);
    assert.equal(removed.backupsRemoved, 1); assert.deepEqual(loadRegistry(f.skills), []);
  });

  test('Windows zero-device alias directory ownership permits equivalent case spellings', t => {
    const f = fixture(t), source = canonicalStage(f.root, 'source', 'body', { 'sections/one.md': 'one', 'SECTIONS/two.md': 'two' }); zeroPathDevices(t);
    const output = path.join(f.root, 'alias'); stageCommandAliases({ staging: source.staging, output, host: 'dsh' });
    assert.equal(fs.readFileSync(path.join(output, 'connect-chrome/sections/two.md'), 'utf8'), 'two');
  });

  test('Windows zero-device DSH scaffold emits both real adapter shims through verified creates', t => {
    const f = fixture(t); zeroPathDevices(t); const output = path.join(f.root, 'profile');
    stageDshProfile({ output, policyPath: f.policy, adapterPath: path.join(repo, 'src/adapters/dsh.mjs'), skillsDir: f.skills });
    for (const [plugin, adapter] of [['gstack861-guard', 'dsh.mjs'], ['gstack861-skills', 'dsh-skills.mjs']]) {
      assert.ok(fs.readFileSync(path.join(output, 'plugins', plugin, 'index.mjs'), 'utf8').includes(pathToFileURL(path.join(repo, 'src/adapters', adapter)).href));
    }
  });

  for (const preexisting of [false, true]) test('Windows zero-device ZCode config and receipt lifecycle retains identity proof' + (preexisting ? ' with existing user settings' : ' fresh'), t => {
    const f = fixture(t), dir = path.join(f.workspace, '.zcode'), file = path.join(dir, 'config.json');
    if (preexisting) { fs.mkdirSync(dir); fs.writeFileSync(file, JSON.stringify({ theme: 'keep', hooks: { events: { Stop: [] } } })); }
    zeroPathDevices(t); const options = zcodeOptions(f);
    applyZcodeConfigPlan(planZcodeConfig(options));
    const receiptPath = path.join(dir, ZCODE_RECEIPT_FILE), receipt = JSON.parse(fs.readFileSync(receiptPath));
    assert.equal(receipt.workspace.dev, '0'); assert.notEqual(receipt.workspace.descriptor.dev, '0');
    const before = fs.readFileSync(file), receiptBefore = fs.readFileSync(receiptPath);
    assert.equal(applyZcodeConfigPlan(planZcodeConfig(options)).changed, false);
    assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(fs.readFileSync(receiptPath), receiptBefore);
    applyZcodeConfigPlan(planZcodeUninstall(options));
    if (preexisting) assert.deepEqual(readConfig(f), { theme: 'keep', hooks: { events: { Stop: [] } } });
    else assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(receiptPath), false);
  });

  test('Windows zero-device receipt without a descriptor witness is never adopted', t => {
    const f = fixture(t); zeroPathDevices(t); const options = zcodeOptions(f); applyZcodeConfigPlan(planZcodeConfig(options));
    const file = path.join(f.workspace, '.zcode', ZCODE_RECEIPT_FILE), receipt = JSON.parse(fs.readFileSync(file)); delete receipt.workspace.descriptor;
    fs.writeFileSync(file, JSON.stringify(receipt)); const before = fs.readFileSync(file);
    for (const planner of [planZcodeConfig, planZcodeUninstall]) assert.throws(() => planner(options), /ZCODE_RECEIPT_CONFLICT/);
    assert.deepEqual(fs.readFileSync(file), before);
  });

  test('Windows zero-device workspace CAS rejects both newly opened handles changing devices together', t => {
    const f = fixture(t), dir = path.join(f.workspace, '.zcode'); fs.mkdirSync(dir); const file = path.join(dir, 'config.json'); fs.writeFileSync(file, '{}');
    zeroPathDevices(t); let changed = false; changedDescriptor(t, name => name === f.workspace, () => changed);
    const plan = planZcodeConfig(zcodeOptions(f)); changed = true;
    assert.throws(() => applyZcodeConfigPlan(plan), /ZCODE_CONFIG_CHANGED/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{}'); assert.deepEqual(fs.readdirSync(dir), ['config.json']);
  });

  test('Windows zero-device promoted config keeps its original temp witness when readback device changes', t => {
    const f = fixture(t), dir = path.join(f.workspace, '.zcode'); fs.mkdirSync(dir); const file = path.join(dir, 'config.json'); fs.writeFileSync(file, '{}');
    zeroPathDevices(t); let changed = false; changedDescriptor(t, name => name === file, () => changed);
    const rename = fs.renameSync; t.mock.method(fs, 'renameSync', (...args) => { const value = rename(...args); if (args[1] === file) changed = true; return value; });
    assert.throws(() => applyZcodeConfigPlan(planZcodeConfig(zcodeOptions(f))), /ZCODE_CONFIG_RECOVERY_REQUIRED/);
    assert.equal(changed, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ZCODE_RECEIPT_FILE))).status, 'pending');
    assert.equal(readConfig(f).hooks.events.PreToolUse.length, 1);
    assert.equal(fs.existsSync(path.join(dir, '.gstack861-zcode-config.lock')), false);
  });

  test('Windows zero-device DSH cleanup preserves a partially written output and original failure', t => {
    const f = fixture(t), output = path.join(f.root, 'profile'); zeroPathDevices(t);
    const open = fs.openSync, close = fs.closeSync, write = fs.writeFileSync, names = new Map(); let injected = false;
    t.mock.method(fs, 'openSync', (...args) => { const fd = open(...args); names.set(fd, String(args[0])); return fd; });
    t.mock.method(fs, 'closeSync', (...args) => { const result = close(...args); names.delete(args[0]); return result; });
    t.mock.method(fs, 'writeFileSync', (...args) => {
      if (!injected && names.get(args[0]) === path.join(output, 'package.json')) { injected = true; write(args[0], 'OPERATOR DATA'); throw Object.assign(new Error('EIO'), { code: 'EIO' }); }
      return write(...args);
    });
    assert.throws(() => stageDshProfile({ output, policyPath: f.policy, adapterPath: path.join(repo, 'src/adapters/dsh.mjs'), skillsDir: f.skills }), /EIO/);
    assert.equal(injected, true); assert.equal(fs.readFileSync(path.join(output, 'package.json'), 'utf8'), 'OPERATOR DATA');
  });
}
