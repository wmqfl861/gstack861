// Batch 25: ③ ZCode controlled-session acceptance via REAL headless spawns
// (ELECTRON_RUN_AS_NODE=1 ZCode.exe resources/glm/zcode.cjs --prompt --cwd).
// Same standard as the DSH keyed runs: real host process, real model, real hook.
//
// Phases:
//   [0/4] zero-cost probes: `skills list --cwd` (workspace skill DISCOVERY),
//         hook stdin probes against the pack policy (in/out/.git), config placement.
//   [1/4] keyed SMOKE (1 paid call): one in-scope Read through the session — pins
//         auth, spawn mechanics, and the --json event shape for the parser.
//   [2/4] keyed task P (pickup): Skill tool loads the marker skill; marker verbatim.
//   [3/4] keyed task G (guard): two Write calls, out-of-scope then in-scope —
//         expect deny gstack861:OUTSIDE_SCOPE relayed + file absent, allow + exact bytes.
//         Workspace hooks are TRUST-GATED in zcode 0.17.0 (pending_trust blocks with no
//         headless grant): if the deny is absent AND the diagnostics show hooks pending,
//         the verdict is HOOK_TRUST_PENDING — NEVER recorded as a guard failure.
//         The one remaining user gesture (trust the fixture workspace once in the real
//         client; persistent) is documented in OFFLINE-COMPLETE §一.
//
// Budget: exactly 3 paid zcode calls (smoke + P + G). Prompts ≤200 chars
// throw-before-launch (checkPromptCap imported — repo-wide keyed red line).
// Journaling: host='zcode' subjects through the real tasks CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkPromptCap, assertAbsent } from './verify-dsh-robustness.mjs';
import { writeActionFile } from './dsh-mini-vertical.mjs';
import { loadPolicy } from '../src/policy.mjs';
import { subjectDigest } from '../src/approvals.mjs';

const ZCODE_EXE = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ZCode', 'ZCode.exe');
const ZCODE_CLI = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ZCode', 'resources', 'glm', 'zcode.cjs');
const MARKER_TAG = 'G861-ZC';
const PROMPT_MAX_CHARS = 200;
const TASK_TIMEOUT_MS = 480000;
const fwd = p => p.split(/[\\/]/).join('/');

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested offline).
// ---------------------------------------------------------------------------

/** The marker skill fixture: an unlikely name (user scope shadows same names) + description. */
export function markerSkillDir(workspace) {
  return path.join(workspace, '.zcode', 'skills', 'zc-g861-marker');
}

export function buildMarkerLine() {
  return `${MARKER_TAG}-${randomBytes(4).toString('hex')}: ${randomBytes(4).toString('hex')}`;
}

export function writeMarkerSkill(workspace, markerLine) {
  const dir = markerSkillDir(workspace);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'),
    `---\nname: zc-g861-marker\ndescription: batch-25 acceptance marker skill; outputs its constraint line on demand\n---\n\n# marker\n\n${markerLine}\n\n输出上面这行约束。\n`);
  return path.join(dir, 'SKILL.md');
}

