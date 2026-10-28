// Batch 16 lane A: DSH RECOVERY vertical (keyed; ONE paid task R).
//
// Proves the batch-15 lease/reap/resume semantics INSIDE a real DSH vertical
// journal: create R → start --lease-ms 5000 → SIMULATED controller crash (the
// controller simply stops: no task is launched under the crashed attempt and no
// heartbeat is ever sent) → NEGATIVE premature reap while the lease is live
// (must fail TASK_LEASE_ACTIVE — order-correctness control) → real-clock wait
// past expiry → reap (interrupted) → resume --lease-ms 900000 (running,
// attempts=2) → the ONE keyed task runs UNDER the recovered journal and
// completes it terminal-correct (final tasks list: exactly 1 record,
// completed, attempts=2, bound to action-R).
//
// HONESTY GRADING: the crash is simulated in-process as start-then-no-heartbeat
// — the leased journal record and every transition are REAL (real CLI
// subprocesses, real wall clock), but the controller death is not a process
// kill. Real multi-process SIGKILL races are a NON-GOAL per batch 15 (they
// stay a single-process semantics proof here). Exactly ONE keyed run (task R:
// read spec.md, echo the marker line verbatim); the entire crash choreography
// is keyless real-CLI journaling. The 900000ms recovery lease reuses the
// batch-14 SHIP_TTL_MS rationale: 15 minutes must outlive the 8-minute keyed
// task timeout, or the journal lease could phantom-expire while the resumed
// attempt is legitimately still working (a reaper must never interrupt a task
// that is alive, only one that is dead).
//
// Exit codes: 0 = PASS (recovery choreography correct AND the keyed task
// verdict PASS AND the journal terminal-correct); 1 = failure with an honest
// code — REAP_PREMATURE_SUCCEEDED | REAP_FAILED | RESUME_FAILED |
// TASK_VERDICT_FAIL | JOURNAL_FINAL_STATE_WRONG (choreography/verdict/journal)
// or the generic CLI_FAILED/setup codes used by the sibling verticals;
// 2 = BLOCKED (DEEPSEEK_API_KEY absent — nothing runs, zero paid calls, no
// DSH process is spawned at all).
//
// KEY HANDLING (same discipline as verify-dsh-robustness/dsh-mini-vertical/
// dsh-ship-vertical): the key is taken ONLY from the DEEPSEEK_API_KEY
// environment variable, passed ONLY into the keyed DSH child env — never read
// from ~/.dsh, never printed, never written to disk. Every journal CLI child
// (node bin/gstack861.mjs tasks ...) is OFFLINE: this script's own runner
// (runTasksCli — the mini-vertical's runTasksCli/journalRun are not exported)
// strips the key from the child env; journal transitions make zero model calls.
//
// Reuse (plan-review fix 1): the scaffold is prepareMini() exported from
// dsh-mini-vertical.mjs (mini fixture + headless-seeded guard-only profile +
// real loadPolicy hash + tasks-state dir), extended here with ONE action file
// {phase:'recovery', task:'R'}. tasksArgs NEVER emits --lease-ms, so
// tasksLeaseArgs below appends it — scoped to start/resume ONLY: the CLI
// rejects --lease-ms on reap/complete with INVALID_ARGUMENTS, and the builder
// refusing to even build it is the stronger guarantee (same pattern as the
// ship-vertical's approvalsArgs). heartbeat is deliberately not expressible:
// this vertical's crash IS the absence of heartbeats.
//
// Prompt discipline: task R reuses the mini-vertical's proven task-A pattern
// (buildSpecPrompt pins the read tool; the marker line is unguessable) with
// the ≤200-char cap enforced throw-before-launch by checkPromptCap against the
// ACTUAL built string. Known caveat, stated honestly: the task host may
// additionally issue its usual tiny effort-off session-title request
// (headless template).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { subjectDigest } from '../src/approvals.mjs';
import { checkPromptCap, composeCheckGuard, launchTask, diagnoseFailure } from './verify-dsh-robustness.mjs';
import { prepareMini, buildSpecPrompt, verdictMarker, writeActionFile, subjectFor, tasksArgs } from './dsh-mini-vertical.mjs';

// Must equal dsh-mini-vertical.mjs's internal PROFILE constant (not exported):
// prepareMini seeds exactly this profile name; passing anything else breaks launchTask.
const MINI_PROFILE = 'g861mini';
const CLI = fileURLToPath(new URL('../bin/gstack861.mjs', import.meta.url));
const CLI_TIMEOUT_MS = 30000; // journal transitions are sync fs operations
// 5s crash lease: wide enough for the premature-reap negative control to spawn
// its CLI child inside the window (plan-review fix 4); the success leg waits
// 6200ms = 24% margin past expiry.
export const CRASH_LEASE_MS = 5000;
export const CRASH_WAIT_MS = 6200;
// 15min > the 8min keyed task timeout — batch-14 SHIP_TTL_MS rationale: the
// recovery lease must outlive the task the resumed attempt carries.
export const RECOVERY_LEASE_MS = 900000;

