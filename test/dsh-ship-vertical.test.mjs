// Offline unit tests for the batch-14 ship vertical (scripts/dsh-ship-vertical.mjs).
//
// The KEYED path (real DSH task D + the full choreography) runs only under the
// coordinator with DEEPSEEK_API_KEY; these tests never launch DSH. Coverage is
// deliberately INCREMENTAL over existing suites: the store-level approval
// state machine lives in approvals.test.mjs and the CLI ask-bridge (approve /
// reject / no-answer exit 3 / wrong subject / prompt-file failures) is already
// pinned by real subprocesses in adapters.test.mjs — neither is duplicated
// here. What this file pins: the ship prompt + cap, the shipGate matrix, the
// task-D deny verdict, the privileged-copy gate, the approvals CLI increments
// that were store-level only (--ttl-ms expiry, verify, consume-on-pending,
// consume replay), the args-vector discipline, the dual-store subject binding,
// and the policy leg (ship dir outside writeRoots => OUTSIDE_SCOPE).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compilePolicy, evaluate, loadPolicy } from '../src/policy.mjs';
import { TaskStore } from '../src/tasks.mjs';
import { subjectDigest } from '../src/approvals.mjs';
import { PROMPT_MAX_CHARS, checkPromptCap, policyJson } from '../scripts/verify-dsh-robustness.mjs';
import { writeMiniFixture, writeActionFile, subjectFor } from '../scripts/dsh-mini-vertical.mjs';
import {
  SHIP_TTL_MS, buildShipPrompt, shipGate, verdictShipDeny, controllerShip,
  approvalsArgs, parsePrintedDocs, runCli,
} from '../scripts/dsh-ship-vertical.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fwd = p => p.split(/[\\/]/).join('/');

function base(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-sv-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A real loadPolicy hash bound to a real fixture (same shape the keyed run journals). */
function realPolicy(t) {
  const root = base(t);
  const fixture = writeMiniFixture(root);
  fs.writeFileSync(fixture.implPath, fixture.implContent); // controller stand-in, as prepareShip does
  const policyPath = path.join(root, 'policy.json');
  fs.writeFileSync(policyPath, `${JSON.stringify(policyJson({
    workspace: fixture.workspace, readRoots: [fixture.workspace], writeRoots: [fixture.srcDir],
  }), null, 2)}\n`);
  return { root, fixture, policy: loadPolicy(policyPath), policyPath };
}

// ---------------------------------------------------------------------------
// Prompt builder and the hard cap.
// ---------------------------------------------------------------------------

test('SHIP_TTL_MS is 900000 (15min > the 8min task timeout; plan-review required change 1)', () => {
  assert.equal(SHIP_TTL_MS, 900000);
});

test('buildShipPrompt pins the write tool and embeds the forward-slash absolute target', () => {
  const prompt = buildShipPrompt({ shipTarget: 'C:/t/w/ship/impl.mjs' });
  assert.ok(prompt.includes('用write工具'), 'pins the write tool (batch-13 drift lesson)');
  assert.ok(prompt.includes('C:/t/w/ship/impl.mjs'), 'forward-slash target');
  const windows = buildShipPrompt({ shipTarget: 'C:\\t\\w\\ship\\impl.mjs' });
  assert.ok(windows.includes('C:/t/w/ship/impl.mjs'), 'windows-style input is embedded forward-slash');
  checkPromptCap(prompt, 'ship-deny'); // 45 chars here — well under the cap
});

test('buildShipPrompt measures <=190 with the real temp root and survives the worst-case 52-char base', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = buildShipPrompt({ shipTarget: path.join(root, 'w', 'ship', 'impl.mjs') });
  assert.ok(real.length <= 190, `expected <=190 with the real temp root, measured ${real.length}`);
  checkPromptCap(real, 'ship-deny');
  const synthetic = buildShipPrompt({ shipTarget: `C:/Users/${'u'.repeat(23)}/AppData/Local/Temp/gabcdef/w/ship/impl.mjs` });
  assert.ok(synthetic.length <= PROMPT_MAX_CHARS, `${synthetic.length} > ${PROMPT_MAX_CHARS}`);
});

test('a pathological 180-char temp base pushes the ship prompt past the cap: refuses to launch', () => {
  const prompt = buildShipPrompt({ shipTarget: `C:/${'x'.repeat(177)}/gabcdef/w/ship/impl.mjs` });
  assert.ok(prompt.length > PROMPT_MAX_CHARS, 'fixture must exceed the cap for the assertion to mean anything');
  assert.throws(() => checkPromptCap(prompt, 'pathological'), /PROMPT_TOO_LONG/);
});

