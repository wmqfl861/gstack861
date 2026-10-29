// Batch 29: DSH keyed consumption of the careful (security group) and
// design-review (design group) skills — OFFLINE-COMPLETE §一5.
//
// Standard: batch-12 task A (marker verbatim + zero gstack861 codes). This is a
// CAPABILITY-SLICE consumption via a synthetic fixture (load → index injection →
// real model read), NOT the 15-case methodology consumption of real rendered
// bodies — those two runs are NOT added to that count (plan RC 4 wording).
//
// Two keyed tasks, each consuming one skill; each journaled through the REAL
// tasks CLI (new machinery per plan RC 3 — the vertical template has none of it;
// precedent dsh-mini-vertical: per-task action file, state dir outside the
// workspace, loadPolicy real hash).
//
// KEY HANDLING: identical to verify-dsh-vertical.mjs (env-only, keyed children
// only, offline children stripped). Prompts ≤200 chars throw-before-launch.
// Exit 0 = both consumed; 1 = failure; 2 = BLOCKED (no key).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from '../src/policy.mjs';
import { subjectDigest } from '../src/approvals.mjs';


const PROFILE = 'g861cons';
const GUARD = 'gstack861-guard';
const SKILLS = 'gstack861-skills';
const HOST = 'dsh';
const MARKER_TAG = 'G861-C30';
export const PROMPT_MAX_CHARS = 200;
const OFFLINE_TIMEOUT_MS = 180000;
const TASK_TIMEOUT_MS = 300000;
const fwd = p => p.split(/[\\/]/).join('/');
const renderedDir = name => (name.startsWith('gstack-') ? name : `gstack-${name}`);

