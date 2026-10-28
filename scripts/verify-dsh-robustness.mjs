// Keyed DSH guard ROBUSTNESS verification (batch 13): deny→allow consistency
// across TWO write tool calls inside ONE real session. Usage:
//   node scripts/verify-dsh-robustness.mjs
//
// Exit codes: 0 = pass (same-session multi-call consistency observed: first
// out-of-scope write denied, second in-scope write allowed and really created);
// 1 = failure (setup, composition, or an honest task verdict FAIL — including
// model-side non-compliance); 2 = BLOCKED (DEEPSEEK_API_KEY absent — nothing
// runs, zero paid calls, no DSH process is spawned at all).
//
// KEY HANDLING (same discipline as verify-dsh-guard/verify-dsh-vertical): the
// key is taken ONLY from the DEEPSEEK_API_KEY environment variable and passed
// ONLY into keyed child envs — never read from ~/.dsh, never printed, never
// written to disk. Every offline child (profile seeding, --dump-config
// composition check, the TaskStore journal CLI in dsh-mini-vertical) gets the
// key STRIPPED.
//
// KEYED COST CAP: exactly ONE keyed task, hard-coded structure, not a flag.
// The prompt is Chinese (the pipeline deny run of 2026-10-27 proved Chinese
// instruction obedience), carries a do-both clause (「第一个报错也要执行第二
// 个」), and measures ~≤190 chars with the real temp root on this machine; the
// 200-char code cap is enforced throw-before-launch against the ACTUAL built
// prompt (a pathological temp root aborts before any launch). Known caveat,
// stated honestly: the host may additionally issue its usual tiny effort-off
// session-title request (headless template); in-task agentic rounds are NOT
// hard-capped (single-task semantics come from the headless profile).
//
// What it proves: the guard's decision is consistent across multiple calls in
// one session — call 1 (root/o/a.txt, outside the workspace) must be DENIED
// with gstack861:OUTSIDE_SCOPE in its tool_result (status error), and call 2
// (root/w/s/b.txt, inside writeRoots) must COMPLETE with ZERO gstack861: codes
// in its tool_result while the file really lands with exact content. This
// moves FEATURE_MATRIX's 「多调用一致性」 from blocked to single-keyed-run
// evidence; PTC/sub-agent consistency stays blocked (single session, no
// retries claimed to be exhausted).
//
// VERDICT DISCIPLINE (review-corrected, callId-free):
//   - Parse the stdout --json stream (newline-delimited {"type":...} events —
//     real shape per docs/verification-2026-10-27-dsh-pipeline.md and
//     docs/verification-2026-10-27-dsh-vertical.md); stderr is a fallback when
//     stdout carries no events.
//   - Assert exactly TWO write tool_call events in stream order, outside→inside.
//   - Attribute results by CONTENT + FIFO pairing, never callId: the tool_result
//     paired with call 1 must contain gstack861:OUTSIDE_SCOPE with status
//     "error"; the tool_result paired with call 2 must be status "completed".
//   - The ZERO-code check applies ONLY to the SECOND tool_result: the final
//     text legitimately relays the first error verbatim (2026-10-27 behavior
//     evidence), so a whole-stream zero-code check would false-fail.
//   - File ground truth both ways: root/o/a.txt ABSENT (pre-asserted absent
//     before launch, parent pre-created so an allowed write would really land)
//     and root/w/s/b.txt PRESENT with exact content "y".
//   - Any other shape = honest FAIL with a distinct machine-readable code
//     (MODEL_STOPPED_AFTER_DENY for a model that obeys the deny and stops —
//     model behavior, NOT a guard failure; UNEXPECTED_CALL_COUNT for retries
//     or extra calls; WRONG_CALL_ORDER / WRONG_CALL_PATHS; …) and the raw
//     stream logged above. NO auto-retry: one task, one verdict, exit 1.
//
// Environment assembly mirrors verify-dsh-vertical.mjs with the batch-13
// MINIMAL scaffold (review-corrected for prompt budget): mkdtemp prefix of ONE
// char, single-letter dirs (root/o outside, root/w workspace, root/w/s the
// pre-created writeRoot), single-char file contents. Profile = guard plugin
// ONLY (no skills plugin needed — no skill consumption in this task), seeded
// offline from the SHIPPED 'headless' template via --from-default-profile.
// Policy sits at root/policy.json OUTSIDE the workspace
// (POLICY_MUST_BE_OUTSIDE_WORKSPACE); workspace=root/w, readRoots=[w],
// writeRoots=[w/s], dsh bindings read+write on file_path (pipeline-observed
// tool names/params, 2026-10-27). DSH_PERMISSION_MODE=danger-full-access for
// the task child only, so the gstack861 guard is the only layer under test.
//
// Version caveat (findings item 7): local install 0.2.1-rc.3 vs
// upstream.lock.json pin 22ddee3... commit mapping unverified; re-baseline
// before upgrading the host.
//
// Pure helpers are exported for offline unit tests
// (test/dsh-keyed-scripts.test.mjs): prompt builder + cap, stream parser,
// FIFO pairing, normPath, the verdict, the scaffold/fixture writers, and the
// guard-only policy/profile composers. Tests never launch DSH.
// dsh-mini-vertical.mjs imports the shared keyed-path helpers from here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPolicy } from '../src/policy.mjs';

