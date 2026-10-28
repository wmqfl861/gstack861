// Offline tests for the batch-16 zcode workflow journal harness
// (scripts/zcode-workflow-vertical.mjs).
//
// The harness is FULLY OFFLINE (graded offline-workflow-journal-harness: real
// CLI journals/approvals + controller-authored stand-ins, zero model calls,
// zero ZCode host APIs), so the strongest test runs the WHOLE thing as a
// subprocess and asserts exit 0 + RESULT: PASS. Alongside it: the zcode
// builders' args discipline (new code — the dsh builders hardcode --host dsh,
// so these vectors are not duplication), the local shipGate matrix, the
// scoped policy leg on a harness-authored policy file, the host-zcode subject
// digest, and the FAIL-injection knob (exit 1 + the named SHIP_TARGET_EXISTS
// code). Deliberately NOT re-tested here: the raw wx EEXIST throw (the
// batch-14 test owns it — plan-review fix 3) and the generic policy IN/OUT
// matrix (policy.test.mjs owns it — review scoping suggestion).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPolicy, evaluate } from '../src/policy.mjs';
import { subjectDigest } from '../src/approvals.mjs';
import { writeActionFile, subjectFor } from '../scripts/dsh-mini-vertical.mjs';
import {
  STAGES, zcodeTasksArgs, zcodeApprovalsArgs, subjectForZcode, shipGate, zcodePolicyJson,
} from '../scripts/zcode-workflow-vertical.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function base(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-zw-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run the whole harness as a subprocess (it is fully offline — that is the point). */
function runHarness(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.DEEPSEEK_API_KEY; // the harness must never see a key, and never need one
  return spawnSync(process.execPath, [path.join(repoRoot, 'scripts/zcode-workflow-vertical.mjs')],
    { encoding: 'utf8', timeout: 240000, cwd: repoRoot, env });
}

// ---------------------------------------------------------------------------
// 1. Builders: the zcode-host args vectors (new code, not dsh duplication).
// ---------------------------------------------------------------------------