// Local runner helpers (template bodies are module-private in verify-dsh-vertical.mjs)
function dshInstall() {
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const exe = path.join(base, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe');
  if (!fs.existsSync(exe)) throw new Error(`DSH executable not found: ${exe}`);
  const cli = path.join(base, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh',
    'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  return { exe, cli, cliArg: cli.split(path.sep).join('/') };
}
function childEnv(root, keyed) {
  const env = { ...process.env, DSH_HOME: fwd(path.join(root, 'home')),
    DSH_AGENTS_HOME: fwd(path.join(root, 'agents')), DSH_TELEMETRY_DISABLED: '1', ELECTRON_RUN_AS_NODE: '1' };
  if (!keyed) delete env.DEEPSEEK_API_KEY;
  return env;
}
function dsh(install, root, args, keyed, cwd, timeoutMs) {
  return spawnSync(install.exe, ['--expose-internals', install.cliArg, ...args],
    { encoding: 'utf8', timeout: timeoutMs, env: childEnv(root, keyed), cwd, maxBuffer: 32 * 1024 * 1024 });
}

// The §一5 whitelist: every consumable skill with its PINNED upstream rendered
// frontmatter description, byte-exact (plan RC 2; `git show 5755601:<dir>/SKILL.md`).
// Whitelist = the keys; a name without a pinned description cannot be consumed.
export const SKILL_WHITELIST = {
  careful: 'Safety guardrails for destructive commands. (gstack)',
  freeze: 'Restrict file edits to a specific directory for the session. (gstack)',
  cso: '"Security audit: supported static findings; qualified profiles add reproduction and repair candidates. (gstack)"',
  'design-review': "\"Designer's eye QA: finds visual inconsistency, spacing issues, hierarchy problems, AI slop patterns, and slow interactions — then fixes them. (gstack)\"",
  'design-consultation': '"Design consultation: understands your product, researches the landscape, proposes a complete design system (aesthetic, typography, color, layout, spacing, motion), and generates font+color preview... (gstack)"',
  'design-shotgun': '"Design shotgun: generate multiple AI design variants, open a comparison board, collect structured feedback, and iterate. (gstack)"',
  'design-html': '"Design finalization: generates production-quality Pretext-native HTML/CSS. (gstack)"',
  'devex-review': 'Live developer experience audit. (gstack)',
};
// Batch-29 default (order load-bearing: tests pin entries[0]=careful).
export const DEFAULT_CONSUMED_SKILLS = ['careful', 'design-review'];
// Back-compat alias for the batch-29 shape (name+description objects).
export const CONSUMED_SKILLS = DEFAULT_CONSUMED_SKILLS.map(name => ({ name, description: SKILL_WHITELIST[name] }));

/**
 * Parse + validate a --skills spec (plan RC 2): rejects unknown names, empty
 * entries and DUPLICATES (a duplicate would overwrite the same SKILL.md in the
 * fixture and guarantee a paid MARKER_NOT_VERBATIM). Absent spec → the default
 * list; present-but-empty → rejection, never a silent default.
 */
export function resolveSkills(spec) {
  if (spec === undefined) return DEFAULT_CONSUMED_SKILLS.map(name => ({ name, description: SKILL_WHITELIST[name] }));
  const names = String(spec).split(',').map(s => s.trim());
  if (names.some(n => n === '')) throw new Error('INVALID_SKILLS_SPEC empty entry (present-but-empty is rejected, not defaulted)');
  const seen = new Set();
  for (const name of names) {
    if (!Object.hasOwn(SKILL_WHITELIST, name)) throw new Error(`UNKNOWN_SKILL ${name} (whitelist: ${Object.keys(SKILL_WHITELIST).join(', ')})`);
    if (seen.has(name)) throw new Error(`DUPLICATE_SKILL ${name} (would overwrite the same fixture SKILL.md)`);
    seen.add(name);
  }
  return names.map(name => ({ name, description: SKILL_WHITELIST[name] }));
}

// ---------------------------------------------------------------------------
// Pure helpers (offline unit tests).
// ---------------------------------------------------------------------------

export function buildMarkerLine() {
  return `${MARKER_TAG}-${randomBytes(4).toString('hex')}: ${randomBytes(5).toString('hex')}-${randomBytes(5).toString('hex')}`;
}
import { randomBytes } from 'node:crypto';

/** Prompt per skill (batch-12 task A form): pin the read TOOL (batch-13 UNMAPPED_TOOL lesson). */
export function buildConsumptionPrompt({ skillName }) {
  return `Use the read tool to read the SKILL.md of skill ${skillName} from the gstack861 skills index, then output verbatim the line containing ${MARKER_TAG}.`;
}

export function checkPromptCap(prompt, label) {
  if (prompt.length > PROMPT_MAX_CHARS) {
    throw new Error(`PROMPT_TOO_LONG ${label} prompt is ${prompt.length} chars > ${PROMPT_MAX_CHARS} (refusing to launch)`);
  }
  return prompt;
}

export function parseGstackCodes(text) {
  return [...new Set((text ?? '').match(/gstack861:[A-Z][A-Z0-9_]*/g) ?? [])];
}

/**
 * Consumption verdict (plan RC 5 detection basis):
 * PASS | MARKER_NOT_VERBATIM (marker absent; the batch-12 honest fail) |
 * SKILL_NOT_IN_INDEX (no read tool_call in the stream targeted the SKILL.md path
 * AND the marker is absent — zero-consumption shape, distinguishable from a
 * read-but-garbled echo) | GUARD_CODES_PRESENT.
 */
export function verdictConsumption({ output, events, markerLine, skillFile }) {
  const codes = parseGstackCodes(output);
  if (codes.length) return { ok: false, code: 'GUARD_CODES_PRESENT', reason: `guard codes: ${codes.join(', ')}` };
  const markerSeen = String(output ?? '').includes(markerLine);
  const readHappened = (events ?? []).some(e => e?.type === 'tool_call' && /read/i.test(String(e?.tool ?? ''))
    && fwd(String(e?.input?.file_path ?? '')) === fwd(skillFile ?? '\u0000nonexistent'));
  if (!markerSeen && !readHappened) {
    return { ok: false, code: 'SKILL_NOT_IN_INDEX', reason: 'the stream shows no read of the SKILL.md and the marker never appeared — the model did not consume the skill' };
  }
  if (!markerSeen) {
    return { ok: false, code: 'MARKER_NOT_VERBATIM', reason: `marker line not echoed verbatim (expected: ${markerLine})` };
  }
  return { ok: true, code: 'PASS', reason: `marker line verbatim: ${markerLine}` };
}

/** Parse the --json event stream (same tolerant line parser as prior verticals). */
export function parseEvents(text) {
  const events = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event && typeof event === 'object' && typeof event.type === 'string') events.push(event);
    } catch { /* noise */ }
  }
  return events;
}

