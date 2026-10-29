// Batch 16 lane B: ZCode six-stage WORKFLOW-LAYER journal harness (FULLY OFFLINE).
//
// HONESTY GRADING: **offline-workflow-journal-harness** — the workflow LAYER
// only. The journals and the approval chain run through REAL CLI subprocesses
// (node bin/gstack861.mjs tasks|approvals ...), but every stage artifact is a
// CONTROLLER-AUTHORED STAND-IN: ZERO model calls, ZERO ZCode host APIs. This
// is NOT a host vertical and NOT host_verified — it turns the human-recorded
// zcode workflow evidence (FEATURE_MATRIX row 23) into something
// machine-checkable and repeatable, nothing more.
//
// Choreography (STAGES = spec→plan→implement→review→qa→ship, host=zcode):
//   [stages 1-5]  tasks create → start (--lease-ms, realism) → controller
//     writes w/s/artifacts/<phase>.md with an unguessable marker line →
//     tasks complete. The review stage embeds the recovery leg: after start,
//     tasks interrupt → tasks resume --lease-ms (attempts must be 2 in the
//     resume output) → artifact → complete — the batch-15 recovery semantics
//     composed into a multi-stage journal through the real CLI.
//   [ship gate]   approvals issue --ttl-ms → NEGATIVE controller gate refuses
//     while pending (pure shipGate: only 'approved' passes) → ask bridge
//     (stdin piped = operator-channel stand-in; production is a human on the
//     bridge) → parsePrintedDocs (2 docs, second approved, reason echoed) →
//     show (the reason is echoed to stdout only, never persisted) → verify
//     (binding match) → controller privileged copy (mkdir w/ship + wx +
//     byte-verify; a bare EEXIST is mapped to the named verdict
//     SHIP_TARGET_EXISTS, plan-review fix 3) → consume → NEGATIVE replay
//     refused → ship stage journaled create→start→complete.
//   [policy leg]  evaluate on the COMPILED policy (the loadPolicy return)
//     proves zcode Write to w/ship/final.md — inside the workspace, OUTSIDE
//     writeRoots — is OUTSIDE_SCOPE while the artifacts writeRoot is
//     IN_SCOPE: the policy-engine-level "model cannot self-ship" proof for
//     the zcode host. Deliberately scoped (review suggestion): the generic
//     IN/OUT matrix is already pinned by policy.test.mjs; only this
//     harness-specific fact is asserted. No keyed zcode host run happens
//     anywhere in this lane.
//
// Always runnable — no key, no network: every CLI child has DEEPSEEK_API_KEY
// stripped, so the harness cannot make a paid call even by accident. Exit
// codes: 0 = PASS / 1 = FAIL. Every failure branch carries an
// UPPER_SNAKE_CASE verdict code (STAGE_JOURNAL_FAILED,
// APPROVAL_ISSUE_FAILED, APPROVAL_CHAIN_FAILED, GATE_REFUSED_TO_REFUSE,
// ASK_BRIDGE_FAILED, SHOW_REASON_PERSISTED, VERIFY_BINDING_MISMATCH,
// SHIP_TARGET_EXISTS, SHIP_BYTES_MISMATCH, CONSUME_FAILED,
// APPROVAL_REPLAY_ALLOWED, POLICY_LEG_FAILED, FINAL_STATE_WRONG).
//
// FAIL injection (test-only knob, plan-review fix 3):
// ZCODE_WORKFLOW_INJECT_SHIP_TARGET=1 skips the setup absent-assert and
// pre-creates w/ship/final.md, so the wx publish lands on EEXIST and the
// harness must exit 1 with SHIP_TARGET_EXISTS — proving a FAIL path cannot
// be misreported as PASS. (The raw EEXIST throw itself is owned by the
// batch-14 test and is not re-tested here.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadPolicy, evaluate } from '../src/policy.mjs';
import { subjectDigest } from '../src/approvals.mjs';
import { assertAbsent } from './verify-dsh-robustness.mjs';
import { writeActionFile } from './dsh-mini-vertical.mjs';
import { parsePrintedDocs, SHIP_TTL_MS } from './dsh-ship-vertical.mjs';

