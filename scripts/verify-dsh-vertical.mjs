// Keyed DSH vertical verification (batch 12): skills runtime consumption + allow path.
// Usage: node scripts/verify-dsh-vertical.mjs
//
// Exit codes: 0 = both keyed tasks passed; 1 = failure (setup, composition, or a task
// verdict failed); 2 = BLOCKED (DEEPSEEK_API_KEY absent — nothing runs, zero paid calls).
//
// KEY HANDLING (same discipline as scripts/verify-dsh-guard.mjs): the key is taken ONLY
// from the DEEPSEEK_API_KEY environment variable and passed ONLY into keyed child envs —
// never read from ~/.dsh, never printed, never written to disk. Every offline child
// (profile seeding, --dump-config composition check) gets the key STRIPPED.
//
// KEYED COST CAP: exactly TWO keyed tasks, no more (hard-coded structure, not a flag).
// Each prompt is hard-capped at PROMPT_MAX_CHARS=200 chars in code (throw-before-launch)
// and carries a single instruction. Known caveat, stated honestly: each task host may
// additionally issue its usual tiny effort-off session-title request
// (session-title-first-prompt-llm ships in the headless template) — the cap is 2 tasks,
// not 2 requests. In-task agentic rounds are NOT hard-capped (single-task semantics
// come from the headless profile).
//
// What it proves (boundary ② runtime half + DSH minimal vertical, allow side):
//   Task A (skills consumption) — a REAL DSH session with BOTH repository plugins
//     mounted (gstack861-guard + gstack861-skills) must actually READ a fixture
//     SKILL.md listed in the injected gstack861 skills index and echo back its
//     unguessable marker line verbatim (G861-MARK-<random>): the index exposes only
//     name | description | path, so the marker is obtainable only by really reading
//     the file. Verdict: marker line verbatim in the final text AND zero gstack861:
//     codes. A model that ignores the index fails honestly.
//   Task B (allow path) — pre-created <ws>/src/, a fresh unique filename asserted
//     ABSENT before launch; the task must create it with the fixed content
//     'vertical-ok'. Verdict: file exists + content exact + zero gstack861: codes —
//     the guard (deny-only layer) abstained on an in-scope write.
//
// Environment assembly (all inside ONE throwaway temp root; ~/.dsh never touched):
//   - DSH_HOME/DSH_AGENTS_HOME redirected under the root; profile seeded from the
//     SHIPPED 'headless' template via --from-default-profile (offline, key stripped).
//   - The skills store is staged INSIDE the temp workspace at <root>/workspace/skills
//     through the REAL offline chain (render-tree fixture → stageRender →
//     installSkills) — INSIDE is load-bearing: policy readRoots=[workspace], and a
//     root outside the workspace cannot compile (ROOT_OUTSIDE_WORKSPACE).
//   - Policy at <root>/policy.json, OUTSIDE the workspace (loadPolicy:
//     POLICY_MUST_BE_OUTSIDE_WORKSPACE), readRoots=[workspace], writeRoots=[workspace/src],
//     dsh bindings read/write on file_path (write pipeline-observed 2026-10-27,
//     docs/verification-2026-10-27-dsh-pipeline.md; read pinned-commit source-inspected,
//     claude-review §二.10).
//   - cordis.patch.yml carries BOTH plugin entries; both shims re-export the
//     repository adapters unchanged. The offline composeCheck asserts BOTH plugin ids
//     in the --dump-config dump plus the agent stack, with no patch-layer warnings.
//   - DSH_PERMISSION_MODE=danger-full-access for task children only (same rationale as
//     verify-dsh-guard: approval becomes 'never' and the host pre-execute layer allows
//     everything, so the gstack861 guard is the only layer whose abstain/deny the
//     verdicts observe).
//
// Version caveat (findings item 7): local install 0.2.1-rc.3 vs upstream.lock.json pin
// 22ddee3... commit mapping unverified; re-baseline before upgrading the host.
//
// Pure helpers are exported for offline unit tests (test/verify-dsh-vertical.test.mjs,
// first verify-script test mode): prompt builders + cap checks, verdict parsers, the
// fixture/markers builder, and the policy/profile composers. Tests never launch DSH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stageRender } from '../src/stage.mjs';
import { installSkills } from '../src/install.mjs';
import { textDigest } from '../src/json.mjs';