// ---------------------------------------------------------------------------
// shipGate and the privileged copy.
// ---------------------------------------------------------------------------

test('shipGate allows ONLY approved; pending/rejected/consumed/missing all refuse', () => {
  assert.equal(shipGate('approved').ok, true);
  for (const state of ['pending', 'rejected', 'consumed', undefined, null, 'garbage']) {
    const verdict = shipGate(state);
    assert.equal(verdict.ok, false, `${state}`);
    assert.equal(verdict.code, 'APPROVAL_NOT_APPROVED', `${state}`);
  }
});

test('controllerShip refuses without a passed gate (zero bytes) and ships byte-verified with one', (t) => {
  const root = base(t);
  const src = path.join(root, 'impl.mjs');
  fs.writeFileSync(src, 'artifact-bytes');
  const shipDir = path.join(root, 'ship');
  const to = path.join(shipDir, 'impl.mjs');
  const refused = controllerShip({ gate: shipGate('pending'), from: src, to });
  assert.equal(refused.ok, false);
  assert.equal(refused.shipped, false);
  assert.ok(!fs.existsSync(shipDir), 'a refused gate writes nothing — not even the directory');
  const shipped = controllerShip({ gate: shipGate('approved'), from: src, to });
  assert.equal(shipped.ok, true, shipped.reason);
  assert.equal(shipped.shipped, true);
  assert.deepEqual(fs.readFileSync(to), Buffer.from('artifact-bytes'), 'byte-verified copy');
  // wx: a second controller racing the same publish lands on EEXIST — the
  // serialization argument recorded in the evidence doc.
  assert.throws(() => controllerShip({ gate: shipGate('approved'), from: src, to }), /EEXIST/);
});

// ---------------------------------------------------------------------------
// Task-D deny verdict (callId-free pairing reused from batch 13).
// ---------------------------------------------------------------------------

/** The expected deny shape: one write call to the ship target, error result with the code, final relay. */
function denyEvents(target) {
  return [
    { type: 'thinking', text: '发货' },
    { type: 'tool_call', tool: 'write', input: { file_path: target, content: 'z' } },
    { type: 'tool_result', status: 'error', result: 'Error: gstack861:OUTSIDE_SCOPE' },
    { type: 'text', text: 'Error: gstack861:OUTSIDE_SCOPE' },
    { type: 'final', text: 'Error: gstack861:OUTSIDE_SCOPE' },
  ];
}

test('verdictShipDeny PASSES on the correct single deny stream (file absent, code observed, status error)', (t) => {
  const shipTarget = path.join(base(t), 'w', 'ship', 'impl.mjs');
  const verdict = verdictShipDeny({ events: denyEvents(fwd(shipTarget)), shipTarget, shipFileExists: false });
  assert.equal(verdict.ok, true, verdict.reason);
  assert.equal(verdict.code, 'PASS');
});

test('verdictShipDeny tolerates windows-style and drive-case echoes from the model', (t) => {
  const shipTarget = path.join(base(t), 'w', 'ship', 'impl.mjs');
  const lowerDrive = p => p.charAt(0).toLowerCase() + p.slice(1);
  const verdict = verdictShipDeny({ events: denyEvents(lowerDrive(fwd(shipTarget)).split('/').join('\\')), shipTarget, shipFileExists: false });
  assert.equal(verdict.ok, true, verdict.reason);
});

test('a created ship file outranks the stream: SHIP_FILE_LEAKED even on a perfectly-shaped deny stream', (t) => {
  const shipTarget = path.join(base(t), 'w', 'ship', 'impl.mjs');
  const verdict = verdictShipDeny({ events: denyEvents(fwd(shipTarget)), shipTarget, shipFileExists: true });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'SHIP_FILE_LEAKED');
});

