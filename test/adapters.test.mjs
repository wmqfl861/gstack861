import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handleZcode, zcodeHookConfig } from '../src/adapters/zcode.mjs';
import { apply } from '../src/adapters/dsh.mjs';
import { ApprovalStore } from '../src/approvals.mjs';
import { fixture, repository } from './helpers.mjs';
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
  for (const [p, input] of [[f.policyPath, '{'], [f.policyPath + '.missing', '{}'], [f.policyPath, 'x'.repeat(4 * 1024 * 1024 + 1)]]) {
    const child = spawnSync(process.execPath, [cli, 'hook', 'zcode', '--policy', p], { input, encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 2);
    assert.equal(JSON.parse(child.stdout).hookSpecificOutput.permissionDecision, 'deny');
  }
});
test('real hook subprocess accepts valid payloads above 1 MiB and below the 4 MiB cap', t => {
  const f = fixture(t);
  // Hosts embed file contents in tool_input: a >1 MiB valid request must pass the cap
  // (the old limit) and be policy-evaluated normally, not refused by size alone.
  const big = JSON.stringify({ ...event(f), tool_input: { file_path: 'src/new', content: 'x'.repeat(2 * 1024 * 1024) } });
  assert.ok(big.length > 1024 * 1024 && big.length < 4 * 1024 * 1024);
  const child = spawnSync(process.execPath, [cli, 'hook', 'zcode', '--policy', f.policyPath], { input: big, encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {});
});
test('CLI config generation does not modify existing files', t => {
  const f = fixture(t), before = fs.readFileSync(f.policyPath, 'utf8');
  const child = spawnSync(process.execPath, [cli, 'zcode-config', '--policy', f.policyPath], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).hooks.enabled, true);
  assert.equal(fs.readFileSync(f.policyPath, 'utf8'), before);
});
test('ZCode hook config can scope the matcher to bound file tools only', t => {
  const f = fixture(t);
  const scoped = zcodeHookConfig({ nodePath: process.execPath, cliPath: cli, policyPath: f.policyPath, matcher: 'Read|Write|Edit' });
  assert.equal(scoped.hooks.events.PreToolUse[0].matcher, 'Read|Write|Edit');
  assert.throws(() => zcodeHookConfig({ nodePath: process.execPath, cliPath: cli, policyPath: f.policyPath, matcher: '((' }), /INVALID_MATCHER/);
});
test('ZCode hook config matcher refusals are a conservative emission choice', t => {
  const f = fixture(t);
  // The host actually treats '*' as match-all (not a regex-compile failure); a trailing '\'
  // and 'a**b' are not compilable regexes. Refusing all three is this generator's
  // conservative choice about what it emits, not a host limit (src/adapters/zcode.mjs).
  for (const matcher of ['*', '\\', 'a**b']) {
    assert.throws(() => zcodeHookConfig({ nodePath: process.execPath, cliPath: cli, policyPath: f.policyPath, matcher }), /INVALID_MATCHER/);
  }
});
test('CLI generate, install and uninstall round-trip real skill packages', t => {
  const r = repository(t), staging = path.join(r.base, 'staging'), target = path.join(r.base, 'target');
  const run = (...a) => spawnSync(process.execPath, [cli, ...a], { encoding: 'utf8', timeout: 30000 });
  // The fixture commit arrives via GSTACK861_TEST_COMMIT (was: --commit flag); the
  // assertions below are unchanged in strength — only the value source moved.
  const gen = spawnSync(process.execPath, [cli, 'generate', '--upstream', r.root, '--staging', staging, '--host', 'zcode'],
    { encoding: 'utf8', timeout: 30000, env: { ...process.env, GSTACK861_TEST_COMMIT: r.commit } });
  assert.equal(gen.status, 0, gen.stderr);
  assert.equal(JSON.parse(gen.stdout).generated, 2);
  assert.match(gen.stderr, new RegExp(`^gstack861: TEST_COMMIT_OVERRIDE active \\(${r.commit.slice(0, 12)}\\)`));
  assert.ok(fs.existsSync(path.join(staging, 'review', 'manifest.json')));
  const inst = run('install', '--staging', staging, '--target', target);
  assert.equal(inst.status, 0, inst.stderr);
  assert.deepEqual(JSON.parse(inst.stdout), { installed: ['investigate', 'review'], skipped: [], backedUp: [] });
  assert.deepEqual(JSON.parse(run('install', '--staging', staging, '--target', target).stdout).skipped, ['investigate', 'review']);
  const un = run('uninstall', '--target', target);
  assert.equal(un.status, 0, un.stderr);
  assert.deepEqual(JSON.parse(un.stdout).uninstalled.sort(), ['investigate', 'review']);
  assert.ok(!fs.existsSync(path.join(target, 'review')));
  assert.ok(!fs.existsSync(path.join(target, 'investigate')));
});
test('generate --commit is removed; GSTACK861_TEST_COMMIT drives the pin and announces itself on stderr', t => {
  const r = repository(t), staging = path.join(r.base, 'staging');
  // The flag itself is gone: passing it is now an argument error that writes nothing.
  const refused = spawnSync(process.execPath, [cli, 'generate', '--upstream', r.root, '--staging', staging, '--host', 'zcode', '--commit', r.commit], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /INVALID_ARGUMENTS/);
  assert.ok(!fs.existsSync(staging));
  // The env var is honored, announced with the first 12 chars, and the run succeeds.
  const gen = spawnSync(process.execPath, [cli, 'generate', '--upstream', r.root, '--staging', staging, '--host', 'zcode'],
    { encoding: 'utf8', env: { ...process.env, GSTACK861_TEST_COMMIT: r.commit } });
  assert.equal(gen.status, 0, gen.stderr);
  assert.equal(JSON.parse(gen.stdout).generated, 2);
  assert.equal(gen.stderr, `gstack861: TEST_COMMIT_OVERRIDE active (${r.commit.slice(0, 12)})\n`);
  // A value that is not a full 40-hex commit is refused without the notice.
  const bad = spawnSync(process.execPath, [cli, 'generate', '--upstream', r.root, '--staging', path.join(r.base, 's2'), '--host', 'zcode'],
    { encoding: 'utf8', env: { ...process.env, GSTACK861_TEST_COMMIT: 'short' } });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /FULL_COMMIT_REQUIRED/);
  assert.equal(bad.stderr.includes('TEST_COMMIT_OVERRIDE'), false);
  assert.ok(!fs.existsSync(path.join(r.base, 's2')));
});
test('CLI rejects unknown commands and bad arguments with prefixed codes and non-zero exit', () => {
  const usage = spawnSync(process.execPath, [cli, 'nope'], { encoding: 'utf8' });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /^Usage:/);
  const bad = spawnSync(process.execPath, [cli, 'generate', '--upstream', 'relative/path', '--staging', 'C:/abs', '--host', 'zcode'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^gstack861:/);
});
test('approvals CLI lists, approves bound subjects, and refuses mismatches or replay', t => {
  const f = fixture(t), state = path.join(f.base, 'approvals');
  const store = new ApprovalStore(state);
  const subject = { host: 'zcode', sessionId: 's1', runId: 'r1', policyHash: f.policy.policyHash,
    action: { tool: 'Write', input: { file_path: 'src/a' } } };
  const id = store.issue(subject);
  const actionFile = path.join(f.base, 'action.json');
  fs.writeFileSync(actionFile, JSON.stringify(subject.action));
  const list = spawnSync(process.execPath, [cli, 'approvals', 'list', '--state', state], { encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout)[0].state, 'pending');
  const approve = ['approvals', 'approve', '--state', state, '--id', id, '--host', 'zcode', '--session', 's1',
    '--run', 'r1', '--policy-hash', subject.policyHash, '--action-file', actionFile];
  const ok = spawnSync(process.execPath, [cli, ...approve], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).state, 'approved');
  // CLI approval and core consume share one store: single consumption still enforced across channels.
  assert.equal(store.consume(id, subject).state, 'consumed');
  const replay = spawnSync(process.execPath, [cli, ...approve], { encoding: 'utf8' });
  assert.equal(replay.status, 1);
  assert.match(replay.stderr, /APPROVAL_WRONG_STATE/);
  const other = store.issue(subject);
  const mismatch = spawnSync(process.execPath, [cli, 'approvals', 'approve', '--state', state, '--id', other,
    '--host', 'zcode', '--session', 'other-session', '--run', 'r1', '--policy-hash', subject.policyHash, '--action-file', actionFile], { encoding: 'utf8' });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /APPROVAL_BINDING_MISMATCH/);
});
test('approvals CLI rejects unknown subcommands, invented states and malformed action files', t => {
  const f = fixture(t), state = path.join(f.base, 'approvals');
  const store = new ApprovalStore(state);
  const subject = { host: 'zcode', sessionId: 's1', runId: 'r1', policyHash: f.policy.policyHash, action: { tool: 'Write', input: { file_path: 'src/a' } } };
  const id = store.issue(subject);
  // Unknown subcommand must fail before the store constructor creates any state directory.
  const absent = path.join(f.base, 'never-created');
  const bogus = spawnSync(process.execPath, [cli, 'approvals', 'bogus', '--state', absent], { encoding: 'utf8' });
  assert.equal(bogus.status, 1);
  assert.match(bogus.stderr, /UNKNOWN_SUBCOMMAND/);
  assert.equal(fs.existsSync(absent), false, 'unknown subcommand must not leave a state directory behind');
  // Read views must refuse records carrying states outside the state machine.
  fs.writeFileSync(store.file(id), JSON.stringify({ ...JSON.parse(fs.readFileSync(store.file(id), 'utf8')), state: 'invented-state' }) + '\n');
  const show = spawnSync(process.execPath, [cli, 'approvals', 'show', '--state', state, '--id', id], { encoding: 'utf8' });
  assert.equal(show.status, 1);
  assert.match(show.stderr, /INVALID_APPROVAL_RECORD/);
  // Malformed action files surface a stable code, not a raw V8 parse message.
  const badAction = path.join(f.base, 'bad-action.json');
  fs.writeFileSync(badAction, '{ not json');
  const approve = spawnSync(process.execPath, [cli, 'approvals', 'approve', '--state', state, '--id', id, '--host', 'zcode',
    '--session', 's1', '--run', 'r1', '--policy-hash', subject.policyHash, '--action-file', badAction], { encoding: 'utf8' });
  assert.equal(approve.status, 1);
  assert.match(approve.stderr, /gstack861: INVALID_ACTION_FILE/);
});
test('approvals CLI action-file failures are scoped: missing files INVALID_ACTION_FILE, relative paths ABSOLUTE_PATH_REQUIRED', t => {
  const f = fixture(t), state = path.join(f.base, 'approvals');
  const base = [cli, 'approvals', 'approve', '--state', state, '--id', '00000000-0000-4000-8000-000000000000',
    '--host', 'zcode', '--session', 's1', '--run', 'r1', '--policy-hash', f.policy.policyHash];
  // A missing action file previously leaked the raw ENOENT message.
  const missing = spawnSync(process.execPath, [...base, '--action-file', path.join(f.base, 'absent-action.json')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /gstack861: INVALID_ACTION_FILE/);
  // A relative --action-file keeps its own path-semantics code; it must not be masked as INVALID_ACTION_FILE.
  const relative = spawnSync(process.execPath, [...base, '--action-file', 'relative-action.json'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(relative.status, 1);
  assert.match(relative.stderr, /gstack861: ABSOLUTE_PATH_REQUIRED/);
  assert.equal(relative.stderr.includes('INVALID_ACTION_FILE'), false);
});
test('approvals CLI issue→verify→approve→consume chain; verify mismatch stays read-only; replay refused', t => {
  const f = fixture(t), state = path.join(f.base, 'approvals');
  const action = { tool: 'Write', input: { file_path: 'src/a' } };
  const actionFile = path.join(f.base, 'action.json');
  fs.writeFileSync(actionFile, JSON.stringify(action));
  const run = (...a) => spawnSync(process.execPath, [cli, 'approvals', ...a], { encoding: 'utf8', timeout: 10000 });
  const subject = ['--host', 'zcode', '--session', 's1', '--run', 'r1', '--policy-hash', f.policy.policyHash, '--action-file', actionFile];
  const issue = run('issue', '--state', state, ...subject, '--ttl-ms', '60000');
  assert.equal(issue.status, 0, issue.stderr);
  const id = JSON.parse(issue.stdout);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const recordFile = path.join(state, `approval-${id}.json`);
  const verifyMatch = run('verify', '--state', state, '--id', id, ...subject);
  assert.equal(verifyMatch.status, 0, verifyMatch.stderr);
  assert.deepEqual(JSON.parse(verifyMatch.stdout), { id, state: 'pending', binding: 'match' });
  const mismatch = run('verify', '--state', state, '--id', id, '--host', 'zcode', '--session', 'other-session',
    '--run', 'r1', '--policy-hash', f.policy.policyHash, '--action-file', actionFile);
  assert.equal(mismatch.status, 0, mismatch.stderr);
  assert.deepEqual(JSON.parse(mismatch.stdout), { id, state: 'pending', binding: 'mismatch' });
  // Read-only proof: two verifies plus the issue leave the record bytes and state untouched,
  // and the record still contains a digest only — never the action payload (red line).
  const issued = fs.readFileSync(recordFile, 'utf8');
  run('verify', '--state', state, '--id', id, ...subject);
  assert.equal(fs.readFileSync(recordFile, 'utf8'), issued);
  assert.equal(JSON.parse(issued).state, 'pending');
  assert.equal(issued.includes('src/a'), false);
  const approve = run('approve', '--state', state, '--id', id, ...subject);
  assert.equal(approve.status, 0, approve.stderr);
  assert.equal(JSON.parse(approve.stdout).state, 'approved');
  const consume = run('consume', '--state', state, '--id', id, ...subject);
  assert.equal(consume.status, 0, consume.stderr);
  assert.equal(JSON.parse(consume.stdout).state, 'consumed');
  const replay = run('consume', '--state', state, '--id', id, ...subject);
  assert.equal(replay.status, 1);
  assert.match(replay.stderr, /APPROVAL_WRONG_STATE/);
});
test('approvals CLI issue validates ttl-ms and refuses unknown subcommands before creating state', t => {
  const f = fixture(t);
  const actionFile = path.join(f.base, 'action.json');
  fs.writeFileSync(actionFile, JSON.stringify({ kind: 'publish' }));
  const subject = ['--host', 'zcode', '--session', 's1', '--run', 'r1', '--policy-hash', f.policy.policyHash, '--action-file', actionFile];
  const run = dir => spawnSync(process.execPath, [cli, 'approvals', 'issue', '--state', dir, ...subject, '--ttl-ms', '0'], { encoding: 'utf8', timeout: 10000 });
  const refused = run(path.join(f.base, 'never-created'));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /INVALID_TTL/);
  assert.equal(fs.existsSync(path.join(f.base, 'never-created')), false, 'a refused ttl must not leave a state directory behind');
  const badNumber = spawnSync(process.execPath, [cli, 'approvals', 'issue', '--state', path.join(f.base, 'never-created2'),
    ...subject, '--ttl-ms', 'abc'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(badNumber.status, 1);
  assert.match(badNumber.stderr, /INVALID_TTL/);
});
test('tasks CLI create→start→interrupt→resume→complete smoke records owner and states', t => {
  const f = fixture(t), state = path.join(f.base, 'tasks');
  const actionFile = path.join(f.base, 'action.json');
  fs.writeFileSync(actionFile, JSON.stringify({ tool: 'Write', input: { file_path: 'src/a' } }));
  const run = (...a) => spawnSync(process.execPath, [cli, 'tasks', ...a], { encoding: 'utf8', timeout: 10000 });
  const subject = ['--host', 'zcode', '--session', 's1', '--run', 'r1', '--policy-hash', f.policy.policyHash, '--action-file', actionFile];
  const create = run('create', '--state', state, ...subject, '--owner', 'operator-a');
  assert.equal(create.status, 0, create.stderr);
  const id = JSON.parse(create.stdout);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const shown = () => JSON.parse(run('show', '--state', state, '--id', id).stdout);
  assert.equal(shown().state, 'planned');
  assert.equal(shown().owner, 'operator-a');
  const step = sub => {
    const child = run(sub, '--state', state, '--id', id, ...subject);
    assert.equal(child.status, 0, `${sub}: ${child.stderr}`);
    return JSON.parse(child.stdout);
  };
  assert.equal(step('start').state, 'running');
  assert.equal(step('interrupt').state, 'interrupted');
  assert.equal(step('resume').state, 'running');
  assert.equal(step('complete').state, 'completed');
  const final = shown();
  assert.equal(final.state, 'completed');
  assert.equal(final.owner, 'operator-a');
  assert.equal(final.attempts, 2);
  const list = JSON.parse(run('list', '--state', state).stdout);
  assert.deepEqual(list.map(r => r.id), [id]);
  assert.equal(list[0].state, 'completed');
});
test('tasks create rejects --id instead of silently ignoring it', t => {
  const f = fixture(t), state = path.join(f.base, 'tasks-id');
  const actionFile = path.join(f.base, 'action.json');
  fs.writeFileSync(actionFile, JSON.stringify({ tool: 'Write', input: { file_path: 'src/a' } }));
  const child = spawnSync(process.execPath, [cli, 'tasks', 'create', '--state', state, '--id', '00000000-0000-4000-8000-000000000000',
    '--host', 'zcode', '--session', 's1', '--run', 'r1', '--policy-hash', f.policy.policyHash, '--action-file', actionFile], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /INVALID_ARGUMENTS/);
  assert.equal(fs.existsSync(state), false, 'refusal must not leave a state directory behind');
});
test('tasks CLI cancels interrupted tasks and refuses unknown subcommands without creating state', t => {
  const f = fixture(t), state = path.join(f.base, 'tasks');
  const actionFile = path.join(f.base, 'action.json');
  fs.writeFileSync(actionFile, JSON.stringify({ tool: 'Write', input: { file_path: 'src/a' } }));
  const run = (...a) => spawnSync(process.execPath, [cli, 'tasks', ...a], { encoding: 'utf8', timeout: 10000 });
  const subject = ['--host', 'zcode', '--session', 's1', '--run', 'r1', '--policy-hash', f.policy.policyHash, '--action-file', actionFile];
  const absent = path.join(f.base, 'never-created');
  const bogus = run('bogus', '--state', absent);
  assert.equal(bogus.status, 1);
  assert.match(bogus.stderr, /UNKNOWN_SUBCOMMAND/);
  assert.equal(fs.existsSync(absent), false, 'unknown subcommand must not leave a state directory behind');
  const id = JSON.parse(run('create', '--state', state, ...subject).stdout);
  const step = sub => {
    const child = run(sub, '--state', state, '--id', id, ...subject);
    assert.equal(child.status, 0, `${sub}: ${child.stderr}`);
    return JSON.parse(child.stdout);
  };
  step('start'); step('interrupt');
  assert.equal(step('cancel').state, 'cancelled');
  const tooLongOwner = run('create', '--state', path.join(f.base, 'also-never'), ...subject, '--owner', 'x'.repeat(257));
  assert.equal(tooLongOwner.status, 1);
  assert.match(tooLongOwner.stderr, /INVALID_OWNER/);
  assert.equal(fs.existsSync(path.join(f.base, 'also-never')), false);
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
  assert.equal(info.hosts.dsh, 'vertical-verified-single-keyed-runs');
  assert.equal(info.modelCalls, 0);
});
test('doctor reports the rendered-skill consumption count and user unlock actions', () => {
  const child = spawnSync(process.execPath, [cli, 'doctor'], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  const info = JSON.parse(child.stdout);
  assert.equal(info.consumption.renderedSkillsConsumed, 15);
  assert.deepEqual(info.consumption.evidence, ['docs/verification-2026-10-27-render-consumption.md',
    'docs/verification-2026-10-27-safety-suite.md', 'docs/verification-2026-10-27-workflow-suite.md',
    'docs/verification-2026-10-27-product-suite.md', 'docs/verification-2026-10-27-final-suite.md']);
  assert.equal(typeof info.consumption.note, 'string');
  assert.match(info.consumption.note, /context-injection; auto-pickup unverified/);
  assert.equal(info.unlocks.dsh, 'set DEEPSEEK_API_KEY then run node scripts/verify-dsh-guard.mjs');
  assert.equal(info.unlocks.zcode, 'follow docs/integration/zcode-acceptance.md + host-loading.md section 2.4 in a controlled new session');
});

test('real hook subprocess decodes multi-byte UTF-8 split across stdin chunks', t => {
  const f = fixture(t);
  // ZCode sends toolInput twice (camelCase + snake_case); > 64 KiB forces several stdin chunks.
  const toolInput = { file_path: path.join(f.src, 'notes.md'), content: '中文内容'.repeat(30000) };
  const payload = { cwd: f.workspace, hookEventName: 'PreToolUse', toolName: 'Write', toolInput,
    hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: toolInput };
  const child = spawnSync(process.execPath, [cli, 'hook', 'zcode', '--policy', f.policyPath], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stdout);
});

/** ask prints the question JSON first and the transition result second; split the two pretty docs. */
function parsePrinted(out) {
  const boundary = out.indexOf('\n}\n');
  assert.notEqual(boundary, -1, 'expected two printed JSON documents on stdout');
  return [JSON.parse(out.slice(0, boundary + 2)), JSON.parse(out.slice(boundary + 3))];
}
const askSubject = f => ({ host: 'zcode', sessionId: 's1', runId: 'r1', policyHash: f.policy.policyHash,
  action: { tool: 'Write', input: { file_path: 'src/a' } } });
const writeActionFile = (f, action) => {
  const actionFile = path.join(f.base, 'action.json');
  fs.writeFileSync(actionFile, JSON.stringify(action));
  return actionFile;
};

test('approvals ask applies a piped approve and keeps pending on EOF or unrecognized answers', t => {
  const f = fixture(t), state = path.join(f.base, 'approvals');
  const store = new ApprovalStore(state);
  const subject = askSubject(f);
  const id = store.issue(subject);
  const actionFile = writeActionFile(f, subject.action);
  const ask = input => spawnSync(process.execPath, [cli, 'approvals', 'ask', '--state', state, '--id', id,
    '--host', 'zcode', '--session', 's1', '--run', 'r1', '--policy-hash', subject.policyHash, '--action-file', actionFile], { input, encoding: 'utf8', timeout: 10000 });
  // EOF with no answer line: the question still prints, then the bridge blocks — never auto-agrees.
  const eof = ask('');
  assert.equal(eof.status, 3);
  assert.match(eof.stderr, /^gstack861: ASK_UNANSWERED\n$/);
  assert.equal(JSON.parse(eof.stdout).id, id);
  const show = () => JSON.parse(spawnSync(process.execPath, [cli, 'approvals', 'show', '--state', state, '--id', id], { encoding: 'utf8', timeout: 10000 }).stdout);
  assert.equal(show().state, 'pending', 'unanswered ask must leave the record pending');
  // Matching is trimmed but case-sensitive: ' Approve ' is not an answer.
  const shout = ask(' Approve \n');
  assert.equal(shout.status, 3);
  assert.match(shout.stderr, /ASK_UNANSWERED/);
  assert.equal(show().state, 'pending');
  // An exact piped approve answers the question and prints the approved record.
  const ok = ask('approve\n');
  assert.equal(ok.status, 0, ok.stderr);
  const [question, result] = parsePrinted(ok.stdout);
  assert.equal(question.id, id);
  assert.equal(question.state, 'pending');
  assert.equal(question.prompt, '');
  assert.deepEqual(question.subject, { host: 'zcode', sessionId: 's1', runId: 'r1', policyHashPrefix16: subject.policyHash.slice(0, 16) });
  assert.equal(question.actionDigest, store.get(id).subjectHash.slice(0, 16));
  assert.ok(question.expiresInMillisRemaining > 0 && question.expiresInMillisRemaining <= 300000);
  assert.equal(result.state, 'approved');
  // stdout ends with exactly the record as persisted on disk.
  assert.deepEqual(result, JSON.parse(fs.readFileSync(path.join(state, `approval-${id}.json`), 'utf8')));
});
test('approvals ask reject echoes the reason in stdout only, never in the record', t => {
  const f = fixture(t), state = path.join(f.base, 'approvals');
  const store = new ApprovalStore(state);
  const subject = askSubject(f);
  const id = store.issue(subject);
  const actionFile = writeActionFile(f, subject.action);
  const child = spawnSync(process.execPath, [cli, 'approvals', 'ask', '--state', state, '--id', id,
    '--host', 'zcode', '--session', 's1', '--run', 'r1', '--policy-hash', subject.policyHash, '--action-file', actionFile], { input: 'reject\nreason text\n', encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const [, result] = parsePrinted(child.stdout);
  assert.equal(result.state, 'rejected');
  assert.equal(result.reason, 'reason text');
  // The on-disk record keeps the digest-only schema: reason is echoed, never persisted.
  const raw = fs.readFileSync(path.join(state, `approval-${id}.json`), 'utf8');
  assert.equal(raw.includes('reason text'), false);
  const record = JSON.parse(raw);
  assert.equal(record.reason, undefined);
  assert.deepEqual(Object.keys(record).sort(),
    ['changedAt', 'expiresAt', 'id', 'issuedAt', 'schemaVersion', 'state', 'subjectHash']);
});
test('approvals ask forwards prompt-file into the question and keeps error codes and usage intact', t => {
  const f = fixture(t), state = path.join(f.base, 'approvals');
  const store = new ApprovalStore(state);
  const subject = askSubject(f);
  const id = store.issue(subject);
  const actionFile = writeActionFile(f, subject.action);
  const promptFile = path.join(f.base, 'prompt.txt');
  fs.writeFileSync(promptFile, 'Deploy to production?');
  const ask = (input, ...extra) => spawnSync(process.execPath, [cli, 'approvals', 'ask', '--state', state, '--id', id,
    '--host', 'zcode', '--session', 's1', '--run', 'r1', '--policy-hash', subject.policyHash, '--action-file', actionFile, ...extra], { input, encoding: 'utf8', timeout: 10000 });
  const ok = ask('approve\n', '--prompt-file', promptFile);
  assert.equal(ok.status, 0, ok.stderr);
  const [question] = parsePrinted(ok.stdout);
  assert.equal(question.prompt, 'Deploy to production?');
  assert.equal(question.actionDigest, store.get(id).subjectHash.slice(0, 16));
  // Missing required flags is an argument error before any question or state directory work.
  const missing = spawnSync(process.execPath, [cli, 'approvals', 'ask', '--state', state], { encoding: 'utf8', timeout: 10000 });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /INVALID_ARGUMENTS/);
  assert.equal(missing.stdout, '');
  // A structurally invalid subject fails with the existing code and no question printed.
  const bad = spawnSync(process.execPath, [cli, 'approvals', 'ask', '--state', state, '--id', id, '--host', 'zcode',
    '--session', 's1', '--run', 'r1', '--policy-hash', 'nope', '--action-file', actionFile], { input: 'approve\n', encoding: 'utf8', timeout: 10000 });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /INVALID_SUBJECT/);
  assert.equal(bad.stdout, '');
  // A well-formed but mismatched subject still surfaces the binding error after the answer.
  const other = store.issue(subject);
  const mismatch = spawnSync(process.execPath, [cli, 'approvals', 'ask', '--state', state, '--id', other, '--host', 'zcode',
    '--session', 'other-session', '--run', 'r1', '--policy-hash', subject.policyHash, '--action-file', actionFile], { input: 'approve\n', encoding: 'utf8', timeout: 10000 });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /APPROVAL_BINDING_MISMATCH/);
  assert.equal(store.get(other).state, 'pending');
  // The usage text documents the new bridge.
  const usage = spawnSync(process.execPath, [cli, 'nope'], { encoding: 'utf8' });
  assert.match(usage.stderr, /approvals ask --state DIR --id ID/);
});
test('approvals ask scopes prompt-file failures: missing files INVALID_PROMPT_FILE, relative paths ABSOLUTE_PATH_REQUIRED', t => {
  const f = fixture(t), state = path.join(f.base, 'approvals');
  const store = new ApprovalStore(state);
  const subject = askSubject(f);
  const id = store.issue(subject);
  const actionFile = writeActionFile(f, subject.action);
  const ask = (...extra) => spawnSync(process.execPath, [cli, 'approvals', 'ask', '--state', state, '--id', id,
    '--host', 'zcode', '--session', 's1', '--run', 'r1', '--policy-hash', subject.policyHash, '--action-file', actionFile, ...extra], { input: 'approve\n', encoding: 'utf8', timeout: 10000 });
  // A missing prompt file previously leaked the raw ENOENT message. The read runs
  // before the stdin await, so a bad prompt file exits with EMPTY stdout — no
  // question printed — and never blocks waiting for an operator answer (the piped
  // approve below is never consumed).
  const missing = ask('--prompt-file', path.join(f.base, 'absent-prompt.txt'));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /gstack861: INVALID_PROMPT_FILE/);
  assert.equal(missing.stdout, '');
  // A relative --prompt-file keeps its own path-semantics code; it must not be masked as INVALID_PROMPT_FILE.
  const relative = ask('--prompt-file', 'relative-prompt.txt');
  assert.equal(relative.status, 1);
  assert.match(relative.stderr, /gstack861: ABSOLUTE_PATH_REQUIRED/);
  assert.equal(relative.stderr.includes('INVALID_PROMPT_FILE'), false);
  assert.equal(relative.stdout, '');
  // Both refusals leave the record pending: a prompt-file failure never answers the question.
  assert.equal(store.get(id).state, 'pending');
  // The happy path is unaffected: a readable prompt file still flows into the question.
  const promptFile = path.join(f.base, 'prompt-ok.txt');
  fs.writeFileSync(promptFile, 'Ship the release?');
  const ok = ask('--prompt-file', promptFile);
  assert.equal(ok.status, 0, ok.stderr);
  const [question] = parsePrinted(ok.stdout);
  assert.equal(question.prompt, 'Ship the release?');
});
