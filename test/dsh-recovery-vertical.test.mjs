// Offline unit tests for the batch-16 recovery vertical (scripts/dsh-recovery-vertical.mjs).
//
// The KEYED path (the crash choreography's keyed leg: real DSH task R under the
// recovered journal) runs only under the coordinator with DEEPSEEK_API_KEY;
// these tests never launch DSH. Coverage is deliberately MINIMAL per the
// batch-16 plan-review fix 2 — exactly the three vectors this script adds:
//
//   1. The REAL-CLOCK CLI expiry matrix (--lease-ms 1 + 25ms real elapsed →
//      reap SUCCEEDS → resume → attempts=2 running). Existing coverage is
//      fake-clock store-level (tasks.test.mjs) and CLI-negative only (the
//      unexpired TASK_LEASE_ACTIVE reap); the real-clock CLI SUCCESS path
//      through reap→resume is new here.
//   2. The new script's keyless discipline: exit 2 with the three-part BLOCKED
//      output, zero spawns.
//   3. buildSpecPrompt measured against the REAL temp root (≤190 chars,
//      checkPromptCap passes) — the real-root vector for the SPEC prompt is
//      new; the 52/180 synthetic-root tiers, the read-tool pinning and the
//      verdictMarker matrix are already pinned by dsh-keyed-scripts.test.mjs
//      and are NOT re-tested.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkPromptCap } from '../scripts/verify-dsh-robustness.mjs';
import { writeMiniFixture, buildSpecPrompt, writeActionFile } from '../scripts/dsh-mini-vertical.mjs';
import { RECOVERY_LEASE_MS, runTasksCli, syncWait, tasksLeaseArgs } from '../scripts/dsh-recovery-vertical.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function base(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-rv-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// 1. Real-clock CLI expiry matrix (the new success path; key stripped).
// ---------------------------------------------------------------------------

test('real-clock CLI expiry matrix: --lease-ms 1 + 25ms → reap succeeds → resume attempts=2 running', (t) => {
  const root = base(t);
  // host 'dsh' + any 64-hex policyHash: subjectDigest accepts it, and the
  // journal semantics under test (lease expiry, not policy) need no real policy.
  const actionFile = writeActionFile(root, { phase: 'recovery', task: 'R' });
  const subject = { stateDir: path.join(root, 'tasks-state'), sessionId: 'rv-uuid',
    runId: 'rv1a2b3c', policyHash: 'a'.repeat(64), actionFile };
  const cli = extra => runTasksCli(tasksLeaseArgs({ ...subject, ...extra }), { cwd: repoRoot });
  // The builder guard (result-review minor 1): --lease-ms must be un-buildable
  // for any subcommand the CLI itself would reject it on.
  for (const sub of ['create', 'reap', 'complete', 'fail', 'heartbeat']) {
    assert.throws(() => tasksLeaseArgs({ ...subject, sub, id: 'x', leaseMs: 1000 }), /LEASE_SCOPE_VIOLATION/, sub);
  }

  const created = cli({ sub: 'create' });
  assert.equal(created.status, 0, created.stderr);
  const id = created.parsed;

  const started = cli({ sub: 'start', id, leaseMs: 1 });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.parsed.state, 'running');
  assert.equal(started.parsed.attempts, 1, 'create→start bumps attempts exactly once');

  // Real wall clock: 25ms of true elapsed time against a 1ms lease — the
  // reaper's own child spawn already takes longer, but the explicit blocking
  // wait makes the vector deterministic (same syncWait the keyed run uses).
  syncWait(25);

  const reaped = cli({ sub: 'reap', id });
  assert.equal(reaped.status, 0, `reap after expiry must succeed: ${reaped.stderr}`);
  assert.equal(reaped.parsed.state, 'interrupted');

  const resumed = cli({ sub: 'resume', id, leaseMs: RECOVERY_LEASE_MS });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.parsed.attempts, 2, 'reaping is not an attempt; the resume is (crash + recovery, no double count)');
  assert.equal(resumed.parsed.state, 'running');
}, { timeout: 60000 });

// ---------------------------------------------------------------------------
// 2. Keyless discipline: the script exits 2 with a BLOCKED message, zero spawns.
// ---------------------------------------------------------------------------

test('keyless invocation: the recovery vertical exits 2 (BLOCKED) without touching DSH', () => {
  const child = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/dsh-recovery-vertical.mjs')], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, DEEPSEEK_API_KEY: '' },
  });
  assert.equal(child.status, 2);
  assert.match(child.stdout, /BLOCKED/);
  assert.match(child.stdout, /DEEPSEEK_API_KEY/);
}, { timeout: 120000 });

// ---------------------------------------------------------------------------
// 3. The SPEC prompt against the REAL temp root (the recovery-spec vector).
// ---------------------------------------------------------------------------

test('buildSpecPrompt measures <=190 with the real temp root and passes checkPromptCap', (t) => {
  // Same mkdtemp shape prepareMini uses at runtime (1-char prefix): the
  // measured length with the REAL machine temp root is the number the keyed
  // run prints for its recovery-spec prompt.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prompt = buildSpecPrompt({ specPath: writeMiniFixture(root).specPath });
  assert.ok(prompt.length <= 190, `expected <=190 with the real temp root, measured ${prompt.length}`);
  assert.equal(checkPromptCap(prompt, 'recovery-spec'), prompt);
});
