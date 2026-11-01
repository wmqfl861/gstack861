import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { planZcodeConfig, applyZcodeConfigPlan, planZcodeUninstall } from '../src/zcode-profile.mjs';

const RECEIPT = '.gstack861-zcode-receipt.json';
const LOCK = '.gstack861-zcode-config.lock';
function fixture(t, { zdir = true, config } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g861-zc-')));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  if (zdir) fs.mkdirSync(path.join(workspace, '.zcode'));
  const f = { root, workspace, nodePath: process.execPath, cliPath: path.join(root, 'bin', 'gstack861.mjs'), policyPath: path.join(root, 'private', 'policy.json') };
  f.dir = path.join(workspace, '.zcode'); f.file = path.join(f.dir, 'config.json'); f.receipt = path.join(f.dir, RECEIPT);
  if (config !== undefined) fs.writeFileSync(f.file, typeof config === 'string' ? config : JSON.stringify(config));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return f;
}
const read = f => JSON.parse(fs.readFileSync(f.file, 'utf8'));
const owned = f => ({ matcher: '.*', hooks: [{ type: 'process', command: f.nodePath, args: [f.cliPath, 'hook', 'zcode', '--policy', f.policyPath], timeoutMs: 10000 }] });
const install = f => applyZcodeConfigPlan(planZcodeConfig(f));
const uninstall = f => applyZcodeConfigPlan(planZcodeUninstall(f));
function tree(root) {
  const entries = [];
  function walk(file, relative) {
    const st = fs.lstatSync(file, { throwIfNoEntry: false }); if (!st) return;
    const entry = { path: relative, kind: st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file', mtime: st.mtimeMs };
    if (st.isSymbolicLink()) entry.target = fs.readlinkSync(file);
    else if (st.isFile()) entry.sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    entries.push(entry);
    if (st.isDirectory() && !st.isSymbolicLink()) for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name), path.join(relative, name));
  }
  walk(root, '.'); return entries;
}
const linkDirectory = (target, file) => fs.symlinkSync(target, file, process.platform === 'win32' ? 'junction' : 'dir');
function clean(f) {
  if (fs.existsSync(f.dir)) assert.deepEqual(fs.readdirSync(f.dir).filter(n => n === LOCK || n.endsWith('.tmp')), []);
}
const ioError = code => Object.assign(new Error(code), { code });