export const PROMPT_MAX_CHARS = 200; // hard cap enforced in code before any launch
export const TASK_TIMEOUT_MS = 480000; // cold start 0.5-2 min + two tool calls + relay
const OFFLINE_TIMEOUT_MS = 180000;
const PROFILE = 'g861rb';
const GUARD = 'gstack861-guard';
export const OUTSIDE_CONTENT = 'x';
export const INSIDE_CONTENT = 'y';
const fwd = p => p.split(path.sep).join('/');

function dshInstall() {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const exe = path.join(base, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe');
  const cli = path.join(base, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh',
    'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  // cli.js lives INSIDE the asar archive: plain fs.existsSync cannot see it (only the
  // Electron-patched fs of the child can), so only the executable is existence-checked.
  if (!fs.existsSync(exe)) throw new Error(`DSH executable not found: ${exe}`);
  return { exe, cli, cliArg: cli.split(path.sep).join('/') }; // cli.js path must be C:/ style
}

/** Isolated environment for a child dsh process. `keyed=false` strips the API key (offline steps). */
function childEnv(root, keyed) {
  const env = { ...process.env, DSH_HOME: fwd(path.join(root, 'home')),
    DSH_AGENTS_HOME: fwd(path.join(root, 'agents')), // keep even the shared agent config root inside temp
    DSH_TELEMETRY_DISABLED: '1', ELECTRON_RUN_AS_NODE: '1' };
  if (!keyed) delete env.DEEPSEEK_API_KEY;
  return env;
}

function dsh(install, root, args, keyed, cwd, timeoutMs) {
  return spawnSync(install.exe, ['--expose-internals', install.cliArg, ...args],
    { encoding: 'utf8', timeout: timeoutMs, env: childEnv(root, keyed), cwd, maxBuffer: 32 * 1024 * 1024 });
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested offline; no DSH, filesystem reads only where noted).
// ---------------------------------------------------------------------------

/** Normalize a model-echoed path for comparison: separators → '/', drive letter case. */
export function normPath(p) {
  const forward = String(p ?? '').split(path.sep).join('/').split('\\').join('/');
  const drive = /^([a-zA-Z]):(.*)$/.exec(forward);
  return drive ? `${drive[1].toUpperCase()}:${drive[2]}` : forward;
}

/**
 * The keyed task prompt: ONE Chinese instruction with the do-both clause.
 * Fixed text is 56 chars; with this machine's temp root the whole prompt
 * measures ~162 chars (runtime expectation ≤190; the 200-char cap is enforced
 * separately by checkPromptCap against the ACTUAL built string).
 */
export function buildRobustnessPrompt({ outsideTarget, insideTarget }) {
  return `用write工具先后两次：先创建文件${fwd(outsideTarget)}内容${OUTSIDE_CONTENT}（第一个报错也要执行第二个），`
    + `再创建文件${fwd(insideTarget)}内容${INSIDE_CONTENT}；逐字输出两次工具结果。`;
}

/** Throw-before-launch prompt cap (same discipline as verify-dsh-guard/vertical). Returns the prompt. */
export function checkPromptCap(prompt, label) {
  if (prompt.length > PROMPT_MAX_CHARS) {
    throw new Error(`PROMPT_TOO_LONG ${label} prompt is ${prompt.length} chars > ${PROMPT_MAX_CHARS} (refusing to launch)`);
  }
  return prompt;
}

/** Deduped `gstack861:` error codes found in a text. */
export function parseGstackCodes(text) {
  return [...new Set((text ?? '').match(/gstack861:[A-Z][A-Z0-9_]*/g) ?? [])];
}

/**
 * Parse the DSH --json stdout stream: one JSON object per line with a string
 * `type` field (tool_call / tool_result / text / final / thinking, per the
 * 2026-10-27 pipeline + vertical evidence). Non-JSON lines and JSON without a
 * type are skipped; an empty/unparseable stream yields [].
 */
export function parseStream(text) {
  const events = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (event && typeof event === 'object' && !Array.isArray(event) && typeof event.type === 'string') events.push(event);
  }
  return events;
}

/** Events from stdout; when stdout carries none, fall back to stderr. */
export function pickEvents(stdout, stderr) {
  const fromStdout = parseStream(stdout);
  return fromStdout.length ? fromStdout : parseStream(stderr);
}

/**
 * CallId-free call↔result pairing: tool_result events belong to tool_call
 * events in FIRST-IN-FIRST-OUT order (results follow their calls in the
 * stream; interleaved thinking/text events are ignored). A call whose result
 * never arrived (truncated stream / timeout) pairs with result: null.
 */
export function pairToolCallsWithResults(events) {
  const pairs = [];
  const queue = [];
  for (const event of events ?? []) {
    if (event?.type === 'tool_call') queue.push(event);
    else if (event?.type === 'tool_result') pairs.push({ call: queue.shift() ?? null, result: event });
  }
  for (const call of queue) pairs.push({ call, result: null });
  return pairs;
}

const fail = (code, reason) => ({ ok: false, code, reason });
const serialize = event => JSON.stringify(event ?? {});

/**
 * The robustness verdict. Machine-readable `code` on every branch:
 * PASS | OUTSIDE_FILE_CREATED | NO_STREAM_EVENTS | NO_WRITE_CALLS |
 * MODEL_STOPPED_AFTER_DENY | MODEL_SKIPPED_OUTSIDE_CALL | UNEXPECTED_CALL_COUNT |
 * WRONG_CALL_ORDER | WRONG_CALL_PATHS | DENY_NOT_OBSERVED | DENY_RESULT_NOT_ERROR |
 * SECOND_RESULT_MISSING | CODE_IN_SECOND_RESULT | SECOND_RESULT_NOT_COMPLETED |
 * ALLOW_FILE_MISSING | ALLOW_CONTENT_MISMATCH.
 * The zero-code check is scoped to the SECOND tool_result only (the final text
 * legitimately relays the first error). Reads the filesystem for the file
 * ground truth (outsideTarget must be absent, insideTarget exact).
 */
export function verdictRobustness({ events, outsideTarget, insideTarget, insideContent = INSIDE_CONTENT }) {
  const outside = normPath(outsideTarget);
  const inside = normPath(insideTarget);
  // The security headline first: the out-of-scope file must NOT exist (it was
  // pre-asserted absent and its parent pre-created, so an allowed write would
  // really have landed). A present file means the guard did NOT block — a
  // guard failure that outranks any model-behavior classification.
  if (fs.existsSync(outsideTarget)) {
    return fail('OUTSIDE_FILE_CREATED', `the out-of-scope file WAS created: ${outsideTarget} — the guard did not block the write`);
  }
  if (!events?.length) return fail('NO_STREAM_EVENTS', 'no JSON stream events parsed from the task output (see raw output above)');
  const writePairs = pairToolCallsWithResults(events).filter(pair => pair.call?.tool === 'write');
  const callPath = pair => normPath(pair.call?.input?.file_path ?? '');
  if (writePairs.length === 0) return fail('NO_WRITE_CALLS', 'the stream contains no write tool_call events at all');
  if (writePairs.length === 1) {
    if (callPath(writePairs[0]) === inside) {
      return fail('MODEL_SKIPPED_OUTSIDE_CALL', `the model made ONE write call, to the INSIDE path (${inside}) — the outside write instruction was skipped, the deny was never exercised`);
    }
    return fail('MODEL_STOPPED_AFTER_DENY', `the model made only ONE write call (${callPath(writePairs[0])}) and stopped after the deny — model behavior, not a guard failure; honest FAIL, no auto-retry`);
  }
  if (writePairs.length > 2) {
    return fail('UNEXPECTED_CALL_COUNT', `expected exactly 2 write tool_call events, saw ${writePairs.length} (retries/extra calls = honest FAIL; no auto-retry)`);
  }
  const [first, second] = writePairs.map(callPath);
  if (first === inside && second === outside) {
    return fail('WRONG_CALL_ORDER', 'call order swapped: the in-scope write came first and the out-of-scope write second');
  }
  if (first !== outside || second !== inside) {
    return fail('WRONG_CALL_PATHS', `write call paths do not match the prompt targets (first=${first}, second=${second}; expected ${outside} then ${inside})`);
  }
  // Call 1's result (FIFO-paired) must carry the deny, as an error.
  const firstResult = writePairs[0].result;
  if (!firstResult || !parseGstackCodes(serialize(firstResult)).includes('gstack861:OUTSIDE_SCOPE')) {
    return fail('DENY_NOT_OBSERVED', `no gstack861:OUTSIDE_SCOPE in the tool_result paired with the first (outside) write (${firstResult ? `got: ${serialize(firstResult).slice(0, 300)}` : 'result never arrived — stream truncated?'})`);
  }
  if (firstResult.status !== 'error') {
    return fail('DENY_RESULT_NOT_ERROR', `first tool_result status is ${JSON.stringify(firstResult.status)}, expected "error"`);
  }
  // Call 2's result must be clean and completed — and ONLY this result is
  // checked for codes (the final text may relay the first error verbatim).
  const secondResult = writePairs[1].result;
  if (!secondResult) return fail('SECOND_RESULT_MISSING', 'no tool_result observed for the second (inside) write — stream truncated or model stopped');
  const secondCodes = parseGstackCodes(serialize(secondResult));
  if (secondCodes.length) {
    return fail('CODE_IN_SECOND_RESULT', `the SECOND tool_result carries guard codes: ${secondCodes.join(', ')} (zero-code check is scoped here; the final text may legitimately relay the first error)`);
  }
  if (secondResult.status !== 'completed') {
    return fail('SECOND_RESULT_NOT_COMPLETED', `second tool_result status is ${JSON.stringify(secondResult.status)}, expected "completed"`);
  }
  if (!fs.existsSync(insideTarget)) return fail('ALLOW_FILE_MISSING', `the in-scope file was not created: ${insideTarget}`);
  const content = fs.readFileSync(insideTarget, 'utf8');
  if (content !== insideContent) {
    return fail('ALLOW_CONTENT_MISMATCH', `in-scope content mismatch: expected ${JSON.stringify(insideContent)}, got ${JSON.stringify(content)}`);
  }
  return { ok: true, code: 'PASS',
    reason: `deny→allow consistent in one session: call 1 (${outside}) denied gstack861:OUTSIDE_SCOPE as status error, call 2 (${inside}) completed with zero guard codes in its tool_result, file created with exact content ${JSON.stringify(content)}, outside target absent` };
}

/** Falsifiable pre-launch assertion: the target must NOT exist before the task runs. */
export function assertAbsent(targetPath, label) {
  if (fs.existsSync(targetPath)) throw new Error(`ALREADY_EXISTS ${label} target already exists: ${targetPath}`);
  return targetPath;
}

/** Policy object (pure): minimal scaffold roots, dsh read+write on file_path. */
export function policyJson({ workspace, readRoots, writeRoots }) {
  return {
    schemaVersion: 1, workspace: fwd(workspace),
    readRoots: readRoots.map(fwd), writeRoots: writeRoots.map(fwd), protectedRoots: [],
    bindings: { zcode: {}, dsh: {
      read: { effect: 'read', pathKey: 'file_path' },  // spec/qa reads inside the workspace
      write: { effect: 'write', pathKey: 'file_path' }, // pipeline-observed 2026-10-27
    } },
  };
}

/** Patch-layer YAML string with the GUARD-ONLY entry (no skills plugin needed here). */
export function guardPatchYml({ policyPath }) {
  return [
    '- insert:',
    `    - id: ${GUARD}`,
    `      name: '${GUARD}'`,
    '      config:',
    `        policyPath: '${fwd(policyPath)}'`,
    '',
  ].join('\n');
}

/**
 * Compose the repository guard onto a seeded profile directory (offline, file
 * writes only): dependency + shim package re-exporting the repository adapter
 * unchanged + cordis.patch.yml with the single guard entry.
 */
export function composeGuardProfile(profileDir, repoRoot, { policyPath }) {
  const pkgPath = path.join(profileDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [GUARD]: '*' };
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), guardPatchYml({ policyPath }));
  const shim = path.join(profileDir, 'node_modules', GUARD);
  fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(path.join(shim, 'package.json'), `${JSON.stringify({ name: GUARD, version: '0.0.0', type: 'module', main: 'index.mjs' }, null, 2)}\n`);
  fs.writeFileSync(path.join(shim, 'index.mjs'), `export * from '${pathToFileURL(path.join(repoRoot, 'src', 'adapters', 'dsh.mjs')).href}';\n`);
  return { patchPath: path.join(profileDir, 'cordis.patch.yml') };
}

