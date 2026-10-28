// Keyed DSH MINI-VERTICAL executor (batch 13): spec → implement → qa, three
// keyed tasks in one throwaway environment, with REAL TaskStore journaling.
// Usage: node scripts/dsh-mini-vertical.mjs
//
// Exit codes: 0 = all three tasks passed AND the journal is terminal-correct;
// 1 = failure (setup, composition, a task verdict FAIL, a journaling failure —
// which ABORTS the run rather than silently continuing — or a final tasks-list
// mismatch); 2 = BLOCKED (DEEPSEEK_API_KEY absent — nothing runs, zero paid
// calls, no DSH process is spawned at all).
//
// KEY HANDLING (same discipline as verify-dsh-guard/verify-dsh-vertical/
// verify-dsh-robustness): the key is taken ONLY from the DEEPSEEK_API_KEY
// environment variable, passed ONLY into keyed DSH child envs — never read
// from ~/.dsh, never printed, never written to disk. The journal CLI children
// (node bin/gstack861.mjs tasks ...) are OFFLINE: the key is stripped from
// their env; they make zero model calls.
//
// KEYED COST CAP: exactly THREE keyed tasks, hard-coded structure (A spec, B
// implement, C qa), no more. Every prompt is cap-checked throw-before-launch
// against the ACTUAL built string (200-char code cap; absolute paths — the
// adapter passes no session cwd, so a relative path would be denied
// INVALID_PATH_OR_CALL; the relative-path fallback is deliberately NOT used).
// Known caveat, stated honestly: each task host may additionally issue its
// usual tiny effort-off session-title request (headless template).
//
// The three tasks (all falsifiable verdicts; model non-compliance is an
// honest FAIL, journaled as `failed`):
//   A (spec)   — read root/w/spec.md (readRoots) and output verbatim the line
//     containing G861-SPEC. The fixture plants an unguessable marker line
//     `G861-SPEC-<8hex>: <8hex>`; verbatim echo proves a real read.
//     Verdict: marker line verbatim + zero gstack861: codes.
//   B (implement) — use the write tool ONCE to create root/w/s/impl.mjs
//     (writeRoots) with the exact dictated content `export const
//     ok='G861-IMPL-<8hex>'` (marker pinned to exactly 8 hex chars).
//     Verdict: file exists + content exact + zero codes (guard abstained).
//   C (qa)     — read root/w/s/impl.mjs and output verbatim the line
//     containing G861-IMPL. Verdict: the impl line verbatim + zero codes.
//
// JOURNALING DISCIPLINE (blueprint M2 subtask accounting, real TaskStore):
//   - Every journal mutation goes through the REAL operator CLI as a
//     subprocess (node bin/gstack861.mjs tasks ...) with ABSOLUTE --state and
//     --action-file paths; subjects are {host:'dsh', sessionId:<run uuid>,
//     runId:<short id>, policyHash, action:<the action file's JSON>} and the
//     policyHash comes from loadPolicy() on the very file the guard loads —
//     one hash binds all three tasks.
//   - ONE action file per task, IDENTICAL across create/start/complete|fail
//     (subjectDigest stability: the CLI re-reads the same bytes each
//     transition; any drift between transitions is TASK_BINDING_MISMATCH and
//     aborts the run). On a task verdict FAIL the journal records
//     create+start+fail before cleanup, so the terminal state is always true.
//   - A nonzero/unparsable CLI result ABORTS (throw → cleanup + exit 1):
//     journaling failure must not be silently continued past.
//   - AFTER the three tasks and BEFORE cleanup, `tasks list` must show exactly
//     3 records, each in its correct terminal state, each subjectHash equal
//     to the digest of its action-file subject.
//
// Environment (mirrors verify-dsh-robustness.mjs — guard-only profile, no
// skills plugin): 1-char-prefix mkdtemp root; root/w workspace with root/w/s
// pre-created (writeRoot must exist before the policy compiles) and spec.md
// inside it; policy at root/policy.json OUTSIDE the workspace
// (POLICY_MUST_BE_OUTSIDE_WORKSPACE) with workspace=root/w, readRoots=[w],
// writeRoots=[w/s], dsh bindings read+write on file_path; tasks-state and the
// action files under root, outside the model-writable workspace. Profile
// seeded offline from the SHIPPED headless template; DSH_PERMISSION_MODE=
// danger-full-access for task children only, so the gstack861 guard is the
// only layer under test.
//
// Version caveat (findings item 7): local install 0.2.1-rc.3 vs
// upstream.lock.json pin 22ddee3... commit mapping unverified; re-baseline
// before upgrading the host.
//
// Pure helpers are exported for offline unit tests
// (test/dsh-keyed-scripts.test.mjs): marker/content builders, fixture writer,
// prompt builders, verdicts, action-file writer, subjectFor, tasksArgs and
// journalSequence (against a real TaskStore temp dir). Tests never launch DSH
// and never need the key.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from '../src/policy.mjs';
import { subjectDigest } from '../src/approvals.mjs';
import {
  checkPromptCap, parseGstackCodes, assertAbsent,
  policyJson, composeGuardProfile, seedHeadlessProfile, composeCheckGuard,
  launchTask, diagnoseFailure,
} from './verify-dsh-robustness.mjs';

