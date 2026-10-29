// Offline tests for the batch-29 keyed consumption script. The KEYED path runs
// only under the coordinator; these never launch DSH. Coverage: pinned upstream
// frontmatter (byte-exact), fixture shape (3 index entries incl. root router),
// prompts under the 200 cap, verdict codes incl. the RC-5 SKILL_NOT_IN_INDEX
// detection basis, tasks-CLI vector discipline, and the keyless exit-2 gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  CONSUMED_SKILLS, DEFAULT_CONSUMED_SKILLS, SKILL_WHITELIST, resolveSkills, PROMPT_MAX_CHARS, buildConsumptionFixture, buildConsumptionPrompt,
  buildMarkerLine, checkPromptCap, consumptionTasksArgs, parseEvents, parseGstackCodes,
  verdictConsumption, writeActionFile,
} from '../scripts/dsh-keyed-consumption.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function base(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-c30-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('CONSUMED_SKILLS: names exist at the pinned upstream; descriptions byte-match the rendered frontmatter', () => {
  for (const skill of CONSUMED_SKILLS) {
    const rendered = execFileSync('git', ['-C', path.join(repoRoot, 'upstream', 'gstack'), 'show', `5755601:${skill.name}/SKILL.md`], { encoding: 'utf8' });
    const desc = rendered.split('\n').find(l => l.startsWith('description:'));
    assert.ok(desc, `${skill.name}: description line exists at the pin`);
    // Our fixture embeds the value INCLUDING the surrounding quotes for design-review.
    const value = desc.replace(/^description:[ ]?/, '');
    assert.equal(skill.description, value, `${skill.name}: byte-exact description (plan RC 2)`);
  }
});

test('buildConsumptionFixture: real chain install of 2 skills + root router; markers unguessable and NOT in frontmatter', (t) => {
  const root = base(t);
  const fixture = buildConsumptionFixture(root);
  assert.equal(fixture.entries.length, 2);
  assert.ok(fs.existsSync(path.join(fixture.skillsDir, 'gstack', 'SKILL.md')), 'root router installed (3rd index entry)');
  for (const entry of fixture.entries) {
    const text = fs.readFileSync(entry.skillFile, 'utf8');
    assert.match(text, new RegExp(`^name: ${entry.name}$`, 'm'));
    assert.ok(text.includes(entry.markerLine), `${entry.name}: marker in the body`);
    assert.ok(!text.split('---')[1].includes(entry.markerLine.split(': ')[0].slice(-12)), 'marker tag never in frontmatter (index cannot leak it)');
    assert.notEqual(entry.markerLine, buildMarkerLine(), 'markers are random per build');
  }
});

test('prompts pin the named skill and stay under the cap at a realistic temp root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const skill of CONSUMED_SKILLS) {
    const prompt = buildConsumptionPrompt({ skillName: skill.name });
    assert.ok(prompt.startsWith('Use the read tool'), 'pin the tool choice: keyed run 1 hit UNMAPPED_TOOL on model drift (batch-13 lesson)');
    assert.ok(prompt.includes(skill.name), `${skill.name}: names the skill`);
    assert.ok(prompt.length <= PROMPT_MAX_CHARS, `${skill.name}: ${prompt.length} chars`);
    checkPromptCap(prompt, `consume-${skill.name}`);
  }
});

test('verdictConsumption: PASS / MARKER_NOT_VERBATIM / SKILL_NOT_IN_INDEX / GUARD_CODES_PRESENT shapes', (t) => {
  const root = base(t);
  const fixture = buildConsumptionFixture(root);
  const [careful] = fixture.entries;
  const readCall = { type: 'tool_call', tool: 'read', input: { file_path: careful.skillFile } };
  // PASS: marker verbatim, a real read observed.
  assert.equal(verdictConsumption({ output: `intro\n${careful.markerLine}\n`, events: [readCall], markerLine: careful.markerLine, skillFile: careful.skillFile }).code, 'PASS');
  // Marker absent BUT a read happened: read-but-garbled echo.
  assert.equal(verdictConsumption({ output: 'i read it but forgot the line', events: [readCall], markerLine: careful.markerLine, skillFile: careful.skillFile }).code, 'MARKER_NOT_VERBATIM');
  // Marker absent AND no read targeting the file: zero-consumption shape (RC 5).
  const otherRead = { type: 'tool_call', tool: 'read', input: { file_path: path.join(root, 'other.md') } };
  assert.equal(verdictConsumption({ output: 'no idea', events: [otherRead], markerLine: careful.markerLine, skillFile: careful.skillFile }).code, 'SKILL_NOT_IN_INDEX');
  assert.equal(verdictConsumption({ output: 'nothing', events: [], markerLine: careful.markerLine, skillFile: careful.skillFile }).code, 'SKILL_NOT_IN_INDEX');
  // Windows-style path echo from the model still counts as the read.
  const winRead = { type: 'tool_call', tool: 'Read', input: { file_path: careful.skillFile.split('/').join('\\') } };
  assert.equal(verdictConsumption({ output: careful.markerLine, events: [winRead], markerLine: careful.markerLine, skillFile: careful.skillFile }).code, 'PASS');
  // Guard codes outrank everything.
  assert.equal(verdictConsumption({ output: `${careful.markerLine} gstack861:OUTSIDE_SCOPE`, events: [readCall], markerLine: careful.markerLine, skillFile: careful.skillFile }).code, 'GUARD_CODES_PRESENT');
});