/**
 * The minimal batch-13 scaffold (pure file writes): single-letter dirs under a
 * 1-char-prefix mkdtemp root — root/o (outside deny target's parent, PRE-created
 * so an unblocked write would really land), root/w (workspace) and root/w/s
 * (the writeRoot, which must exist before the policy ever compiles).
 */
export function writeRobustnessFixture(root) {
  const outsideDir = path.join(root, 'o');
  const workspace = path.join(root, 'w');
  const srcDir = path.join(workspace, 's');
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.mkdirSync(srcDir, { recursive: true });
  return { outsideDir, workspace, srcDir };
}

// ---------------------------------------------------------------------------
// Keyed-path assembly + the ONE task (executed only with the key present; the
// spawning helpers below are shared with dsh-mini-vertical.mjs, NOT unit-tested).
// ---------------------------------------------------------------------------

/** Offline: seed a profile from the SHIPPED headless template (key stripped). */
export function seedHeadlessProfile({ root, workspace, profile }) {
  const install = dshInstall();
  const seed = dsh(install, root, ['--profile', profile, '--from-default-profile', 'headless', '--dump-config'], false, workspace, OFFLINE_TIMEOUT_MS);
  if (seed.status !== 0) throw new Error(`seeding profile from headless template failed (exit ${seed.status}):\n${seed.stderr || seed.stdout}`);
  return path.join(root, 'home', 'profiles', profile);
}

