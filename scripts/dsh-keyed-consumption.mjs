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
const MARKER_TAG = 'G861-C29';
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

// The two consumed skills: index descriptions are the PINNED upstream rendered
// frontmatter, byte-exact (plan RC 2; measured via `git show 5755601:<dir>/SKILL.md`).
export const CONSUMED_SKILLS = [
  { name: 'careful', description: 'Safety guardrails for destructive commands. (gstack)' },
  { name: 'design-review', description: "\"Designer's eye QA: finds visual inconsistency, spacing issues, hierarchy problems, AI slop patterns, and slow interactions — then fixes them. (gstack)\"" },
];

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

/** Build the skills store with BOTH consumed skills + the gstack root router (3 index entries). */
export function buildConsumptionFixture(root) {
  const markers = CONSUMED_SKILLS.map(() => buildMarkerLine());
  const banner = name => `<!-- AUTO-GENERATED from ${name}/SKILL.md.tmpl — do not edit directly -->`;
  const rendered = path.join(root, 'rendered');
  const skillsRoot = path.join(rendered, `.${HOST}`, 'skills');
  const manifestSkills = {};
  CONSUMED_SKILLS.forEach((skill, index) => {
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
  if (installed.installed.length !== CONSUMED_SKILLS.length + 1) {
    throw new Error(`internal: installSkills installed ${JSON.stringify(installed.installed)} (expected ${CONSUMED_SKILLS.length + 1} incl. root router)`);
  }
  return {
    skillsDir,
    entries: CONSUMED_SKILLS.map((skill, index) => ({
      ...skill, markerLine: markers[index], skillFile: path.join(skillsDir, skill.name, 'SKILL.md'),
    })),
  };
}

function blocked() {
  console.log('RESULT: BLOCKED — DSH 键控消费执行器（careful + design-review）未执行：DEEPSEEK_API_KEY 未设置。');
  console.log('(a) 用法：DEEPSEEK_API_KEY=<key> node scripts/dsh-keyed-consumption.mjs');
  console.log('(b) 密钥成本上限：恰 2 个计费任务（每技能一个，≤200 字符 throw-before-launch）；应急上限 3（本批历史：UNMAPPED_TOOL 诚实失败复跑后实花 4，第三十九轮如实记录）。');
  console.log('(c) 判据=批次 12 任务 A 同款（marker verbatim + 零码）；合成 fixture 链路切片，非 15 例方法论消费（计划 RC4）。');
  console.log('exit 2（blocked；0=两技能均消费 / 1=失败 / 2=受阻）');
  process.exitCode = 2;
}

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) return blocked();
  let prepared;
  try {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    console.log('dsh-keyed-consumption: key present — 2 paid tasks (careful + design-review via index→read).');
    console.log('[1/4] scaffold: headless-seeded dual-plugin profile + 3-entry skills store + policy + journal state...');
    prepared = prepareConsumption(repoRoot);
    console.log(`      ok (root: ${prepared.root}；3 index entries incl. root router)`);
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
      console.log(`[3/4 task ${index + 1}/2] keyed consumption of ${entry.name} — journal create→start, then the task...`);
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
    console.log('[4/4] journal check BEFORE cleanup: exactly 2 records, terminal-correct...');
    const list = journalRun(['tasks', 'list', '--state', prepared.subject.stateDir], 'list', a => Array.isArray(a));
    if (list.length !== 2) throw new Error(`JOURNAL count ${list.length} != 2`);
    for (const outcome of outcomes) {
      const record = list.find(r => r.id === outcome.id);
      if (!record || record.state !== (outcome.verdict.ok ? 'completed' : 'failed')) throw new Error(`JOURNAL ${outcome.name} wrong state`);
      const expectedHash = subjectDigest(subjectFor({ ...prepared.subject, actionFile: path.join(prepared.root, `action-consume-${outcome.name}.json`) }));
      if (record.subjectHash !== expectedHash) throw new Error(`JOURNAL ${outcome.name} subjectHash does not match its action file`);
    }
    console.log(`      ok (${outcomes.map(o => `${o.name}=${o.verdict.ok ? 'consumed' : o.verdict.code}`).join(', ')})`);
    if (outcomes.every(o => o.verdict.ok)) {
      console.log('RESULT: PASS — both skills consumed via index→read (marker verbatim, zero codes); journaled completed x2.');
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

function prepareConsumption(repoRoot) {
  const install = dshInstall();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g861c29-'));
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    const seed = dsh(install, root, ['--profile', PROFILE, '--from-default-profile', 'headless', '--dump-config'], false, workspace, OFFLINE_TIMEOUT_MS);
    if (seed.status !== 0) throw new Error(`seeding failed (exit ${seed.status}): ${seed.stderr || seed.stdout}`);
    const profile = path.join(root, 'home', 'profiles', PROFILE);
    const fixture = buildConsumptionFixture(root);
    const policyPath = path.join(root, 'policy.json');
    fs.writeFileSync(policyPath, `${JSON.stringify(policyJson({
      workspace, readRoots: [workspace], writeRoots: [path.join(workspace, 'src')],
    }), null, 2)}\n`);
    composeProfileLayer(profile, repoRoot, { policyPath, skillsDir: fixture.skillsDir });
    return {
      root, workspace, install, policyPath,
      subject: {
        stateDir: path.join(root, 'tasks-state'),
        sessionId: `c29-${randomBytes(4).toString('hex')}`,
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