export const STAGES = ['spec', 'plan', 'implement', 'review', 'qa', 'ship'];
const CLI = fileURLToPath(new URL('../bin/gstack861.mjs', import.meta.url));
const CLI_TIMEOUT_MS = 30000;
// Same 15-minute bound as the batch-14 SHIP_TTL_MS argument: comfortably above
// any plausible stage duration. The lease is advisory bookkeeping here (no
// reaper runs; interrupt/complete drop it), but the journal shape must be the
// production shape, lease and all.
const STAGE_LEASE_MS = SHIP_TTL_MS;
const fwd = p => p.split(/[\\/]/).join('/');

// ---------------------------------------------------------------------------
// Pure helpers and builders (unit-tested offline; no host APIs, no key).
// ---------------------------------------------------------------------------

/**
 * Argument vector for one zcode-host tasks CLI invocation. The subject flag
 * block is byte-identical across every subject-bearing subcommand (the dsh
 * builders' discipline, re-authored here because they hardcode --host dsh);
 * `--lease-ms` arms a lease and is scoped to start|resume ONLY (the CLI also
 * accepts it on heartbeat, which this harness never issues — interrupt,
 * complete and friends would be refused INVALID_ARGUMENTS). `--attempt-token`
 * is the lease-minted fence (audit #5), scoped to complete ONLY here (this
 * harness never heartbeats or fails a stage).
 */
export function zcodeTasksArgs({ sub, stateDir, sessionId, runId, policyHash, actionFile, id, leaseMs, attemptToken }) {
  if (sub === 'list') return ['tasks', 'list', '--state', stateDir];
  // Scoped flags refuse to build rather than silently dropping (lane-A pattern):
  // a caller mistake surfaces here instead of being masked into a valid vector.
  if (leaseMs !== undefined && sub !== 'start' && sub !== 'resume') {
    throw new Error(`LEASE_SCOPE_VIOLATION --lease-ms belongs to start/resume only, saw sub=${sub}`);
  }
  if (attemptToken !== undefined && sub !== 'complete') {
    throw new Error(`TOKEN_SCOPE_VIOLATION --attempt-token belongs to complete only here, saw sub=${sub}`);
  }
  const args = ['tasks', sub, '--state', stateDir, '--host', 'zcode',
    '--session', sessionId, '--run', runId, '--policy-hash', policyHash, '--action-file', actionFile];
  if (id !== undefined) args.push('--id', id);
  if (leaseMs !== undefined) args.push('--lease-ms', String(leaseMs));
  if (attemptToken !== undefined) args.push('--attempt-token', attemptToken);
  return args;
}

/**
 * Argument vector for one zcode-host approvals CLI invocation; --id sits BEFORE
 * the byte-identical subject block, --ttl-ms belongs to issue only and
 * --prompt-file to ask only — no other subcommand can even express them (the
 * builder refusing to build them is the stronger guarantee, same as batch 14).
 */
export function zcodeApprovalsArgs({ sub, stateDir, sessionId, runId, policyHash, actionFile, id, ttlMs, promptFile }) {
  if (sub === 'list') return ['approvals', 'list', '--state', stateDir];
  const args = ['approvals', sub, '--state', stateDir];
  if (id !== undefined) args.push('--id', id);
  args.push('--host', 'zcode', '--session', sessionId, '--run', runId, '--policy-hash', policyHash, '--action-file', actionFile);
  if (ttlMs !== undefined && sub !== 'issue') throw new Error('LEASE_SCOPE_VIOLATION --ttl-ms belongs to issue only');
  if (promptFile !== undefined && sub !== 'ask') throw new Error('LEASE_SCOPE_VIOLATION --prompt-file belongs to ask only');
  if (sub === 'issue' && ttlMs !== undefined) args.push('--ttl-ms', String(ttlMs));
  if (sub === 'ask' && promptFile !== undefined) args.push('--prompt-file', promptFile);
  return args;
}

/** The zcode-host subject exactly as the CLI builds it from the flags + action file; only its digest is persisted. */
export function subjectForZcode({ sessionId, runId, policyHash, actionFile }) {
  return { host: 'zcode', sessionId, runId, policyHash, action: JSON.parse(fs.readFileSync(actionFile, 'utf8')) };
}