test('zcode builders: stage table, byte-identical subject blocks, lease/ttl/prompt-file scoping, minimal list', () => {
  assert.deepEqual(STAGES, ['spec', 'plan', 'implement', 'review', 'qa', 'ship']);
  const common = { stateDir: 'C:/s', sessionId: 'si-uuid', runId: 'zw1a2b3c',
    policyHash: 'a'.repeat(64), actionFile: 'C:/a.json' };
  const block = ['--host', 'zcode', '--session', 'si-uuid', '--run', 'zw1a2b3c',
    '--policy-hash', 'a'.repeat(64), '--action-file', 'C:/a.json'];

  // tasks: create carries the subject block with NO --id; every other
  // subject-bearing subcommand appends --id AFTER the identical block.
  assert.deepEqual(zcodeTasksArgs({ ...common, sub: 'create' }),
    ['tasks', 'create', '--state', 'C:/s', ...block]);
  for (const sub of ['start', 'resume', 'interrupt', 'complete', 'fail', 'cancel', 'show']) {
    assert.deepEqual(zcodeTasksArgs({ ...common, sub, id: 'tid-1' }),
      ['tasks', sub, '--state', 'C:/s', ...block, '--id', 'tid-1'], `${sub} carries the identical block`);
  }
  // --lease-ms is scoped to start|resume ONLY, appended after --id; out-of-scope
  // callers get a builder refusal (LEASE_SCOPE_VIOLATION) instead of a silently
  // dropped flag — a caller mistake surfaces, never masks into a valid vector.
  for (const sub of ['start', 'resume']) {
    assert.deepEqual(zcodeTasksArgs({ ...common, sub, id: 'tid-1', leaseMs: 900000 }),
      ['tasks', sub, '--state', 'C:/s', ...block, '--id', 'tid-1', '--lease-ms', '900000']);
  }
  for (const sub of ['create', 'interrupt', 'complete', 'fail', 'cancel', 'show', 'heartbeat']) {
    assert.throws(() => zcodeTasksArgs({ ...common, sub, id: 'tid-1', leaseMs: 900000 }), /LEASE_SCOPE_VIOLATION/, sub);
  }
  assert.deepEqual(zcodeTasksArgs({ sub: 'list', stateDir: 'C:/s' }), ['tasks', 'list', '--state', 'C:/s']);

  // approvals: --id sits BEFORE the identical subject block (batch-14 discipline mirrored).
  assert.deepEqual(zcodeApprovalsArgs({ ...common, sub: 'issue', ttlMs: 900000 }),
    ['approvals', 'issue', '--state', 'C:/s', ...block, '--ttl-ms', '900000']);
  for (const sub of ['approve', 'reject', 'consume', 'verify', 'show', 'ask']) {
    assert.deepEqual(zcodeApprovalsArgs({ ...common, sub, id: 'aid-1' }),
      ['approvals', sub, '--state', 'C:/s', '--id', 'aid-1', ...block], `${sub} carries the identical block`);
  }
  // --prompt-file belongs to ask only; --ttl-ms to issue only — even on the
  // subcommand that may carry the OTHER scoped flag (the mismatched one throws).
  assert.deepEqual(zcodeApprovalsArgs({ ...common, sub: 'ask', id: 'aid-1', promptFile: 'C:/p.txt' }),
    ['approvals', 'ask', '--state', 'C:/s', '--id', 'aid-1', ...block, '--prompt-file', 'C:/p.txt']);
  assert.throws(() => zcodeApprovalsArgs({ ...common, sub: 'ask', id: 'aid-1', ttlMs: 1 }), /LEASE_SCOPE_VIOLATION/);
  for (const sub of ['approve', 'reject', 'consume', 'verify', 'show']) {
    assert.throws(() => zcodeApprovalsArgs({ ...common, sub, id: 'aid-1', ttlMs: 900000 }), /LEASE_SCOPE_VIOLATION/, `${sub} --ttl-ms`);
    assert.throws(() => zcodeApprovalsArgs({ ...common, sub, id: 'aid-1', promptFile: 'C:/p.txt' }), /LEASE_SCOPE_VIOLATION/, `${sub} --prompt-file`);
  }
  assert.deepEqual(zcodeApprovalsArgs({ ...common, sub: 'issue', ttlMs: 5 }),
    ['approvals', 'issue', '--state', 'C:/s', ...block, '--ttl-ms', '5']);
  assert.throws(() => zcodeApprovalsArgs({ ...common, sub: 'issue', promptFile: 'C:/p.txt' }), /LEASE_SCOPE_VIOLATION/);
  assert.deepEqual(zcodeApprovalsArgs({ sub: 'list', stateDir: 'C:/s' }), ['approvals', 'list', '--state', 'C:/s']);
});

// ---------------------------------------------------------------------------
// 2. shipGate matrix (the local publish gate).
// ---------------------------------------------------------------------------

test('shipGate allows ONLY approved; pending/rejected/consumed/missing all refuse', () => {
  assert.equal(shipGate('approved').ok, true);
  assert.equal(shipGate('approved').code, 'PASS');
  for (const state of ['pending', 'rejected', 'consumed', undefined, null, 'garbage']) {
    const verdict = shipGate(state);
    assert.equal(verdict.ok, false, `${state}`);
    assert.equal(verdict.code, 'APPROVAL_NOT_APPROVED', `${state}`);
  }
});

// ---------------------------------------------------------------------------
// 3. Policy leg on a harness-authored policy file (scoped: the ship dir sits
//    inside the workspace but outside writeRoots under THIS policy shape).
// ---------------------------------------------------------------------------