// ---------------------------------------------------------------------------
// Pure/CLI helpers (unit-tested offline; no DSH, no key).
// ---------------------------------------------------------------------------

/**
 * Lease-aware argument vector: the shared tasksArgs block with --lease-ms
 * appended for start/resume ONLY. Any other subcommand cannot even express a
 * lease (the CLI would reject it with INVALID_ARGUMENTS — reap/complete must
 * never carry one).
 */
export function tasksLeaseArgs({ sub, leaseMs, ...rest }) {
  if (leaseMs !== undefined && sub !== 'start' && sub !== 'resume') {
    throw new Error(`LEASE_SCOPE_VIOLATION --lease-ms belongs to start/resume only, saw sub=${sub}`);
  }
  const args = tasksArgs({ ...rest, sub });
  if (leaseMs !== undefined) args.push('--lease-ms', String(leaseMs));
  return args;
}

/**
 * One offline journal CLI child: node bin/gstack861.mjs <args>, key STRIPPED,
 * stdout pre-parsed (null when the exit was nonzero or the output unparsable).
 */
export function runTasksCli(args, { cwd } = {}) {
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY; // offline child: the journal CLI never gets the key
  const child = spawnSync(process.execPath, [CLI, ...args],
    { encoding: 'utf8', timeout: CLI_TIMEOUT_MS, cwd, maxBuffer: 8 * 1024 * 1024, env });
  let parsed = null;
  if (child.status === 0) {
    try { parsed = JSON.parse(child.stdout); } catch { parsed = null; }
  }
  return { status: child.status, signal: child.signal, stdout: child.stdout ?? '', stderr: child.stderr ?? '', parsed };
}

/** cliExpect-style validation: nonzero exit, unparsable output or failed validation ABORTS the run. */
export function cliExpect(run, label, validate) {
  if (run.status !== 0 || run.parsed === null || !validate(run.parsed)) {
    throw new Error(`CLI_FAILED ${label}: exit=${run.status} signal=${run.signal ?? ''} `
      + `stdout=${JSON.stringify(run.stdout.slice(0, 400))} stderr=${JSON.stringify(run.stderr.slice(0, 400))}`);
  }
  return run.parsed;
}

/**
 * Real-clock blocking wait for SYNCHRONOUS code (NOT setTimeout): Atomics.wait
 * slices of at most 25ms until the Date.now() deadline, so platform wait
 * granularity can never under-sleep the crash window. The lease expiry is
 * judged by the CLI child against the same wall clock.
 */
export function syncWait(ms) {
  const deadline = Date.now() + ms;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    Atomics.wait(sleeper, 0, 0, Math.max(1, Math.min(25, deadline - Date.now())));
  }
}

// ---------------------------------------------------------------------------
// Keyed choreography (key present only; not unit-tested — the offline tests
// pin the CLI runner, the args discipline and the keyless exit).
// ---------------------------------------------------------------------------