test('parseEvents: typed JSON lines, tolerant of noise and tool_input deltas', () => {
  const events = parseEvents([
    'noise',
    '{"type":"tool_call","tool":"read","input":{"file_path":"C:/x/SKILL.md"}}',
    'not json',
    '{"type":"final","text":"done"}',
  ].join('\n'));
  assert.deepEqual(events.map(e => e.type), ['tool_call', 'final']);
  assert.deepEqual(parseEvents(''), []);
});

test('consumptionTasksArgs: identical host=dsh subject block; --id only on non-create', () => {
  const common = { stateDir: 'C:/s', sessionId: 'si', runId: 'r', policyHash: 'a'.repeat(64), actionFile: 'C:/a.json' };
  const create = consumptionTasksArgs({ ...common, sub: 'create' });
  assert.deepEqual(create, ['tasks', 'create', '--state', 'C:/s', '--host', 'dsh', '--session', 'si', '--run', 'r', '--policy-hash', 'a'.repeat(64), '--action-file', 'C:/a.json']);
  for (const sub of ['start', 'complete', 'fail']) {
    assert.deepEqual(consumptionTasksArgs({ ...common, sub, id: 'id-1' }),
      ['tasks', sub, ...create.slice(2), '--id', 'id-1'], `${sub} carries the identical block plus --id`);
  }
});

test('writeActionFile: one stable {phase,task} file per skill', (t) => {
  const root = base(t);
  const a = writeActionFile(root, { phase: 'consume-careful', task: 'careful' });
  const b = writeActionFile(root, { phase: 'consume-design-review', task: 'design-review' });
  assert.notEqual(a, b);
  assert.deepEqual(JSON.parse(fs.readFileSync(a, 'utf8')), { phase: 'consume-careful', task: 'careful' });
});

test('resolveSkills: absent=defaults (order pinned); unknown/empty/duplicate rejected; freeze,cso resolves byte-pinned', () => {
  const def = resolveSkills(undefined);
  assert.deepEqual(def.map(s => s.name), DEFAULT_CONSUMED_SKILLS, 'default order load-bearing (entries[0]=careful)');
  assert.equal(def[0].name, 'careful');
  assert.equal(resolveSkills('freeze,cso').map(s => s.name).join(','), 'freeze,cso');
  assert.equal(resolveSkills('freeze,cso')[0].description, SKILL_WHITELIST.freeze);
  assert.throws(() => resolveSkills('freeze,'), /INVALID_SKILLS_SPEC/);
  assert.throws(() => resolveSkills(''), /INVALID_SKILLS_SPEC/);
  assert.throws(() => resolveSkills('careful,careful'), /DUPLICATE_SKILL/);
  assert.throws(() => resolveSkills('nonexistent'), /UNKNOWN_SKILL/);
});

test('WHITELIST: every entry byte-matches the pinned upstream rendered frontmatter', () => {
  for (const [name, description] of Object.entries(SKILL_WHITELIST)) {
    const rendered = execFileSync('git', ['-C', path.join(repoRoot, 'upstream', 'gstack'), 'show', `5755601:${name}/SKILL.md`], { encoding: 'utf8' });
    const desc = rendered.split('\n').find(l => l.startsWith('description:'));
    assert.equal(description, desc.replace(/^description:[ ]?/, ''), `${name}: byte-exact`);
  }
});

test('fixture parameterization: --skills freeze,cso builds a 3-entry store with the right markers', (t) => {
  const root = base(t);
  const skills = resolveSkills('freeze,cso');
  const fixture = buildConsumptionFixture(root, skills);
  assert.equal(fixture.entries.length, 2);
  assert.equal(fixture.entries[0].name, 'freeze');
  assert.equal(fixture.entries[1].name, 'cso');
  assert.ok(fs.existsSync(path.join(fixture.skillsDir, 'gstack', 'SKILL.md')), 'root router (3rd entry)');
  for (const entry of fixture.entries) {
    const text = fs.readFileSync(entry.skillFile, 'utf8');
    assert.ok(text.includes(entry.markerLine));
    assert.match(text, new RegExp(`^name: ${entry.name}$`, 'm'));
  }
});

test('invalid --skills fails BEFORE the key gate (keyless exit 1 with the rejection)', () => {
  const child = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/dsh-keyed-consumption.mjs'), '--skills', 'typo'], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, DEEPSEEK_API_KEY: '' },
  });
  assert.equal(child.status, 1);
  assert.match(child.stdout, /UNKNOWN_SKILL/);
}, { timeout: 120000 });

test('--skills present without a value exits 1 keylessly (never silently defaults)', () => {
  const child = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/dsh-keyed-consumption.mjs'), '--skills'], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, DEEPSEEK_API_KEY: '' },
  });
  assert.equal(child.status, 1);
  assert.match(child.stdout, /INVALID_SKILLS_SPEC/);
}, { timeout: 120000 });

test('keyless invocation: exits 2 (BLOCKED) without touching DSH', () => {
  const child = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/dsh-keyed-consumption.mjs')], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, DEEPSEEK_API_KEY: '' },
  });
  assert.equal(child.status, 2);
  assert.match(child.stdout, /BLOCKED/);
  assert.match(child.stdout, /DEEPSEEK_API_KEY/);
}, { timeout: 120000 });