test('verdictShipDeny failure codes: empty stream, no writes, extra writes, wrong target, missing/deny-less/non-error results', (t) => {
  const shipTarget = path.join(base(t), 'w', 'ship', 'impl.mjs');
  const check = (events, code) => {
    const verdict = verdictShipDeny({ events, shipTarget, shipFileExists: false });
    assert.equal(verdict.code, code, `saw ${verdict.code}: ${verdict.reason}`);
    assert.equal(verdict.ok, false);
  };
  check([], 'NO_STREAM_EVENTS');
  check([{ type: 'final', text: 'done' }], 'NO_WRITE_CALLS');
  check([...denyEvents(fwd(shipTarget)), { type: 'tool_call', tool: 'write', input: { file_path: fwd(path.join(path.dirname(shipTarget), 'retry.mjs')), content: 'z' } },
    { type: 'tool_result', status: 'error', result: 'Error: gstack861:OUTSIDE_SCOPE' }], 'UNEXPECTED_CALL_COUNT');
  const wrongTarget = denyEvents(fwd(path.join(path.dirname(shipTarget), 'elsewhere.mjs')));
  check(wrongTarget, 'WRONG_TARGET');
  const truncated = denyEvents(fwd(shipTarget)).filter(e => e.type !== 'tool_result');
  check(truncated, 'DENY_RESULT_MISSING');
  check([
    { type: 'tool_call', tool: 'write', input: { file_path: fwd(shipTarget), content: 'z' } },
    { type: 'tool_result', status: 'error', result: 'Error: gstack861:UNMAPPED_TOOL' },
  ], 'DENY_NOT_OBSERVED');
  check([
    { type: 'tool_call', tool: 'write', input: { file_path: fwd(shipTarget), content: 'z' } },
    { type: 'tool_result', status: 'completed', result: 'Error: gstack861:OUTSIDE_SCOPE' },
  ], 'DENY_RESULT_NOT_ERROR');
});

// ---------------------------------------------------------------------------
// approvalsArgs discipline + parsePrintedDocs.
// ---------------------------------------------------------------------------

test('approvalsArgs keeps the subject block byte-identical; ttl/prompt-file scoped; list minimal', () => {
  const common = { stateDir: 'C:/s', sessionId: 'si', runId: 'r', policyHash: 'a'.repeat(64), actionFile: 'C:/a.json' };
  const issue = approvalsArgs({ ...common, sub: 'issue', ttlMs: 900000 });
  assert.deepEqual(issue, ['approvals', 'issue', '--state', 'C:/s', '--host', 'dsh',
    '--session', 'si', '--run', 'r', '--policy-hash', 'a'.repeat(64), '--action-file', 'C:/a.json', '--ttl-ms', '900000']);
  const subjectBlock = ['--host', 'dsh', '--session', 'si', '--run', 'r', '--policy-hash', 'a'.repeat(64), '--action-file', 'C:/a.json'];
  for (const sub of ['approve', 'reject', 'consume', 'verify']) {
    const vec = approvalsArgs({ ...common, sub, id: 'id-1' });
    assert.equal(vec[1], sub);
    assert.deepEqual(vec.slice(2), ['--state', 'C:/s', '--id', 'id-1', ...subjectBlock], `${sub} carries the identical block`);
  }
  const ask = approvalsArgs({ ...common, sub: 'ask', id: 'id-1', promptFile: 'C:/p.txt' });
  assert.deepEqual(ask.slice(2), ['--state', 'C:/s', '--id', 'id-1', ...subjectBlock, '--prompt-file', 'C:/p.txt']);
  // --ttl-ms on a non-issue subcommand or --prompt-file outside ask cannot even be expressed.
  assert.equal(approvalsArgs({ ...common, sub: 'approve', id: 'i', ttlMs: 1, promptFile: 'C:/p' })
    .filter(v => v === '--ttl-ms' || v === '--prompt-file').length, 0);
  assert.deepEqual(approvalsArgs({ sub: 'list', stateDir: 'C:/s' }), ['approvals', 'list', '--state', 'C:/s']);
});

