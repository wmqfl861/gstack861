// Keyless DSH skill-loading plugin ACTIVATION verification. Usage: node scripts/verify-dsh-skills.mjs [--keep]
//
// Exit codes: 0 = all controls passed; 1 = failure (setup error or a control did not
// behave as required); 2 = BLOCKED (no DSH install found on this machine).
//
// What this proves (activation level, batch 10b boundary ②): the repository plugin
// src/adapters/dsh-skills.mjs loads into a REAL DSH boot through a hand-built profile
// and (positive control) ACTIVATES cleanly; (negative control 1) refuses activation on
// a corrupt skills dir — the host turns the apply() throw into a "did not activate"
// warning while still exiting 0 (findings 差异清单 item 2); (negative control 2) sits
// pending on the systemPrompt service its `inject` declaration names, proving that
// declaration is real, not decorative. What it deliberately does NOT prove: runtime
// model consumption of the injected index (blocked on boundary ①, per plan).
//
// ZERO paid model calls BY DESIGN — unlike verify-dsh-guard.mjs this script NEVER
// needs DEEPSEEK_API_KEY: every child boots TASKLESS (no task text anywhere), the
// hand-built plugin tree contains no LLM plugin (system-prompt + tools + ours only),
// telemetry is disabled, and the key is stripped from every child's environment.
// The shipped `--from-default-profile headless` template is deliberately NOT used:
// it refuses taskless startup (it demands a task), and adding a task to get around
// that would break the keyless/0-paid-call premise — so the profile is hand-built
// exactly per the findings smoke recipe (docs/integration/dsh-local-findings.md
// 受控冒烟: package.json dsh.profile.bundles:[] + dependencies, cordis.yml [], a
// `- insert:` patch layer, and a shim package re-exporting the repository adapter).
//
// The skills store the plugin validates is REAL and built OFFLINE through the
// repository chain: a mini render tree (two skills with a description line, one
// without — mirroring the test/stage.test.mjs renderOutput recipe) is staged by
// stageRender and installed by installSkills into <root>/skills-target, so the
// plugin validates a genuinely loaded registry (.gstack861-registry.json), not a
// hand-written one. Nothing outside the throwaway temp root is read or written:
// ~/.dsh is never touched (DSH_HOME and DSH_AGENTS_HOME are redirected), and the
// root is removed in finally unless --keep is passed.
//
// Version caveat (findings item 7): local install 0.2.1-rc.3 vs upstream.lock.json
// pin 22ddee3... mapping is unverified; re-baseline before upgrading the host.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stageRender } from '../src/stage.mjs';
import { installSkills } from '../src/install.mjs';
import { textDigest } from '../src/json.mjs';

const OFFLINE_TIMEOUT_MS = 180000; // taskless boot composes and mounts plugins, then exits
const PROFILE = 'g861skills';
const PLUGIN = 'gstack861-skills';
const HOST = 'dsh'; // the host this verifier exercises the skill store for
const DID_NOT_ACTIVATE = /did not activate/;
const PLUGIN_ERRED = new RegExp(`${PLUGIN}[^:\\n]*: Error:`); // "gstack861-skills (name): Error: CODE"
const PLUGIN_PENDING_SYSTEM_PROMPT = new RegExp(
  `${PLUGIN}[^:\\n]*: pending \\(waiting for service: systemPrompt\\)`);
// Mirrors the upstream renderer's dir naming exactly (gen-skill-docs.ts via
// scripts/render-upstream.mjs): already-prefixed names pass through.
const renderedDir = name => (name.startsWith('gstack-') ? name : `gstack-${name}`);

