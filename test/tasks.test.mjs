import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { TaskStore } from '../src/tasks.mjs';
import { ApprovalStore, subjectDigest } from '../src/approvals.mjs';
import { fixture } from './helpers.mjs';
const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/gstack861.mjs', import.meta.url));
const subject = f => ({ host: 'zcode', runId: 'r1', sessionId: 's1', policyHash: f.policy.policyHash, action: { kind: 'publish', artifactHash: 'fixture' } });

test('task lifecycle create→start→complete tracks state and attempts', t => {
  const f = fixture(t), store = new TaskStore(path.join(f.base, 'tasks')), s = subject(f);
  const id = store.create(s);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const planned = store.get(id);
  assert.equal(planned.schemaVersion, 1);
  assert.equal(planned.id, id);
  assert.equal(planned.state, 'planned');
  assert.equal(planned.attempts, 0);
  assert.equal(planned.subjectHash, subjectDigest(s));
  assert.equal(Object.isFrozen(planned), true);
  assert.equal(store.start(id, s).state, 'running');
  assert.equal(store.get(id).attempts, 1);
  assert.throws(() => store.start(id, s), /TASK_WRONG_STATE/);
  assert.equal(store.complete(id, s).state, 'completed');
  assert.equal(store.get(id).attempts, 1);
});
test('a planned task cannot skip to completed or be interrupted', t => {
  const f = fixture(t), store = new TaskStore(path.join(f.base, 'tasks')), s = subject(f);
  const id = store.create(s);
  assert.throws(() => store.complete(id, s), /TASK_WRONG_STATE/);
  assert.throws(() => store.fail(id, s), /TASK_WRONG_STATE/);
  assert.throws(() => store.interrupt(id, s), /TASK_WRONG_STATE/);
  assert.equal(store.get(id).state, 'planned');
});
test('fail and cancel follow their allowed state orders', t => {
  const f = fixture(t), store = new TaskStore(path.join(f.base, 'tasks')), s = subject(f);
  const a = store.create(s);
  store.start(a, s);
  assert.equal(store.fail(a, s).state, 'failed');
  assert.throws(() => store.complete(a, s), /TASK_WRONG_STATE/);
  const b = store.create(s);
  assert.equal(store.cancel(b, s).state, 'cancelled');
  assert.throws(() => store.start(b, s), /TASK_WRONG_STATE/);
  const c = store.create(s);
  store.start(c, s);
  assert.equal(store.cancel(c, s).state, 'cancelled');
  assert.throws(() => store.interrupt(c, s), /TASK_WRONG_STATE/);
});
test('interrupted tasks recover via start or resume and count attempts', t => {
  const f = fixture(t), store = new TaskStore(path.join(f.base, 'tasks')), s = subject(f);
  const id = store.create(s);
  assert.throws(() => store.resume(id, s), /TASK_WRONG_STATE/);
  store.start(id, s);
  assert.equal(store.interrupt(id, s).state, 'interrupted');
  assert.equal(store.start(id, s).state, 'running');
  assert.equal(store.get(id).attempts, 2);
  store.interrupt(id, s);
  assert.equal(store.resume(id, s).state, 'running');
  assert.equal(store.get(id).attempts, 3);
});
test('task records bind to host, session, run, policy and action', t => {
  const f = fixture(t), store = new TaskStore(path.join(f.base, 'tasks')), s = subject(f);
  const id = store.create(s);
  for (const changed of [{ host: 'dsh' }, { runId: 'r2' }, { sessionId: 's2' }, { policyHash: 'a'.repeat(64) }, { action: { kind: 'delete' } }]) {
    assert.throws(() => store.start(id, { ...s, ...changed }), /TASK_BINDING_MISMATCH/);
  }
  assert.equal(store.start(id, s).state, 'running');
  assert.throws(() => store.create({ ...s, extra: true }), /INVALID_SUBJECT/);
});
test('get and list return frozen records with state filtering', t => {
  const f = fixture(t), store = new TaskStore(path.join(f.base, 'tasks')), s = subject(f);
  const ids = [store.create(s), store.create(s), store.create(s)];
  store.start(ids[0], s); store.complete(ids[0], s);
  store.start(ids[1], s);
  assert.throws(() => store.get('00000000-0000-4000-8000-000000000000'), /NOT_FOUND/);
  for (const id of ['../task', '', 'constructor']) assert.throws(() => store.get(id), /INVALID_TASK_ID/);
  const all = store.list();
  assert.deepEqual(all.map(r => r.id), [...ids].sort());
  assert.equal(all.every(Object.isFrozen), true);
  assert.deepEqual(store.list({ state: 'planned' }).map(r => r.id), [ids[2]]);
  assert.deepEqual(store.list({ state: 'running' }).map(r => r.id), [ids[1]]);
  assert.deepEqual(store.list({ state: 'completed' }).map(r => r.id), [ids[0]]);
  assert.deepEqual(store.list({ state: 'failed' }), []);
});
test('task state survives a new store instance', t => {
  const f = fixture(t), dir = path.join(f.base, 'tasks'), store = new TaskStore(dir), s = subject(f);
  const id = store.create(s); store.start(id, s); store.interrupt(id, s);
  const reopened = new TaskStore(dir);
  assert.equal(reopened.get(id).state, 'interrupted');
  assert.equal(reopened.resume(id, s).state, 'running');
  assert.equal(reopened.get(id).attempts, 2);
});
test('tampered task records fail closed', t => {
  const f = fixture(t), store = new TaskStore(path.join(f.base, 'tasks')), s = subject(f);
  const id = store.create(s);
  const forged = { ...store.get(id), id: '00000000-0000-4000-8000-000000000000' };
  fs.writeFileSync(store.file(id), JSON.stringify(forged) + '\n');
  assert.throws(() => store.start(id, s), /INVALID_TASK_RECORD/);
  assert.throws(() => store.get(id), /INVALID_TASK_RECORD/);
});
test('null and non-object task records fail closed as INVALID_TASK_RECORD', t => {
  const f = fixture(t), store = new TaskStore(path.join(f.base, 'tasks')), s = subject(f);
  const id = store.create(s);
  fs.writeFileSync(store.file(id), 'null\n');
  assert.throws(() => store.get(id), /INVALID_TASK_RECORD/);
  assert.throws(() => store.start(id, s), /INVALID_TASK_RECORD/);
  fs.writeFileSync(store.file(id), '[]\n');
  assert.throws(() => store.get(id), /INVALID_TASK_RECORD/);
});
test('an abandoned lock directory reports busy without auto-clearing', t => {
  const f = fixture(t), store = new TaskStore(path.join(f.base, 'tasks')), s = subject(f);
  const id = store.create(s), lock = store.file(id) + '.lock';
  fs.mkdirSync(lock);
  assert.throws(() => store.start(id, s), /TASK_BUSY/);
  assert.equal(fs.existsSync(lock), true);
  fs.rmdirSync(lock);
  assert.equal(store.start(id, s).state, 'running');
});
test('subjectDigest matches the ApprovalStore digest for the same subject', t => {
  const f = fixture(t), s = subject(f);
  assert.match(subjectDigest(s), /^[a-f0-9]{64}$/);
  const approvalId = new ApprovalStore(path.join(f.base, 'approvals')).issue(s);
  const approvalRecord = JSON.parse(fs.readFileSync(path.join(f.base, 'approvals', `approval-${approvalId}.json`), 'utf8'));
  assert.equal(subjectDigest(s), approvalRecord.subjectHash);
  const store = new TaskStore(path.join(f.base, 'tasks'));
  assert.equal(store.get(store.create(s)).subjectHash, subjectDigest(s));
});
test('shared state directory keeps task and approval stores namespaced and transitions intact', async t => {
  const f = fixture(t), dir = path.join(f.base, 'shared-state'), s = subject(f);
  const tasks = new TaskStore(dir), approvals = new ApprovalStore(dir);
  const taskId = tasks.create(s);
  const approvalId = approvals.issue(s);
  // Filename namespaces: each store owns its prefixed file; no bare-uuid records exist.
  assert.equal(fs.existsSync(path.join(dir, `task-${taskId}.json`)), true);
  assert.equal(fs.existsSync(path.join(dir, `approval-${approvalId}.json`)), true);
  assert.equal(fs.existsSync(path.join(dir, `${taskId}.json`)), false);
  // Record content is unchanged: the bare uuid stays the id inside the file.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `task-${taskId}.json`), 'utf8')).id, taskId);
  assert.deepEqual(tasks.list().map(r => r.id), [taskId]);
  assert.deepEqual(approvals.list().map(r => r.id), [approvalId]);
  // Foreign records must not break transitions in either store.
  assert.equal(tasks.start(taskId, s).state, 'running');
  assert.equal(approvals.approve(approvalId, s).state, 'approved');
  assert.equal(tasks.complete(taskId, s).state, 'completed');
  assert.equal(approvals.consume(approvalId, s).state, 'consumed');
  // Operator CLI smoke: approvals show stays readable in the mixed directory.
  const show = await execute(process.execPath, [cli, 'approvals', 'show', '--state', dir, '--id', approvalId]);
  assert.equal(JSON.parse(show.stdout).state, 'consumed');
});
test('approval records disguised into the task namespace fail closed and stray names are ignored', t => {
  const f = fixture(t), dir = path.join(f.base, 'shared'), s = subject(f);
  const tasks = new TaskStore(dir), approvals = new ApprovalStore(dir);
  const approvalId = approvals.issue(s);
  const taskId = tasks.create(s);
  // A foreign record renamed into task-<uuid>.json: content validation stays authoritative.
  fs.renameSync(approvals.file(approvalId), path.join(dir, `task-${approvalId}.json`));
  assert.throws(() => tasks.get(approvalId), /INVALID_TASK_RECORD/);
  assert.throws(() => tasks.list(), /INVALID_TASK_RECORD/);
  // Double-prefixed and foreign-named files are not task-namespace members: list ignores them.
  fs.renameSync(path.join(dir, `task-${approvalId}.json`), path.join(dir, `task-task-${approvalId}.json`));
  fs.writeFileSync(path.join(dir, 'approval-x.json'), 'garbage');
  assert.deepEqual(tasks.list().map(r => r.id), [taskId]);
});
test('task directories must be absolute and not symlinked', t => {
  const f = fixture(t), dir = path.join(f.base, 'tasks');
  new TaskStore(dir);
  const alias = path.join(f.base, 'alias');
  fs.symlinkSync(dir, alias);
  assert.throws(() => new TaskStore(alias), /UNSAFE_STATE_DIRECTORY/);
  assert.throws(() => new TaskStore('tasks-relative'), /ABSOLUTE_STATE_PATH_REQUIRED/);
});
test('transitions update updatedAt from the injected clock', t => {
  const f = fixture(t); let time = 5000;
  const store = new TaskStore(path.join(f.base, 'tasks'), { clock: () => time }), s = subject(f);
  const id = store.create(s);
  assert.equal(store.get(id).createdAt, 5000);
  assert.equal(store.get(id).updatedAt, 5000);
  time = 6000;
  store.start(id, s);
  assert.equal(store.get(id).createdAt, 5000);
  assert.equal(store.get(id).updatedAt, 6000);
});
test('interrupted tasks can be cancelled', t => {
  const f = fixture(t), store = new TaskStore(path.join(f.base, 'tasks')), s = subject(f);
  const id = store.create(s);
  store.start(id, s);
  store.interrupt(id, s);
  assert.equal(store.cancel(id, s).state, 'cancelled');
  assert.throws(() => store.start(id, s), /TASK_WRONG_STATE/);
  assert.throws(() => store.resume(id, s), /TASK_WRONG_STATE/);
});
test('owner is recorded on create and start and survives reopening', t => {
  const f = fixture(t), dir = path.join(f.base, 'tasks'), store = new TaskStore(dir), s = subject(f);
  const id = store.create(s, { owner: 'operator-a' });
  assert.equal(store.get(id).owner, 'operator-a');
  assert.equal(store.start(id, s, { owner: 'operator-b' }).owner, 'operator-b');
  assert.equal(store.get(id).owner, 'operator-b');
  assert.equal(new TaskStore(dir).get(id).owner, 'operator-b');
  const bare = store.create(s);
  assert.equal('owner' in store.get(bare), false, 'records without an owner must not carry the key');
  assert.equal(store.start(bare, s).owner, undefined);
});
test('owner must be a non-empty string of at most 256 characters', t => {
  const f = fixture(t), store = new TaskStore(path.join(f.base, 'tasks')), s = subject(f);
  assert.equal(store.create(s, { owner: 'x'.repeat(256) }).length > 0, true);
  const id = store.create(s);
  for (const owner of ['x'.repeat(257), '', 42, null]) assert.throws(() => store.create(s, { owner }), /INVALID_OWNER/);
  for (const owner of ['x'.repeat(257), '', 42]) assert.throws(() => store.start(id, s, { owner }), /INVALID_OWNER/);
});
test('tampered owner fields fail closed as INVALID_TASK_RECORD', t => {
  const f = fixture(t), store = new TaskStore(path.join(f.base, 'tasks')), s = subject(f);
  const id = store.create(s, { owner: 'operator-a' });
  fs.writeFileSync(store.file(id), JSON.stringify({ ...store.get(id), owner: 123 }) + '\n');
  assert.throws(() => store.get(id), /INVALID_TASK_RECORD/);
  assert.throws(() => store.start(id, s), /INVALID_TASK_RECORD/);
});
test('two real processes cannot both start one task', async t => {
  const f = fixture(t), dir = path.join(f.base, 'tasks'), store = new TaskStore(dir), s = subject(f);
  const id = store.create(s);
  const module = new URL('../src/tasks.mjs', import.meta.url).href;
  const code = `import { TaskStore } from ${JSON.stringify(module)}; try { new TaskStore(process.argv[1]).start(process.argv[2], JSON.parse(process.argv[3])); process.stdout.write('started'); } catch { process.exitCode = 2; }`;
  const results = await Promise.allSettled([0, 1].map(() => execute(process.execPath, ['--input-type=module', '-e', code, dir, id, JSON.stringify(s)])));
  assert.equal(results.filter(r => r.status === 'fulfilled' && r.value.stdout === 'started').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal(store.get(id).state, 'running');
});