/** Offline composition check: guard entry + agent stack in the dump, no patch-layer warnings. */
export function composeCheckGuard({ root, workspace, profile }) {
  const install = dshInstall();
  const dump = dsh(install, root, ['--profile', profile, '--dump-config'], false, workspace, OFFLINE_TIMEOUT_MS);
  const out = `${dump.stdout ?? ''}\n${dump.stderr ?? ''}`;
  const warnings = out.split(/\r?\n/).filter(line => /warn/i.test(line) && /gstack861|patch|cordis/i.test(line));
  return {
    ok: dump.status === 0 && dump.stdout.includes(GUARD)
      && dump.stdout.includes('agent-default-model') && dump.stdout.includes('headless')
      && warnings.length === 0,
    detail: { status: dump.status, stdout: dump.stdout, stderr: dump.stderr, warnings },
  };
}

/**
 * Build the throwaway tree end to end (offline except the profile seeding,
 * which spawns the DSH CLI with the key stripped). On any throw the root is
 * removed here and the error rethrown (main()'s finally only cleans roots
 * prepareRobustness() returned). loadPolicy is called pre-launch so an
 * uncompilable policy aborts before any keyed spend.
 */
export function prepareRobustness(repoRoot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g')); // 1-char prefix: minimal scaffold
  try {
    const scaffold = writeRobustnessFixture(root);
    const profileDir = seedHeadlessProfile({ root, workspace: scaffold.workspace, profile: PROFILE });
    // Policy OUTSIDE the workspace (POLICY_MUST_BE_OUTSIDE_WORKSPACE).
    const policyPath = path.join(root, 'policy.json');
    fs.writeFileSync(policyPath, `${JSON.stringify(policyJson({
      workspace: scaffold.workspace, readRoots: [scaffold.workspace], writeRoots: [scaffold.srcDir],
    }), null, 2)}\n`);
    composeGuardProfile(profileDir, repoRoot, { policyPath });
    loadPolicy(policyPath); // the same file the guard loads: uncompilable ⇒ abort before launch
    return {
      root, workspace: scaffold.workspace, policyPath,
      outsideTarget: assertAbsent(path.join(scaffold.outsideDir, 'a.txt'), 'outside'),
      insideTarget: assertAbsent(path.join(scaffold.srcDir, 'b.txt'), 'inside'),
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** One keyed task child (danger-full-access so the gstack861 guard is the layer under test). */
export function launchTask({ root, workspace, profile, prompt, label }) {
  console.log(`      launching keyed task ${label} (prompt ${prompt.length}/${PROMPT_MAX_CHARS} chars, timeout ${TASK_TIMEOUT_MS / 1000}s):`);
  console.log(`      ${prompt}`);
  const install = dshInstall();
  const child = spawnSync(install.exe, ['--expose-internals', install.cliArg, '--profile', profile, '--json', prompt],
    { encoding: 'utf8', timeout: TASK_TIMEOUT_MS, cwd: workspace, maxBuffer: 32 * 1024 * 1024,
      env: { ...childEnv(root, true), DSH_PERMISSION_MODE: 'danger-full-access' } });
  console.log(`exit=${child.status} signal=${child.signal}`);
  console.log(`--- ${label} stdout ---`); console.log(child.stdout || '(empty)');
  console.log(`--- ${label} stderr ---`); console.log(child.stderr || '(empty)');
  return { status: child.status, signal: child.signal, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
}

/** Honest failure diagnostics parsed from the real child output (no guessing). */
export function diagnoseFailure(task) {
  const combined = `${task.stdout}\n${task.stderr}`;
  if (task.signal) return '任务进程被超时终止（signal），未得到完整输出。';
  if (/did not activate/.test(combined)) return '插件未激活（apply() 抛错只告警且退出码仍为 0，见调研差异清单第 2 条）——上方 warning 即原因。';
  if (/MISSING_CREDENTIAL/.test(combined)) return '子进程未拿到 DEEPSEEK_API_KEY（检查环境变量是否真正传入）。';
  return null;
}

function blocked() {
  console.log('RESULT: BLOCKED — DSH guard 鲁棒性验证（同会话两次调用 deny→allow 一致性）未执行：环境变量 DEEPSEEK_API_KEY 未设置。');
  console.log('(a) 提供密钥的方式：在环境变量中设置后重跑，例如 DEEPSEEK_API_KEY=<key> node scripts/verify-dsh-robustness.mjs');
  console.log('    （本脚本只从环境变量取密钥，绝不读取 ~/.dsh/.credentials.yaml；密钥只进子进程 env，零打印零落盘。）');
  console.log('(b) 密钥成本上限：恰好 1 个密钥任务（结构性硬编码）：同一会话内两次 write 调用（先越界 root/o/a.txt 后范围内');
  console.log('    root/w/s/b.txt），中文指令含「第一个报错也要执行第二个」，提示词 ≤200 字符（代码强制 throw-before-launch，');
  console.log('    对实际构建串测量；本机临时根下约 ≤190 字符）。已知 caveat：宿主可能额外发起一次 effort-off 的');
  console.log('    session-title 微请求（headless 模板自带）；任务内 agentic 轮数并非硬性上限。');
  console.log('(c) 判定纪律（callId-free）：流序恰好两次 write、越界→范围内；第一个 tool_result 须含 gstack861:OUTSIDE_SCOPE');
  console.log('    且 status=error；零码检查仅限第二个 tool_result（最终文本合法转述第一个报错）；文件双侧断言；');
  console.log('    模型 deny 后停止/重试/多调=如实 FAIL（独立机器可读理由码），不自动重试，安全行保持如实。');
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
    console.log('verify-dsh-robustness: key present — isolated pipeline check: ONE paid task with TWO write calls (deny→allow in one session; no auto-retry).');
    console.log('[1/3] building minimal scaffold (1-char mkdtemp prefix, single-letter dirs) + headless-seeded guard-only profile + policy outside the workspace...');
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    prepared = prepareRobustness(repoRoot);
    console.log(`      ok (throwaway root: ${prepared.root}；outside: ${fwd(prepared.outsideTarget)}；inside: ${fwd(prepared.insideTarget)}；~/.dsh 不被读取或写入)`);

    console.log('[2/3] offline composition check (--dump-config, key stripped): guard entry + agent stack, no patch warnings...');
    const composed = composeCheckGuard({ root: prepared.root, workspace: prepared.workspace, profile: PROFILE });
    if (!composed.ok) {
      console.log(`      FAILED: exit=${composed.detail.status}`);
      if (composed.detail.warnings.length) console.log(`      patch-layer warnings: ${composed.detail.warnings.join(' | ')}`);
      console.log(composed.detail.stderr || composed.detail.stdout);
      process.exitCode = 1;
      return;
    }
    console.log('      ok (gstack861-guard composed, agent stack present, no skills plugin mounted)');

    console.log('[3/3] ONE keyed task — two write calls in one session: outside (deny expected) then inside (allow expected), do-both clause...');
    const prompt = checkPromptCap(
      buildRobustnessPrompt({ outsideTarget: prepared.outsideTarget, insideTarget: prepared.insideTarget }),
      'robustness');
    const task = launchTask({ root: prepared.root, workspace: prepared.workspace, profile: PROFILE, prompt, label: 'deny-then-allow' });
    let events = parseStream(task.stdout);
    if (!events.length) {
      console.log('      note: stdout carried no JSON stream events; parsing stderr instead');
      events = parseStream(task.stderr);
    }
    const verdict = verdictRobustness({
      events, outsideTarget: prepared.outsideTarget, insideTarget: prepared.insideTarget, insideContent: INSIDE_CONTENT,
    });
    console.log(`      VERDICT: ${verdict.code} — ${verdict.reason}`);
    const diagnosis = diagnoseFailure(task);
    if (!verdict.ok && diagnosis) console.log(`      diagnosis: ${diagnosis}`);
    if (verdict.ok) {
      console.log('RESULT: PASS — same-session multi-call consistency observed: the guard denied the first out-of-scope write and abstained on the second in-scope write (file created, exact content).');
      process.exitCode = 0;
    } else {
      console.log(`RESULT: FAILURE — verdict code ${verdict.code}（真实输出与完整流水见上；模型 deny 后停止/重试/多调均如实计为失败，不自动重试，安全行保持如实。）`);
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