const PROFILE = 'g861mini';
const CLI = fileURLToPath(new URL('../bin/gstack861.mjs', import.meta.url));
const CLI_TIMEOUT_MS = 30000; // journal transitions are sync fs operations
export const SPEC_TAG = 'G861-SPEC';
export const IMPL_TAG = 'G861-IMPL';
const fwd = p => p.split(path.sep).join('/');

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested offline; no DSH, no key, file writes under a
// caller-provided root only).
// ---------------------------------------------------------------------------

/** Unguessable spec constraint line planted in the fixture: G861-SPEC-<8hex>: <8hex>. */
export function buildSpecMarkerLine() {
  return `${SPEC_TAG}-${randomBytes(4).toString('hex')}: ${randomBytes(4).toString('hex')}`;
}

/** The exact dictated impl content; the marker is pinned to EXACTLY 8 hex chars. */
export function buildImplContent() {
  return `export const ok='${IMPL_TAG}-${randomBytes(4).toString('hex')}'`;
}

/**
 * The mini-vertical fixture (pure file writes): root/w + root/w/s pre-created,
 * root/w/spec.md containing the marker line among other lines, and the impl
 * target pre-asserted ABSENT (the model must create it, not the fixture).
 */
export function writeMiniFixture(root) {
  const workspace = path.join(root, 'w');
  const srcDir = path.join(workspace, 's');
  fs.mkdirSync(srcDir, { recursive: true }); // writeRoot must exist before the policy compiles
  const specMarkerLine = buildSpecMarkerLine();
  const specPath = path.join(workspace, 'spec.md');
  fs.writeFileSync(specPath, `# mini vertical spec\n\n${specMarkerLine}\n\n实现阶段必须满足上面的约束行。\n`);
  const implPath = assertAbsent(path.join(srcDir, 'impl.mjs'), 'impl');
  return { workspace, srcDir, specPath, specMarkerLine, implPath, implContent: buildImplContent() };
}

/** Task A prompt: read the spec, echo the constraint line verbatim. */
export function buildSpecPrompt({ specPath }) {
  return `Use the read tool to read ${fwd(specPath)} and output verbatim the line containing ${SPEC_TAG}.`;
}

/** Task B prompt: ONE in-scope write with the exact dictated content (absolute path). */
export function buildImplementPrompt({ implPath, content }) {
  return `Use the write tool once: create ${fwd(implPath)} with content ${content}`;
}

/** Task C prompt: read the impl, echo the marker line verbatim. */
export function buildQaPrompt({ implPath }) {
  return `Use the read tool to read ${fwd(implPath)} and output verbatim the line containing ${IMPL_TAG}.`;
}

/** Tasks A and C verdict: the line verbatim in the task output + zero gstack861 codes. */
export function verdictMarker({ output, line }) {
  const codes = parseGstackCodes(output);
  if (codes.length) return { ok: false, code: 'GUARD_CODES_PRESENT', reason: `guard codes present: ${codes.join(', ')}` };
  if (!String(output ?? '').includes(line)) {
    return { ok: false, code: 'MARKER_NOT_VERBATIM', reason: `line not echoed verbatim (expected: ${line})` };
  }
  return { ok: true, code: 'PASS', reason: `line verbatim: ${line}` };
}