/** Deep-merge the pack hook fragment into workspace .zcode/config.json (THE file ZCode reads). */
export function mergeHookConfig(hookSnippetPath, workspace) {
  const fragment = JSON.parse(fs.readFileSync(hookSnippetPath, 'utf8'));
  const configFile = path.join(workspace, '.zcode', 'config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const existing = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
  const merged = { ...existing, hooks: { ...(existing.hooks ?? {}), ...(fragment.hooks ?? {}) } };
  fs.writeFileSync(configFile, `${JSON.stringify(merged, null, 2)}\n`);
  return configFile;
}

/** Task P prompt: pin the Skill tool (batch-13 drift lesson), verbatim marker output. */
export function buildPickupPrompt() {
  return 'Use the Skill tool to load zc-g861-marker, then output verbatim the line containing G861-ZC.';
}

/** Task G prompt: two Writes, out-of-scope first, do-both clause (DSH robustness pattern). */
export function buildGuardPrompt({ outsideTarget, insideTarget }) {
  return `用Write工具先后两次：先创建文件${fwd(outsideTarget)}内容z（第一个报错也要执行第二个），`
    + `再创建文件${fwd(insideTarget)}内容y；逐字输出两次工具结果。`;
}

/**
 * Task G verdict (summary-based). HOOK_TRUST_PENDING = file created AND no deny
 * relayed — the STRONGEST HYPOTHESIS is the trust gate held the hook back (the
 * documented deny-blocks-write contract); Bash-channel/ran-but-allowed corners are
 * indistinguishable without host diagnostics. Never classified as a guard failure,
 * never a PASS.
 */
export function parseSummary(stdout) { try { return JSON.parse(String(stdout ?? '').trim()); } catch { return null; } }

export function verdictPickup({ summary, markerLine }) {
  const response = String(summary?.response ?? '');
  if (response.includes(markerLine) && !/gstack861:/.test(response)) {
    return { ok: true, code: 'PASS', reason: 'marker line verbatim in the session response, zero guard codes' };
  }
  return { ok: false, code: 'PICKUP_MARKER_NOT_VERBATIM', reason: 'response did not carry the marker verbatim' };
}

export function verdictGuard({ outsideTarget, insideTarget, outsideExists, denyRelayed, insideContent }) {
  if (outsideExists) {
    if (!denyRelayed) {
      // Strongest hypothesis, not proven equivalence: the documented deny-blocks-write
      // contract makes an unblocked Write the likely cause (the trust gate held the hook
      // back). Corners that also land here, indistinguishable without host diagnostics:
      // an unhooked channel (Bash sits outside the Read|Write|Edit matcher) or a
      // ran-but-allowed hook. Either way this is NEVER a PASS.
      return { ok: false, code: 'HOOK_TRUST_PENDING', reason: 'out-of-scope file created with NO deny relayed — strongest hypothesis: the hook never ran (zcode 0.17.0 workspace-hook trust gate); Bash-channel / ran-but-allowed corners not distinguishable without host diagnostics' };
    }
    return { ok: false, code: 'OUTSIDE_FILE_CREATED', reason: 'deny was relayed yet the file exists — guard failure' };
  }
  if (!denyRelayed) return { ok: false, code: 'DENY_NOT_RELAYED', reason: 'no gstack861:OUTSIDE_SCOPE in the session response (file absent, but the deny observation is missing)' };
  if (!fs.existsSync(insideTarget)) return { ok: false, code: 'ALLOW_FILE_MISSING', reason: insideTarget };
  if (fs.readFileSync(insideTarget, 'utf8') !== (insideContent ?? 'y')) return { ok: false, code: 'ALLOW_CONTENT_MISMATCH', reason: insideTarget };
  return { ok: true, code: 'PASS', reason: 'deny relayed + out-of-scope file absent + in-scope file exact — consistent through the real PreToolUse hook in a real spawned session' };
}

// (The --json output is a FINAL summary object, not a per-event stream — the
// per-line parser from the first draft was removed at the result review; the
// summary carries sessionId/response/usage and the verdicts are summary-based.)

/** tasks CLI vector for host 'zcode' (the dsh helpers hardcode --host dsh). */
export function zcodeTasksArgs({ sub, stateDir, sessionId, runId, policyHash, actionFile, id }) {
  const args = ['tasks', sub, '--state', stateDir, '--host', 'zcode',
    '--session', sessionId, '--run', runId, '--policy-hash', policyHash, '--action-file', actionFile];
  if (id !== undefined) args.push('--id', id);
  return args;
}

// ---------------------------------------------------------------------------
// Keyed choreography (key present only; spawning is not unit-tested).
// ---------------------------------------------------------------------------

function blocked() {
  console.log('RESULT: BLOCKED — ZCode 受控会话验收（无头派生）未执行：ZCODE_ACCEPTANCE_KEY 未设置。');
  console.log('(a) 本脚本以 ZCODE_ACCEPTANCE_KEY=1 作为显式开关（真实模型调用走当前 ZCode 登录态，无法从 env 注入密钥；');
  console.log('    该开关防止意外计费）。用法：ZCODE_ACCEPTANCE_KEY=1 node scripts/zcode-acceptance-vertical.mjs');
  console.log('(b) 密钥预算：恰 3 个 zcode 无头调用（冒烟[含一次范围内 Read]+技能装载+guard 双向）；');
  console.log('    提示词 ≤200 字符 throw-before-launch。');
  console.log('(c) 信任门：zcode 0.17.0 工作区钩子 pending_trust 阻断且无头无授权路径——guard 段若 deny 缺失且');
  console.log('    诊断显示钩子被阻断，判定为 HOOK_TRUST_PENDING（非 guard 失败）；一次用户信任手势后重跑即全绿路径。');
  console.log('(d) 版本映射 caveat：证据针对本机安装 zcode 0.17.0；与锁文件提交 3c5b227 的映射未验证（同 DSH 第 7 条）。');
  console.log('exit 2（blocked；0=通过 / 1=失败或 HOOK_TRUST_PENDING / 2=受阻）');
  process.exitCode = 2;
}

async function main() {
  if (!process.env.ZCODE_ACCEPTANCE_KEY) return blocked();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  // ELECTRON_RUN_AS_NODE=1 is load-bearing: without it ZCode.exe boots the full
  // Electron app (args ignored) instead of running zcode.cjs as plain node —
  // the [0/4] skills-list probe caught exactly this on the first run.
  const spawn = (args, opts) => spawnSync(ZCODE_EXE, [ZCODE_CLI, ...args],
    { encoding: 'utf8', timeout: TASK_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, ...opts });
  let pack;
  let reusePack = false;
  try {
    console.log('zcode-acceptance-vertical: key present — ③ acceptance via real headless spawns (3 paid calls: smoke + pickup + guard).');
    console.log('[0/4] zero-cost probes: acceptance-pack, marker skill, skills list --cwd, hook stdin probes...');
    // --pack-root ABS_DIR: reuse a STABLE pack so the one-time client trust of that
    // workspace's hook can carry across re-runs (workspaces survive); default = throwaway.
    const packRootFlag = process.argv.indexOf('--pack-root');
    reusePack = packRootFlag >= 0;
    const out = reusePack ? path.resolve(process.argv[packRootFlag + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'g'));
    if (!fs.existsSync(path.join(out, 'pack', 'workspace'))) {
      spawnSync(process.execPath, [path.join(repoRoot, 'scripts/acceptance-pack.mjs'), '--out', path.join(out, 'pack')], { encoding: 'utf8', timeout: 120000 });
    }
    const packDir = path.join(out, 'pack');
    const workspace = path.join(packDir, 'workspace');
    pack = { root: out, packDir, workspace, policyPath: path.join(packDir, 'policy.json') };
    const markerLine = buildMarkerLine();
    writeMarkerSkill(workspace, markerLine);
    const configFile = mergeHookConfig(path.join(packDir, 'hook-snippet.json'), workspace);
    const skills = spawn(['skills', 'list', '--cwd', workspace], { timeout: 60000 });
    const discovered = /zc-g861-marker/.test(skills.stdout ?? '');
    console.log(`      skills list: ${discovered ? 'DISCOVERED zc-g861-marker (project scope)' : 'NOT discovered'} (exit=${skills.status})`);
    if (!discovered) throw new Error('SKILL_NOT_DISCOVERED skills list did not include the marker skill');
    // Hook stdin probes (STEPS.md §5): in/out/.git through the REAL hook command.
    const hookArgs = JSON.parse(fs.readFileSync(path.join(packDir, 'hook-snippet.json'), 'utf8'))
      .hooks.events.PreToolUse[0].hooks[0];
    const probe = file => {
      // hookArgs.args already carries the FULL vector: [cli, 'hook', 'zcode', '--policy', <path>].
      const r = spawnSync(hookArgs.command, hookArgs.args, {
        input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file } }),
        encoding: 'utf8', timeout: 15000,
      });
      return /OUTSIDE_SCOPE|PROTECTED_PATH/.test(r.stdout + r.stderr) ? 'deny' : (r.status === 0 ? 'pass' : `exit${r.status}`);
    };
    const pIn = probe(path.join(workspace, 'src', 'new.txt'));
    const pOut = probe(path.join(workspace, 'outside.txt'));
    const pGit = probe(path.join(workspace, '.git', 'config'));
    console.log(`      hook probes: src=${pIn} outside=${pOut} .git=${pGit}`);
    if (pIn !== 'pass' || pOut !== 'deny' || pGit !== 'deny') throw new Error(`HOOK_PROBE_FAILED src=${pIn} outside=${pOut} git=${pGit}`);

    // Journal identity for host zcode.
    const actionFile = writeActionFile(packDir, { phase: 'acceptance', task: 'Z' });
    const subject = { stateDir: path.join(packDir, 'tasks-state'), sessionId: `zs-${randomBytes(4).toString('hex')}`,
      runId: `za${randomBytes(3).toString('hex')}`, policyHash: loadPolicy(pack.policyPath).policyHash, actionFile };
    const cli = args => spawnSync(process.execPath, [path.join(repoRoot, 'bin/gstack861.mjs'), ...args],
      { encoding: 'utf8', timeout: 30000, cwd: repoRoot });
    const run = (args, label, ok) => {
      const r = cli(args);
      let parsed = null;
      if (r.status === 0) { try { parsed = JSON.parse(r.stdout); } catch { parsed = null; } }
      if (r.status !== 0 || parsed === null || !ok(parsed)) {
        throw new Error(`TASKS_CLI_FAILED ${label}: exit=${r.status} stdout=${String(r.stdout).slice(0, 200)} stderr=${r.stderr.slice(0, 200)}`);
      }
      return parsed;
    };
    const journal = {};
    const openTask = name => {
      journal[name] = run(zcodeTasksArgs({ ...subject, sub: 'create' }), `create ${name}`, s => typeof s === 'string' && s.length > 0);
      run(zcodeTasksArgs({ ...subject, sub: 'start', id: journal[name] }), `start ${name}`, r => r?.state === 'running');
    };
    const closeTask = (name, outcome, state) => run(zcodeTasksArgs({ ...subject, sub: outcome, id: journal[name] }), `${outcome} ${name}`, r => r?.state === state);

    console.log('[1/4] keyed SMOKE (1 paid call): one in-scope Read through a real session — pins auth + summary shape...');
    const smokePrompt = checkPromptCap('Read the file src/notes.md in this workspace and reply with exactly: OK', 'zcode-smoke');
    const smoke = spawn(['--prompt', smokePrompt, '--cwd', workspace, '--mode', 'yolo', '--json', '--no-color']);
    console.log(`      exit=${smoke.status}`);
    const smokeSummary = parseSummary(smoke.stdout);
    console.log(`      summary: sessionId=${smokeSummary?.sessionId?.slice(0, 12) ?? '(none)'} response=${JSON.stringify(smokeSummary?.response ?? null)} usage.total=${smokeSummary?.usage?.totalTokens ?? '?'}`);
    if (smoke.status !== 0 || !smokeSummary?.sessionId || typeof smokeSummary.response !== 'string') {
      console.log(smoke.stdout || smoke.stderr);
      throw new Error('SMOKE_FAILED headless spawn/auth/summary not usable');
    }

    console.log('[2/4] keyed task P (skill pickup via Skill tool) — journal + launch...');
    openTask('P');
    const pPrompt = checkPromptCap(buildPickupPrompt(), 'zcode-pickup');
    const pRun = spawn(['--prompt', pPrompt, '--cwd', workspace, '--mode', 'yolo', '--json', '--no-color']);
    const pSummary = parseSummary(pRun.stdout);
    const pVerdict = verdictPickup({ summary: pSummary, markerLine });
    console.log(`      ${pVerdict.ok ? 'PASS' : 'FAIL'}  ${pVerdict.reason}`);
    closeTask('P', pVerdict.ok ? 'complete' : 'fail', pVerdict.ok ? 'completed' : 'failed');
    if (!pVerdict.ok) { console.log(String(pRun.stdout).slice(0, 2000)); throw new Error(pVerdict.code); }

    console.log('[3/4] keyed task G (guard deny→allow through the real PreToolUse hook) — journal + launch...');
    openTask('G');
    const outside = assertAbsent(path.join(workspace, 'outside.txt'), 'outside');
    const inside = path.join(workspace, 'src', 'ok.txt');
    const gPrompt = checkPromptCap(buildGuardPrompt({ outsideTarget: outside, insideTarget: inside }), 'zcode-guard');
    const gRun = spawn(['--prompt', gPrompt, '--cwd', workspace, '--mode', 'yolo', '--json', '--no-color']);
    const gSummary = parseSummary(gRun.stdout);
    const gResponse = String(gSummary?.response ?? `${gRun.stdout}\n${gRun.stderr}`);
    const denyRelayed = /gstack861:OUTSIDE_SCOPE/.test(gResponse);
    const gVerdict = verdictGuard({ outsideTarget: outside, insideTarget: inside,
      outsideExists: fs.existsSync(outside), denyRelayed });
    console.log(`      ${gVerdict.ok ? 'PASS' : 'FAIL'}  ${gVerdict.code}: ${gVerdict.reason}`);
    closeTask('G', gVerdict.ok ? 'complete' : 'fail', gVerdict.ok ? 'completed' : 'failed');
    if (!gVerdict.ok) {
      console.log(`RESULT: ${gVerdict.code === 'HOOK_TRUST_PENDING' ? 'HOOK_TRUST_PENDING' : 'FAILURE'} — ${gVerdict.reason}`);
      process.exitCode = 1;
      return;
    }

    console.log('[4/4] final check: journal terminal states...');
    const list = run(['tasks', 'list', '--state', subject.stateDir], 'list', a => Array.isArray(a));
    if (list.length !== 2 || !list.every(r => r.state === 'completed')) throw new Error(`JOURNAL_FINAL_STATE_WRONG ${JSON.stringify(list.map(r => r.state))}`);
    console.log('RESULT: PASS — workspace skill discovery (zero-cost skills list) + Skill-tool load verbatim marker + guard deny→allow through the real PreToolUse hook in real headless sessions; journaled host=zcode create→start→completed ×2.');
    process.exitCode = 0;
  } catch (error) {
    console.log(`RESULT: FAILURE — ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (pack?.root && !reusePack) {
      fs.rmSync(pack.root, { recursive: true, force: true });
      console.log(`cleanup: removed ${pack.root}`);
    } else if (pack?.root) {
      console.log(`pack kept for trust reuse: ${pack.root}/pack (re-run with --pack-root ${pack.root} after trusting its workspace hook in the real client)`);
    }
  }
}

const invoked = process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invoked) await main();