test('parsePrintedDocs splits the CLI pretty-printed concatenated documents', () => {
  assert.deepEqual(parsePrintedDocs('{\n  "a": 1\n}\n{\n  "b": 2\n}'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(parsePrintedDocs('{\n  "id": "x"\n}'), [{ id: 'x' }]);
  assert.deepEqual(parsePrintedDocs(''), []);
});

// ---------------------------------------------------------------------------
// Approvals CLI increments (real subprocesses, key stripped) — ONLY the cases
// not already pinned by adapters.test.mjs's ask-bridge suite.
// ---------------------------------------------------------------------------

/** One throwaway approvals state + a subject bound to a real action file. */
function approvalFixture(t) {
  const root = base(t);
  const actionFile = writeActionFile(root, { phase: 'ship', task: 'D' });
  const subject = { stateDir: path.join(root, 'approvals-state'), sessionId: 'si-uuid',
    runId: 'sv1a2b3c', policyHash: 'a'.repeat(64), actionFile };
  return { root, subject, approvalSubject: subjectFor(subject) };
}

function cli(subject, extra) {
  return runCli(approvalsArgs({ ...subject, ...extra }), { cwd: repoRoot });
}

test('CLI verify reports match+pending right after issue', (t) => {
  const { subject } = approvalFixture(t);
  const id = JSON.parse(cli(subject, { sub: 'issue' }).stdout);
  const check = JSON.parse(cli(subject, { sub: 'verify', id }).stdout);
  assert.equal(check.state, 'pending');
  assert.equal(check.binding, 'match');
});

test('CLI consume on a pending approval fails APPROVAL_WRONG_STATE (nonzero exit)', (t) => {
  const { subject } = approvalFixture(t);
  const id = JSON.parse(cli(subject, { sub: 'issue' }).stdout);
  const run = cli(subject, { sub: 'consume', id });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /APPROVAL_WRONG_STATE/);
});

test('CLI --ttl-ms 1 with real clock flow: approve/consume after expiry fail APPROVAL_EXPIRED', (t) => {
  const { subject } = approvalFixture(t);
  const id = JSON.parse(cli(subject, { sub: 'issue', ttlMs: 1 }).stdout);
  assert.ok(id.length > 0);
  const waitMs = Date.now() + 25; // real wall clock: a millisecond TTL is long gone
  while (Date.now() < waitMs) { /* spin briefly — deterministic expiry without a fake clock */ }
  const approve = cli(subject, { sub: 'approve', id });
  assert.notEqual(approve.status, 0);
  assert.match(approve.stderr, /APPROVAL_EXPIRED/);
  const consume = cli(subject, { sub: 'consume', id });
  assert.notEqual(consume.status, 0);
  assert.match(consume.stderr, /APPROVAL_EXPIRED/);
});

test('CLI consume replay: approve → consume ok → consume again fails APPROVAL_WRONG_STATE', (t) => {
  const { subject } = approvalFixture(t);
  const id = JSON.parse(cli(subject, { sub: 'issue' }).stdout);
  assert.equal(JSON.parse(cli(subject, { sub: 'approve', id }).stdout).state, 'approved');
  assert.equal(JSON.parse(cli(subject, { sub: 'consume', id }).stdout).state, 'consumed');
  const replay = cli(subject, { sub: 'consume', id });
  assert.notEqual(replay.status, 0);
  assert.match(replay.stderr, /APPROVAL_WRONG_STATE/);
});

// ---------------------------------------------------------------------------
// Dual-store binding + the policy leg.
// ---------------------------------------------------------------------------

test('the same action-D file binds TaskStore and Approval subjects to one digest', (t) => {
  const { root, fixture, policy } = realPolicy(t);
  const actionFile = writeActionFile(root, { phase: 'ship', task: 'D' });
  const identity = { sessionId: 'si-uuid', runId: 'sv1a2b3c', policyHash: policy.policyHash, actionFile };
  const taskSubject = subjectFor(identity);
  const approvalSubject = subjectFor(identity); // both CLI channels build it identically from the flags
  assert.equal(subjectDigest(taskSubject), subjectDigest(approvalSubject));
  // And the task side really journals under that digest.
  const store = new TaskStore(path.join(root, 'tasks-state'));
  const record = store.get(store.create(taskSubject));
  assert.equal(record.subjectHash, subjectDigest(taskSubject));
  assert.ok(!fs.existsSync(path.join(fixture.workspace, 'ship')), 'the ship dir is not pre-created');
});

test('policy leg: writing the ship target is OUTSIDE_SCOPE, writing the src dir is IN_SCOPE', (t) => {
  const { fixture, policy } = realPolicy(t);
  const shipTarget = path.join(fixture.workspace, 'ship', 'impl.mjs'); // need not exist for evaluation
  const deny = evaluate(policy, { host: 'dsh', tool: 'write', input: { file_path: shipTarget } });
  assert.equal(deny.decision, 'deny');
  assert.equal(deny.code, 'OUTSIDE_SCOPE');
  const allow = evaluate(policy, { host: 'dsh', tool: 'write', input: { file_path: path.join(fixture.srcDir, 'new.mjs') } });
  assert.equal(allow.code, 'IN_SCOPE');
  assert.equal(allow.policyHash, policy.policyHash);
});

// ---------------------------------------------------------------------------
// Keyless discipline: the script exits 2 with a BLOCKED message, zero spawns.
// ---------------------------------------------------------------------------

test('keyless invocation: the ship vertical exits 2 (BLOCKED) without touching DSH', () => {
  const child = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/dsh-ship-vertical.mjs')], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, DEEPSEEK_API_KEY: '' },
  });
  assert.equal(child.status, 2);
  assert.match(child.stdout, /BLOCKED/);
  assert.match(child.stdout, /DEEPSEEK_API_KEY/);
}, { timeout: 120000 });
