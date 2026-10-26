import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compilePolicy, evaluate, loadPolicy, inside } from '../src/policy.mjs';
import { fixture } from './helpers.mjs';

const call = (f, file, tool = 'Write') => ({ host: 'zcode', tool, input: { file_path: file }, cwd: f.workspace });

test('in-scope writes abstain without overriding host permissions', t => {
  const f = fixture(t);
  assert.equal(evaluate(f.policy, call(f, 'src/new.txt')).decision, 'abstain');
});
test('read roots and write roots have independent scope', t => {
  const f = fixture(t), file = path.join(f.locked, 'read.txt');
  fs.writeFileSync(file, 'fixture');
  assert.equal(evaluate(f.policy, call(f, file, 'Read')).decision, 'abstain');
  assert.equal(evaluate(f.policy, call(f, file)).code, 'OUTSIDE_SCOPE');
});
test('prefix lookalike directories are not children', t => {
  const f = fixture(t), sibling = f.src + '-other';
  fs.mkdirSync(sibling);
  assert.equal(evaluate(f.policy, call(f, path.join(sibling, 'a'))).code, 'OUTSIDE_SCOPE');
  assert.equal(inside(f.src, sibling), false);
});
test('traversal components are rejected before filesystem normalization', t => {
  const f = fixture(t);
  assert.equal(evaluate(f.policy, call(f, 'src/../src/a.txt')).decision, 'deny');
});
test('symlink escape with a not-yet-existing leaf is blocked', t => {
  const f = fixture(t);
  fs.symlinkSync(f.outside, path.join(f.src, 'escape'));
  assert.equal(evaluate(f.policy, call(f, 'src/escape/new/deep.txt')).code, 'OUTSIDE_SCOPE');
});
test('dangling symlink fails closed', t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.outside, 'missing'), path.join(f.src, 'dangling'));
  assert.equal(evaluate(f.policy, call(f, 'src/dangling')).decision, 'deny');
});
test('an existing in-scope symlink resolves to the actual file', t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.src, 'a.txt'), path.join(f.src, 'alias'));
  assert.equal(evaluate(f.policy, call(f, 'src/alias')).decision, 'abstain');
});
test('existing hardlinks cannot be modified through the guard', t => {
  const f = fixture(t);
  fs.linkSync(path.join(f.outside, 'secret.txt'), path.join(f.src, 'linked'));
  assert.equal(evaluate(f.policy, call(f, 'src/linked')).code, 'UNSAFE_WRITE_TARGET');
});
test('directories cannot be mutated by a file tool binding', t => {
  const f = fixture(t);
  assert.equal(evaluate(f.policy, call(f, f.src)).code, 'UNSAFE_WRITE_TARGET');
});
test('VCS metadata remains protected when the whole workspace is writable', t => {
  const f = fixture(t), policy = compilePolicy({ ...f.raw, writeRoots: [f.workspace] });
  assert.equal(evaluate(policy, call(f, '.git/config')).code, 'PROTECTED_PATH');
  assert.equal(evaluate(policy, call(f, 'locked/new')).code, 'PROTECTED_PATH');
});
test('unknown, Shell, delegation and MCP names are denied by default', t => {
  const f = fixture(t);
  for (const tool of ['Bash', 'Task', 'run_code', 'mcp__fs__write', 'constructor']) assert.equal(evaluate(f.policy, call(f, 'src/a', tool)).decision, 'deny');
});
test('missing path, invalid payload and unknown host are refused', t => {
  const f = fixture(t);
  for (const input of [{}, [], null, { file_path: 3 }]) assert.equal(evaluate(f.policy, { host: 'zcode', tool: 'Write', input }).decision, 'deny');
  assert.equal(evaluate(f.policy, { host: 'claude', tool: 'Write', input: {} }).decision, 'deny');
});
test('a relative path without a known cwd is refused', t => {
  const f = fixture(t);
  assert.equal(evaluate(f.policy, { host: 'dsh', tool: 'write_file', input: { path: 'src/a' } }).decision, 'deny');
});
test('absolute DSH paths work without guessing the session cwd', t => {
  const f = fixture(t);
  assert.equal(evaluate(f.policy, { host: 'dsh', tool: 'write_file', input: { path: path.join(f.src, 'a.txt') } }).decision, 'abstain');
});
test('an uncompiled or mutated policy cannot grant access', t => {
  const f = fixture(t);
  assert.equal(evaluate(f.raw, call(f, 'src/a')).code, 'INVALID_POLICY');
  assert.throws(() => { f.policy.writeRoots.push(f.outside); }, TypeError);
});
test('invalid config schema, roots, effects and typo keys fail validation', t => {
  const f = fixture(t);
  for (const raw of [null, { ...f.raw, schemaVersion: 2 }, { ...f.raw, typo: true }, { ...f.raw, writeRoots: [f.outside] },
    { ...f.raw, bindings: { zcode: { Bash: { effect: 'execute', pathKey: 'command' } } } }]) assert.throws(() => compilePolicy(raw));
});
test('stable policy hash is order-independent and changes with scope', t => {
  const f = fixture(t);
  assert.equal(compilePolicy({ ...f.raw }).policyHash, f.policy.policyHash);
  assert.notEqual(compilePolicy({ ...f.raw, writeRoots: [] }).policyHash, f.policy.policyHash);
});
test('policy file must be outside the model-editable workspace', t => {
  const f = fixture(t), p = path.join(f.src, 'policy.json');
  fs.writeFileSync(p, JSON.stringify(f.raw), { mode: 0o600 });
  assert.throws(() => loadPolicy(p), /POLICY_MUST_BE_OUTSIDE_WORKSPACE/);
  assert.equal(loadPolicy(f.policyPath).policyHash, f.policy.policyHash);
});
test('policy symlinks and writable-by-others policies are rejected', t => {
  const f = fixture(t), alias = path.join(f.base, 'alias');
  fs.symlinkSync(f.policyPath, alias);
  assert.throws(() => loadPolicy(alias), /UNSAFE_POLICY_FILE/);
  if (process.platform !== 'win32') {
    fs.chmodSync(f.policyPath, 0o666);
    assert.throws(() => loadPolicy(f.policyPath), /UNSAFE_POLICY_PERMISSIONS/);
  }
});
test('file-as-parent, NUL, foreign separators and cwd escapes fail closed', t => {
  const f = fixture(t);
  for (const file of ['src/a.txt/new', 'src/a\u0000.txt', 'src\\a.txt']) assert.equal(evaluate(f.policy, call(f, file)).decision, 'deny');
  assert.equal(evaluate(f.policy, { ...call(f, 'new'), cwd: f.outside }).decision, 'deny');
});

test('VCS symlink targets remain protected even after policy compilation', t => {
  const f = fixture(t), policy = compilePolicy({ ...f.raw, writeRoots: [f.workspace] });
  const actual = path.join(f.workspace, 'vcs-data'); fs.mkdirSync(actual);
  fs.rmdirSync(path.join(f.workspace, '.git'));
  fs.symlinkSync(actual, path.join(f.workspace, '.git'));
  assert.equal(evaluate(policy, call(f, '.git/config')).code, 'PROTECTED_PATH');
  assert.equal(evaluate(policy, call(f, 'vcs-data/config')).code, 'PROTECTED_PATH');
});