function dshInstall() {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const exe = path.join(base, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe');
  const cli = path.join(base, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh',
    'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  // cli.js lives INSIDE the asar archive: plain fs cannot see it (only the Electron-patched
  // fs of the child can), so only the executable is existence-checked.
  if (!fs.existsSync(exe)) return null;
  return { exe, cli, cliArg: cli.split(path.sep).join('/') }; // cli.js path must be C:/ style
}

const fwd = p => p.split(path.sep).join('/');

/** Isolated, permanently KEYLESS environment for a child dsh process (no DEEPSEEK_API_KEY ever). */
function childEnv(root) {
  const env = { ...process.env, DSH_HOME: fwd(path.join(root, 'home')),
    DSH_AGENTS_HOME: fwd(path.join(root, 'agents')), // keep the shared agent config root inside temp too
    DSH_TELEMETRY_DISABLED: '1', ELECTRON_RUN_AS_NODE: '1' };
  delete env.DEEPSEEK_API_KEY;
  return env;
}

/** One taskless boot: composes the profile, mounts every plugin entry, exits. No task text. */
function boot(install, root) {
  return spawnSync(install.exe, ['--expose-internals', install.cliArg, '--profile', PROFILE],
    { encoding: 'utf8', timeout: OFFLINE_TIMEOUT_MS, env: childEnv(root),
      cwd: path.join(root, 'workspace'), maxBuffer: 32 * 1024 * 1024 });
}

/**
 * Build the OFFLINE skills store through the real chain: mini render tree → stageRender
 * → installSkills → <root>/skills-target (registry-backed, exactly what a host install
 * produces). Also builds <root>/skills-corrupt, whose registry file is unparseable
 * garbage — unambiguous corruption for negative control 1.
 */
function buildSkills(root) {
  // Mirror of the test/stage.test.mjs renderOutput recipe: rendered/.<host>/skills/
  // <renderedDir(name)>/SKILL.md plus render-manifest-<host>.json. Body shapes follow
  // the REAL renderer output (gen-skill-docs.ts prepends the AUTO-GENERATED banner
  // AFTER the frontmatter block): frontmatter first, banner second. Two skills carry
  // a single-line description (the form the plugin's frontmatterDescription parses);
  // 'rawnote' has none — the plugin must still list it with an empty description
  // (only structural damage refuses activation; a missing description line is not).
  const banner = '<!-- AUTO-GENERATED from review/SKILL.md.tmpl — do not edit directly -->';
  const withDescription = (name, description) =>
    `---\nname: ${name}\ndescription: ${description}\n---\n${banner}\n\nbody of ${name}\n`;
  const withoutDescription = name => `---\nname: ${name}\n---\n${banner}\n\nbody of ${name}\n`;
  const skills = {
    review: withDescription('review', 'Review a plan or change against repository constraints.'),
    plan: withDescription('plan', 'Plan multi-step work from a written specification.'),
    rawnote: withoutDescription('rawnote'),
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
  const manifest = { schemaVersion: 1, host: HOST, generatedBy: 'fixture gen:skill-docs',
    status: 'rendered-experimental', skills: manifestSkills,
    root: { path: 'gstack/SKILL.md', sha256: textDigest(rootBody) } };
  const manifestFile = path.join(root, 'render-manifests', `render-manifest-${HOST}.json`);
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  const staging = path.join(root, 'staging');
  stageRender({ rendered, manifestFile, host: HOST, staging });
  const target = path.join(root, 'skills-target');
  const installed = installSkills({ staging, target });
  if (installed.installed.length !== Object.keys(skills).length + 1) { // +1: root router 'gstack'
    throw new Error(`internal: installSkills installed ${JSON.stringify(installed)} (expected ${
      Object.keys(skills).length + 1} entries including the root router)`);
  }

  const corrupt = path.join(root, 'skills-corrupt');
  fs.mkdirSync(corrupt, { recursive: true });
  fs.writeFileSync(path.join(corrupt, '.gstack861-registry.json'), '{ this is not valid json');
  return { target, corrupt };
}

/**
 * Write the HAND-BUILT profile (findings smoke shape — no shipped template anywhere):
 * package.json with an empty bundle list + a dependency declaring the shim package,
 * cordis.yml as the empty list, a `- insert:` patch layer with the minimal plugin
 * closure (system-prompt provides the systemPrompt service, tools closes over it,
 * then our plugin), and the shim re-exporting the repository adapter unchanged.
 * `withSystemPrompt=false` drops the system-prompt entry (negative control 2);
 * `skillsDir` selects the store the plugin entry is configured with.
 */
function writeProfile(repoRoot, root, { withSystemPrompt, skillsDir }) {
  const profile = path.join(root, 'home', 'profiles', PROFILE);
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), `${JSON.stringify({
    name: PROFILE, version: '0.0.0', private: true, type: 'module',
    dsh: { profile: { bundles: [] } }, // no shipped bundle layer: nothing task-requiring is pulled in
    dependencies: { [PLUGIN]: '*' },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(profile, 'cordis.yml'), '[]\n');
  const lines = ['- insert:'];
  if (withSystemPrompt) {
    lines.push("    - id: system-prompt", '      name: \'@deepseek-ai/dsh-system-prompt\'',
      '      config:', "        personaPrefix: ''");
  }
  lines.push('    - id: tools', "      name: '@deepseek-ai/dsh-tools'",
    `    - id: ${PLUGIN}`, `      name: '${PLUGIN}'`,
    '      config:', `        skillsDir: '${fwd(skillsDir)}'`, '');
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), lines.join('\n'));

  // Shim package re-exporting the repository plugin unchanged (findings smoke form:
  // the repo is not an installable package, so the profile loads it via re-export).
  const shim = path.join(profile, 'node_modules', PLUGIN);
  fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(path.join(shim, 'package.json'), `${JSON.stringify({
    name: PLUGIN, version: '0.0.0', type: 'module', main: 'index.mjs' }, null, 2)}\n`);
  fs.writeFileSync(path.join(shim, 'index.mjs'),
    `export * from '${pathToFileURL(path.join(repoRoot, 'src', 'adapters', 'dsh-skills.mjs')).href}';\n`);
}

/** Boot once, print the real both-stream output, return it for assertions. */
function runControl(install, root, label) {
  console.log(`--- ${label}: taskless boot (no task text, key stripped, telemetry off) ---`);
  const child = boot(install, root);
  console.log(`exit=${child.status} signal=${child.signal}`);
  console.log('--- stdout ---'); console.log(child.stdout || '(empty)');
  console.log('--- stderr ---'); console.log(child.stderr || '(empty)');
  return { status: child.status, signal: child.signal, out: `${child.stdout ?? ''}\n${child.stderr ?? ''}` };
}

function blocked(exe) {
  console.log('RESULT: BLOCKED — DSH 技能装载激活验证未执行：本机未找到 DSH 安装。');
  console.log(`(a) 期望的可执行文件：${exe}`);
  console.log('    (DeepSeek Harness Electron 桌面安装；本脚本只做无密钥的 taskless 激活验证，');
  console.log('     不需要 DEEPSEEK_API_KEY，也不会发起任何付费模型调用。)');
  console.log('(b) 版本映射注意事项（docs/integration/dsh-local-findings.md 差异清单第 7 条）：本机 DSH 安装');
  console.log('    （0.2.1-rc.3）与 upstream.lock.json 固定提交 22ddee3792402c3e70ec5f86a63c3e3e895a2f60 的');
  console.log('    对应关系未验证；升级基线前需先补 commit↔版本映射并回归本脚本。');
  console.log('exit 2（blocked；0=通过 / 1=失败 / 2=受阻）');
  process.exitCode = 2;
}

function main() {
  const keep = process.argv.includes('--keep');
  const install = dshInstall();
  if (!install) return blocked(path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
    'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g861-dsh-skills-'));
  try {
    fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
    console.log('verify-dsh-skills: keyless by design — taskless boots only, 0 paid model calls, DEEPSEEK_API_KEY stripped from every child.');
    console.log(`[1/5] building the OFFLINE skills store through the real chain (render tree → stageRender → installSkills)...`);
    const { target, corrupt } = buildSkills(root);
    console.log(`      ok (skills-target: ${target}; registry-backed, includes one skill without a description line)`);

    console.log('[2/5] POSITIVE control: full patch (system-prompt + tools + gstack861-skills), skillsDir = the real store...');
    writeProfile(repoRoot, root, { withSystemPrompt: true, skillsDir: target });
    const positive = runControl(install, root, 'positive');
    const positiveOk = positive.status === 0 && !DID_NOT_ACTIVATE.test(positive.out);
    console.log(`      ${positiveOk ? 'PASS' : 'FAIL'} (exit ${positive.status}, ${
      DID_NOT_ACTIVATE.test(positive.out) ? 'activation warning PRESENT (unexpected)' : 'no did-not-activate warning'})`);

    console.log('[3/5] NEGATIVE control 1: skillsDir = the corrupt store (unparseable registry) → apply() must throw...');
    writeProfile(repoRoot, root, { withSystemPrompt: true, skillsDir: corrupt });
    const negative1 = runControl(install, root, 'negative-1-corrupt-dir');
    const negative1Ok = negative1.status === 0 && DID_NOT_ACTIVATE.test(negative1.out)
      && PLUGIN_ERRED.test(negative1.out) && negative1.out.includes(PLUGIN);
    console.log(`      ${negative1Ok ? 'PASS' : 'FAIL'} (exit ${negative1.status}, warning names ${PLUGIN} with an Error)`);

    console.log('[4/5] NEGATIVE control 2: system-prompt entry removed → plugin must sit pending on the systemPrompt service...');
    writeProfile(repoRoot, root, { withSystemPrompt: false, skillsDir: target });
    const negative2 = runControl(install, root, 'negative-2-no-system-prompt');
    const negative2Ok = negative2.status === 0 && DID_NOT_ACTIVATE.test(negative2.out)
      && PLUGIN_PENDING_SYSTEM_PROMPT.test(negative2.out);
    console.log(`      ${negative2Ok ? 'PASS' : 'FAIL'} (exit ${negative2.status}, ${
      PLUGIN_PENDING_SYSTEM_PROMPT.test(negative2.out)
        ? 'gstack861-skills pending (waiting for service: systemPrompt) observed' : 'pending line NOT observed'})`);

    const all = [['positive', positiveOk], ['negative-1-corrupt-dir', negative1Ok],
      ['negative-2-no-system-prompt', negative2Ok]];
    console.log('[5/5] verdict:');
    for (const [label, ok] of all) console.log(`      ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    const failed = all.filter(([, ok]) => !ok).map(([label]) => label);
    if (failed.length) {
      console.log(`RESULT: FAILURE — controls did not behave as required: ${failed.join(', ')}（真实输出见上；`);
      console.log('  解读依据 docs/integration/dsh-local-findings.md 差异清单第 2 条：apply() 抛错仅告警、exit 仍为 0。）');
      process.exitCode = 1;
    } else {
      console.log('RESULT: PASS — activation-level verification green: clean taskless activation + both negative controls');
      console.log('  behaved exactly as the findings predict (throw→warning, pending→systemPrompt). Runtime model');
      console.log('  consumption of the injected index remains blocked on boundary ① (plan batch 10b, honest scope).');
      process.exitCode = 0;
    }
  } catch (error) {
    console.log(`RESULT: FAILURE — ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (keep) console.log(`cleanup skipped (--keep): inspect ${root}`);
    else {
      fs.rmSync(root, { recursive: true, force: true });
      console.log(`cleanup: removed ${root}`);
    }
  }
}

const invoked = process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invoked) main();