export const PROMPT_MAX_CHARS = 200; // hard cap enforced in code before any launch
export const MARKER_TAG = 'G861-MARK';
export const ALLOW_CONTENT = 'vertical-ok';
const OFFLINE_TIMEOUT_MS = 180000;
const TASK_TIMEOUT_MS = 300000; // cold start alone is 0.5-2 min
const PROFILE = 'g861vert';
const GUARD = 'gstack861-guard';
const SKILLS = 'gstack861-skills';
const HOST = 'dsh';
// Mirrors the upstream renderer's dir naming exactly (gen-skill-docs.ts via
// scripts/render-upstream.mjs): already-prefixed names pass through.
const renderedDir = name => (name.startsWith('gstack-') ? name : `gstack-${name}`);
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
// Pure helpers (unit-tested offline; no DSH, no filesystem writes except where noted).
// ---------------------------------------------------------------------------

/**
 * The unguessable marker line planted in the chosen fixture SKILL.md. Random hex beyond
 * the known tag: the index exposes only name|description|path, so echoing this line
 * verbatim proves the model really read the file instead of guessing from the index.
 */
export function buildMarkerLine() {
  return `${MARKER_TAG}-${randomBytes(4).toString('hex')}: ${randomBytes(5).toString('hex')}-${randomBytes(5).toString('hex')}`;
}

/** Task A prompt: consume the injected skills index, read the named SKILL.md, echo the marker line. */
export function buildSkillsPrompt({ skillName }) {
  return `Read the SKILL.md of skill ${skillName} listed in the gstack861 skills index, then output verbatim the line containing ${MARKER_TAG}.`;
}

/** Task B prompt: one in-scope write of the fixed content to an absolute path (guard needs absolute). */
export function buildAllowPrompt({ targetPath }) {
  return `Use the write tool once: create ${fwd(targetPath)} with content ${ALLOW_CONTENT}, then output the exact tool result.`;
}

/** Throw-before-launch prompt cap (same discipline as verify-dsh-guard). Returns the prompt. */
export function checkPromptCap(prompt, label) {
  if (prompt.length > PROMPT_MAX_CHARS) {
    throw new Error(`PROMPT_TOO_LONG ${label} prompt is ${prompt.length} chars > ${PROMPT_MAX_CHARS} (refusing to launch)`);
  }
  return prompt;
}

/** Deduped `gstack861:` error codes found in a task's combined output. */
export function parseGstackCodes(text) {
  return [...new Set((text ?? '').match(/gstack861:[A-Z][A-Z0-9_]*/g) ?? [])];
}

/** Task A verdict: marker line verbatim in the final text AND zero gstack861 codes. */
export function verdictSkills({ output, markerLine }) {
  const codes = parseGstackCodes(output);
  if (codes.length) return { ok: false, reason: `guard codes present: ${codes.join(', ')}` };
  if (!String(output ?? '').includes(markerLine)) {
    return { ok: false, reason: `marker line not echoed verbatim (expected: ${markerLine})` };
  }
  return { ok: true, reason: `marker line verbatim: ${markerLine}` };
}