function blocked() {
  console.log('RESULT: BLOCKED — DSH 恢复纵向执行器（租约过期→reap→resume→键控任务 R 复跑）未执行：环境变量 DEEPSEEK_API_KEY 未设置。');
  console.log('(a) 提供密钥的方式：在环境变量中设置后重跑，例如 DEEPSEEK_API_KEY=<key> node scripts/dsh-recovery-vertical.mjs');
  console.log('    （本脚本只从环境变量取密钥，绝不读取 ~/.dsh/.credentials.yaml；密钥只进 DSH 任务子进程 env，零打印零落盘；');
  console.log('    记账/收割 CLI 子进程一律剥离密钥，零模型调用。）');
  console.log('(b) 密钥成本上限：恰 1 个密钥任务（任务 R：读 spec.md 逐字转述标记行，钉死 read 工具，≤200 字符 throw-before-launch）；');
  console.log('    应急上限 2（原因如实记录）。崩溃模拟腿（create→start 短租约→不心跳→租约过期→reap→resume）完全无密钥——真实 CLI 记账，零模型调用。');
  console.log('(c) 恢复纪律：start --lease-ms 5000（5 秒负控窗口）→ 立即 reap 必须 TASK_LEASE_ACTIVE → 真实时钟阻塞等待 6200ms（24% 余量）');
  console.log('    → reap=interrupted → resume --lease-ms 900000（15 分钟 > 8 分钟任务超时，同批次 14 SHIP_TTL_MS 论证，恢复租约不得在任务活着时幻影过期）；');
  console.log('    attempts=2（start 一次 + resume 一次，无双计）；终检恰 1 条 completed 且 subjectHash 绑 action-R；崩溃为进程内模拟（start 后不心跳），');
  console.log('    真实 SIGKILL 多进程竞争属批次 15 非目标。判定码 UPPER_SNAKE_CASE 全覆盖，失败不自动重试。');
  console.log('(d) 版本映射注意事项（docs/integration/dsh-local-findings.md 差异清单第 7 条）：本机 DSH 安装（0.2.1-rc.3）');
  console.log('    与 upstream.lock.json 固定提交 22ddee3792402c3e70ec5f86a63c3e3e895a2f60 的对应关系未验证；升级基线前需先补映射并回归。');
  console.log('(e) 本次未发生任何付费模型调用（密钥缺失即阻塞，未启动任何 DSH 进程）。');
  console.log('exit 2（blocked；0=通过 / 1=失败 / 2=受阻待密钥）');
  process.exitCode = 2;
}

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) return blocked();
  let prepared;
  try {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    console.log('dsh-recovery-vertical: key present — recovery choreography (lease expiry → reap → resume) + ONE paid task R under the recovered journal, all journaling through the real CLI (key stripped).');

    console.log('[1/4] scaffold: prepareMini (mini fixture + headless-seeded guard-only g861mini profile + real loadPolicy hash + tasks-state dir) + action file R {phase:"recovery"} + offline composition check...');
    prepared = prepareMini(repoRoot);
    const actionFile = writeActionFile(prepared.root, { phase: 'recovery', task: 'R' });
    console.log(`      ok (root: ${prepared.root}；policyHash: ${prepared.policyHash.slice(0, 16)}…；~/.dsh 不被读取或写入)`);
    const composed = composeCheckGuard({ root: prepared.root, workspace: prepared.workspace, profile: MINI_PROFILE });
    if (!composed.ok) {
      console.log(`      FAILED: exit=${composed.detail.status}`);
      if (composed.detail.warnings.length) console.log(`      patch-layer warnings: ${composed.detail.warnings.join(' | ')}`);
      console.log(composed.detail.stderr || composed.detail.stdout);
      process.exitCode = 1;
      return;
    }
    console.log('      composition ok (gstack861-guard composed, agent stack present, no skills plugin mounted)');

    console.log(`[2/4] crash simulation (real CLI, key stripped): create R → start --lease-ms ${CRASH_LEASE_MS} → NEGATIVE premature reap (must fail TASK_LEASE_ACTIVE) → controller dies (no heartbeat) → real-clock wait ${CRASH_WAIT_MS}ms → reap → resume --lease-ms ${RECOVERY_LEASE_MS}...`);
    const subject = { stateDir: prepared.stateDir, sessionId: randomUUID(), runId: `rv${randomBytes(3).toString('hex')}`,
      policyHash: prepared.policyHash, actionFile };
    const taskId = cliExpect(runTasksCli(tasksLeaseArgs({ ...subject, sub: 'create' }), { cwd: repoRoot }), 'create R',
      value => typeof value === 'string' && value.length > 0);
    console.log(`      create ok (task ${taskId.slice(0, 8)}…)`);
    const startedAt = Date.now();
    const started = cliExpect(runTasksCli(tasksLeaseArgs({ ...subject, sub: 'start', id: taskId, leaseMs: CRASH_LEASE_MS }), { cwd: repoRoot }),
      'start R', value => value?.state === 'running' && value?.attempts === 1);
    console.log(`      start ok (state=${started.state}, attempts=${started.attempts}, lease ${CRASH_LEASE_MS}ms armed)`);
    // NEGATIVE (plan-review fix 4): reap immediately — the 5s lease is still
    // live, so the reaper must be refused. This is the order-correctness
    // control for the whole choreography (an unordered reaper would pass the
    // success leg vacuously).
    const premature = runTasksCli(tasksLeaseArgs({ ...subject, sub: 'reap', id: taskId }), { cwd: repoRoot });
    if (premature.status === 0) {
      throw new Error(`REAP_PREMATURE_SUCCEEDED the reap fired ${Date.now() - startedAt}ms into a ${CRASH_LEASE_MS}ms lease and was ALLOWED — the negative control failed`);
    }
    if (!/TASK_LEASE_ACTIVE/.test(premature.stderr)) {
      throw new Error(`REAP_FAILED premature reap was refused but not with TASK_LEASE_ACTIVE (exit=${premature.status}): ${premature.stderr.slice(0, 200)}`);
    }
    console.log('      negative ok (premature reap refused with TASK_LEASE_ACTIVE — the lease is still live)');
    // The simulated crash itself: the controller is "dead" from here — no task
    // is launched under the crashed attempt, no heartbeat is ever sent; only
    // the wall clock moves.
    console.log(`      controller crash: no heartbeat for ${CRASH_WAIT_MS}ms of REAL clock (lease expired at +${CRASH_LEASE_MS}ms)...`);
    syncWait(CRASH_WAIT_MS);
    const reaped = runTasksCli(tasksLeaseArgs({ ...subject, sub: 'reap', id: taskId }), { cwd: repoRoot });
    if (reaped.status !== 0 || reaped.parsed?.state !== 'interrupted') {
      throw new Error(`REAP_FAILED post-expiry reap must exit 0 with state=interrupted: exit=${reaped.status} `
        + `parsed=${JSON.stringify(reaped.parsed)} stderr=${reaped.stderr.slice(0, 200)}`);
    }
    console.log(`      reap ok (state=${reaped.parsed.state}, lease cleared)`);
    const resumed = runTasksCli(tasksLeaseArgs({ ...subject, sub: 'resume', id: taskId, leaseMs: RECOVERY_LEASE_MS }), { cwd: repoRoot });
    if (resumed.status !== 0 || resumed.parsed?.state !== 'running' || resumed.parsed?.attempts !== 2) {
      throw new Error(`RESUME_FAILED resume must exit 0 with state=running and attempts=2 (start + resume, no double count): `
        + `exit=${resumed.status} parsed=${JSON.stringify(resumed.parsed)} stderr=${resumed.stderr.slice(0, 200)}`);
    }
    console.log(`      resume ok (state=${resumed.parsed.state}, attempts=${resumed.parsed.attempts}, lease ${RECOVERY_LEASE_MS}ms re-armed > the 8min task timeout)`);

    console.log('[3/4] keyed task R runs UNDER the recovered journal: read spec.md, echo the marker line verbatim...');
    const prompt = checkPromptCap(buildSpecPrompt({ specPath: prepared.specPath }), 'recovery-spec');
    const task = launchTask({ root: prepared.root, workspace: prepared.workspace, profile: MINI_PROFILE, prompt, label: 'taskR-recovery' });
    const verdict = verdictMarker({ output: `${task.stdout}\n${task.stderr}`, line: prepared.specMarkerLine });
    console.log(`      ${verdict.ok ? 'PASS' : 'FAIL'}  ${verdict.code}: ${verdict.reason}`);
    if (!verdict.ok) {
      const diagnosis = diagnoseFailure(task);
      if (diagnosis) console.log(`      diagnosis: ${diagnosis}`);
    }
    // Terminal journal discipline first: the recovered record must land in a
    // true terminal state even (especially) on a verdict FAIL.
    const terminal = verdict.ok ? 'complete' : 'fail';
    cliExpect(runTasksCli(tasksLeaseArgs({ ...subject, sub: terminal, id: taskId }), { cwd: repoRoot }), `${terminal} R`,
      value => value?.state === (verdict.ok ? 'completed' : 'failed'));
    if (!verdict.ok) {
      console.log(`RESULT: FAILURE — TASK_VERDICT_FAIL ${verdict.code}: ${verdict.reason}（已如实 journal 为 failed；模型不遵循=真实失败，不重试。）`);
      process.exitCode = 1;
      return;
    }

    console.log('[4/4] final check BEFORE cleanup: tasks list must show exactly 1 record — completed, attempts=2 (crash + resume, no double count), subjectHash bound to action-R...');
    const records = cliExpect(runTasksCli(tasksLeaseArgs({ sub: 'list', stateDir: prepared.stateDir }), { cwd: repoRoot }), 'list',
      value => Array.isArray(value));
    if (records.length !== 1 || records[0].state !== 'completed' || records[0].attempts !== 2
      || records[0].subjectHash !== subjectDigest(subjectFor(subject))) {
      throw new Error(`JOURNAL_FINAL_STATE_WRONG expected exactly 1 completed record with attempts=2 bound to action-R, saw ${JSON.stringify(records)}`);
    }
    console.log('      ok (1 record: completed, attempts=2, subjectHash binds action-R)');

    console.log('RESULT: PASS — the journal recovered across a simulated crash: the premature reap was refused (TASK_LEASE_ACTIVE), the expired lease was reaped to interrupted, and the resumed attempt (attempts=2) carried the real keyed task to a terminal-correct completed state.');
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