test('policy leg: zcode Write to the ship target is OUTSIDE_SCOPE, to the artifacts writeRoot IN_SCOPE', (t) => {
  const root = base(t);
  const workspace = path.join(root, 'w');
  const srcDir = path.join(workspace, 's');
  fs.mkdirSync(path.join(srcDir, 'artifacts'), { recursive: true }); // writeRoots must exist before compile
  // The harness-authored shape: zcode Write/Read on file_path, dsh bindings EMPTY.
  assert.deepEqual(zcodePolicyJson({ workspace, readRoots: [workspace], writeRoots: [srcDir] }).bindings, {
    zcode: { Write: { effect: 'write', pathKey: 'file_path' }, Read: { effect: 'read', pathKey: 'file_path' } },
    dsh: {},
  });
  const policyPath = path.join(root, 'policy.json'); // OUTSIDE the workspace, as loadPolicy demands
  fs.writeFileSync(policyPath, `${JSON.stringify(zcodePolicyJson({
    workspace, readRoots: [workspace], writeRoots: [srcDir],
  }), null, 2)}\n`);
  const policy = loadPolicy(policyPath); // evaluate needs the COMPILED object loadPolicy returns
  const deny = evaluate(policy, { host: 'zcode', tool: 'Write',
    input: { file_path: path.join(workspace, 'ship', 'final.md') } }); // need not exist for evaluation
  assert.equal(deny.decision, 'deny');
  assert.equal(deny.code, 'OUTSIDE_SCOPE');
  const allow = evaluate(policy, { host: 'zcode', tool: 'Write',
    input: { file_path: path.join(srcDir, 'artifacts', 'newfile.md') } });
  assert.equal(allow.decision, 'abstain');
  assert.equal(allow.code, 'IN_SCOPE');
  assert.equal(allow.policyHash, policy.policyHash);
});

// ---------------------------------------------------------------------------
// 4. The full harness subprocess run — fully offline, so run it whole.
// ---------------------------------------------------------------------------

test('full harness run: fully offline, exit 0 with RESULT: PASS and the honesty grading on stdout', () => {
  const child = runHarness();
  assert.equal(child.status, 0, `exit=${child.status} signal=${child.signal ?? ''} stdout tail=${JSON.stringify((child.stdout ?? '').slice(-1500))} stderr=${JSON.stringify((child.stderr ?? '').slice(500))}`);
  assert.match(child.stdout, /RESULT: PASS/);
  assert.match(child.stdout, /offline-workflow-journal-harness/);
}, { timeout: 300000 });

// ---------------------------------------------------------------------------
// 5. FAIL injection (plan-review fix 3): a pre-created ship target must make
//    the harness exit 1 with the named SHIP_TARGET_EXISTS code. The raw
//    EEXIST throw is NOT re-tested (the batch-14 test owns it).
// ---------------------------------------------------------------------------

test('FAIL injection: pre-created ship target -> exit 1 with SHIP_TARGET_EXISTS, never PASS', () => {
  const child = runHarness({ ZCODE_WORKFLOW_INJECT_SHIP_TARGET: '1' });
  assert.equal(child.status, 1, `exit=${child.status} stdout tail=${JSON.stringify((child.stdout ?? '').slice(-1500))}`);
  assert.match(child.stdout, /SHIP_TARGET_EXISTS/);
  assert.match(child.stdout, /RESULT: FAILURE/);
  assert.doesNotMatch(child.stdout, /RESULT: PASS/);
}, { timeout: 300000 });

// ---------------------------------------------------------------------------
// 6. Subject digest: host zcode (subjectDigest itself is covered elsewhere;
//    this pins only the harness-specific host-distinction fact).
// ---------------------------------------------------------------------------

test('host zcode subject digests to 64-hex and differs from the same fields under host dsh', (t) => {
  const root = base(t);
  const actionFile = writeActionFile(root, { phase: 'ship', task: 'W1' });
  const fields = { sessionId: 'si-uuid', runId: 'zw1a2b3c', policyHash: 'a'.repeat(64), actionFile };
  const subject = subjectForZcode(fields);
  assert.equal(subject.host, 'zcode');
  assert.deepEqual(subject.action, { phase: 'ship', task: 'W1' });
  const hash = subjectDigest(subject);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(subjectDigest(subjectFor(fields)), hash, 'identical fields under host dsh must digest differently');
});