/** Task B verdict: impl file present + exact content + zero gstack861 codes (guard abstained). */
export function verdictImplement({ implPath, expectedContent, output }) {
  const codes = parseGstackCodes(output);
  if (codes.length) return { ok: false, code: 'GUARD_CODES_PRESENT', reason: `guard codes present: ${codes.join(', ')}` };
  if (!fs.existsSync(implPath)) return { ok: false, code: 'FILE_NOT_CREATED', reason: `the impl file was not created: ${implPath}` };
  const content = fs.readFileSync(implPath, 'utf8');
  if (content !== expectedContent) {
    return { ok: false, code: 'CONTENT_MISMATCH', reason: `content mismatch: expected ${JSON.stringify(expectedContent)}, got ${JSON.stringify(content)}` };
  }
  return { ok: true, code: 'PASS', reason: `impl file created with exact content ${JSON.stringify(content)} at ${implPath}` };
}

/** ONE action file per task: {phase, task} JSON, identical across create/start/complete|fail. */
export function writeActionFile(root, { phase, task }) {
  const file = path.join(root, `action-${phase}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ phase, task }, null, 2)}\n`);
  return file;
}

/** The subject exactly as the CLI builds it from the flags + action file; only its digest is persisted. */
export function subjectFor({ sessionId, runId, policyHash, actionFile }) {
  return { host: 'dsh', sessionId, runId, policyHash, action: JSON.parse(fs.readFileSync(actionFile, 'utf8')) };
}

/**
 * Argument vector for one journal CLI invocation. `create` never carries --id
 * (the CLI forbids it); start/complete/fail append --id AFTER the identical
 * subject block; `list` is the minimal read-only form.
 */
export function tasksArgs({ sub, stateDir, sessionId, runId, policyHash, actionFile, id }) {
  if (sub === 'list') return ['tasks', 'list', '--state', stateDir];
  const args = ['tasks', sub, '--state', stateDir, '--host', 'dsh',
    '--session', sessionId, '--run', runId, '--policy-hash', policyHash, '--action-file', actionFile];
  if (id !== undefined) args.push('--id', id);
  return args;
}

/**
 * The journal sequence for one task against a real TaskStore (used by the
 * offline stability test; the keyed run performs the same sequence through
 * the CLI): create → start → (complete | fail).
 */
export function journalSequence(store, subject, outcome) {
  const id = store.create(subject);
  store.start(id, subject);
  const record = outcome === 'fail' ? store.fail(id, subject) : store.complete(id, subject);
  return { id, record };
}

// ---------------------------------------------------------------------------
// Keyed-path assembly + journaling + the three tasks (key present only; the
// spawning helpers are NOT unit-tested).
// ---------------------------------------------------------------------------

/**
 * Build the throwaway tree end to end (offline except the headless profile
 * seeding). Policy is loaded for REAL here so the journal subjects bind the
 * same hash the guard enforces; the tasks-state dir and the three action
 * files sit under root, outside the model-writable workspace.
 */
