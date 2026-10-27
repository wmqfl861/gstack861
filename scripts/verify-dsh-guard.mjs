// Pipeline-level DSH guard verification (readiness script). Usage: node scripts/verify-dsh-guard.mjs
//
// Exit codes: 0 = verified (guard denial observed in a real DSH tool pipeline); 1 = failure
// (composition, activation, task error, or denial not observed); 2 = BLOCKED (see below).
//
// DEEPSEEK_API_KEY absent (this repository's current batch state): prints why the check is
// blocked and exits 2 without touching DSH at all — zero paid model calls, no process spawn.
//
// DEEPSEEK_API_KEY present: builds a throwaway isolated DSH_HOME under the OS temp dir (never
// reads or writes ~/.dsh), seeds a fresh profile from the SHIPPED 'headless' template via
// `--from-default-profile headless` (full agent/model/permission stack), loads the repository
// adapter unchanged through a shim package (gstack861-guard re-export, per findings smoke),
// composes the guard entry into the profile patch layer, runs an OFFLINE composition check
// (--dump-config, key stripped from that child's env), then launches EXACTLY ONE real task.
// The task prompt is hard-capped in code at 200 chars and contains a single instruction, so
// the run makes exactly ONE paid task request; the host may additionally issue its usual tiny
// effort-off session-title request (session-title-first-prompt-llm is part of the shipped
// template). DSH_PERMISSION_MODE=danger-full-access is set for the task child only: with the
// shipped preset, approval becomes 'never' and the host pre-execute layer allows everything,
// which is required because the guard is only consulted AFTER pre-execute allows (findings
// §ctx.tools.guard). The guard must then be the layer that denies the single out-of-scope
// write; the script asserts a `gstack861:`-prefixed error in the real output and prints it.
//
// Verified-offline basis (this machine, 0 paid calls): template seeding, `- insert:` patch
// composition through --dump-config, and the danger-full-access env wiring all reproduce as
// documented in docs/integration/dsh-local-findings.md. NOT verifiable without the key: plugin
// activation inside a real task run — the headless profile refuses to boot without a task
// ("a task is required"), so activation warnings ("did not activate", exit code still 0,
// findings item 2) are parsed from the task run itself and reported on failure.
//
// Version caveat repeated in the blocked message (findings item 7): the local install
// (0.2.1-rc.3) vs upstream.lock.json pin 22ddee3... commit mapping is unverified.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROMPT_MAX_CHARS = 200; // hard cap enforced in code before any call is made
const OFFLINE_TIMEOUT_MS = 180000;
const TASK_TIMEOUT_MS = 300000; // cold start alone is 0.5-2 min
const PROFILE = 'g861verify';
const GUARD = 'gstack861-guard';

function dshInstall() {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const exe = path.join(base, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe');
  const cli = path.join(base, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh',
    'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  // The cli.js path lives INSIDE the asar archive: plain fs.existsSync cannot see it (only the
  // Electron-patched fs of the child can), so only the executable is existence-checked.
  if (!fs.existsSync(exe)) throw new Error(`DSH executable not found: ${exe}`);
  return { exe, cli, cliArg: cli.split(path.sep).join('/') }; // cli.js path must be C:/ style
}

const fwd = p => p.split(path.sep).join('/');

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

/**
 * Build the throwaway tree and seed the profile from the shipped headless template.
 * All offline: the seeding run uses --dump-config (composes, mounts nothing) with the key removed.
 * Returns { root, workspace, probePath, policyPath }.
 */
export function prepare(repoRoot) {
  const install = dshInstall();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g861-dsh-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const seed = dsh(install, root, ['--profile', PROFILE, '--from-default-profile', 'headless', '--dump-config'], false, workspace, OFFLINE_TIMEOUT_MS);
  if (seed.status !== 0) { fs.rmSync(root, { recursive: true, force: true }); throw new Error(`seeding profile from headless template failed (exit ${seed.status}):\n${seed.stderr || seed.stdout}`); }
  const profile = path.join(root, 'home', 'profiles', PROFILE);

  // Policy: workspace-wide read/write inside the temp workspace; the probe file lives OUTSIDE it.
  const policyPath = path.join(root, 'policy.json');
  fs.writeFileSync(policyPath, JSON.stringify({
    schemaVersion: 1, workspace: fwd(workspace),
    readRoots: [fwd(workspace)], writeRoots: [fwd(workspace)], protectedRoots: [],
    // Real DSH file tool names/params per the pinned-commit tool list (review §二.10).
    bindings: { zcode: {}, dsh: {
      read: { effect: 'read', pathKey: 'file_path' },
      write: { effect: 'write', pathKey: 'file_path' },
      edit: { effect: 'write', pathKey: 'file_path' },
    } },
  }, null, 2) + '\n');

  // Patch layer: the seeded layer is an empty list `[]`; replace it with an insert entry
  // (appending after `[]` is invalid YAML, and an unknown bare id is a "not found" error).
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), [
    '- insert:',
    `    - id: ${GUARD}`,
    `      name: '${GUARD}'`,
    '      config:',
    `        policyPath: '${fwd(policyPath)}'`,
    '',
  ].join('\n'));

  // Shim package re-exporting the repository adapter unchanged (findings smoke form).
  const pkgPath = path.join(profile, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [GUARD]: '*' };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  const shim = path.join(profile, 'node_modules', GUARD);
  fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(path.join(shim, 'package.json'), JSON.stringify({ name: GUARD, version: '0.0.0', type: 'module', main: 'index.mjs' }, null, 2) + '\n');
  fs.writeFileSync(path.join(shim, 'index.mjs'), `export * from '${pathToFileURL(path.join(repoRoot, 'src', 'adapters', 'dsh.mjs')).href}';\n`);
  return { root, workspace, probePath: path.join(root, 'outside', 'probe.txt'), policyPath };
}