/**
 * The publish gate: ONLY an approved approval authorizes the privileged copy.
 * pending/rejected/consumed/missing all refuse — consume is what makes an
 * approval single-use, so a consumed record must never re-ship (mirrors the
 * batch-14 dsh shipGate, re-implemented locally for this lane).
 */
export function shipGate(state) {
  if (state === 'approved') return { ok: true, code: 'PASS', reason: 'approval state is approved' };
  return { ok: false, code: 'APPROVAL_NOT_APPROVED',
    reason: `approval state is ${JSON.stringify(state ?? null)}, the controller must not ship` };
}

/**
 * The privileged copy itself. Refuses (zero bytes written) unless the gate
 * passed; on pass, creates the ship directory (the model could never create
 * it — that is the point) and copies with wx, byte-verifying the result. A
 * bare EEXIST — a second controller racing the same publish, or a leaked
 * target — is mapped to the named verdict SHIP_TARGET_EXISTS (plan-review
 * fix 3) instead of surfacing as an anonymous throw.
 */
export function controllerPublish({ gate, from, to }) {
  if (!gate?.ok) return { ...gate, shipped: false };
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, fs.readFileSync(from), { flag: 'wx', mode: 0o644 }); // wx: refuse to overwrite
  } catch (error) {
    if (error.code === 'EEXIST') {
      return { ok: false, code: 'SHIP_TARGET_EXISTS', shipped: false,
        reason: `the ship target already exists: ${to} — refusing to overwrite (a second publish, or a leaked target)` };
    }
    throw error;
  }
  if (!fs.readFileSync(from).equals(fs.readFileSync(to))) {
    return { ok: false, code: 'SHIP_BYTES_MISMATCH', shipped: true,
      reason: `shipped bytes differ from the verified source: ${from} -> ${to}` };
  }
  return { ok: true, code: 'PASS', shipped: true, reason: `privileged copy ${from} -> ${to} byte-verified after shipGate` };
}

/** Unguessable per-stage artifact marker line: G861-ZW-<phase>-<8hex>: <8hex>. */
export function buildStageMarkerLine(phase) {
  return `G861-ZW-${phase}-${randomBytes(4).toString('hex')}: ${randomBytes(4).toString('hex')}`;
}

/**
 * The harness-authored policy: zcode Write/Read bindings on file_path (the
 * capitalization the zcode adapter's tools use), dsh deliberately EMPTY — this
 * lane never spawns a dsh child. Same minimal scaffold shape as
 * verify-dsh-robustness's policyJson, which hardcodes the dsh bindings.
 */
export function zcodePolicyJson({ workspace, readRoots, writeRoots }) {
  return {
    schemaVersion: 1, workspace: fwd(workspace),
    readRoots: readRoots.map(fwd), writeRoots: writeRoots.map(fwd), protectedRoots: [],
    bindings: {
      zcode: {
        Write: { effect: 'write', pathKey: 'file_path' }, // the binding the policy leg proves
        Read: { effect: 'read', pathKey: 'file_path' },
      },
      dsh: {},
    },
  };
}

/**
 * Build the throwaway tree (fully offline). Workspace w + writeRoot w/s (which
 * must EXIST before the policy compiles) + the stage artifacts dir inside it;
 * the ship dir w/ship sits inside the workspace but OUTSIDE writeRoots and is
 * NOT created here — the controller creates it at publish time. The policy
 * file is authored OUTSIDE the workspace (loadPolicy rejects files inside it)
 * and loaded for REAL so the journal subjects bind the exact hash the policy
 * leg evaluates. Under the FAIL-injection knob the ship target is pre-created
 * instead of asserted absent.
 */
