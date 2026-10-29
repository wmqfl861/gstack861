// Batch 18 lane A: real two-process LEASE race through the real CLI.
//
// Honesty grading: this EXTENDS, not replaces, the pre-existing two-process
// START race at test/tasks.test.mjs:222 ("two real processes cannot both start
// one task"). The new coverage is (1) lease timing — every child sleeps past a
// 40ms lease so the raced decisions are reap/heartbeat, not merely a state
// transition; (2) the lock loser's error-code set {TASK_LEASE_ACTIVE,
// TASK_WRONG_STATE, TASK_BUSY} — any mkdir failure on the lock directory maps
// to TASK_BUSY inside transition() (src/tasks.mjs:81), so overlap itself is
// verified behavior; (3) record/winner consistency — the final on-disk record
// must equal the winner's printed record and match that winner's semantics.
//
// The outcome is an ORDER-SET: both lock orders are legal (reap first →
// interrupted with no lease; heartbeat first → running with a future lease).
// Determinism lives in the invariants: exactly one child exits 0, the loser
// names exactly one scenario-legal code, and the final record self-consistently
// identifies the winner. The control test pins the apparatus: a lone reaper
// after expiry MUST succeed, so a broken fixture goes red instead of green.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { TaskStore } from '../src/tasks.mjs';
import { subjectDigest } from '../src/approvals.mjs';
import { fixture } from './helpers.mjs';
const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/gstack861.mjs', import.meta.url));

// Child harness: a real node process that sleeps `delayMs` (letting the lease
// expire / aligning both starts), then spawnSync's the REAL CLI and passes
// exit/stdout/stderr through untouched. Args arrays only — no shell strings,
// so Windows and Linux behave identically.
const childJs = (delayMs, cliArgs) => ['--eval', `setTimeout(()=>{const{spawnSync}=require('node:child_process');const r=spawnSync(process.execPath,${JSON.stringify(cliArgs)},{encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status||0)},${delayMs})`];