/** Offline composition check: the composed tree must contain the guard entry AND the agent stack. */
export function composeCheck(prepared) {
  const install = dshInstall();
  const dump = dsh(install, prepared.root, ['--profile', PROFILE, '--dump-config'], false, prepared.workspace, OFFLINE_TIMEOUT_MS);
  return { ok: dump.status === 0 && dump.stdout.includes(GUARD) && dump.stdout.includes('agent-default-model') && dump.stdout.includes('headless'),
    detail: { status: dump.status, stdout: dump.stdout, stderr: dump.stderr } };
}

/** The keyed run: ONE task whose single out-of-scope write must be denied by the guard. */
function runTask(prepared) {
  const prompt = `Use the write tool once: create ${fwd(prepared.probePath)} with content ok, then output the exact tool result text.`;
  if (prompt.length > PROMPT_MAX_CHARS) throw new Error(`internal: prompt is ${prompt.length} chars > ${PROMPT_MAX_CHARS} (refusing to launch)`);
  console.log(`[3/3] launching ONE keyed task (prompt ${prompt.length}/${PROMPT_MAX_CHARS} chars, single instruction, timeout ${TASK_TIMEOUT_MS / 1000}s):`);
  console.log(`      ${prompt}`);
  const install = dshInstall();
  // danger-full-access (task child only): shipped preset turns approval to 'never' so the host
  // pre-execute layer allows everything and the GUARD is the only gate left to test.
  const child = spawnSync(install.exe, ['--expose-internals', install.cliArg, '--profile', PROFILE, '--json', prompt],
    { encoding: 'utf8', timeout: TASK_TIMEOUT_MS, cwd: prepared.workspace, maxBuffer: 32 * 1024 * 1024,
      env: { ...childEnv(prepared.root, true), DSH_PERMISSION_MODE: 'danger-full-access' } });
  console.log(`exit=${child.status} signal=${child.signal}`);
  console.log('--- task stdout ---'); console.log(child.stdout || '(empty)');
  console.log('--- task stderr ---'); console.log(child.stderr || '(empty)');
  return { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
}

function blocked() {
  console.log('RESULT: BLOCKED — DSH 管线级 guard 验证未执行：环境变量 DEEPSEEK_API_KEY 未设置。');
  console.log('(a) 提供密钥的方式：在环境变量中设置后重跑，例如 DEEPSEEK_API_KEY=<key> node scripts/verify-dsh-guard.mjs');
  console.log('    （本脚本只从环境变量取密钥，绝不读取 ~/.dsh/.credentials.yaml 或任何用户级配置。）');
  console.log('(b) 版本映射注意事项（docs/integration/dsh-local-findings.md 差异清单第 7 条）：本机 DSH 安装（0.2.1-rc.3）');
  console.log('    与 upstream.lock.json 固定提交 22ddee3792402c3e70ec5f86a63c3e3e895a2f60 的对应关系未验证；升级基线前需先补');
  console.log('    commit↔版本映射并回归本脚本。');
  console.log('(c) 本次未发生任何付费模型调用（密钥缺失即阻塞，未启动任何 DSH 进程）。');
  console.log('exit 2（blocked；0=通过 / 1=失败 / 2=受阻待密钥）');
  process.exitCode = 2;
}

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) return blocked();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let prepared;
  try {
    console.log('verify-dsh-guard: key present — isolated pipeline check with EXACTLY ONE paid task call.');
    console.log('[1/3] building isolated DSH_HOME + seeding profile from shipped headless template (offline)...');
    prepared = prepare(repoRoot);
    console.log(`      ok (throwaway root: ${prepared.root}；~/.dsh 不被读取或写入)`);
    console.log('[2/3] offline composition check (--dump-config, key stripped from that child)...');
    const composed = composeCheck(prepared);
    if (!composed.ok) {
      console.log(`      FAILED: exit=${composed.detail.status}`);
      console.log(composed.detail.stderr || composed.detail.stdout);
      process.exitCode = 1;
      return;
    }
    console.log('      ok (guard entry + agent stack composed, no patch warnings)');
    const task = runTask(prepared);
    const codes = [...new Set((task.stdout + task.stderr).match(/gstack861:[A-Z][A-Z0-9_]*/g) ?? [])];
    const leaked = fs.existsSync(prepared.probePath); // danger-full-access: a present probe file means the guard did NOT block the write
    if (codes.length && !leaked) {
      console.log(`RESULT: guard denial observed in the real DSH pipeline: ${codes.join(', ')}（预期 gstack861:OUTSIDE_SCOPE）`);
      process.exitCode = 0;
    } else {
      console.log(leaked ? 'RESULT: FAILURE — the out-of-scope probe file was actually created; the guard did not block the write.'
        : 'RESULT: FAILURE — no gstack861:-prefixed error reached the tool output.');
      if (task.signal) console.log('diagnosis: 任务进程被超时终止（signal），未得到完整输出。');
      else if (/did not activate/.test(task.stderr)) console.log('diagnosis: 插件未激活（apply() 抛错只告警且退出码仍为 0，见调研差异清单第 2 条）——上方 warning 即原因。');
      else if (/MISSING_CREDENTIAL/.test(task.stdout + task.stderr)) console.log('diagnosis: 子进程未拿到 DEEPSEEK_API_KEY（检查环境变量是否真正传入）。');
      else console.log('diagnosis: 任务未产生越界工具调用或输出形态不同——检查上方真实输出；本脚本的密钥路径从未实跑，调整需对照 docs/integration/dsh-local-findings.md。');
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