/** Task B verdict: file exists + exact content + zero gstack861 codes (guard abstained). */
export function verdictAllow({ targetPath, output, expectedContent = ALLOW_CONTENT }) {
  const codes = parseGstackCodes(output);
  if (codes.length) return { ok: false, reason: `guard codes present: ${codes.join(', ')}` };
  if (!fs.existsSync(targetPath)) return { ok: false, reason: `target file was not created: ${targetPath}` };
  const content = fs.readFileSync(targetPath, 'utf8');
  if (content !== expectedContent) {
    return { ok: false, reason: `content mismatch: expected ${JSON.stringify(expectedContent)}, got ${JSON.stringify(content)}` };
  }
  return { ok: true, reason: `file created with exact content ${JSON.stringify(content)} at ${targetPath}` };
}

/** Fresh unique allow-path target inside the (pre-created) writeRoot directory. */
export function freshAllowTarget(srcDir) {
  return path.join(srcDir, `g861-${randomBytes(6).toString('hex')}.txt`);
}

/** Falsifiable pre-launch assertion: the allow target must NOT exist before the task runs. */
export function assertAbsent(targetPath, label) {
  if (fs.existsSync(targetPath)) throw new Error(`ALREADY_EXISTS ${label} target already exists: ${targetPath}`);
  return targetPath;
}

/** Policy object (pure): skills dir coverage comes from readRoots=[workspace] — the store MUST be inside it. */
export function policyJson({ workspace, readRoots, writeRoots }) {
  return {
    schemaVersion: 1, workspace: fwd(workspace),
    readRoots: readRoots.map(fwd), writeRoots: writeRoots.map(fwd), protectedRoots: [],
    bindings: { zcode: {}, dsh: {
      // Real DSH file tools per pipeline evidence (write+file_path observed 2026-10-27)
      // and pinned-commit source inspection (read/edit, claude-review §二.10).
      read: { effect: 'read', pathKey: 'file_path' },  // task A reads a SKILL.md inside the workspace
      write: { effect: 'write', pathKey: 'file_path' }, // task B writes inside workspace/src
    } },
  };
}

/** Patch-layer YAML string with BOTH plugin entries and their configs. */
export function patchLayerYml({ policyPath, skillsDir }) {
  return [
    '- insert:',
    `    - id: ${GUARD}`,
    `      name: '${GUARD}'`,
    '      config:',
    `        policyPath: '${fwd(policyPath)}'`,
    `    - id: ${SKILLS}`,
    `      name: '${SKILLS}'`,
    '      config:',
    `        skillsDir: '${fwd(skillsDir)}'`,
    '',
  ].join('\n');
}

/**
 * Compose the repository layer onto a seeded profile directory (offline, file writes
 * only): both dependencies in package.json, both shim packages re-exporting the
 * repository adapters unchanged, and the cordis.patch.yml layer with both entries.
 */
export function composeProfileLayer(profileDir, repoRoot, { policyPath, skillsDir }) {
  const pkgPath = path.join(profileDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [GUARD]: '*', [SKILLS]: '*' };
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patchLayerYml({ policyPath, skillsDir }));
  const shims = {
    [GUARD]: path.join(repoRoot, 'src', 'adapters', 'dsh.mjs'),
    [SKILLS]: path.join(repoRoot, 'src', 'adapters', 'dsh-skills.mjs'),
  };
  for (const [name, adapter] of Object.entries(shims)) {
    const shim = path.join(profileDir, 'node_modules', name);
    fs.mkdirSync(shim, { recursive: true });
    fs.writeFileSync(path.join(shim, 'package.json'), `${JSON.stringify({ name, version: '0.0.0', type: 'module', main: 'index.mjs' }, null, 2)}\n`);
    fs.writeFileSync(path.join(shim, 'index.mjs'), `export * from '${pathToFileURL(adapter).href}';\n`);
  }
  return { patchPath: path.join(profileDir, 'cordis.patch.yml') };
}

/**
 * Build the OFFLINE skills store through the real chain — render-tree fixture →
 * stageRender → installSkills — with the store staged INSIDE the temp workspace at
 * <root>/workspace/skills (inside = compilable readRoots; outside = the
 * ROOT_OUTSIDE_WORKSPACE trap). The chosen skill 'review' carries the marker line in
 * its body; its frontmatter description stays generic so the injected index never
 * leaks the marker (only really reading SKILL.md yields it). Writes under `root` only.
 */