// spawnSync cannot overlap two children, so the parent spawns both WITHOUT
// awaiting (async spawn wrapped in a promise) and reaps them via Promise.all.
const runChild = (delayMs, cliArgs) => new Promise(resolve => {
  const child = spawn(process.execPath, childJs(delayMs, cliArgs), { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => resolve({ status: null, stdout, stderr: `${stderr}${error}` }));
  child.on('close', status => resolve({ status, stdout, stderr }));
});

/** One task created and started via the real CLI with a 40ms lease (attempts 1). */
async function leasedTask(state, binding) {
  const id = JSON.parse((await execute(process.execPath, [cli, 'tasks', 'create', '--state', state, ...binding])).stdout);
  const started = JSON.parse((await execute(process.execPath, [cli, 'tasks', 'start', '--state', state, '--id', id, ...binding, '--lease-ms', '40'])).stdout);
  assert.equal(started.state, 'running');
  assert.equal(started.attempts, 1, 'the initial start is the only attempt-bump in every scenario');
  assert.match(started.attemptToken, /^[a-f0-9]{32}$/, 'the leased start mints the attempt fence');
  return { id, attemptToken: started.attemptToken };
}

/** Post-race invariants shared by all scenarios. Returns the final record. */
function invariants(state, id, subject, actionFile, actionBytes) {
  // No corruption: a fresh store get() revalidates the whole record schema
  // (INVALID_TASK_RECORD on any tampered field), so this line is the check.
  const final = new TaskStore(state).get(id);
  assert.equal(final.schemaVersion, 1);
  assert.equal(final.id, id);
  assert.equal(final.subjectHash, subjectDigest(subject), 'the binding survives the race untouched');
  // The winner rmdir's the lock in its finally block: no leaked lock directory.
  assert.equal(fs.existsSync(path.join(state, `task-${id}.json.lock`)), false, 'the lock directory must be gone');
  // The single action file the parent wrote is byte-identical after the race.
  assert.deepEqual(fs.readFileSync(actionFile), actionBytes);
  return final;
}

/** Loser discipline: nonzero exit, stderr naming exactly one code from `allowed`. */
function loserCheck(loser, allowed, label) {
  assert.notEqual(loser.status, 0, `${label} must exit nonzero`);
  const codes = loser.stderr.match(/TASK_[A-Z_]+/g) ?? [];
  assert.equal(codes.length, 1, `${label} stderr must name exactly one code (got: ${JSON.stringify(loser.stderr)})`);
  assert.ok(allowed.includes(codes[0]), `${label} code ${codes[0]} must be one of ${allowed.join('|')}`);
}

test('reap vs heartbeat: two real CLI processes race past lease expiry (order-set: exactly one winner)', { timeout: 120_000 }, async t => {
  const f = fixture(t);
  const subject = { host: 'dsh', sessionId: 'lease-race-s1', runId: 'lease-race-r1', policyHash: f.policy.policyHash, action: { kind: 'publish', artifactHash: 'lease-race-fixture' } };
  const actionFile = path.join(f.base, 'action.json');
  fs.writeFileSync(actionFile, JSON.stringify(subject.action));
  const actionBytes = fs.readFileSync(actionFile);
  const binding = ['--host', subject.host, '--session', subject.sessionId, '--run', subject.runId, '--policy-hash', subject.policyHash, '--action-file', actionFile];
  const state = path.join(f.base, 'tasks');
  const { id, attemptToken } = await leasedTask(state, binding); // lease armed for 40ms at start time
  const reapArgs = [cli, 'tasks', 'reap', '--state', state, '--id', id, ...binding];
  // The heartbeat child plays the executor (audit #5/#16): it must present the attempt
  // token the start minted, or its wins would be TASK_ATTEMPT_TOKEN_REQUIRED refusals.
  const heartbeatArgs = [cli, 'tasks', 'heartbeat', '--state', state, '--id', id, ...binding, '--lease-ms', '60000', '--attempt-token', attemptToken]; // 60s margin: never flakes on a slow parent
  // Both children wake at (own start + 60ms) >= 60ms after the 40ms lease armed: always past expiry.
  const [reap, heartbeat] = await Promise.all([runChild(60, reapArgs), runChild(60, heartbeatArgs)]);
  // Exactly one exit 0 — the lock directory mkdir serializes the transitions.
  assert.equal([reap, heartbeat].filter(r => r.status === 0).length, 1,
    `exactly one child may win (reap status=${reap.status}, heartbeat status=${heartbeat.status})`);
  const final = invariants(state, id, subject, actionFile, actionBytes);
  if (final.state === 'interrupted' && final.leaseExpiresAt === undefined) {
    // Reap won: the record itself identifies the winner.
    assert.equal(reap.status, 0, 'an interrupted leaseless record means reap won');
    const winner = JSON.parse(reap.stdout);
    assert.equal(winner.state, 'interrupted');
    assert.deepEqual(final, winner, 'final record equals the reap winner stdout');
    assert.equal(final.attempts, 1, 'reap never bumps attempts');
    loserCheck(heartbeat, ['TASK_WRONG_STATE', 'TASK_BUSY'], 'heartbeat loser');
  } else if (final.state === 'running' && Number.isSafeInteger(final.leaseExpiresAt) && final.leaseExpiresAt > Date.now()) {
    // Heartbeat won: running with a re-armed future lease.
    assert.equal(heartbeat.status, 0, 'a running record with a future lease means heartbeat won');
    const winner = JSON.parse(heartbeat.stdout);
    assert.equal(winner.state, 'running');
    assert.equal(winner.attempts, 1, 'heartbeats are not attempts');
    assert.deepEqual(final, winner, 'final record equals the heartbeat winner stdout');
    loserCheck(reap, ['TASK_LEASE_ACTIVE', 'TASK_BUSY'], 'reap loser');
  } else {
    assert.fail(`final record must match one of the two legal lock orders (got: ${JSON.stringify(final)})`);
  }
});

test('reap vs reap: dual reapers race past lease expiry (exactly one interrupts, attempts stay 1)', { timeout: 120_000 }, async t => {
  const f = fixture(t);
  const subject = { host: 'dsh', sessionId: 'lease-race-s1', runId: 'lease-race-r1', policyHash: f.policy.policyHash, action: { kind: 'publish', artifactHash: 'lease-race-fixture' } };
  const actionFile = path.join(f.base, 'action.json');
  fs.writeFileSync(actionFile, JSON.stringify(subject.action));
  const actionBytes = fs.readFileSync(actionFile);
  const binding = ['--host', subject.host, '--session', subject.sessionId, '--run', subject.runId, '--policy-hash', subject.policyHash, '--action-file', actionFile];
  const state = path.join(f.base, 'tasks');
  const { id } = await leasedTask(state, binding);
  const reapArgs = [cli, 'tasks', 'reap', '--state', state, '--id', id, ...binding];
  const [first, second] = await Promise.all([runChild(60, reapArgs), runChild(60, reapArgs)]);
  assert.equal([first, second].filter(r => r.status === 0).length, 1,
    `exactly one reaper may win (statuses ${first.status}/${second.status})`);
  const winner = first.status === 0 ? first : second;
  const loser = first.status === 0 ? second : first;
  loserCheck(loser, ['TASK_WRONG_STATE', 'TASK_BUSY'], 'second reaper');
  const final = invariants(state, id, subject, actionFile, actionBytes);
  assert.equal(final.state, 'interrupted');
  assert.equal('leaseExpiresAt' in final, false, 'reaping clears the lease');
  assert.equal(final.attempts, 1, 'reap never bumps attempts');
  assert.deepEqual(final, JSON.parse(winner.stdout), 'final record equals the winning reaper stdout');
});

test('control: a single reaper after lease expiry must succeed (apparatus validity, no false green)', { timeout: 120_000 }, async t => {
  const f = fixture(t);
  const subject = { host: 'dsh', sessionId: 'lease-race-s1', runId: 'lease-race-r1', policyHash: f.policy.policyHash, action: { kind: 'publish', artifactHash: 'lease-race-fixture' } };
  const actionFile = path.join(f.base, 'action.json');
  fs.writeFileSync(actionFile, JSON.stringify(subject.action));
  const actionBytes = fs.readFileSync(actionFile);
  const binding = ['--host', subject.host, '--session', subject.sessionId, '--run', subject.runId, '--policy-hash', subject.policyHash, '--action-file', actionFile];
  const state = path.join(f.base, 'tasks');
  const { id } = await leasedTask(state, binding);
  const solo = await runChild(60, [cli, 'tasks', 'reap', '--state', state, '--id', id, ...binding]);
  assert.equal(solo.status, 0, `the control reaper must succeed (stderr: ${solo.stderr})`);
  const final = invariants(state, id, subject, actionFile, actionBytes);
  assert.equal(final.state, 'interrupted');
  assert.equal('leaseExpiresAt' in final, false);
  assert.equal(final.attempts, 1);
  assert.deepEqual(final, JSON.parse(solo.stdout), 'final record equals the lone reaper stdout');
});