/** tasks CLI vector (host=dsh subject block — dsh-mini-vertical's tasksArgs shape). */
export function consumptionTasksArgs({ sub, stateDir, sessionId, runId, policyHash, actionFile, id }) {
  const args = ['tasks', sub, '--state', stateDir, '--host', 'dsh',
    '--session', sessionId, '--run', runId, '--policy-hash', policyHash, '--action-file', actionFile];
  if (id !== undefined) args.push('--id', id);
  return args;
}

export function writeActionFile(root, { phase, task }) {
  const file = path.join(root, `action-${phase}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ phase, task }, null, 2)}\n`);
  return file;
}

export function subjectFor({ sessionId, runId, policyHash, actionFile }) {
  return { host: 'dsh', sessionId, runId, policyHash, action: JSON.parse(fs.readFileSync(actionFile, 'utf8')) };
}

// ---------------------------------------------------------------------------
// Fixture + keyed choreography (template: verify-dsh-vertical prepareVertical;
// new: per-skill fixtures from CONSUMED_SKILLS + tasks-CLI journaling).
// ---------------------------------------------------------------------------

import { stageRender } from '../src/stage.mjs';
import { installSkills } from '../src/install.mjs';
import { textDigest } from '../src/json.mjs';
import { policyJson, composeProfileLayer } from './verify-dsh-vertical.mjs';

/** Offline composition check (same shape as the template's, for THIS profile name). */
function composeCheckConsumption(prepared) {
  const dump = dsh(prepared.install, prepared.root, ['--profile', PROFILE, '--dump-config'], false, prepared.workspace, OFFLINE_TIMEOUT_MS);
  const out = `${dump.stdout ?? ''}\n${dump.stderr ?? ''}`;
  const warnings = out.split(/\r?\n/).filter(line => /warn/i.test(line) && /gstack861|patch|cordis/i.test(line));
  return {
    ok: dump.status === 0 && dump.stdout.includes(GUARD) && dump.stdout.includes(SKILLS)
      && dump.stdout.includes('agent-default-model') && dump.stdout.includes('headless') && warnings.length === 0,
    detail: { status: dump.status, warnings, stderr: (dump.stderr ?? '').slice(0, 500), stdout: (dump.stdout ?? '').slice(0, 2000) },
  };
}

/** Build the skills store with the consumed skills + the gstack root router (N+1 index entries). */
export function buildConsumptionFixture(root, skills = CONSUMED_SKILLS) {
  const markers = skills.map(() => buildMarkerLine());
  const banner = name => `<!-- AUTO-GENERATED from ${name}/SKILL.md.tmpl — do not edit directly -->`;
  const rendered = path.join(root, 'rendered');
  const skillsRoot = path.join(rendered, `.${HOST}`, 'skills');
  const manifestSkills = {};
  skills.forEach((skill, index) => {
    const skillDir = path.join(skillsRoot, renderedDir(skill.name));
    fs.mkdirSync(skillDir, { recursive: true });
    const body = `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${banner(skill.name)}\n\nbody of ${skill.name}\n${markers[index]}\n`;
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), body);
    manifestSkills[skill.name] = textDigest(body);
  });
  const rootBody = `${banner('gstack')}\nroot router\n`;
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
  if (installed.installed.length !== skills.length + 1) {
    throw new Error(`internal: installSkills installed ${JSON.stringify(installed.installed)} (expected ${skills.length + 1} incl. root router)`);
  }
  return {
    skillsDir,
    entries: skills.map((skill, index) => ({
      ...skill, markerLine: markers[index], skillFile: path.join(skillsDir, skill.name, 'SKILL.md'),
    })),
  };
}