export function buildSkillsFixture(root) {
  const markerLine = buildMarkerLine();
  // Mirror of the verify-dsh-skills render-tree recipe: frontmatter first, the
  // AUTO-GENERATED banner second (the real renderer's body shape), so stageRender
  // accepts the tree and the plugin's frontmatterDescription finds the description.
  const banner = '<!-- AUTO-GENERATED from review/SKILL.md.tmpl — do not edit directly -->';
  const skills = {
    review: `---\nname: review\ndescription: Review a plan or change against repository constraints.\n---\n${banner}\n\nbody of review\n${markerLine}\n`,
    plan: `---\nname: plan\ndescription: Plan multi-step work from a written specification.\n---\n${banner}\n\nbody of plan\n`,
  };
  const rendered = path.join(root, 'rendered');
  const skillsRoot = path.join(rendered, `.${HOST}`, 'skills');
  const manifestSkills = {};
  for (const [name, body] of Object.entries(skills)) {
    const skillDir = path.join(skillsRoot, renderedDir(name));
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), body);
    manifestSkills[name] = textDigest(body);
  }
  const rootBody = `${banner}\nroot router\n`;
  const rootDir = path.join(skillsRoot, 'gstack');
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'SKILL.md'), rootBody);
  const manifestFile = path.join(root, 'render-manifests', `render-manifest-${HOST}.json`);
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, `${JSON.stringify({
    schemaVersion: 1, host: HOST, generatedBy: 'fixture gen:skill-docs', status: 'rendered-experimental',
    skills: manifestSkills, root: { path: 'gstack/SKILL.md', sha256: textDigest(rootBody) },
  }, null, 2)}\n`);
  const staging = path.join(root, 'staging');
  stageRender({ rendered, manifestFile, host: HOST, staging });
  const skillsDir = path.join(root, 'workspace', 'skills');
  const installed = installSkills({ staging, target: skillsDir });
  if (installed.installed.length !== Object.keys(skills).length + 1) { // +1: root router 'gstack'
    throw new Error(`internal: installSkills installed ${JSON.stringify(installed)} (expected ${
      Object.keys(skills).length + 1} entries including the root router)`);
  }
  const skillName = 'review';
  return { skillsDir, skillName, skillFile: path.join(skillsDir, skillName, 'SKILL.md'), markerLine };
}

// ---------------------------------------------------------------------------
// Keyed-path assembly + tasks (executed only with the key present; NOT unit-tested).
// ---------------------------------------------------------------------------

/**
 * Build the throwaway tree end to end. Seeding uses --dump-config (offline, key
 * stripped). On any throw the throwaway root is removed here and the error rethrown,
 * because main()'s finally only cleans up roots prepareVertical() returned.
 */
export function prepareVertical(repoRoot) {
  const install = dshInstall();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g861-dsh-'));
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true }); // writeRoots dir must exist before the policy ever compiles
    const seed = dsh(install, root, ['--profile', PROFILE, '--from-default-profile', 'headless', '--dump-config'], false, workspace, OFFLINE_TIMEOUT_MS);
    if (seed.status !== 0) throw new Error(`seeding profile from headless template failed (exit ${seed.status}):\n${seed.stderr || seed.stdout}`);
    const profile = path.join(root, 'home', 'profiles', PROFILE);
    const fixture = buildSkillsFixture(root); // store INSIDE workspace: readRoots=[workspace] covers it
    // Policy file OUTSIDE the workspace (POLICY_MUST_BE_OUTSIDE_WORKSPACE).
    const policyPath = path.join(root, 'policy.json');
    fs.writeFileSync(policyPath, `${JSON.stringify(policyJson({
      workspace, readRoots: [workspace], writeRoots: [path.join(workspace, 'src')],
    }), null, 2)}\n`);
    composeProfileLayer(profile, repoRoot, { policyPath, skillsDir: fixture.skillsDir });
    const targetPath = assertAbsent(freshAllowTarget(path.join(workspace, 'src')), 'allow-target');
    return { root, workspace, policyPath, targetPath, ...fixture };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Offline composition check: BOTH plugin ids + the agent stack in the dump, no patch-layer warnings. */
