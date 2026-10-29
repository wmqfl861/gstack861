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
  // Expiry is checked before the from-state guard, so even the pending→consumed skip surfaces as EXPIRED.
  assert.throws(() => store.consume(id, s), /EXPIRED/);
});
test('consume is fenced by expiry: valid at expiresAt - 1, refused at expiresAt, record stays approved', t => {
  const f = fixture(t); let time = 2000;
  const store = new ApprovalStore(path.join(f.base, 'approvals'), { clock: () => time }), s = subject(f);
  // Boundary contract (src/approvals.mjs:63): a record is expired iff now >= expiresAt —
  // the instant itself is ALREADY expired; expiresAt - 1 is the last valid instant.
  const early = store.issue(s, { ttlMs: 5 }), boundary = store.issue(s, { ttlMs: 5 }); // both expire at 2005
  store.approve(early, s); store.approve(boundary, s); // approve while valid
  assert.equal(store.get(boundary).expiresAt, 2005);
  time = 2004; // one instant before the boundary
  assert.equal(store.consume(early, s).state, 'consumed', 'expiresAt - 1 is still consumable');
  time = 2005; // exactly expiresAt: now >= expiresAt → expired
  assert.throws(() => store.consume(boundary, s), /APPROVAL_EXPIRED/, 'the expiry instant itself is already expired');
  // The refusal is read-only: on disk the record is still approved, not consumed, and untouched.
  const onDisk = JSON.parse(fs.readFileSync(store.file(boundary), 'utf8'));
  assert.equal(onDisk.state, 'approved', 'a refused consume must not have written consumed');
  assert.equal(onDisk.changedAt, 2000, 'a refused consume must not have rewritten the record');
  assert.equal(store.get(boundary).state, 'approved');
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
test('corrupt and non-object approval records fail closed in transitions and reads', t => {
  const f = fixture(t), store = new ApprovalStore(path.join(f.base, 'approvals')), s = subject(f);
  const id = store.issue(s);
  // Corrupt JSON previously surfaced as a raw SyntaxError from transition.
  fs.writeFileSync(store.file(id), '{');
  assert.throws(() => store.approve(id, s), /INVALID_APPROVAL_RECORD/);
  assert.throws(() => store.get(id), /INVALID_APPROVAL_RECORD/);
  // A null record previously crashed transition with a raw TypeError; get already failed closed.
  fs.writeFileSync(store.file(id), 'null\n');
  assert.throws(() => store.approve(id, s), /INVALID_APPROVAL_RECORD/);
  assert.throws(() => store.get(id), /INVALID_APPROVAL_RECORD/);
  fs.writeFileSync(store.file(id), '[]\n');
  assert.throws(() => store.approve(id, s), /INVALID_APPROVAL_RECORD/);
  assert.throws(() => store.get(id), /INVALID_APPROVAL_RECORD/);
});
// Audit #12 evidence classes — kept separate on purpose:
// (a) the free race below proves ATOMICITY: exactly one consumer wins, the loser names a
//     structured store code. A fully serial execution is still a legal race outcome (the
//     loser then reports APPROVAL_WRONG_STATE), so this class alone proves once-only
//     consumption, NOT that the lock path executed.
// (b) the held-lock test after it proves CONTENTION by construction: another real process
//     owns the store's lock directory while a consumer runs, so APPROVAL_BUSY is the only
//     possible failure, the record must survive untouched, and the consume must land
//     exactly once after the lock is released.
test('concurrent consumes across real processes: exactly one wins and the loser names a structured contention code', { timeout: 120_000 }, async t => {
  const f = fixture(t), dir = path.join(f.base, 'approvals'), store = new ApprovalStore(dir), s = subject(f);
  const id = store.issue(s); store.approve(id, s);
  const module = new URL('../src/approvals.mjs', import.meta.url).href;
  // Child contract: exactly one JSON line — {ok:true,state} or {ok:false,code}; exit 2 on failure.
  const code = `import { ApprovalStore } from ${JSON.stringify(module)}; try { const r = new ApprovalStore(process.argv[1]).consume(process.argv[2], JSON.parse(process.argv[3])); process.stdout.write(JSON.stringify({ ok: true, state: r.state })); } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.message })); process.exitCode = 2; }`;
  const results = await Promise.all([0, 1].map(() => run(process.execPath, ['--input-type=module', '-e', code, dir, id, JSON.stringify(s)])));
  const winners = results.filter(r => r.status === 0);
  assert.equal(winners.length, 1, `exactly one process may consume (child reports: ${JSON.stringify(results.map(r => r.stdout))})`);
  assert.equal(JSON.parse(winners[0].stdout).state, 'consumed');
  const losers = results.filter(r => r.status !== 0);
  assert.equal(losers.length, 1);
  // A crashed or mis-loaded child prints no JSON and fails this parse: no arbitrary failure can satisfy the loser slot.
  const report = JSON.parse(losers[0].stdout);
  assert.equal(report.ok, false);
  assert.match(report.code, /^APPROVAL_(BUSY|WRONG_STATE)$/, 'the loser must fail for a race reason, not for any reason');
  // Winner's transition is on disk exactly once: consumed is terminal, so one winner means one transition.
  assert.equal(store.get(id).state, 'consumed');
});
test('a consume against a lock held by another real process fails APPROVAL_BUSY and the record survives', { timeout: 120_000 }, async t => {
  const f = fixture(t), dir = path.join(f.base, 'approvals'), store = new ApprovalStore(dir), s = subject(f);
  const id = store.issue(s); store.approve(id, s);
  const lock = store.file(id) + '.lock', held = path.join(f.base, 'lock-held'), release = path.join(f.base, 'release-lock');
  // Holder child: takes the store's own mutex artifact (the lock dir transition() mkdirs and
  // rmdirs in src/approvals.mjs) and holds it across the barrier until the parent releases.
  const holderCode = `import fs from 'node:fs'; const [lock, held, release] = process.argv.slice(1); fs.mkdirSync(lock, { mode: 0o700 }); fs.writeFileSync(held, ''); const deadline = Date.now() + 15000; while (!fs.existsSync(release) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5)); fs.rmdirSync(lock); process.exitCode = fs.existsSync(release) ? 0 : 3;`;
  const holder = execute(process.execPath, ['--input-type=module', '-e', holderCode, lock, held, release]);
  holder.catch(() => {}); // an earlier assertion failure must not surface as an unhandled rejection
  await waitUntil(held, 'lock holder ready'); // barrier passed: another process owns the lock RIGHT NOW
  const module = new URL('../src/approvals.mjs', import.meta.url).href;
  const code = `import { ApprovalStore } from ${JSON.stringify(module)}; try { const r = new ApprovalStore(process.argv[1]).consume(process.argv[2], JSON.parse(process.argv[3])); process.stdout.write(JSON.stringify({ ok: true, state: r.state })); } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.message })); process.exitCode = 2; }`;
  const loser = await run(process.execPath, ['--input-type=module', '-e', code, dir, id, JSON.stringify(s)]);
  assert.equal(loser.status, 2, `the locked-out consumer must exit nonzero (stdout: ${loser.stdout})`);
  const report = JSON.parse(loser.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.code, 'APPROVAL_BUSY', 'the held lock must be the failure reason, by construction');
  // The refused consume wrote nothing: the on-disk record is still approved, not consumed.
  assert.equal(JSON.parse(fs.readFileSync(store.file(id), 'utf8')).state, 'approved');
  fs.writeFileSync(release, '');
  await holder; // exits 0 only if it observed the release marker (3 on its safety timeout)
  assert.equal(fs.existsSync(lock), false, 'the holder must give the lock back');
  const winner = await run(process.execPath, ['--input-type=module', '-e', code, dir, id, JSON.stringify(s)]);
  assert.equal(winner.status, 0, `after release the consume must succeed (stdout: ${winner.stdout})`);
  assert.equal(JSON.parse(winner.stdout).state, 'consumed');
  assert.equal(store.get(id).state, 'consumed', 'the consume lands exactly once, only after the lock freed');
});
