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
// Dual-process helpers (audit #12): normalize execFile's nonzero-exit rejection so
// winner and loser children share one {status, stdout} shape. A child that prints no
// JSON (crash, module-load failure) fails the caller's JSON.parse by design.
const run = (file, args) => execute(file, args)
  .then(({ stdout }) => ({ status: 0, stdout }),
    error => ({ status: typeof error.code === 'number' ? error.code : null, stdout: error.stdout ?? '' }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Marker-file barrier: resolves once `file` exists; the deadline keeps a stuck child from hanging the suite. */
async function waitUntil(file, what) {
  for (const deadline = Date.now() + 15000; !fs.existsSync(file); await sleep(5)) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
  }
}
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
  const attempt = store.start(id, s);
  assert.equal(attempt.state, 'running');
  assert.equal(store.get(id).attempts, 1);
  assert.throws(() => store.start(id, s), /TASK_WRONG_STATE/);
  assert.equal(store.complete(id, s, { attemptToken: attempt.attemptToken }).state, 'completed');
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
  const aAttempt = store.start(a, s);
  assert.equal(store.fail(a, s, { attemptToken: aAttempt.attemptToken }).state, 'failed');
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
  const doneAttempt = store.start(ids[0], s); store.complete(ids[0], s, { attemptToken: doneAttempt.attemptToken });
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
  const taskAttempt = tasks.start(taskId, s);
  assert.equal(taskAttempt.state, 'running');
  assert.equal(approvals.approve(approvalId, s).state, 'approved');
  assert.equal(tasks.complete(taskId, s, { attemptToken: taskAttempt.attemptToken }).state, 'completed');
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
// Audit #12 evidence classes — kept separate on purpose:
// (a) the free race below proves ATOMICITY: exactly one starter wins, attempts bump once,
//     the loser names a structured store code. A fully serial execution is still a legal
//     race outcome (the loser then reports TASK_WRONG_STATE), so this class alone does
//     NOT prove the lock path executed.
// (b) the held-lock test after it proves CONTENTION by construction: another real process
//     owns the store's lock directory while a starter runs, so TASK_BUSY is the only
//     possible failure, the record must survive untouched, and the start must land
//     exactly once after the lock is released.
test('concurrent starts across real processes: exactly one wins, the loser names a structured contention code', { timeout: 120_000 }, async t => {
  const f = fixture(t), dir = path.join(f.base, 'tasks'), store = new TaskStore(dir), s = subject(f);
  const id = store.create(s);
  const module = new URL('../src/tasks.mjs', import.meta.url).href;
  // Child contract: exactly one JSON line — {ok:true,state,attempts} or {ok:false,code}; exit 2 on failure.
  // Leaseless start: no attemptToken is minted, so there is nothing fenced to thread here.
  const code = `import { TaskStore } from ${JSON.stringify(module)}; try { const r = new TaskStore(process.argv[1]).start(process.argv[2], JSON.parse(process.argv[3])); process.stdout.write(JSON.stringify({ ok: true, state: r.state, attempts: r.attempts })); } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.message })); process.exitCode = 2; }`;
  const results = await Promise.all([0, 1].map(() => run(process.execPath, ['--input-type=module', '-e', code, dir, id, JSON.stringify(s)])));
  const winners = results.filter(r => r.status === 0);
  assert.equal(winners.length, 1, `exactly one process may start (child reports: ${JSON.stringify(results.map(r => r.stdout))})`);
  assert.equal(JSON.parse(winners[0].stdout).attempts, 1, 'the winning start is the first and only attempt bump');
  const losers = results.filter(r => r.status !== 0);
  assert.equal(losers.length, 1);
  // A crashed or mis-loaded child prints no JSON and fails this parse: no arbitrary failure can satisfy the loser slot.
  const report = JSON.parse(losers[0].stdout);
  assert.equal(report.ok, false);
  assert.match(report.code, /^TASK_(BUSY|WRONG_STATE)$/, 'the loser must fail for a race reason, not for any reason');
  // Winner's transition is on disk exactly once: running at attempts 1, lock released.
  assert.equal(store.get(id).state, 'running');
  assert.equal(store.get(id).attempts, 1);
  assert.equal(fs.existsSync(store.file(id) + '.lock'), false, 'the winner must have released the lock');
});
test('a start against a lock held by another real process fails TASK_BUSY, never touches the record, and lands after release', { timeout: 120_000 }, async t => {
  const f = fixture(t), dir = path.join(f.base, 'tasks'), store = new TaskStore(dir), s = subject(f);
  const id = store.create(s);
  const lock = store.file(id) + '.lock', held = path.join(f.base, 'lock-held'), release = path.join(f.base, 'release-lock');
  // Holder child: takes the store's own mutex artifact (the lock dir transition() mkdirs and
  // rmdirs in src/tasks.mjs) and holds it across the barrier until the parent releases.
  const holderCode = `import fs from 'node:fs'; const [lock, held, release] = process.argv.slice(1); fs.mkdirSync(lock, { mode: 0o700 }); fs.writeFileSync(held, ''); const deadline = Date.now() + 15000; while (!fs.existsSync(release) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5)); fs.rmdirSync(lock); process.exitCode = fs.existsSync(release) ? 0 : 3;`;
  const holder = execute(process.execPath, ['--input-type=module', '-e', holderCode, lock, held, release]);
  holder.catch(() => {}); // an earlier assertion failure must not surface as an unhandled rejection
  await waitUntil(held, 'lock holder ready'); // barrier passed: another process owns the lock RIGHT NOW
  const module = new URL('../src/tasks.mjs', import.meta.url).href;
  const code = `import { TaskStore } from ${JSON.stringify(module)}; try { const r = new TaskStore(process.argv[1]).start(process.argv[2], JSON.parse(process.argv[3])); process.stdout.write(JSON.stringify({ ok: true, state: r.state, attempts: r.attempts })); } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.message })); process.exitCode = 2; }`;
  const loser = await run(process.execPath, ['--input-type=module', '-e', code, dir, id, JSON.stringify(s)]);
  assert.equal(loser.status, 2, `the locked-out starter must exit nonzero (stdout: ${loser.stdout})`);
  const report = JSON.parse(loser.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.code, 'TASK_BUSY', 'the held lock must be the failure reason, by construction');
  // The refused start wrote nothing: the on-disk record is still planned at attempts 0.
  assert.equal(store.get(id).state, 'planned');
  assert.equal(store.get(id).attempts, 0);
  fs.writeFileSync(release, '');
  await holder; // exits 0 only if it observed the release marker (3 on its safety timeout)
  assert.equal(fs.existsSync(lock), false, 'the holder must give the lock back');
  const winner = await run(process.execPath, ['--input-type=module', '-e', code, dir, id, JSON.stringify(s)]);
  assert.equal(winner.status, 0, `after release the start must succeed (stdout: ${winner.stdout})`);
  assert.equal(JSON.parse(winner.stdout).state, 'running');
  assert.equal(store.get(id).state, 'running');
  assert.equal(store.get(id).attempts, 1, 'after release the start lands exactly once');
});
test('start and resume with leaseMs record the exact lease expiry from the clock', t => {
  const f = fixture(t); let time = 5000;
  const store = new TaskStore(path.join(f.base, 'tasks'), { clock: () => time }), s = subject(f);
  const id = store.create(s);
  assert.equal(store.start(id, s, { leaseMs: 1000 }).leaseExpiresAt, 6000);
  assert.equal(store.get(id).leaseExpiresAt, 6000);
  store.interrupt(id, s);
  time = 7000;
  assert.equal(store.resume(id, s, { leaseMs: 2000 }).leaseExpiresAt, 9000);
  assert.equal(store.get(id).updatedAt, 7000);
});
test('entering running without leaseMs clears stale leases instead of re-arming phantoms', t => {
  const f = fixture(t); let time = 5000;
  const store = new TaskStore(path.join(f.base, 'tasks'), { clock: () => time }), s = subject(f);
  const a = store.create(s);
  store.start(a, s, { leaseMs: 1000 });
  store.interrupt(a, s);
  assert.equal(store.resume(a, s).state, 'running');
  assert.equal('leaseExpiresAt' in store.get(a), false, 'a leaseless resume must not resurrect the old expiry');
  time = 999999;
  assert.throws(() => store.reap(a, s), /TASK_LEASE_REQUIRED/);
  assert.equal(store.get(a).state, 'running', 'no lease signal means no reap, not a phantom crash');
  const b = store.create(s);
  const bAttempt = store.start(b, s, { leaseMs: 1000 });
  store.fail(b, s, { attemptToken: bAttempt.attemptToken });
  store.requeue(b, s);
  assert.equal(store.start(b, s).state, 'running');
  assert.equal('leaseExpiresAt' in store.get(b), false);
  for (const leave of ['interrupt', 'cancel', 'complete']) {
    const id = store.create(s);
    const { attemptToken } = store.start(id, s, { leaseMs: 1000 });
    if (leave === 'complete') store.complete(id, s, { attemptToken }); // executor-side: fenced
    else store[leave](id, s); // supervisor-side: acts on the record, never token-checked
    assert.equal('leaseExpiresAt' in store.get(id), false, `${leave} must clear the lease`);
    assert.equal('attemptToken' in store.get(id), false, `${leave} must retire the attempt token`);
  }
});
test('heartbeat extends a lease but never invents one', t => {
  const f = fixture(t); let time = 5000;
  const store = new TaskStore(path.join(f.base, 'tasks'), { clock: () => time }), s = subject(f);
  const id = store.create(s);
  assert.throws(() => store.heartbeat(id, s, { leaseMs: 1000 }), /TASK_WRONG_STATE/); // planned, not running
  const early = store.start(id, s); // leaseless, but the attempt is still fenced
  assert.throws(() => store.heartbeat(id, s, { leaseMs: 1000 }), /TASK_LEASE_REQUIRED/); // started leaseless
  assert.throws(() => store.heartbeat(id, s), /INVALID_LEASE/); // leaseMs is required: no updatedAt-only no-op
  store.fail(id, s, { attemptToken: early.attemptToken }); store.requeue(id, s);
  const leased = store.start(id, s, { leaseMs: 1000 });
  assert.match(leased.attemptToken, /^[a-f0-9]{32}$/, 'a leased start mints its fence token');
  time = 5500;
  assert.equal(store.heartbeat(id, s, { leaseMs: 2000, attemptToken: leased.attemptToken }).state, 'running');
  assert.equal(store.get(id).leaseExpiresAt, 7500);
  assert.equal(store.get(id).attempts, 2, 'heartbeats are not attempts');
  time = 8000; // past the 7500 expiry: liveness is proven by the call itself
  assert.equal(store.heartbeat(id, s, { leaseMs: 1000, attemptToken: leased.attemptToken }).leaseExpiresAt, 9000);
});
test('reap interrupts only an expired lease; recovery re-arms fresh and bumps attempts', t => {
  const f = fixture(t); let time = 5000;
  const store = new TaskStore(path.join(f.base, 'tasks'), { clock: () => time }), s = subject(f);
  const id = store.create(s);
  const opener = store.start(id, s);
  assert.throws(() => store.reap(id, s), /TASK_LEASE_REQUIRED/); // lease absence is not crash proof
  assert.equal(store.get(id).state, 'running');
  store.fail(id, s, { attemptToken: opener.attemptToken }); store.requeue(id, s);
  store.start(id, s, { leaseMs: 1000 });
  assert.throws(() => store.reap(id, s), /TASK_LEASE_ACTIVE/); // 5000 < 6000: live lease
  assert.equal(store.get(id).state, 'running');
  time = 6000; // now >= leaseExpiresAt
  const reaped = store.reap(id, s);
  assert.equal(reaped.state, 'interrupted');
  assert.equal('leaseExpiresAt' in reaped, false);
  assert.equal(store.get(id).attempts, 2, 'reaping is not an attempt; the resume is');
  time = 7000;
  assert.equal(store.resume(id, s, { leaseMs: 1500 }).state, 'running');
  assert.equal(store.get(id).attempts, 3);
  assert.equal(store.get(id).leaseExpiresAt, 8500);
});
test('a heartbeat landing before the reaper re-arms the lease and blocks the reap', t => {
  const f = fixture(t); let time = 5000;
  const store = new TaskStore(path.join(f.base, 'tasks'), { clock: () => time }), s = subject(f);
  const id = store.create(s);
  const leased = store.start(id, s, { leaseMs: 1000 }); // expiry 6000
  time = 6000;
  assert.equal(store.heartbeat(id, s, { leaseMs: 1000, attemptToken: leased.attemptToken }).leaseExpiresAt, 7000);
  assert.throws(() => store.reap(id, s), /TASK_LEASE_ACTIVE/);
  assert.equal(store.get(id).state, 'running');
  time = 7000;
  assert.equal(store.reap(id, s).state, 'interrupted'); // the same serialized check now passes
  assert.throws(() => store.heartbeat(id, s, { leaseMs: 1000, attemptToken: leased.attemptToken }), /TASK_WRONG_STATE/); // reaped: liveness lost
});

test('attempt fencing: a stale leased executor cannot complete the reaper-resumed attempt (codex audit #5)', t => {
  const f = fixture(t); let time = 5000;
  const store = new TaskStore(path.join(f.base, 'tasks'), { clock: () => time }), s = subject(f);
  const id = store.create(s);
  const workerA = store.start(id, s, { owner: 'worker-a', leaseMs: 1000 }); // attempt 1, expiry 6000
  time = 6000; // A's lease expires; the reaper interrupts...
  assert.equal(store.reap(id, s).state, 'interrupted');
  time = 7000;
  const workerB = store.resume(id, s, { leaseMs: 900000 }); // attempt 2 with a FRESH token
  assert.notEqual(workerB.attemptToken, workerA.attemptToken, 'each attempt mints its own token');
  // A's late executor-side transitions must all fail against attempt 2...
  assert.throws(() => store.complete(id, s, { attemptToken: workerA.attemptToken }), /TASK_ATTEMPT_MISMATCH/);
  assert.throws(() => store.fail(id, s, { attemptToken: workerA.attemptToken }), /TASK_ATTEMPT_MISMATCH/);
  assert.throws(() => store.heartbeat(id, s, { leaseMs: 1000, attemptToken: workerA.attemptToken }), /TASK_ATTEMPT_MISMATCH/);
  assert.throws(() => store.complete(id, s), /TASK_ATTEMPT_TOKEN_REQUIRED/, 'a fenced record refuses tokenless completion');
  // ...while B's own transitions succeed, and the record reflects attempt 2.
  assert.equal(store.heartbeat(id, s, { leaseMs: 900000, attemptToken: workerB.attemptToken }).state, 'running');
  assert.equal(store.complete(id, s, { attemptToken: workerB.attemptToken }).state, 'completed');
  assert.equal(store.get(id).owner, 'worker-a', 'owner is a label; fencing lives on the token');
  assert.equal(store.get(id).attempts, 2);
});

test('attempt fencing: a stale executor cannot complete a leaseless reaper-resumed attempt either (codex audit #5, round 3)', t => {
  const f = fixture(t); let time = 5000;
  const store = new TaskStore(path.join(f.base, 'tasks'), { clock: () => time }), s = subject(f);
  const id = store.create(s);
  const workerA = store.start(id, s, { owner: 'worker-a', leaseMs: 1000 }); // attempt 1
  time = 6000; // the lease expires; the reaper interrupts...
  assert.equal(store.reap(id, s).state, 'interrupted');
  time = 7000;
  // B resumes WITHOUT a lease: fencing is per-attempt (round 3), so a fresh token is
  // minted anyway — otherwise A would walk back in and complete B's attempt.
  const workerB = store.resume(id, s);
  assert.match(workerB.attemptToken, /^[a-f0-9]{32}$/, 'a leaseless resume still fences its attempt');
  assert.notEqual(workerB.attemptToken, workerA.attemptToken, 'each attempt mints its own token');
  assert.throws(() => store.complete(id, s, { attemptToken: workerA.attemptToken }), /TASK_ATTEMPT_MISMATCH/, 'A\'s late complete against attempt 2');
  assert.throws(() => store.complete(id, s), /TASK_ATTEMPT_TOKEN_REQUIRED/, 'tokenless completion of a fenced record');
  assert.equal(store.complete(id, s, { attemptToken: workerB.attemptToken }).state, 'completed');
  assert.equal(store.get(id).attempts, 2);
});

test('attempt fencing: leaseless attempts are fenced from mint to completion', t => {
  const f = fixture(t), store = new TaskStore(path.join(f.base, 'tasks')), s = subject(f);
  const id = store.create(s);
  const started = store.start(id, s); // no lease — the attempt still gets its fence
  assert.match(started.attemptToken, /^[a-f0-9]{32}$/, 'every start mints a token, leased or not');
  assert.throws(() => store.complete(id, s), /TASK_ATTEMPT_TOKEN_REQUIRED/, 'tokenless completion is refused');
  assert.equal(store.complete(id, s, { attemptToken: started.attemptToken }).state, 'completed');
});

test('requeue moves failed back to planned; every other state is enumerated and rejected', t => {
  const f = fixture(t), store = new TaskStore(path.join(f.base, 'tasks')), s = subject(f);
  const id = store.create(s);
  const first = store.start(id, s);
  store.fail(id, s, { attemptToken: first.attemptToken });
  assert.equal(store.requeue(id, s).state, 'planned');
  assert.equal(store.start(id, s).state, 'running');
  assert.equal(store.get(id).attempts, 2, 'the retry start bumps across the cycle');
  assert.throws(() => store.requeue(id, s), /TASK_WRONG_STATE/); // running
  assert.throws(() => store.requeue(store.create(s), s), /TASK_WRONG_STATE/); // planned
  const done = store.create(s); const doneAttempt = store.start(done, s); store.complete(done, s, { attemptToken: doneAttempt.attemptToken });
  assert.throws(() => store.requeue(done, s), /TASK_WRONG_STATE/); // completed
  const cancelled = store.create(s); store.cancel(cancelled, s);
  assert.throws(() => store.requeue(cancelled, s), /TASK_WRONG_STATE/); // cancelled stays terminal
  const parked = store.create(s); store.start(parked, s); store.interrupt(parked, s);
  assert.throws(() => store.requeue(parked, s), /TASK_WRONG_STATE/); // interrupted recovers via resume
});
test('leaseMs must be a safe integer within 1..86400000', t => {
  const f = fixture(t), store = new TaskStore(path.join(f.base, 'tasks')), s = subject(f);
  const id = store.create(s);
  for (const leaseMs of [0, 86400001, 1.5, 'x']) {
    assert.throws(() => store.start(id, s, { leaseMs }), /INVALID_LEASE/);
    assert.throws(() => store.resume(id, s, { leaseMs }), /INVALID_LEASE/);
    assert.throws(() => store.heartbeat(id, s, { leaseMs }), /INVALID_LEASE/);
  }
  const armed = store.start(id, s, { leaseMs: 1 });
  assert.equal(armed.state, 'running');
  assert.equal(Number.isSafeInteger(store.heartbeat(id, s, { leaseMs: 86400000, attemptToken: armed.attemptToken }).leaseExpiresAt), true);
});
test('legacy records without leaseExpiresAt stay readable and transitional', t => {
  const f = fixture(t), store = new TaskStore(path.join(f.base, 'tasks')), s = subject(f);
  const id = store.create(s);
  // Hand-written pre-lease shape: schemaVersion 1, every field valid, no lease key.
  fs.writeFileSync(store.file(id), JSON.stringify(
    { schemaVersion: 1, id, subjectHash: subjectDigest(s), state: 'planned', attempts: 0, createdAt: 1000, updatedAt: 1000 }) + '\n');
  assert.equal(store.get(id).state, 'planned');
  assert.deepEqual(store.list().map(r => r.id), [id]);
  assert.equal(store.start(id, s).state, 'running'); // zero migration: old records keep working
  store.interrupt(id, s);
  assert.equal(store.resume(id, s, { leaseMs: 1000 }).state, 'running');
});
test('tampered leaseExpiresAt fields fail closed as INVALID_TASK_RECORD', t => {
  const f = fixture(t), store = new TaskStore(path.join(f.base, 'tasks')), s = subject(f);
  const id = store.create(s);
  const pristine = store.get(id); // read once: the tampered record itself must not be re-readable
  for (const bad of [1.5, '6000', -1]) {
    fs.writeFileSync(store.file(id), JSON.stringify({ ...pristine, leaseExpiresAt: bad }) + '\n');
    assert.throws(() => store.get(id), /INVALID_TASK_RECORD/, `leaseExpiresAt=${JSON.stringify(bad)}`);
  }
  assert.throws(() => store.start(id, s), /INVALID_TASK_RECORD/);
});
test('tasks CLI requires --lease-ms on heartbeat and refuses bad leases before creating state', async t => {
  const f = fixture(t), state = path.join(f.base, 'never-created');
  const actionFile = path.join(f.base, 'action.json');
  fs.writeFileSync(actionFile, JSON.stringify({ kind: 'publish', artifactHash: 'fixture' }));
  const binding = ['--host', 'zcode', '--session', 's1', '--run', 'r1', '--policy-hash', f.policy.policyHash, '--action-file', actionFile];
  await assert.rejects(execute(process.execPath, [cli, 'tasks', 'heartbeat', '--state', state, '--id', '00000000-0000-4000-8000-000000000000', ...binding]),
    error => error.code === 1 && /INVALID_ARGUMENTS/.test(error.stderr));
  await assert.rejects(execute(process.execPath, [cli, 'tasks', 'start', '--state', state, '--id', '00000000-0000-4000-8000-000000000000', ...binding, '--lease-ms', '0']),
    error => error.code === 1 && /INVALID_LEASE/.test(error.stderr));
  assert.equal(fs.existsSync(state), false, 'a refused lease must not leave a state directory behind');
});
test('tasks CLI refuses --attempt-token off-scope or malformed before creating any state (audit #5)', async t => {
  const f = fixture(t), state = path.join(f.base, 'never-created');
  const actionFile = path.join(f.base, 'action.json');
  fs.writeFileSync(actionFile, JSON.stringify({ kind: 'publish', artifactHash: 'fixture' }));
  const binding = ['--host', 'zcode', '--session', 's1', '--run', 'r1', '--policy-hash', f.policy.policyHash, '--action-file', actionFile];
  const id = '00000000-0000-4000-8000-000000000000';
  await assert.rejects(execute(process.execPath, [cli, 'tasks', 'start', '--state', state, '--id', id, ...binding, '--attempt-token', 'a'.repeat(32)]),
    error => error.code === 1 && /INVALID_ARGUMENTS/.test(error.stderr), 'the flag is scoped to heartbeat/complete/fail');
  await assert.rejects(execute(process.execPath, [cli, 'tasks', 'complete', '--state', state, '--id', id, ...binding, '--attempt-token', 'not-hex']),
    error => error.code === 1 && /INVALID_ATTEMPT_TOKEN/.test(error.stderr), 'the token is 32 lowercase hex');
  assert.equal(fs.existsSync(state), false, 'a refused token must not leave a state directory behind');
});
test('tasks CLI start --lease-ms arms a lease the reaper must respect until expiry', async t => {
  const f = fixture(t), state = path.join(f.base, 'tasks');
  const actionFile = path.join(f.base, 'action.json');
  fs.writeFileSync(actionFile, JSON.stringify({ kind: 'publish', artifactHash: 'fixture' }));
  const binding = ['--host', 'zcode', '--session', 's1', '--run', 'r1', '--policy-hash', f.policy.policyHash, '--action-file', actionFile];
  const id = JSON.parse((await execute(process.execPath, [cli, 'tasks', 'create', '--state', state, ...binding])).stdout);
  const started = JSON.parse((await execute(process.execPath, [cli, 'tasks', 'start', '--state', state, '--id', id, ...binding, '--lease-ms', '60000'])).stdout);
  assert.equal(started.state, 'running');
  assert.equal(Number.isSafeInteger(started.leaseExpiresAt), true);
  const shown = JSON.parse((await execute(process.execPath, [cli, 'tasks', 'show', '--state', state, '--id', id])).stdout);
  assert.equal(shown.leaseExpiresAt, started.leaseExpiresAt);
  await assert.rejects(execute(process.execPath, [cli, 'tasks', 'reap', '--state', state, '--id', id, ...binding]),
    error => error.code === 1 && /TASK_LEASE_ACTIVE/.test(error.stderr));
});
