import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ApprovalStore } from '../src/approvals.mjs';
import { TaskStore } from '../src/tasks.mjs';
import { fixture } from './helpers.mjs';
const execute = promisify(execFile);
const subject = f => ({ host: 'zcode', runId: 'r1', sessionId: 's1', policyHash: f.policy.policyHash, action: { kind: 'publish', artifactHash: 'fixture' } });

test('approval requires explicit approve and can be consumed only once', t => {
  const f = fixture(t), store = new ApprovalStore(path.join(f.base, 'approvals')), s = subject(f);
  const id = store.issue(s);
  assert.throws(() => store.consume(id, s), /WRONG_STATE/);
  store.approve(id, s);
  assert.equal(store.consume(id, s).state, 'consumed');
  assert.throws(() => store.consume(id, s), /WRONG_STATE/);
});
test('approval binding covers host, session, run, policy and action', t => {
  const f = fixture(t), store = new ApprovalStore(path.join(f.base, 'approvals')), s = subject(f);
  const id = store.issue(s); store.approve(id, s);
  for (const changed of [{ host: 'dsh' }, { runId: 'r2' }, { sessionId: 's2' }, { policyHash: 'a'.repeat(64) }, { action: { kind: 'delete' } }]) {
    assert.throws(() => store.consume(id, { ...s, ...changed }), /BINDING_MISMATCH/);
  }
  assert.equal(store.consume(id, s).state, 'consumed');
});
test('expired approval cannot be approved or consumed', t => {
  const f = fixture(t); let time = 1000;
  const store = new ApprovalStore(path.join(f.base, 'approvals'), { clock: () => time }), s = subject(f);
  const id = store.issue(s, { ttlMs: 5 }); time = 1005;
  assert.throws(() => store.approve(id, s), /EXPIRED/);
});
test('rejection is terminal and approval is not automatically renewed', t => {
  const f = fixture(t), store = new ApprovalStore(path.join(f.base, 'approvals')), s = subject(f);
  const id = store.issue(s); store.reject(id, s);
  assert.throws(() => store.approve(id, s), /WRONG_STATE/);
  assert.throws(() => store.consume(id, s), /WRONG_STATE/);
});
test('persisted consumed state survives a new store instance', t => {
  const f = fixture(t), dir = path.join(f.base, 'approvals'), store = new ApprovalStore(dir), s = subject(f);
  const id = store.issue(s); store.approve(id, s); store.consume(id, s);
  assert.throws(() => new ApprovalStore(dir).consume(id, s), /WRONG_STATE/);
});
test('approval records contain digests, not action payloads', t => {
  const f = fixture(t), store = new ApprovalStore(path.join(f.base, 'approvals')), s = subject(f);
  s.action = { credentialLikeValue: 'private-test-payload' };
  const id = store.issue(s), content = fs.readFileSync(store.file(id), 'utf8');
  assert.equal(content.includes('private-test-payload'), false);
  assert.match(JSON.parse(content).subjectHash, /^[a-f0-9]{64}$/);
});
test('invalid ids, TTL and malformed subjects are refused', t => {
  const f = fixture(t), store = new ApprovalStore(path.join(f.base, 'approvals')), s = subject(f);
  for (const id of ['../policy', '', 'constructor']) assert.throws(() => store.consume(id, s), /INVALID_APPROVAL_ID/);
  for (const ttlMs of [-1, 0, NaN, 86400001]) assert.throws(() => store.issue(s, { ttlMs }), /INVALID_TTL/);
  assert.throws(() => store.issue({ ...s, extra: true }), /INVALID_SUBJECT/);
});
test('an active or abandoned lock never auto-grants approval', t => {
  const f = fixture(t), store = new ApprovalStore(path.join(f.base, 'approvals')), s = subject(f), id = store.issue(s);
  const lock = store.file(id) + '.lock'; fs.mkdirSync(lock);
  assert.throws(() => store.approve(id, s), /BUSY/);
  fs.rmdirSync(lock);
  assert.equal(store.approve(id, s).state, 'approved');
});
test('symlink state directories and record tampering fail closed', t => {
  const f = fixture(t), dir = path.join(f.base, 'approvals'), store = new ApprovalStore(dir), s = subject(f);
  const alias = path.join(f.base, 'alias'); fs.symlinkSync(dir, alias);
  assert.throws(() => new ApprovalStore(alias), /UNSAFE_STATE_DIRECTORY/);
  const id = store.issue(s); fs.writeFileSync(store.file(id), '{');
  assert.throws(() => store.approve(id, s));
});
test('get keeps NOT_FOUND for missing ids and refuses tampered record shapes', t => {
  const f = fixture(t), dir = path.join(f.base, 'approvals'), store = new ApprovalStore(dir), s = subject(f);
  assert.throws(() => store.get('00000000-0000-4000-8000-000000000000'), /NOT_FOUND/);
  const nullId = store.issue(s);
  fs.writeFileSync(store.file(nullId), 'null\n');
  assert.throws(() => store.get(nullId), /INVALID_APPROVAL_RECORD/);
  const stateId = store.issue(s);
  fs.writeFileSync(store.file(stateId), JSON.stringify({ ...store.get(stateId), state: 'invented-state' }) + '\n');
  assert.throws(() => store.get(stateId), /INVALID_APPROVAL_RECORD/);
});
test('verify is read-only: reports binding without transitioning or storing payloads', t => {
  const f = fixture(t), store = new ApprovalStore(path.join(f.base, 'approvals')), s = subject(f);
  const id = store.issue(s);
  assert.deepEqual(store.verify(id, s), { id, state: 'pending', binding: 'match' });
  assert.deepEqual(store.verify(id, { ...s, sessionId: 's2' }), { id, state: 'pending', binding: 'mismatch' });
  assert.equal(store.get(id).state, 'pending', 'verify must never transition the record');
  assert.equal(Object.isFrozen(store.verify(id, s)), true);
  assert.throws(() => store.verify(id, { ...s, extra: true }), /INVALID_SUBJECT/);
  assert.throws(() => store.verify('00000000-0000-4000-8000-000000000000', s), /NOT_FOUND/);
  for (const wrong of ['../policy', '', 'constructor']) assert.throws(() => store.verify(wrong, s), /INVALID_APPROVAL_ID/);
});
test('task records disguised into the approval namespace fail closed and stray names are ignored', t => {
  const f = fixture(t), dir = path.join(f.base, 'shared'), s = subject(f);
  const tasks = new TaskStore(dir), approvals = new ApprovalStore(dir);
  const approvalId = approvals.issue(s);
  const taskId = tasks.create(s);
  // A foreign record renamed into approval-<uuid>.json: content validation stays authoritative.
  fs.renameSync(tasks.file(taskId), path.join(dir, `approval-${taskId}.json`));
  assert.throws(() => approvals.get(taskId), /INVALID_APPROVAL_RECORD/);
  assert.throws(() => approvals.list(), /INVALID_APPROVAL_RECORD/);
  // Double-prefixed and foreign-named files are not approval-namespace members: list ignores them.
  fs.renameSync(path.join(dir, `approval-${taskId}.json`), path.join(dir, `approval-approval-${taskId}.json`));
  fs.writeFileSync(path.join(dir, 'task-x.json'), 'garbage');
  assert.deepEqual(approvals.list().map(r => r.id), [approvalId]);
});
test('two real processes cannot both consume one approval', async t => {
  const f = fixture(t), dir = path.join(f.base, 'approvals'), store = new ApprovalStore(dir), s = subject(f);
  const id = store.issue(s); store.approve(id, s);
  const module = new URL('../src/approvals.mjs', import.meta.url).href;
  const code = `import { ApprovalStore } from ${JSON.stringify(module)}; try { new ApprovalStore(process.argv[1]).consume(process.argv[2], JSON.parse(process.argv[3])); process.stdout.write('consumed'); } catch { process.exitCode = 2; }`;
  const results = await Promise.allSettled([0, 1].map(() => execute(process.execPath, ['--input-type=module', '-e', code, dir, id, JSON.stringify(s)])));
  assert.equal(results.filter(r => r.status === 'fulfilled' && r.value.stdout === 'consumed').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
});