export function prepareZcodeWorkflow() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g')); // 1-char prefix: minimal scaffold
  try {
    const workspace = path.join(root, 'w');
    const srcDir = path.join(workspace, 's');
    fs.mkdirSync(srcDir, { recursive: true }); // writeRoot must exist before compilePolicy
    const artifactsDir = path.join(srcDir, 'artifacts');
    fs.mkdirSync(artifactsDir);
    const shipDir = path.join(workspace, 'ship'); // inside the workspace, OUTSIDE writeRoots
    const policyPath = path.join(root, 'policy.json'); // OUTSIDE the workspace
    fs.writeFileSync(policyPath, `${JSON.stringify(zcodePolicyJson({
      workspace, readRoots: [workspace], writeRoots: [srcDir],
    }), null, 2)}\n`);
    const policy = loadPolicy(policyPath); // compiled: the policy leg evaluates THIS object
    const injected = process.env.ZCODE_WORKFLOW_INJECT_SHIP_TARGET === '1';
    let shipTarget;
    if (injected) {
      // FAIL injection (plan-review fix 3): skip the absent-assert and pre-plant
      // the target so the wx publish lands on EEXIST.
      fs.mkdirSync(shipDir, { recursive: true });
      fs.writeFileSync(shipTarget = path.join(shipDir, 'final.md'), 'injected pre-existing target\n');
    } else {
      shipTarget = assertAbsent(path.join(shipDir, 'final.md'), 'ship');
    }
    return {
      root, workspace, srcDir, artifactsDir, shipDir, shipTarget, policyPath, policy,
      policyHash: policy.policyHash, injected,
      stateDir: path.join(root, 'tasks-state'),
      approvalsDir: path.join(root, 'approvals-state'), // both stores outside the model-writable workspace
      actionFiles: Object.fromEntries(STAGES.map(phase =>
        [phase, writeActionFile(root, { phase, task: 'W1' })])), // one action file per stage, {phase, task:'W1'}
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Offline CLI runner (the dsh scripts' runners are theirs; this lane owns one).
// ---------------------------------------------------------------------------

/** One offline CLI child: node bin/gstack861.mjs <args>, key STRIPPED — zero model calls in every branch. */
function runZcodeCli(args, { cwd, input } = {}) {
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;
  const child = spawnSync(process.execPath, [CLI, ...args],
    { encoding: 'utf8', timeout: CLI_TIMEOUT_MS, cwd, maxBuffer: 8 * 1024 * 1024, env, input });
  let parsed = null;
  if (child.status === 0) {
    try { parsed = JSON.parse(child.stdout); } catch { parsed = null; }
  }
  return { status: child.status, signal: child.signal ?? '', stdout: child.stdout ?? '', stderr: child.stderr ?? '', parsed };
}

/** Run one CLI step; nonzero exit, unparsable output or failed validation ABORTS with the named verdict code. */
function cliExpect(run, code, label, validate) {
  if (run.status !== 0 || run.parsed === null || !validate(run.parsed)) {
    throw new Error(`${code} ${label}: exit=${run.status} signal=${run.signal} `
      + `stdout=${JSON.stringify(run.stdout.slice(0, 400))} stderr=${JSON.stringify(run.stderr.slice(0, 400))}`);
  }
  return run.parsed;
}

// ---------------------------------------------------------------------------
// The offline choreography itself (no key needed; this is the whole point).
// ---------------------------------------------------------------------------

async function main() {
  let prepared;
  try {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    console.log('zcode-workflow-vertical: OFFLINE workflow-layer journal harness (graded offline-workflow-journal-harness: real CLI journals/approvals + controller-authored stand-ins; ZERO model calls, ZERO ZCode host APIs; not a host vertical, not host_verified).');
    console.log('[1/6] building scaffold: workspace w + writeRoot w/s + artifacts dir, ship target w/ship/final.md (inside workspace, OUTSIDE writeRoots), policy OUTSIDE the workspace (real loadPolicy), tasks/approvals state + six {phase,task:W1} action files...');
    prepared = prepareZcodeWorkflow();
    console.log(`      ok (root: ${prepared.root}；policyHash: ${prepared.policyHash.slice(0, 16)}…${prepared.injected ? '；FAIL 注入：ship 目标已预置，期望 SHIP_TARGET_EXISTS/exit 1' : '；ship 目标预断言不存在'})`);

    // One subject identity for the whole run; stages differ only by their action file.
    const identity = { sessionId: randomUUID(), runId: `zw${randomBytes(3).toString('hex')}`, policyHash: prepared.policyHash };
    const stage = phase => ({ stateDir: prepared.stateDir, ...identity, actionFile: prepared.actionFiles[phase] });
    const artifacts = {}; // phase -> { file, marker }

    console.log('[2/6] five stage journals (spec→plan→implement→review→qa): create → start --lease-ms → [review: interrupt → resume --lease-ms, attempts=2] → controller-authored artifact → complete...');
    for (const phase of STAGES.filter(name => name !== 'ship')) {
      const cli = (sub, extra, validate) => cliExpect(
        runZcodeCli(zcodeTasksArgs({ ...stage(phase), sub, ...extra }), { cwd: repoRoot }),
        'STAGE_JOURNAL_FAILED', `${sub} ${phase}`, validate);
      const id = cli('create', {}, value => typeof value === 'string' && value.length > 0);
      const started = cli('start', { id, leaseMs: STAGE_LEASE_MS }, value => value?.state === 'running' && value?.attempts === 1);
      // The leased start minted an attempt fence token (audit #5); complete must present it.
      let attemptToken = started.attemptToken;
      const expectedAttempts = phase === 'review' ? 2 : 1;
      if (phase === 'review') {
        // The recovery leg: the running stage is interrupted (a crash stand-in),
        // then resumed under a fresh lease — the resume output itself must show
        // attempts=2 (the interrupt never counts as an attempt; the resume does).
        cli('interrupt', { id }, value => value?.state === 'interrupted');
        const resumed = cli('resume', { id, leaseMs: STAGE_LEASE_MS }, value => value?.state === 'running' && value?.attempts === 2);
        attemptToken = resumed.attemptToken; // the resume minted a fresh fence; the old token died with the interrupt
      }
      const marker = buildStageMarkerLine(phase);
      const artifactFile = path.join(prepared.artifactsDir, `${phase}.md`);
      fs.writeFileSync(artifactFile, `# zcode workflow stage: ${phase}\n\n${marker}\n`); // controller stand-in, honestly labeled
      cli('complete', { id, attemptToken }, value => value?.state === 'completed' && value?.attempts === expectedAttempts);
      artifacts[phase] = { file: artifactFile, marker };
      console.log(`      ${phase}: completed (attempts=${expectedAttempts}${phase === 'review' ? ', interrupt→resume recovery leg' : ''})`);
    }

    console.log('[3/6] ship approval chain (real CLI): issue --ttl-ms 900000 → NEGATIVE gate refuses while pending → ask bridge (piped answer) → show (reason not persisted) → verify match...');
    const approvalBase = { stateDir: prepared.approvalsDir, ...identity, actionFile: prepared.actionFiles.ship };
    const approvalId = cliExpect(runZcodeCli(zcodeApprovalsArgs({ ...approvalBase, sub: 'issue', ttlMs: SHIP_TTL_MS }), { cwd: repoRoot }),
      'APPROVAL_ISSUE_FAILED', 'issue', value => typeof value === 'string' && value.length > 0);
    const withId = extra => zcodeApprovalsArgs({ ...approvalBase, id: approvalId, ...extra });
    // NEGATIVE: the controller gate must refuse while the approval is still pending.
    const pendingRecord = cliExpect(runZcodeCli(withId({ sub: 'show' }), { cwd: repoRoot }),
      'APPROVAL_CHAIN_FAILED', 'show pending', value => value?.state === 'pending');
    const pendingGate = shipGate(pendingRecord.state);
    if (pendingGate.ok) {
      throw new Error('GATE_REFUSED_TO_REFUSE shipGate(pending) passed — the controller gate must refuse everything but approved');
    }
    console.log(`      negative ok (shipGate(pending) refused: ${pendingGate.code})`);
    // The operator bridge: the script pipes the answer the way a human at the
    // bridge would type it (production = a real person; the bridge itself
    // never auto-agrees — no piped answer means no approval).
    const promptFile = path.join(prepared.root, 'ask-prompt.txt');
    fs.writeFileSync(promptFile, 'zcode workflow ship：发布 implement 工件至 w/ship/final.md（策略腿已证明模型无法自写）。\n');
    const askReason = 'zcode workflow ship';
    const askRun = runZcodeCli(withId({ sub: 'ask', promptFile }), { cwd: repoRoot, input: `approve\n${askReason}\n` });
    const docs = askRun.status === 0 ? parsePrintedDocs(askRun.stdout) : []; // reused from the batch-14 script
    if (askRun.status !== 0 || docs.length !== 2 || docs[0]?.id !== approvalId
      || docs[1]?.state !== 'approved' || docs[1]?.reason !== askReason) {
      throw new Error(`ASK_BRIDGE_FAILED ask: exit=${askRun.status} expected 2 printed docs (question + approved with the reason echoed), `
        + `saw ${JSON.stringify(docs).slice(0, 300)} stderr=${JSON.stringify(askRun.stderr.slice(0, 200))}`);
    }
    const approvedRecord = cliExpect(runZcodeCli(withId({ sub: 'show' }), { cwd: repoRoot }),
      'APPROVAL_CHAIN_FAILED', 'show approved', value => value?.state === 'approved');
    if (approvedRecord.reason !== undefined) {
      throw new Error(`SHOW_REASON_PERSISTED show() must never persist the reason, saw ${JSON.stringify(approvedRecord.reason)}`);
    }
    cliExpect(runZcodeCli(withId({ sub: 'verify' }), { cwd: repoRoot }),
      'VERIFY_BINDING_MISMATCH', 'verify', value => value?.state === 'approved' && value?.binding === 'match');
    console.log(`      ok (approval ${approvalId.slice(0, 8)} approved via the ask bridge; reason echoed, not persisted; verify=match)`);

    console.log('[4/6] privileged publish: shipGate on the on-disk state → controller wx copy of the implement artifact (byte-verified; bare EEXIST → SHIP_TARGET_EXISTS) → consume → NEGATIVE replay consume...');
    const gate = shipGate(approvedRecord.state); // defensive re-gate: only 'approved' can reach the copy
    const publish = controllerPublish({ gate, from: artifacts.implement.file, to: prepared.shipTarget });
    if (!publish.ok) {
      throw new Error(`${publish.code}: ${publish.reason}`);
    }
    cliExpect(runZcodeCli(withId({ sub: 'consume' }), { cwd: repoRoot }),
      'CONSUME_FAILED', 'consume', value => value?.state === 'consumed');
    const replay = runZcodeCli(withId({ sub: 'consume' }), { cwd: repoRoot });
    if (replay.status === 0 || !/APPROVAL_WRONG_STATE/.test(replay.stderr)) {
      throw new Error(`APPROVAL_REPLAY_ALLOWED replay consume: exit=${replay.status} stderr=${JSON.stringify(replay.stderr.slice(0, 200))}`);
    }
    console.log('      ok (publish byte-verified; approval consumed exactly once; replay refused with APPROVAL_WRONG_STATE)');

    console.log('[5/6] ship stage journal (create → start → controller artifact → complete) + zcode policy leg (evaluate on the compiled policy)...');
    const shipMarker = buildStageMarkerLine('ship');
    const shipArtifact = path.join(prepared.artifactsDir, 'ship.md');
    const shipId = cliExpect(runZcodeCli(zcodeTasksArgs({ ...stage('ship'), sub: 'create' }), { cwd: repoRoot }),
      'STAGE_JOURNAL_FAILED', 'create ship', value => typeof value === 'string' && value.length > 0);
    const shipStart = cliExpect(runZcodeCli(zcodeTasksArgs({ ...stage('ship'), sub: 'start', id: shipId, leaseMs: STAGE_LEASE_MS }), { cwd: repoRoot }),
      'STAGE_JOURNAL_FAILED', 'start ship', value => value?.state === 'running' && value?.attempts === 1);
    fs.writeFileSync(shipArtifact, `# zcode workflow stage: ship\n\n${shipMarker}\n\nshipped: ${fwd(prepared.shipTarget)}\n`);
    cliExpect(runZcodeCli([...zcodeTasksArgs({ ...stage('ship'), sub: 'complete', id: shipId }), '--attempt-token', shipStart.attemptToken], { cwd: repoRoot }),
      'STAGE_JOURNAL_FAILED', 'complete ship', value => value?.state === 'completed' && value?.attempts === 1);
    artifacts.ship = { file: shipArtifact, marker: shipMarker };
    // The policy leg needs the COMPILED policy object (loadPolicy's return):
    // the ship target sits inside the workspace but outside writeRoots, so a
    // zcode Write there must be OUTSIDE_SCOPE; the artifacts writeRoot stays
    // IN_SCOPE. Policy-engine level only — no keyed zcode host run, per the
    // lane's stated boundary.
    const denyLeg = evaluate(prepared.policy, { host: 'zcode', tool: 'Write', input: { file_path: prepared.shipTarget } });
    if (denyLeg.code !== 'OUTSIDE_SCOPE') {
      throw new Error(`POLICY_LEG_FAILED zcode Write to the ship target expected OUTSIDE_SCOPE, saw ${JSON.stringify(denyLeg)}`);
    }
    const allowLeg = evaluate(prepared.policy, { host: 'zcode', tool: 'Write', input: { file_path: path.join(prepared.artifactsDir, 'newfile.md') } });
    if (allowLeg.code !== 'IN_SCOPE') {
      throw new Error(`POLICY_LEG_FAILED zcode Write to the artifacts writeRoot expected IN_SCOPE, saw ${JSON.stringify(allowLeg)}`);
    }
    console.log('      ok (ship journal completed attempts=1; zcode Write → ship target OUTSIDE_SCOPE, → artifacts writeRoot IN_SCOPE)');

    console.log('[6/6] final check BEFORE cleanup: approvals list = 1 consumed; tasks list = 6 completed (review attempts=2, others 1, each bound to its action file); six artifacts with markers; ship copy byte-equal to the implement artifact...');
    const approvalsList = cliExpect(runZcodeCli(zcodeApprovalsArgs({ sub: 'list', stateDir: prepared.approvalsDir }), { cwd: repoRoot }),
      'FINAL_STATE_WRONG', 'approvals list', Array.isArray);
    if (approvalsList.length !== 1 || approvalsList[0].state !== 'consumed') {
      throw new Error(`FINAL_STATE_WRONG approvals list expected exactly 1 consumed record, saw ${JSON.stringify(approvalsList)}`);
    }
    const records = cliExpect(runZcodeCli(zcodeTasksArgs({ sub: 'list', stateDir: prepared.stateDir }), { cwd: repoRoot }),
      'FINAL_STATE_WRONG', 'tasks list', Array.isArray);
    if (records.length !== STAGES.length) {
      throw new Error(`FINAL_STATE_WRONG tasks list expected exactly ${STAGES.length} records, saw ${records.length}`);
    }
    for (const phase of STAGES) {
      const expectedHash = subjectDigest(subjectForZcode({ ...identity, actionFile: prepared.actionFiles[phase] }));
      const record = records.find(r => r.subjectHash === expectedHash);
      const expectedAttempts = phase === 'review' ? 2 : 1;
      if (!record || record.state !== 'completed' || record.attempts !== expectedAttempts) {
        throw new Error(`FINAL_STATE_WRONG stage ${phase} expected completed attempts=${expectedAttempts} bound to its action file, saw ${JSON.stringify(record ?? null)}`);
      }
      const artifact = fs.readFileSync(artifacts[phase].file, 'utf8');
      if (!artifact.includes(artifacts[phase].marker)) {
        throw new Error(`FINAL_STATE_WRONG stage ${phase} artifact ${artifacts[phase].file} lost its marker line`);
      }
    }
    if (!fs.readFileSync(prepared.shipTarget).equals(fs.readFileSync(artifacts.implement.file))) {
      throw new Error('FINAL_STATE_WRONG the shipped copy is not byte-equal to the implement artifact');
    }
    console.log('      ok (1 approval consumed; 6/6 stages completed, review attempts=2; markers intact; ship byte-equal)');

    console.log('RESULT: PASS — six-stage zcode workflow journal machine-checked through the real CLI (review recovered via interrupt→resume, attempts=2); ship gated by the approval chain (pending gate refused, ask bridge approved with the reason echoed but never persisted, verify=match, wx publish byte-verified, consumed exactly once with the replay refused); policy leg proves zcode Write to the ship target OUTSIDE_SCOPE. Graded offline-workflow-journal-harness: controller-authored stand-ins, zero model calls, zero ZCode host APIs.');
    process.exitCode = 0;
  } catch (error) {
    console.log(`RESULT: FAILURE — ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (prepared) {
      fs.rmSync(prepared.root, { recursive: true, force: true });
      console.log(`cleanup: removed ${prepared.root}`);
    }
  }
}

const invoked = process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invoked) await main();