// These retain the original safety assertions after correcting root -> workspace.
test('merges workspace hook config while preserving unrelated settings and existing hooks', t => {
  const existing = { theme: 'dark', hooks: { enabled: true, events: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'other' }] }], Stop: [{ matcher: '.*', hooks: [{ type: 'command', command: 'stop' }] }] } } };
  const f = fixture(t, { config: existing }); const plan = planZcodeConfig(f);
  assert.equal(applyZcodeConfigPlan(plan).changed, true);
  assert.equal(read(f).theme, 'dark'); assert.equal(read(f).hooks.events.Stop.length, 1); assert.equal(read(f).hooks.events.PreToolUse.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).status, 'committed');
  uninstall(f); assert.deepEqual(read(f), existing); assert.equal(fs.existsSync(f.receipt), false);
});
test('apply is idempotent and uninstall removes only the exact owned hook', t => {
  const f = fixture(t, { config: {} }); install(f);
  const before = tree(f.workspace), plan = planZcodeConfig(f);
  assert.equal(plan.changed, false); assert.equal(applyZcodeConfigPlan(plan).changed, false); assert.deepEqual(tree(f.workspace), before);
  assert.equal(uninstall(f).changed, true); assert.equal(read(f).hooks, undefined); assert.equal(fs.existsSync(f.receipt), false);
});
test('fresh .zcode preview writes nothing and apply supports a true clean roundtrip', t => {
  const f = fixture(t, { zdir: false }), before = tree(f.workspace), plan = planZcodeConfig(f);
  assert.equal(plan.changed, true); assert.deepEqual(tree(f.workspace), before);
  assert.equal(applyZcodeConfigPlan(plan).changed, true); assert.equal(read(f).hooks.events.PreToolUse.length, 1);
  uninstall(f); assert.equal(fs.existsSync(f.file), false); assert.equal(fs.existsSync(f.receipt), false); clean(f);
});
test('uninstall without a receipt is a verified zero-write no-op even without .zcode', t => {
  const f = fixture(t, { zdir: false }), before = tree(f.workspace), plan = planZcodeUninstall(f);
  assert.equal(plan.changed, false); assert.equal(applyZcodeConfigPlan(plan).changed, false); assert.deepEqual(tree(f.workspace), before);
});
test('install and uninstall preview preserve all tree bytes and metadata', t => {
  const f = fixture(t, { config: '\r\n{\r\n\t"theme":"dark"\r\n}\r\n' });
  let before = tree(f.workspace); planZcodeConfig(f); assert.deepEqual(tree(f.workspace), before);
  install(f); before = tree(f.workspace); planZcodeUninstall(f); assert.deepEqual(tree(f.workspace), before);
});
for (const [name, original] of [
  ['absent hooks', { theme: 'dark' }], ['empty hooks', { hooks: {} }], ['preexisting true', { hooks: { enabled: true } }],
  ['empty events', { hooks: { enabled: true, events: {} } }], ['empty PreToolUse', { hooks: { enabled: true, events: { PreToolUse: [] } } }],
  ['foreign hook without enabled', { hooks: { events: { Stop: [{ matcher: '.*', hooks: [{ type: 'command', command: 'stop' }] }] } } }],
]) test('receipt restores original field presence: ' + name, t => {
  const f = fixture(t, { config: original }); install(f); install(f); uninstall(f); assert.deepEqual(read(f), original);
});
for (const enabled of [undefined, true]) test('preexisting exact hook is never adopted, including absent enabled: ' + String(enabled), t => {
  const f = fixture(t), hooks = { events: { PreToolUse: [owned(f)] } }; if (enabled !== undefined) hooks.enabled = enabled;
  fs.writeFileSync(f.file, JSON.stringify({ theme: 'dark', hooks })); const before = tree(f.workspace), plan = planZcodeConfig(f);
  assert.equal(plan.changed, false); assert.equal(applyZcodeConfigPlan(plan).changed, false); assert.deepEqual(tree(f.workspace), before);
  assert.equal(fs.existsSync(f.receipt), false); assert.equal(uninstall(f).changed, false); assert.deepEqual(tree(f.workspace), before);
});
test('missing receipt never authorizes removing an annotated foreign near-match', t => {
  const f = fixture(t), original = { hooks: { enabled: true, events: { PreToolUse: [{ ...owned(f), userMetadata: 'keep' }] } } };
  fs.writeFileSync(f.file, JSON.stringify(original)); const before = tree(f.workspace);
  assert.equal(uninstall(f).changed, false); assert.deepEqual(tree(f.workspace), before);
});
test('uninstall removes at most one full recorded entry and preserves metadata and duplicates', t => {
  const f = fixture(t, { config: {} }); install(f); const current = read(f), entry = owned(f);
  current.hooks.events.PreToolUse.push({ ...entry, userMetadata: 'keep' }, entry, { ...entry, hooks: [{ ...entry.hooks[0], timeoutMs: 9999 }] });
  fs.writeFileSync(f.file, JSON.stringify(current)); uninstall(f);
  assert.deepEqual(read(f).hooks.events.PreToolUse, [{ ...entry, userMetadata: 'keep' }, entry, { ...entry, hooks: [{ ...entry.hooks[0], timeoutMs: 9999 }] }]);
});
test('uninstall preserves a modified owned entry and unrelated concurrent user edits', t => {
  const f = fixture(t, { config: { theme: 'dark' } }); install(f); const current = read(f);
  current.theme = 'light'; current.hooks.enabled = false; current.userAdded = true; current.hooks.events.PreToolUse[0].userMetadata = 'keep';
  current.hooks.events.Stop = [{ matcher: 'Write', hooks: [{ type: 'command', command: 'stop' }] }]; fs.writeFileSync(f.file, JSON.stringify(current));
  uninstall(f); assert.deepEqual(read(f), current); assert.equal(fs.existsSync(f.receipt), false);
});
test('uninstall preserves foreign hooks and user false while removing the recorded entry', t => {
  const f = fixture(t, { config: {} }); install(f); const current = read(f), foreign = { matcher: 'Write', hooks: [{ type: 'command', command: 'other' }] };
  current.theme = 'light'; current.hooks.enabled = false; current.hooks.events.PreToolUse.push(foreign); fs.writeFileSync(f.file, JSON.stringify(current)); uninstall(f);
  assert.deepEqual(read(f), { theme: 'light', hooks: { enabled: false, events: { PreToolUse: [foreign] } } });
});
test('conflicting installer identity refuses without replacing original receipt', t => {
  const f = fixture(t, { config: {} }); install(f); const bytes = fs.readFileSync(f.receipt), before = tree(f.workspace);
  assert.throws(() => planZcodeConfig({ ...f, policyPath: path.join(f.root, 'another-policy.json') }), /ZCODE_RECEIPT_CONFLICT/);
  assert.throws(() => planZcodeUninstall({ ...f, cliPath: path.join(f.root, 'another-cli.mjs') }), /ZCODE_RECEIPT_CONFLICT/);
  assert.deepEqual(fs.readFileSync(f.receipt), bytes); assert.deepEqual(tree(f.workspace), before);
});
for (const verb of ['install', 'uninstall']) test('semantic stale ' + verb + ' plan refuses and preserves exact concurrent bytes', t => {
  const f = fixture(t, { config: {} }); if (verb === 'uninstall') install(f);
  const plan = verb === 'install' ? planZcodeConfig(f) : planZcodeUninstall(f), current = read(f); current.concurrent = true;
  fs.writeFileSync(f.file, JSON.stringify(current)); const bytes = fs.readFileSync(f.file);
  assert.throws(() => applyZcodeConfigPlan(plan), /ZCODE_CONFIG_CHANGED/); assert.deepEqual(fs.readFileSync(f.file), bytes); clean(f);
});
for (const mutation of ['format', 'delete', 'create', 'identical inode replacement']) test('raw snapshot refuses stale ' + mutation, t => {
  const f = fixture(t, mutation === 'create' ? {} : { config: {} }), plan = planZcodeConfig(f);
  if (mutation === 'format') fs.writeFileSync(f.file, ' { }\r\n');
  if (mutation === 'delete') fs.unlinkSync(f.file);
  if (mutation === 'create') fs.writeFileSync(f.file, '{}');
  if (mutation === 'identical inode replacement') { fs.renameSync(f.file, f.file + '.old'); fs.writeFileSync(f.file, '{}'); }
  const before = tree(f.workspace); assert.throws(() => applyZcodeConfigPlan(plan), /ZCODE_CONFIG_CHANGED/); assert.deepEqual(tree(f.workspace), before);
});
test('stale receipt bytes are bound to a plan even when configuration is unchanged', t => {
  const f = fixture(t, { config: {} }); install(f); const plan = planZcodeUninstall(f); fs.appendFileSync(f.receipt, '\n'); const before = tree(f.workspace);
  assert.throws(() => applyZcodeConfigPlan(plan), /ZCODE_CONFIG_CHANGED/); assert.deepEqual(tree(f.workspace), before);
});
test('authentic plans are deeply frozen and forged external destinations refuse', t => {
  const f = fixture(t, { config: {} }), plan = planZcodeConfig(f), external = path.join(f.root, 'external.json'); fs.writeFileSync(external, '{}');
  assert.equal(Object.isFrozen(plan.config.hooks.events.PreToolUse[0].hooks[0].args), true);
  assert.throws(() => { plan.config.hooks.enabled = false; }, TypeError);
  assert.throws(() => applyZcodeConfigPlan({ ...plan, configPath: external }), /INVALID_PLAN/); assert.equal(fs.readFileSync(external, 'utf8'), '{}');
  applyZcodeConfigPlan(plan); assert.equal(read(f).hooks.enabled, true);
});
test('existingConfig preview cannot authorize overwriting different disk state', t => {
  const f = fixture(t, { config: { user: true } }), before = tree(f.workspace), plan = planZcodeConfig({ ...f, existingConfig: {} });
  assert.throws(() => applyZcodeConfigPlan(plan), /ZCODE_CONFIG_CHANGED|INVALID_PLAN/); assert.deepEqual(tree(f.workspace), before);
});
for (const [name, config] of [
  ['malformed JSON', '{'], ['array root', []], ['null hooks', { hooks: null }], ['array hooks', { hooks: [] }],
  ['string enabled', { hooks: { enabled: 'false' } }], ['null enabled', { hooks: { enabled: null } }], ['null events', { hooks: { events: null } }],
  ['array events', { hooks: { events: [] } }], ['non-array event', { hooks: { events: { Stop: 'bad' } } }],
  ['non-object entry', { hooks: { events: { PreToolUse: [null] } } }], ['number matcher', { hooks: { events: { PreToolUse: [{ matcher: 7, hooks: [] }] } } }],
  ['string hooks', { hooks: { events: { PreToolUse: [{ matcher: '.*', hooks: 'bad' }] } } }],
  ['invalid command', { hooks: { events: { Stop: [{ matcher: '.*', hooks: [{ type: 'process', command: 7 }] }] } } }],
]) test('both planners fail closed on ' + name, t => {
  const f = fixture(t, { config }), before = tree(f.workspace);
  assert.throws(() => planZcodeConfig(f), /ZCODE_CONFIG_INVALID|ZCODE_HOOKS_INVALID|ZCODE_EVENTS_INVALID/);
  assert.throws(() => planZcodeUninstall(f), /ZCODE_CONFIG_INVALID|ZCODE_HOOKS_INVALID|ZCODE_EVENTS_INVALID/);
  assert.deepEqual(tree(f.workspace), before);
});
test('disabled install refuses while foreign extension metadata survives normal roundtrip', t => {
  const f = fixture(t, { config: { hooks: { enabled: false } } }); assert.throws(() => planZcodeConfig(f), /ZCODE_HOOKS_DISABLED/);
  const foreign = { matcher: 'Write', extension: { keep: true }, hooks: [{ type: 'command', command: 'other', extension: 'keep' }] };
  const original = { hooks: { enabled: true, customSetting: true, events: { Stop: [foreign] } } }; fs.writeFileSync(f.file, JSON.stringify(original));
  install(f); uninstall(f); assert.deepEqual(read(f), original);
});
test('both planners reject missing or junction workspace and linked .zcode', t => {
  const f = fixture(t), missing = { ...f, workspace: path.join(f.root, 'missing') };
  for (const planner of [planZcodeConfig, planZcodeUninstall]) assert.throws(() => planner(missing), /WORKSPACE_INVALID/);
  const alias = path.join(f.root, 'alias'); linkDirectory(f.workspace, alias);
  for (const planner of [planZcodeConfig, planZcodeUninstall]) assert.throws(() => planner({ ...f, workspace: alias }), /WORKSPACE_INVALID/);
  fs.renameSync(f.dir, path.join(f.root, 'real-zcode')); linkDirectory(path.join(f.root, 'real-zcode'), f.dir); const before = tree(f.root);
  for (const planner of [planZcodeConfig, planZcodeUninstall]) assert.throws(() => planner(f), /ZCODE_CONFIG_DIR_UNSAFE/);
  assert.deepEqual(tree(f.root), before);
});
test('both planners refuse a junction in a workspace ancestor', t => {
  const f = fixture(t), parent = path.join(f.root, 'real-parent'); fs.mkdirSync(parent); fs.renameSync(f.workspace, path.join(parent, 'workspace'));
  const alias = path.join(f.root, 'alias'); linkDirectory(parent, alias); const before = tree(parent);
  for (const planner of [planZcodeConfig, planZcodeUninstall]) assert.throws(() => planner({ ...f, workspace: path.join(alias, 'workspace') }), /WORKSPACE_INVALID/);
  assert.deepEqual(tree(parent), before);
});
for (const target of ['config', 'receipt']) test('both planners reject multiply linked ' + target, t => {
  const f = fixture(t, { config: {} }); if (target === 'receipt') install(f);
  const file = target === 'config' ? f.file : f.receipt; fs.linkSync(file, path.join(f.root, 'hardlink'));
  for (const planner of [planZcodeConfig, planZcodeUninstall]) assert.throws(() => planner(f), /ZCODE_CONFIG_UNSAFE|ZCODE_RECEIPT_UNSAFE/);
});
for (const target of ['workspace', '.zcode']) for (const replacement of ['plain', 'junction']) test('apply rejects ' + replacement + ' ' + target + ' replacement after plan', t => {
  const f = fixture(t, { config: {} }), plan = planZcodeConfig(f), file = target === 'workspace' ? f.workspace : f.dir, parked = path.join(f.root, 'parked');
  fs.renameSync(file, parked); const real = replacement === 'plain' ? file : path.join(f.root, 'external'); fs.mkdirSync(real);
  if (target === 'workspace') fs.mkdirSync(path.join(real, '.zcode'));
  fs.writeFileSync(path.join(real, target === 'workspace' ? '.zcode/config.json' : 'config.json'), '{}'); if (replacement === 'junction') linkDirectory(real, file);
  const before = tree(real); assert.throws(() => applyZcodeConfigPlan(plan), /ZCODE_CONFIG_CHANGED|ZCODE_CONFIG_DIR_UNSAFE|WORKSPACE_INVALID/); assert.deepEqual(tree(real), before);
});
test('a .zcode link introduced after preview is refused before any lock mutation', t => {
  const f = fixture(t, { config: {} }), plan = planZcodeConfig(f), external = path.join(f.root, 'external'); fs.renameSync(f.dir, external); linkDirectory(external, f.dir);
  const before = tree(external); assert.throws(() => applyZcodeConfigPlan(plan), /ZCODE_CONFIG_CHANGED|ZCODE_CONFIG_DIR_UNSAFE/); assert.deepEqual(tree(external), before);
});
for (const shape of ['corrupt', 'pending', 'symlink']) test('unsafe or incomplete receipt refuses both planners: ' + shape, t => {
  const f = fixture(t, { config: {} }); install(f);
  if (shape === 'corrupt') fs.writeFileSync(f.receipt, '{}');
  if (shape === 'pending') { const receipt = JSON.parse(fs.readFileSync(f.receipt)); receipt.status = 'pending'; fs.writeFileSync(f.receipt, JSON.stringify(receipt)); }
  if (shape === 'symlink') { const target = path.join(f.root, 'receipt-target'); fs.renameSync(f.receipt, target); fs.symlinkSync(target, f.receipt, 'file'); }
  const before = tree(f.workspace);
  for (const planner of [planZcodeConfig, planZcodeUninstall]) assert.throws(() => planner(f), shape === 'pending' ? /ZCODE_CONFIG_RECOVERY_REQUIRED/ : /ZCODE_RECEIPT_INVALID|ZCODE_RECEIPT_UNSAFE/);
  assert.deepEqual(tree(f.workspace), before);
});
for (const fault of ['intent-write', 'config-write', 'config-rename', 'receipt-finalize']) test('install transaction rolls back exact bytes after ' + fault, t => {
  const f = fixture(t, { config: '\r\n{ "theme": "dark" }\r\n' }), before = fs.readFileSync(f.file), plan = planZcodeConfig(f); let injected = false, partial = null, partialIno = null;
  const method = fault === 'config-rename' ? 'renameSync' : 'writeFileSync', original = fs[method];
  t.mock.method(fs, method, (...args) => {
    const file = String(args[0]), body = String(args[1]);
    const matches = fault === 'config-rename' ? args[1] === f.file
      : fault === 'config-write' ? file.startsWith(f.file + '.')
      : file.startsWith(f.receipt + '.') && JSON.parse(body).status === (fault === 'intent-write' ? 'pending' : 'committed');
    if (matches && !injected) {
      injected = true;
      if (fault === 'config-write') { partial = file; partialIno = String(fs.lstatSync(file, { bigint: true }).ino); original(file, '{', args[2]); }
      throw ioError('EIO');
    }
    return original(...args);
  });
  assert.throws(() => applyZcodeConfigPlan(plan), /EIO/); t.mock.restoreAll(); assert.equal(injected, true);
  assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(fs.existsSync(f.receipt), false);
  if (partial) {
    assert.equal(fs.readFileSync(partial, 'utf8'), '{'); assert.equal(String(fs.lstatSync(partial, { bigint: true }).ino), partialIno);
    assert.deepEqual(fs.readdirSync(f.dir).sort(), [path.basename(f.file), path.basename(partial)].sort());
  } else clean(f);
});
for (const fault of ['config-rename', 'receipt-finalize']) test('uninstall transaction restores config and committed receipt after ' + fault, t => {
  const f = fixture(t, { config: { theme: 'dark' } }); install(f); const configBefore = fs.readFileSync(f.file), receiptBefore = fs.readFileSync(f.receipt), plan = planZcodeUninstall(f); let injected = false;
  const method = fault === 'config-rename' ? 'renameSync' : 'unlinkSync', original = fs[method];
  t.mock.method(fs, method, (...args) => {
    if (!injected && (fault === 'config-rename' ? args[1] === f.file : args[0] === f.receipt)) { injected = true; throw ioError('EIO'); }
    return original(...args);
  });
  assert.throws(() => applyZcodeConfigPlan(plan), /EIO/); t.mock.restoreAll(); assert.equal(injected, true);
  assert.deepEqual(fs.readFileSync(f.file), configBefore); assert.deepEqual(fs.readFileSync(f.receipt), receiptBefore); clean(f);
});
test('failed receipt finalize plus failed rollback leaves pending recovery evidence and refuses later mutation', t => {
  const f = fixture(t, { config: {} }), plan = planZcodeConfig(f), write = fs.writeFileSync, rename = fs.renameSync; let configCommits = 0, finalized = false;
  t.mock.method(fs, 'writeFileSync', (...args) => {
    if (String(args[0]).startsWith(f.receipt + '.') && JSON.parse(String(args[1])).status === 'committed') { finalized = true; throw ioError('EIO'); }
    return write(...args);
  });
  t.mock.method(fs, 'renameSync', (...args) => { if (args[1] === f.file && ++configCommits > 1) throw ioError('EACCES'); return rename(...args); });
  assert.throws(() => applyZcodeConfigPlan(plan), /ZCODE_CONFIG_RECOVERY_REQUIRED/); t.mock.restoreAll();
  assert.equal(finalized, true); assert.equal(JSON.parse(fs.readFileSync(f.receipt)).status, 'pending'); assert.equal(read(f).hooks.events.PreToolUse.length, 1);
  for (const planner of [planZcodeConfig, planZcodeUninstall]) assert.throws(() => planner(f), /ZCODE_CONFIG_RECOVERY_REQUIRED/); clean(f);
});
test('rollback never overwrites a concurrent user edit after config commit', t => {
  const f = fixture(t, { config: {} }), plan = planZcodeConfig(f), original = fs.writeFileSync; let injected = false;
  t.mock.method(fs, 'writeFileSync', (...args) => {
    if (String(args[0]).startsWith(f.receipt + '.') && JSON.parse(String(args[1])).status === 'committed') { injected = true; original(f.file, '{"concurrentUserEdit":true}'); throw ioError('EIO'); }
    return original(...args);
  });
  assert.throws(() => applyZcodeConfigPlan(plan), /ZCODE_CONFIG_RECOVERY_REQUIRED/); t.mock.restoreAll(); assert.equal(injected, true);
  assert.deepEqual(read(f), { concurrentUserEdit: true }); assert.equal(JSON.parse(fs.readFileSync(f.receipt)).status, 'pending'); clean(f);
});
test('active foreign lock survives and non-EEXIST lock errors retain their code', t => {
  const f = fixture(t, { config: {} }), plan = planZcodeConfig(f); fs.mkdirSync(path.join(f.dir, LOCK)); const before = tree(f.workspace);
  assert.throws(() => applyZcodeConfigPlan(plan), /ZCODE_CONFIG_BUSY/); assert.deepEqual(tree(f.workspace), before); fs.rmdirSync(path.join(f.dir, LOCK));
  const original = fs.mkdirSync; t.mock.method(fs, 'mkdirSync', (...args) => { if (args[0] === path.join(f.dir, LOCK)) throw ioError('EACCES'); return original(...args); });
  assert.throws(() => applyZcodeConfigPlan(plan), /EACCES/); t.mock.restoreAll(); assert.equal(fs.readFileSync(f.file, 'utf8'), '{}');
});
test('failed fresh installation removes only its own empty directory and preserves foreign files', t => {
  const f = fixture(t, { zdir: false }), plan = planZcodeConfig(f), original = fs.writeFileSync; let injected = false;
  t.mock.method(fs, 'writeFileSync', (...args) => {
    if (!injected && String(args[0]).startsWith(f.receipt + '.')) { injected = true; original(path.join(f.dir, 'foreign.txt'), 'keep'); throw ioError('EIO'); }
    return original(...args);
  });
  assert.throws(() => applyZcodeConfigPlan(plan), /EIO/); t.mock.restoreAll(); assert.equal(injected, true);
  assert.equal(fs.readFileSync(path.join(f.dir, 'foreign.txt'), 'utf8'), 'keep'); assert.equal(fs.existsSync(f.file), false); assert.equal(fs.existsSync(f.receipt), false); clean(f);
});
test('post-commit lock cleanup failure reports committed state and preserves ownership receipt', t => {
  const f = fixture(t, { config: {} }), plan = planZcodeConfig(f), original = fs.rmdirSync;
  t.mock.method(fs, 'rmdirSync', (...args) => { if (args[0] === path.join(f.dir, LOCK)) throw ioError('EACCES'); return original(...args); });
  assert.throws(() => applyZcodeConfigPlan(plan), /ZCODE_CONFIG_COMMITTED_CLEANUP_FAILED/); t.mock.restoreAll();
  assert.equal(read(f).hooks.events.PreToolUse.length, 1); assert.equal(JSON.parse(fs.readFileSync(f.receipt)).status, 'committed');
});
for (const change of ['modified', 'removed']) test('uninstall restores only receipt-owned flag after hook is ' + change, t => {
  const f = fixture(t, { config: {} }); install(f); const current = read(f);
  if (change === 'modified') current.hooks.events.PreToolUse[0].userMetadata = 'keep';
  else current.hooks.events.PreToolUse = [];
  fs.writeFileSync(f.file, JSON.stringify(current)); uninstall(f);
  if (change === 'modified') assert.deepEqual(read(f), { hooks: { events: { PreToolUse: [{ ...owned(f), userMetadata: 'keep' }] } } });
  else assert.deepEqual(read(f), {});
  assert.equal(fs.existsSync(f.receipt), false);
});
test('read I/O error during apply keeps its sanitized code and original bytes', t => {
  const f = fixture(t, { config: {} }), plan = planZcodeConfig(f), original = fs.readFileSync; let injected = false;
  t.mock.method(fs, 'readFileSync', (...args) => { if (!injected && typeof args[0] === 'number') { injected = true; throw ioError('EACCES'); } return original(...args); });
  assert.throws(() => applyZcodeConfigPlan(plan), /EACCES/); t.mock.restoreAll(); assert.equal(injected, true);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{}'); assert.equal(fs.existsSync(f.receipt), false); clean(f);
});
test('temp ownership is not adopted from a replacement after exclusive creation', t => {
  const f = fixture(t, { config: {} }), plan = planZcodeConfig(f), open = fs.openSync; let replacement = null;
  t.mock.method(fs, 'openSync', (...args) => {
    const fd = open(...args);
    if (!replacement && String(args[0]).startsWith(f.receipt + '.') && args[1] === 'wx') {
      replacement = String(args[0]); fs.renameSync(replacement, replacement + '.parked'); fs.writeFileSync(replacement, 'foreign recovery file');
    }
    return fd;
  });
  assert.throws(() => applyZcodeConfigPlan(plan), /ZCODE_CONFIG_CHANGED|PATH_CHANGED/); t.mock.restoreAll(); assert.ok(replacement);
  assert.equal(fs.readFileSync(replacement, 'utf8'), 'foreign recovery file'); assert.equal(fs.readFileSync(f.file, 'utf8'), '{}');
});
for (const target of ['config', 'receipt']) for (const type of ['symlink', 'hardlink']) test('apply refuses ' + target + ' ' + type + ' introduced after planning', t => {
  const f = fixture(t, { config: {} }); if (target === 'receipt') install(f);
  const plan = target === 'config' ? planZcodeConfig(f) : planZcodeUninstall(f), file = target === 'config' ? f.file : f.receipt, external = path.join(f.root, 'external');
  if (type === 'symlink') { fs.renameSync(file, external); fs.symlinkSync(external, file, 'file'); }
  else fs.linkSync(file, external);
  const before = tree(f.root); assert.throws(() => applyZcodeConfigPlan(plan), /ZCODE_CONFIG_CHANGED/); assert.deepEqual(tree(f.root), before);
});
test('R3 hook insertion refuses output above the accepted 1MiB boundary before mutation', t => {
  const config = '{"padding":"' + 'x'.repeat(1048576 - 14) + '"}', f = fixture(t, { config });
  assert.equal(Buffer.byteLength(config), 1048576); const before = tree(f.workspace);
  assert.throws(() => planZcodeConfig(f), /ZCODE_CONFIG_UNSAFE/); assert.deepEqual(tree(f.workspace), before);
});
test('R3 compact config whose pretty encoding exceeds 1MiB refuses before mutation', t => {
  const config = { values: Array(120000).fill('x') }, raw = JSON.stringify(config), f = fixture(t, { config: raw });
  assert.ok(Buffer.byteLength(raw) < 1048576); assert.ok(Buffer.byteLength(JSON.stringify(config, null, 2) + '\n') > 1048576);
  const before = tree(f.workspace); assert.throws(() => planZcodeConfig(f), /ZCODE_CONFIG_UNSAFE/); assert.deepEqual(tree(f.workspace), before);
});
test('R3 below-limit config remains readable and supports uninstall recovery', t => {
  const original = { padding: 'x'.repeat(1048576 - 4096) }, f = fixture(t, { config: original });
  install(f); assert.ok(fs.statSync(f.file).size <= 1048576); assert.equal(planZcodeConfig(f).changed, false);
  uninstall(f); assert.deepEqual(read(f), original); assert.equal(fs.existsSync(f.receipt), false);
});
test('R3 oversized uninstall encoding preserves config and receipt until user data is reduced', t => {
  const f = fixture(t, { config: {} }); install(f); const config = read(f); config.values = Array(120000).fill('x');
  const raw = JSON.stringify(config); assert.ok(Buffer.byteLength(raw) < 1048576); fs.writeFileSync(f.file, raw);
  const before = tree(f.workspace); assert.throws(() => planZcodeUninstall(f), /ZCODE_CONFIG_UNSAFE/); assert.deepEqual(tree(f.workspace), before);
  config.values = ['keep']; fs.writeFileSync(f.file, JSON.stringify(config)); uninstall(f);
  assert.deepEqual(read(f), { values: ['keep'] }); assert.equal(fs.existsSync(f.receipt), false);
});

