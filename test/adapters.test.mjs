import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handleZcode, zcodeHookConfig } from '../src/adapters/zcode.mjs';
import { apply } from '../src/adapters/dsh.mjs';
import { fixture } from './helpers.mjs';
const cli = fileURLToPath(new URL('../bin/gstack861.mjs', import.meta.url));
const event = f => ({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'src/new' }, cwd: f.workspace });

test('ZCode snake_case payload maps to an abstaining result', t => {
  const f = fixture(t);
  assert.deepEqual(handleZcode(event(f), f.policy), { output: {}, exitCode: 0 });
});
test('ZCode camelCase aliases are accepted', t => {
  const f = fixture(t);
  assert.equal(handleZcode({ hookEventName: 'PreToolUse', toolName: 'Read', toolInput: { file_path: 'src/a.txt' }, cwd: f.workspace }, f.policy).exitCode, 0);
});
test('ZCode conflicting aliases fail closed', t => {
  const f = fixture(t);
  assert.equal(handleZcode({ ...event(f), toolName: 'Bash' }, f.policy).exitCode, 2);
});
test('ZCode denials return both protocol denial and exit code 2', t => {
  const f = fixture(t), result = handleZcode({ ...event(f), tool_name: 'Bash' }, f.policy);
  assert.equal(result.exitCode, 2);
  assert.equal(result.output.hookSpecificOutput.permissionDecision, 'deny');
});
test('ZCode rejects unrelated or malformed events', t => {
  const f = fixture(t);
  for (const e of [null, [], {}, { ...event(f), hook_event_name: 'Stop' }]) assert.equal(handleZcode(e, f.policy).exitCode, 2);
});
test('ZCode config uses wildcard synchronous process hooks and argv, not shell interpolation', t => {
  const f = fixture(t), result = zcodeHookConfig({ nodePath: process.execPath, cliPath: cli, policyPath: f.policyPath });
  const entry = result.hooks.events.PreToolUse[0];
  assert.equal(entry.matcher, '.*');
  assert.equal(entry.hooks[0].type, 'process');
  assert.deepEqual(entry.hooks[0].args, [cli, 'hook', 'zcode', '--policy', f.policyPath]);
  assert.equal(entry.hooks[0].async, undefined);
  assert.throws(() => zcodeHookConfig({ nodePath: 'node', cliPath: cli, policyPath: f.policyPath }));
});
test('real hook subprocess accepts a valid request and refuses an out-of-scope request', t => {
  const f = fixture(t);
  const run = input => spawnSync(process.execPath, [cli, 'hook', 'zcode', '--policy', f.policyPath], { input: JSON.stringify(input), encoding: 'utf8', timeout: 5000 });
  const pass = run(event(f));
  assert.equal(pass.status, 0, pass.stderr);
  assert.deepEqual(JSON.parse(pass.stdout), {});
  const denied = run({ ...event(f), tool_input: { file_path: path.join(f.outside, 'secret.txt') } });
  assert.equal(denied.status, 2);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(fs.readFileSync(path.join(f.outside, 'secret.txt'), 'utf8'), 'fixture-only');
});
test('real hook subprocess denies invalid JSON, missing policy, and oversized payloads', t => {
  const f = fixture(t);
  for (const [p, input] of [[f.policyPath, '{'], [f.policyPath + '.missing', '{}'], [f.policyPath, 'x'.repeat(1048577)]]) {
    const child = spawnSync(process.execPath, [cli, 'hook', 'zcode', '--policy', p], { input, encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 2);
    assert.equal(JSON.parse(child.stdout).hookSpecificOutput.permissionDecision, 'deny');
  }
});
test('CLI config generation does not modify existing files', t => {
  const f = fixture(t), before = fs.readFileSync(f.policyPath, 'utf8');
  const child = spawnSync(process.execPath, [cli, 'zcode-config', '--policy', f.policyPath], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).hooks.enabled, true);
  assert.equal(fs.readFileSync(f.policyPath, 'utf8'), before);
});
test('DSH registers a monotonic guard, not a permissive waterfall', t => {
  const f = fixture(t);
  let guard;
  const dispose = () => {};
  assert.equal(apply({ tools: { guard(fn) { guard = fn; return dispose; } } }, { policyPath: f.policyPath }), dispose);
  assert.equal(guard({ name: 'write_file', arguments: { path: path.join(f.src, 'new') } }), undefined);
  assert.match(guard({ name: 'run_code', arguments: {} }), /UNMAPPED_TOOL/);
  assert.match(guard({ name: 'write_file', arguments: { path: 'src/new' } }), /INVALID_PATH_OR_CALL/);
  assert.match(guard({ name: 'write_file', arguments: { path: path.join(f.outside, 'new') } }), /OUTSIDE_SCOPE/);
});
test('DSH plugin activation refuses missing guard API or invalid policy', t => {
  const f = fixture(t);
  assert.throws(() => apply({}, { policyPath: f.policyPath }), /MONOTONIC_GUARD/);
  assert.throws(() => apply({ tools: { guard() {} } }, {}), /POLICY_PATH/);
  assert.throws(() => apply({ tools: { guard() {} } }, { policyPath: f.policyPath + '.missing' }));
});
test('DSH checks policy on every call and refuses corruption or cancellation', t => {
  const f = fixture(t); let guard;
  apply({ tools: { guard(fn) { guard = fn; } } }, { policyPath: f.policyPath });
  const exec = { name: 'write_file', arguments: { path: path.join(f.src, 'new') } };
  assert.equal(guard(exec), undefined);
  assert.match(guard({ ...exec, signal: AbortSignal.abort() }), /CANCELLED/);
  fs.writeFileSync(f.policyPath, '{');
  assert.match(guard(exec), /POLICY_UNAVAILABLE/);
});
test('doctor makes no claim of host or full-parity certification', () => {
  const child = spawnSync(process.execPath, [cli, 'doctor'], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  const info = JSON.parse(child.stdout);
  assert.equal(info.hosts.zcode, 'not-host-verified');
  assert.equal(info.hosts.dsh, 'not-host-verified');
  assert.equal(info.modelCalls, 0);
});