export function composeCheckVertical(prepared) {
  const install = dshInstall();
  const dump = dsh(install, prepared.root, ['--profile', PROFILE, '--dump-config'], false, prepared.workspace, OFFLINE_TIMEOUT_MS);
  const out = `${dump.stdout ?? ''}\n${dump.stderr ?? ''}`;
  const warnings = out.split(/\r?\n/).filter(line => /warn/i.test(line) && /gstack861|patch|cordis/i.test(line));
  return {
    ok: dump.status === 0 && dump.stdout.includes(GUARD) && dump.stdout.includes(SKILLS)
      && dump.stdout.includes('agent-default-model') && dump.stdout.includes('headless')
      && warnings.length === 0,
    detail: { status: dump.status, stdout: dump.stdout, stderr: dump.stderr, warnings },
  };
}

/** One keyed task child (danger-full-access so the gstack861 guard is the layer under test). */
function runTask(prepared, prompt, label) {
  console.log(`      launching keyed task ${label} (prompt ${prompt.length}/${PROMPT_MAX_CHARS} chars, timeout ${TASK_TIMEOUT_MS / 1000}s):`);
  console.log(`      ${prompt}`);
  const install = dshInstall();
  const child = spawnSync(install.exe, ['--expose-internals', install.cliArg, '--profile', PROFILE, '--json', prompt],
    { encoding: 'utf8', timeout: TASK_TIMEOUT_MS, cwd: prepared.workspace, maxBuffer: 32 * 1024 * 1024,
      env: { ...childEnv(prepared.root, true), DSH_PERMISSION_MODE: 'danger-full-access' } });
  console.log(`exit=${child.status} signal=${child.signal}`);
  console.log(`--- ${label} stdout ---`); console.log(child.stdout || '(empty)');
  console.log(`--- ${label} stderr ---`); console.log(child.stderr || '(empty)');
  return { status: child.status, signal: child.signal, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
}

function blocked() {
  console.log('RESULT: BLOCKED — DSH 纵向验证（技能运行时消费 + allow 路径）未执行：环境变量 DEEPSEEK_API_KEY 未设置。');
  console.log('(a) 提供密钥的方式：在环境变量中设置后重跑，例如 DEEPSEEK_API_KEY=<key> node scripts/verify-dsh-vertical.mjs');
  console.log('    （本脚本只从环境变量取密钥，绝不读取 ~/.dsh/.credentials.yaml；密钥只进子进程 env，零打印零落盘。）');
  console.log('(b) 密钥成本上限：恰好 2 个密钥任务（结构性硬编码，任务 A 技能读取 + 任务 B allow 写入），');
  console.log('    每个提示词 ≤200 字符（代码强制 throw-before-launch）。已知 caveat：每个任务的宿主可能额外');
  console.log('    发起一次 effort-off 的 session-title 微请求（headless 模板自带）；上限是 2 个任务而非 2 次请求；');
  console.log('    任务内 agentic 轮数并非硬性上限（单任务语义来自 headless 模板）。');
  console.log('(c) 版本映射注意事项（docs/integration/dsh-local-findings.md 差异清单第 7 条）：本机 DSH 安装');
  console.log('    （0.2.1-rc.3）与 upstream.lock.json 固定提交 22ddee3792402c3e70ec5f86a63c3e3e895a2f60 的');
  console.log('    对应关系未验证；升级基线前需先补 commit↔版本映射并回归本脚本。');
  console.log('(d) 本次未发生任何付费模型调用（密钥缺失即阻塞，未启动任何 DSH 进程）。');
  console.log('exit 2（blocked；0=两任务全过 / 1=失败 / 2=受阻待密钥）');
  process.exitCode = 2;
}

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) return blocked();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let prepared;
  try {
    console.log('verify-dsh-vertical: key present — isolated pipeline check: TWO paid tasks, minimal prompts (in-task agentic rounds not hard-capped; see header).');
    console.log('[1/4] building isolated DSH_HOME + headless-seeded profile + OFFLINE skills store inside the temp workspace + policy outside it...');
    prepared = prepareVertical(repoRoot);
    console.log(`      ok (throwaway root: ${prepared.root}；skills store: ${prepared.skillsDir}；~/.dsh 不被读取或写入)`);
    console.log('[2/4] offline composition check (--dump-config, key stripped): BOTH plugin ids + agent stack, no patch warnings...');
    const composed = composeCheckVertical(prepared);
    if (!composed.ok) {
      console.log(`      FAILED: exit=${composed.detail.status}`);
      if (composed.detail.warnings.length) console.log(`      patch-layer warnings: ${composed.detail.warnings.join(' | ')}`);
      console.log(composed.detail.stderr || composed.detail.stdout);
      process.exitCode = 1;
      return;
    }
    console.log('      ok (gstack861-guard + gstack861-skills composed, agent stack present)');

    console.log('[3/4] keyed task A — skills consumption: read the indexed SKILL.md, echo the marker line...');
    const promptA = checkPromptCap(buildSkillsPrompt({ skillName: prepared.skillName }), 'skills');
    const taskA = runTask(prepared, promptA, 'taskA-skills');
    const verdictA = verdictSkills({ output: `${taskA.stdout}\n${taskA.stderr}`, markerLine: prepared.markerLine });
    console.log(`      ${verdictA.ok ? 'PASS' : 'FAIL'}  ${verdictA.reason}`);
    if (!verdictA.ok && taskA.signal) console.log('      diagnosis: 任务进程被超时终止（signal），未得到完整输出。');
    if (!verdictA.ok && /did not activate/.test(taskA.stderr + taskA.stdout)) {
      console.log('      diagnosis: 插件未激活（apply() 抛错只告警且退出码仍为 0，见调研差异清单第 2 条）。');
    }

    console.log('[4/4] keyed task B — allow path: create the pre-asserted-absent file inside workspace/src...');
    const promptB = checkPromptCap(buildAllowPrompt({ targetPath: prepared.targetPath }), 'allow');
    const taskB = runTask(prepared, promptB, 'taskB-allow');
    const verdictB = verdictAllow({ targetPath: prepared.targetPath, output: `${taskB.stdout}\n${taskB.stderr}` });
    console.log(`      ${verdictB.ok ? 'PASS' : 'FAIL'}  ${verdictB.reason}`);
    if (!verdictB.ok && taskB.signal) console.log('      diagnosis: 任务进程被超时终止（signal），未得到完整输出。');
    if (!verdictB.ok && /did not activate/.test(taskB.stderr + taskB.stdout)) {
      console.log('      diagnosis: 插件未激活（apply() 抛错只告警且退出码仍为 0，见调研差异清单第 2 条）。');
    }

    const all = [['taskA-skills', verdictA], ['taskB-allow', verdictB]];
    if (all.every(([, v]) => v.ok)) {
      console.log('RESULT: PASS — both keyed tasks green: the model really read the indexed SKILL.md (marker verbatim) and the guard abstained on the in-scope write.');
      process.exitCode = 0;
    } else {
      const failed = all.filter(([, v]) => !v.ok).map(([label]) => label);
      console.log(`RESULT: FAILURE — tasks failed: ${failed.join(', ')}（真实输出见上；模型不遵循索引/未完成 allow 写入均如实计为失败。）`);
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