// Inject only a real destination read/inspection after a successful filesystem
// mutation; all staging writes, renames, identities and ordinary reads stay real.
function readbackFault(t, f, stage, onFailure = () => {}) {
  const open = fs.openSync, readFile = fs.readFileSync, rename = fs.renameSync, unlink = fs.unlinkSync, lstat = fs.lstatSync;
  const descriptors = new Map(), fault = { injected: false }; let target = null;
  t.mock.method(fs, 'openSync', (...args) => { const fd = open(...args); descriptors.set(fd, String(args[0])); return fd; });
  t.mock.method(fs, 'renameSync', (...args) => {
    let selected = stage === 'config' && args[1] === f.file;
    if (args[1] === f.receipt && ['initial intent', 'final receipt'].includes(stage)) {
      const status = JSON.parse(readFile(args[0], 'utf8')).status;
      selected = status === (stage === 'initial intent' ? 'pending' : 'committed');
    }
    const result = rename(...args); if (selected && !fault.injected) target = String(args[1]); return result;
  });
  t.mock.method(fs, 'unlinkSync', (...args) => {
    const result = unlink(...args);
    if (!fault.injected && ((stage === 'config deletion' && args[0] === f.file) || (stage === 'receipt deletion' && args[0] === f.receipt))) target = String(args[0]);
    return result;
  });
  const inject = () => { fault.injected = true; target = null; onFailure(); throw ioError('EACCES'); };
  t.mock.method(fs, 'readFileSync', (...args) => {
    if (!fault.injected && target && typeof args[0] === 'number' && descriptors.get(args[0]) === target) inject();
    return readFile(...args);
  });
  t.mock.method(fs, 'lstatSync', (...args) => {
    if (!fault.injected && target && stage.endsWith('deletion') && String(args[0]) === target) inject();
    return lstat(...args);
  });
  return fault;
}
for (const [verb, stage, originalAbsent] of [
  ['install', 'initial intent', false], ['install', 'config', false], ['install', 'final receipt', false],
  ['install', 'initial intent', true], ['uninstall', 'initial intent', false], ['uninstall', 'config', false],
  ['uninstall', 'config deletion', true], ['uninstall', 'receipt deletion', false], ['uninstall', 'receipt deletion', true],
]) test('R4 transient ' + stage + ' readback restores exact ' + verb + ' inputs' + (originalAbsent ? ' with absent original config' : ''), t => {
  const f = fixture(t, originalAbsent ? {} : { config: '\r\n{ "theme": "dark" }\r\n' });
  if (verb === 'uninstall') install(f);
  const configBefore = fs.existsSync(f.file) ? fs.readFileSync(f.file) : null, receiptBefore = fs.existsSync(f.receipt) ? fs.readFileSync(f.receipt) : null;
  const plan = verb === 'install' ? planZcodeConfig(f) : planZcodeUninstall(f), fault = readbackFault(t, f, stage);
  assert.throws(() => applyZcodeConfigPlan(plan), /EACCES/); t.mock.restoreAll(); assert.equal(fault.injected, true);
  assert.deepEqual(fs.existsSync(f.file) ? fs.readFileSync(f.file) : null, configBefore);
  assert.deepEqual(fs.existsSync(f.receipt) ? fs.readFileSync(f.receipt) : null, receiptBefore);
  assert.doesNotThrow(() => planZcodeConfig(f)); assert.doesNotThrow(() => planZcodeUninstall(f)); clean(f);
});
test('R4 finalized receipt readback plus rollback failure re-arms pending and blocks later planners', t => {
  const f = fixture(t, { config: {} }), plan = planZcodeConfig(f), fault = readbackFault(t, f, 'final receipt'), rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (...args) => { if (fault.injected && args[1] === f.file) throw ioError('EIO'); return rename(...args); });
  assert.throws(() => applyZcodeConfigPlan(plan), /ZCODE_CONFIG_RECOVERY_REQUIRED/); t.mock.restoreAll(); assert.equal(fault.injected, true);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).status, 'pending'); assert.equal(read(f).hooks.events.PreToolUse.length, 1);
  for (const planner of [planZcodeConfig, planZcodeUninstall]) assert.throws(() => planner(f), /ZCODE_CONFIG_RECOVERY_REQUIRED/); clean(f);
});
for (const change of ['edit', 'replacement']) test('R4 config readback fault never rolls back a concurrent operator ' + change, t => {
  const f = fixture(t, { config: {} }), plan = planZcodeConfig(f); let operatorIno = null;
  const fault = readbackFault(t, f, 'config', () => {
    if (change === 'replacement') fs.renameSync(f.file, f.file + '.operator-backup');
    fs.writeFileSync(f.file, '{"operator":"keep"}'); operatorIno = String(fs.lstatSync(f.file, { bigint: true }).ino);
  });
  assert.throws(() => applyZcodeConfigPlan(plan), /ZCODE_CONFIG_RECOVERY_REQUIRED/); t.mock.restoreAll(); assert.equal(fault.injected, true);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{"operator":"keep"}'); assert.equal(String(fs.lstatSync(f.file, { bigint: true }).ino), operatorIno);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).status, 'pending');
  for (const planner of [planZcodeConfig, planZcodeUninstall]) assert.throws(() => planner(f), /ZCODE_CONFIG_RECOVERY_REQUIRED/); clean(f);
});
for (const cleanupFailure of [false, true]) test('R4 failure to re-arm finalized receipt reports committed state rather than false pending recovery' + (cleanupFailure ? ' with cleanup failure' : ''), t => {
  const f = fixture(t, { config: {} }), plan = planZcodeConfig(f), fault = readbackFault(t, f, 'final receipt'), write = fs.writeFileSync, rmdir = fs.rmdirSync; let cleanupInjected = false;
  t.mock.method(fs, 'writeFileSync', (...args) => {
    if (fault.injected && String(args[0]).startsWith(f.receipt + '.') && JSON.parse(String(args[1])).status === 'pending') throw ioError('EIO');
    return write(...args);
  });
  if (cleanupFailure) t.mock.method(fs, 'rmdirSync', (...args) => {
    if (args[0] === path.join(f.dir, LOCK)) { cleanupInjected = true; throw ioError('EACCES'); }
    return rmdir(...args);
  });
  assert.throws(() => applyZcodeConfigPlan(plan), error => {
    assert.equal(error.message, 'ZCODE_CONFIG_COMMITTED_RECOVERY_FAILED');
    assert.equal(error.cleanupCode, cleanupFailure ? 'EACCES' : undefined); return true;
  }); t.mock.restoreAll(); assert.equal(fault.injected, true); assert.equal(cleanupInjected, cleanupFailure);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).status, 'committed'); assert.equal(read(f).hooks.events.PreToolUse.length, 1);
  assert.equal(planZcodeConfig(f).changed, false); assert.equal(planZcodeUninstall(f).changed, true);
  if (cleanupFailure) assert.equal(fs.existsSync(path.join(f.dir, LOCK)), true); else clean(f);
});
test('R4 finalized readback fault preserves operator drift and reports committed uncertainty', t => {
  const f = fixture(t, { config: {} }), plan = planZcodeConfig(f); let operatorIno = null;
  const fault = readbackFault(t, f, 'final receipt', () => {
    fs.writeFileSync(f.file, '{"operator":"keep"}'); operatorIno = String(fs.lstatSync(f.file, { bigint: true }).ino);
  });
  assert.throws(() => applyZcodeConfigPlan(plan), /ZCODE_CONFIG_COMMITTED_RECOVERY_FAILED/); t.mock.restoreAll(); assert.equal(fault.injected, true);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{"operator":"keep"}'); assert.equal(String(fs.lstatSync(f.file, { bigint: true }).ino), operatorIno);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).status, 'committed'); assert.doesNotThrow(() => planZcodeUninstall(f)); clean(f);
});
for (const cleanupFailure of [false, true]) test('R4b receipt operator drift retains uncertain status' + (cleanupFailure ? ' with cleanup failure' : ''), t => {
  const f = fixture(t, { config: {} }), plan = planZcodeConfig(f), rmdir = fs.rmdirSync; let operatorIno = null, cleanupInjected = false;
  const fault = readbackFault(t, f, 'final receipt', () => {
    fs.writeFileSync(f.receipt, '{"operator":"keep"}'); operatorIno = String(fs.lstatSync(f.receipt, { bigint: true }).ino);
  });
  if (cleanupFailure) t.mock.method(fs, 'rmdirSync', (...args) => {
    if (args[0] === path.join(f.dir, LOCK)) { cleanupInjected = true; throw ioError('EACCES'); }
    return rmdir(...args);
  });
  assert.throws(() => applyZcodeConfigPlan(plan), error => {
    assert.equal(error.message, 'ZCODE_CONFIG_RECOVERY_UNCERTAIN');
    assert.equal(error.cleanupCode, cleanupFailure ? 'EACCES' : undefined); return true;
  }); t.mock.restoreAll(); assert.equal(fault.injected, true); assert.equal(cleanupInjected, cleanupFailure);
  assert.equal(fs.readFileSync(f.receipt, 'utf8'), '{"operator":"keep"}');
  assert.equal(String(fs.lstatSync(f.receipt, { bigint: true }).ino), operatorIno); assert.equal(read(f).hooks.events.PreToolUse.length, 1);
  for (const planner of [planZcodeConfig, planZcodeUninstall]) assert.throws(() => planner(f), /ZCODE_RECEIPT_INVALID/);
  if (cleanupFailure) assert.equal(fs.existsSync(path.join(f.dir, LOCK)), true); else clean(f);
});
for (const target of ['receipt', 'config']) for (const fault of ['operator data', 'prewrite', 'partial']) test('R5 ' + target + ' temp content ownership after ' + fault + ' EIO', t => {
  const f = fixture(t, { config: '{}' }), plan = planZcodeConfig(f), write = fs.writeFileSync;
  const prefix = (target === 'receipt' ? f.receipt : f.file) + '.';
  let temp = null, tempIno = null;
  t.mock.method(fs, 'writeFileSync', (...args) => {
    if (!temp && String(args[0]).startsWith(prefix)) {
      temp = String(args[0]); tempIno = String(fs.lstatSync(temp, { bigint: true }).ino);
      if (fault !== 'prewrite') write(temp, fault === 'partial' ? '{' : 'OPERATOR DATA', args[2]);
      throw ioError('EIO');
    }
    return write(...args);
  });
  assert.throws(() => applyZcodeConfigPlan(plan), error => { assert.equal(error.message, 'EIO'); return true; });
  t.mock.restoreAll(); assert.ok(temp);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{}'); assert.equal(fs.existsSync(f.receipt), false);
  assert.equal(fs.existsSync(path.join(f.dir, LOCK)), false);
  if (fault === 'prewrite') { assert.equal(fs.existsSync(temp), false); assert.deepEqual(fs.readdirSync(f.dir), ['config.json']); }
  else {
    assert.equal(fs.readFileSync(temp, 'utf8'), fault === 'partial' ? '{' : 'OPERATOR DATA');
    assert.equal(String(fs.lstatSync(temp, { bigint: true }).ino), tempIno);
    assert.deepEqual(fs.readdirSync(f.dir).sort(), ['config.json', path.basename(temp)].sort());
  }
});
// ZC-07 remains OPEN: pathname checks are not an OS-atomic final-syscall sandbox.
// The retained adversarial syscall-seam reproduction is evidence, not a passing test.