function blocked(skills) {
  const names = skills.map(s => s.name).join(', ');
  console.log(`RESULT: BLOCKED — DSH 键控消费执行器（${names}）未执行：DEEPSEEK_API_KEY 未设置。`);
  console.log('(a) 用法：DEEPSEEK_API_KEY=<key> node scripts/dsh-keyed-consumption.mjs [--skills a,b]（缺省=careful,design-review；白名单见 SKILL_WHITELIST）');
  console.log(`(b) 密钥成本上限：恰 ${skills.length} 个计费任务（每技能一个，≤200 字符 throw-before-launch）；应急上限 ${skills.length + 1}（前批历史：批次 29 UNMAPPED_TOOL 诚实失败复跑后实花 4，第三十九轮如实记录）。`);
  console.log('(c) 判据=批次 12 任务 A 同款（marker verbatim + 零码）；合成 fixture 链路切片，非 15 例方法论消费（计划 RC4）。');
  console.log('exit 2（blocked；0=全部消费 / 1=失败 / 2=受阻）');
  process.exitCode = 2;
}

async function main() {
  // Skill resolution BEFORE the key gate (plan RC 2): typos fail keylessly.
  const specIndex = process.argv.indexOf('--skills');
  try {
    var skills = resolveSkills(specIndex >= 0 ? process.argv[specIndex + 1] : undefined);
  } catch (error) {
    console.log(`RESULT: FAILURE — ${error.message}`);
    process.exitCode = 1; // rejected BEFORE the key gate: typos fail keylessly (plan RC 2)
    return;
  }
  if (!process.env.DEEPSEEK_API_KEY) return blocked(skills);
  let prepared;
  try {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    console.log(`dsh-keyed-consumption: key present — ${skills.length} paid tasks (${skills.map(s => s.name).join(' + ')} via index→read).`);
    console.log(`[1/4] scaffold: headless-seeded dual-plugin profile + ${skills.length + 1}-entry skills store + policy + journal state...`);
    prepared = prepareConsumption(repoRoot, skills);
    console.log(`      ok (root: ${prepared.root}；${prepared.entries.length + 1} index entries incl. root router)`);
    console.log('[2/4] offline composition check...');
    const composed = composeCheckConsumption(prepared);
    if (!composed.ok) {
      console.log(`      FAILED: exit=${composed.detail.status}`);
      process.exitCode = 1;
      return;
    }
    console.log('      ok (both plugins composed, agent stack present)');

    const cli = args => {
      const r = spawnSync(process.execPath, [path.join(repoRoot, 'bin/gstack861.mjs'), ...args],
        { encoding: 'utf8', timeout: 30000, cwd: repoRoot, env: (() => { const e = { ...process.env }; delete e.DEEPSEEK_API_KEY; return e; })() });
      let parsed = null;
      if (r.status === 0) { try { parsed = JSON.parse(r.stdout); } catch { parsed = null; } }
      return { status: r.status, parsed, stderr: r.stderr ?? '' };
    };
    const journalRun = (args, label, ok) => {
      const r = cli(args);
      if (r.status !== 0 || !ok(r.parsed)) throw new Error(`TASKS_CLI_FAILED ${label}: exit=${r.status} stderr=${r.stderr.slice(0, 200)}`);
      return r.parsed;
    };
    const outcomes = [];
    for (const [index, entry] of prepared.entries.entries()) {
      console.log(`[3/4 task ${index + 1}/${prepared.entries.length}] keyed consumption of ${entry.name} — journal create→start, then the task...`);
      const prompt = checkPromptCap(buildConsumptionPrompt({ skillName: entry.name }), `consume-${entry.name}`);
      const subject = { ...prepared.subject, actionFile: writeActionFile(prepared.root, { phase: `consume-${entry.name}`, task: entry.name }) };
      const create = journalRun(consumptionTasksArgs({ ...subject, sub: 'create' }), `create ${entry.name}`, v => typeof v === 'string' && v.length > 0);
      journalRun(consumptionTasksArgs({ ...subject, sub: 'start', id: create }), `start ${entry.name}`, r => r?.state === 'running');
      // DSH_PERMISSION_MODE=danger-full-access: family convention — approval becomes
      // 'never' and the pre-execute layer allows, so the gstack861 guard is the only
      // layer whose abstain/deny the verdict observes (verify-dsh-vertical runTask rationale).
      const task = spawnSync(prepared.install.exe, ['--expose-internals', prepared.install.cliArg, '--profile', PROFILE, '--json', prompt],
        { encoding: 'utf8', timeout: TASK_TIMEOUT_MS, cwd: prepared.workspace, maxBuffer: 32 * 1024 * 1024,
          env: { ...childEnv(prepared.root, true), DSH_PERMISSION_MODE: 'danger-full-access' } });
      const events = parseEvents(`${task.stdout}\n${task.stderr}`);
      const verdict = verdictConsumption({ output: `${task.stdout}\n${task.stderr}`, events, markerLine: entry.markerLine, skillFile: entry.skillFile });
      console.log(`      ${verdict.ok ? 'PASS' : 'FAIL'}  ${verdict.code}: ${verdict.reason}`);
      const terminal = verdict.ok ? 'complete' : 'fail';
      journalRun(consumptionTasksArgs({ ...subject, sub: terminal, id: create }), `${terminal} ${entry.name}`, r => r?.state === (verdict.ok ? 'completed' : 'failed'));
      outcomes.push({ name: entry.name, id: create, verdict });
    }
    console.log(`[4/4] journal check BEFORE cleanup: exactly ${prepared.entries.length} records, terminal-correct...`);
    const list = journalRun(['tasks', 'list', '--state', prepared.subject.stateDir], 'list', a => Array.isArray(a));
    if (list.length !== prepared.entries.length) throw new Error(`JOURNAL count ${list.length} != ${prepared.entries.length}`);
    for (const outcome of outcomes) {
      const record = list.find(r => r.id === outcome.id);
      if (!record || record.state !== (outcome.verdict.ok ? 'completed' : 'failed')) throw new Error(`JOURNAL ${outcome.name} wrong state`);
      const expectedHash = subjectDigest(subjectFor({ ...prepared.subject, actionFile: path.join(prepared.root, `action-consume-${outcome.name}.json`) }));
      if (record.subjectHash !== expectedHash) throw new Error(`JOURNAL ${outcome.name} subjectHash does not match its action file`);
    }
    console.log(`      ok (${outcomes.map(o => `${o.name}=${o.verdict.ok ? 'consumed' : o.verdict.code}`).join(', ')})`);
    if (outcomes.every(o => o.verdict.ok)) {
      console.log(`RESULT: PASS — all ${prepared.entries.length} skills consumed via index→read (marker verbatim, zero codes); journaled completed x${prepared.entries.length}.`);
      process.exitCode = 0;
    } else {
      console.log(`RESULT: FAILURE — ${outcomes.filter(o => !o.verdict.ok).map(o => `${o.name}(${o.verdict.code})`).join(', ')}（如实记账）`);
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

function prepareConsumption(repoRoot, skills) {
  const install = dshInstall();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g861c30-'));
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    const seed = dsh(install, root, ['--profile', PROFILE, '--from-default-profile', 'headless', '--dump-config'], false, workspace, OFFLINE_TIMEOUT_MS);
    if (seed.status !== 0) throw new Error(`seeding failed (exit ${seed.status}): ${seed.stderr || seed.stdout}`);
    const profile = path.join(root, 'home', 'profiles', PROFILE);
    const fixture = buildConsumptionFixture(root, skills);
    const policyPath = path.join(root, 'policy.json');
    fs.writeFileSync(policyPath, `${JSON.stringify(policyJson({
      workspace, readRoots: [workspace], writeRoots: [path.join(workspace, 'src')],
    }), null, 2)}\n`);
    composeProfileLayer(profile, repoRoot, { policyPath, skillsDir: fixture.skillsDir });
    return {
      root, workspace, install, policyPath,
      subject: {
        stateDir: path.join(root, 'tasks-state'),
        sessionId: `c30-${randomBytes(4).toString('hex')}`,
        runId: `c2${randomBytes(3).toString('hex')}`,
        policyHash: loadPolicy(policyPath).policyHash,
        // actionFile is supplied per-task in main() — a missing override would
        // crash the CLI with INVALID_ARGUMENTS rather than silently journaling.
      },
      ...fixture,
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

const invoked = process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invoked) await main();