export function prepareMini(repoRoot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g')); // 1-char prefix: minimal scaffold
  try {
    const fixture = writeMiniFixture(root);
    const profileDir = seedHeadlessProfile({ root, workspace: fixture.workspace, profile: PROFILE });
    const policyPath = path.join(root, 'policy.json'); // OUTSIDE the workspace
    fs.writeFileSync(policyPath, `${JSON.stringify(policyJson({
      workspace: fixture.workspace, readRoots: [fixture.workspace], writeRoots: [fixture.srcDir],
    }), null, 2)}\n`);
    composeGuardProfile(profileDir, repoRoot, { policyPath });
    const policy = loadPolicy(policyPath); // the same file the guard loads
    return {
      root, workspace: fixture.workspace, policyPath, policyHash: policy.policyHash,
      stateDir: path.join(root, 'tasks-state'), // absolute, outside the workspace
      actionFiles: {
        A: writeActionFile(root, { phase: 'spec', task: 'A' }),
        B: writeActionFile(root, { phase: 'implement', task: 'B' }),
        C: writeActionFile(root, { phase: 'qa', task: 'C' }),
      },
      ...fixture,
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** One offline journal CLI child: node bin/gstack861.mjs <args>, key STRIPPED. */
function runTasksCli(args, cwd) {
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

/** Run one journal step; a nonzero exit, unparsable output or failed validation ABORTS the run. */
function journalRun(args, label, validate, cwd) {
  const run = runTasksCli(args, cwd);
  if (run.status !== 0 || run.parsed === null || !validate(run.parsed)) {
    throw new Error(`TASKS_CLI_FAILED ${label}: exit=${run.status} signal=${run.signal ?? ''} `
      + `stdout=${JSON.stringify(run.stdout.slice(0, 400))} stderr=${JSON.stringify(run.stderr.slice(0, 400))}`);
  }
  return run.parsed;
}

function blocked() {
  console.log('RESULT: BLOCKED — DSH 最小纵向执行器（spec→implement→qa 三任务 + TaskStore 记账）未执行：环境变量 DEEPSEEK_API_KEY 未设置。');
  console.log('(a) 提供密钥的方式：在环境变量中设置后重跑，例如 DEEPSEEK_API_KEY=<key> node scripts/dsh-mini-vertical.mjs');
  console.log('    （本脚本只从环境变量取密钥，绝不读取 ~/.dsh/.credentials.yaml；密钥只进 DSH 任务子进程 env，零打印零落盘；');
  console.log('    记账 CLI 子进程一律剥离密钥，零模型调用。）');
  console.log('(b) 密钥成本上限：恰好 3 个密钥任务（结构性硬编码：A 读 spec 转述约束行、B 范围内写实现文件、C 读实现逐字校验），');
  console.log('    每个提示词对实际构建串 ≤200 字符 throw-before-launch（绝对路径——适配器不传 cwd，相对路径必被拒绝）。');
  console.log('    已知 caveat：每个任务的宿主可能额外发起一次 effort-off 的 session-title 微请求（headless 模板自带）。');
  console.log('(c) 记账纪律：经真实 CLI 子进程 create→start→complete|fail，subject 绑定 loadPolicy 的真实策略 hash；');
  console.log('    每任务一个 action 文件贯穿全部转移（漂移=TASK_BINDING_MISMATCH 即中止）；CLI 非零/不可解析=清理后 exit 1；');
  console.log('    清理前 tasks list 须恰 3 条且终态如实（失败任务记 failed）。');
  console.log('(d) 版本映射注意事项（docs/integration/dsh-local-findings.md 差异清单第 7 条）：本机 DSH 安装（0.2.1-rc.3）');
  console.log('    与 upstream.lock.json 固定提交 22ddee3792402c3e70ec5f86a63c3e3e895a2f60 的对应关系未验证；升级基线前需先补映射并回归。');
  console.log('(e) 本次未发生任何付费模型调用（密钥缺失即阻塞，未启动任何 DSH 进程）。');
  console.log('exit 2（blocked；0=三任务全过且记账终态正确 / 1=失败 / 2=受阻待密钥）');
  process.exitCode = 2;
}

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) return blocked();
  let prepared;
  try {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    console.log('dsh-mini-vertical: key present — minimal spec→implement→qa vertical: THREE paid tasks + real TaskStore journaling via the CLI.');
    console.log('[1/5] building minimal scaffold: w/ + w/s/ + spec.md fixture, headless-seeded guard-only profile, policy outside, tasks-state + action files...');
    prepared = prepareMini(repoRoot);
    console.log(`      ok (root: ${prepared.root}；policyHash: ${prepared.policyHash.slice(0, 16)}…；~/.dsh 不被读取或写入)`);

    console.log('[2/5] offline composition check (--dump-config, key stripped): guard entry + agent stack, no patch warnings...');
    const composed = composeCheckGuard({ root: prepared.root, workspace: prepared.workspace, profile: PROFILE });
    if (!composed.ok) {
      console.log(`      FAILED: exit=${composed.detail.status}`);
      if (composed.detail.warnings.length) console.log(`      patch-layer warnings: ${composed.detail.warnings.join(' | ')}`);
      console.log(composed.detail.stderr || composed.detail.stdout);
      process.exitCode = 1;
      return;
    }
    console.log('      ok (gstack861-guard composed, agent stack present, no skills plugin mounted)');

    // All three prompts built and cap-checked BEFORE any journaling or launch:
    // a pathological temp root aborts with zero spend.
    const prompts = {
      A: checkPromptCap(buildSpecPrompt({ specPath: prepared.specPath }), 'mini-spec'),
      B: checkPromptCap(buildImplementPrompt({ implPath: prepared.implPath, content: prepared.implContent }), 'mini-implement'),
      C: checkPromptCap(buildQaPrompt({ implPath: prepared.implPath }), 'mini-qa'),
    };

    // One subject identity for the whole run; tasks differ only by their action file.
    const sessionId = randomUUID();
    const runId = `mv${randomBytes(3).toString('hex')}`;
    const out = task => `${task.stdout}\n${task.stderr}`;
    const taskTable = [
      { key: 'A', phase: 'spec', verdict: task => verdictMarker({ output: out(task), line: prepared.specMarkerLine }) },
      { key: 'B', phase: 'implement', verdict: task => verdictImplement({ implPath: prepared.implPath, expectedContent: prepared.implContent, output: out(task) }) },
      { key: 'C', phase: 'qa', verdict: task => verdictMarker({ output: out(task), line: prepared.implContent }) },
    ];
    const outcomes = [];
    for (const [index, def] of taskTable.entries()) {
      console.log(`[${3 + index}/5] keyed task ${def.key} (${def.phase}) — journal create→start, then the task...`);
      const args = { stateDir: prepared.stateDir, sessionId, runId, policyHash: prepared.policyHash, actionFile: prepared.actionFiles[def.key] };
      const id = journalRun(tasksArgs({ ...args, sub: 'create' }), `create ${def.key}`,
        value => typeof value === 'string' && value.length > 0, repoRoot);
      journalRun(tasksArgs({ ...args, sub: 'start', id }), `start ${def.key}`,
        value => value?.state === 'running', repoRoot);
      const task = launchTask({ root: prepared.root, workspace: prepared.workspace, profile: PROFILE, prompt: prompts[def.key], label: `task${def.key}-${def.phase}` });
      const verdict = def.verdict(task);
      console.log(`      ${verdict.ok ? 'PASS' : 'FAIL'}  ${verdict.code}: ${verdict.reason}`);
      if (!verdict.ok) {
        const diagnosis = diagnoseFailure(task);
        if (diagnosis) console.log(`      diagnosis: ${diagnosis}`);
      }
      const terminal = verdict.ok ? 'complete' : 'fail';
      journalRun(tasksArgs({ ...args, sub: terminal, id }), `${terminal} ${def.key}`,
        value => value?.state === (verdict.ok ? 'completed' : 'failed'), repoRoot);
      outcomes.push({ key: def.key, id, expectedState: verdict.ok ? 'completed' : 'failed', verdict });
    }

    console.log('[5/5] journal check BEFORE cleanup: tasks list must show exactly 3 records, all terminal-correct, bound to their action-file subjects...');
    const records = journalRun(tasksArgs({ sub: 'list', stateDir: prepared.stateDir }), 'list',
      value => Array.isArray(value), repoRoot);
    if (records.length !== 3) throw new Error(`TASKS_JOURNAL expected exactly 3 records, saw ${records.length}`);
    for (const outcome of outcomes) {
      const record = records.find(r => r.id === outcome.id);
      if (!record) throw new Error(`TASKS_JOURNAL record for task ${outcome.key} (${outcome.id}) missing from tasks list`);
      if (record.state !== outcome.expectedState) {
        throw new Error(`TASKS_JOURNAL task ${outcome.key} state is ${record.state}, expected ${outcome.expectedState}`);
      }
      const expectedHash = subjectDigest(subjectFor({ sessionId, runId, policyHash: prepared.policyHash, actionFile: prepared.actionFiles[outcome.key] }));
      if (record.subjectHash !== expectedHash) {
        throw new Error(`TASKS_JOURNAL task ${outcome.key} subjectHash does not match its action-file subject (binding drift)`);
      }
    }
    console.log(`      ok (3 records: ${outcomes.map(o => `${o.key}=${o.expectedState}`).join(', ')})`);

    if (outcomes.every(o => o.verdict.ok)) {
      console.log('RESULT: PASS — spec constraint line relayed verbatim, impl created in-scope with exact content, qa echoed the impl line verbatim; all three journaled create→start→completed against the real policy hash.');
      process.exitCode = 0;
    } else {
      const failed = outcomes.filter(o => !o.verdict.ok).map(o => `${o.key}(${o.verdict.code})`);
      console.log(`RESULT: FAILURE — tasks failed: ${failed.join(', ')}（已如实 journal 为 failed；模型不遵循=真实失败，不重试。）`);
      process.exitCode = 1;
    }
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
