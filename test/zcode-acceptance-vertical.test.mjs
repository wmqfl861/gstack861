// Offline unit tests for the batch-25 zcode acceptance vertical. The KEYED
// path (real headless zcode spawns) runs only under the coordinator with
// ZCODE_ACCEPTANCE_KEY=1; these tests never spawn ZCode. Coverage per the
// plan-review rulings: the .zcode/config.json merge target (NOT settings.json),
// the HOOK_TRUST_PENDING distinct classification, prompt caps via the shared
// checkPromptCap, marker fixture shape, verdictGuard shapes, stream parser,
// host=zcode CLI vectors, and the keyless exit-2 gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkPromptCap } from '../scripts/verify-dsh-robustness.mjs';
import {
  markerSkillDir, buildMarkerLine, writeMarkerSkill, mergeHookConfig,
  buildPickupPrompt, buildGuardPrompt, verdictGuard, parseStream, zcodeTasksArgs,
} from '../scripts/zcode-acceptance-vertical.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function base(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-zc-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('marker skill fixture: unguessable line, description present, unlikely name', (t) => {
  const root = base(t);
  const workspace = path.join(root, 'workspace');
  const line = buildMarkerLine();
  assert.match(line, /^G861-ZC-[0-9a-f]{8}: [0-9a-f]{8}$/);
  assert.notEqual(line, buildMarkerLine());
  const file = writeMarkerSkill(workspace, line);
  assert.equal(file, path.join(markerSkillDir(workspace), 'SKILL.md'));
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^description: /m, 'frontmatter description (missing descriptions drop skills)');
  assert.ok(text.includes(line));
  assert.ok(!fs.existsSync(path.join(workspace, '.zcode', 'config.json')), 'no config written by the fixture itself');
});

test('mergeHookConfig writes workspace .zcode/config.json (the file ZCode reads) and merges over existing config', (t) => {
  const root = base(t);
  const snippet = path.join(root, 'hook-snippet.json');
  fs.writeFileSync(snippet, JSON.stringify({ hooks: { enabled: true, events: { PreToolUse: [{ matcher: 'Read|Write|Edit', hooks: [{ type: 'process', command: 'node', args: ['x'], timeoutMs: 10000 }] }] } } }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, '.zcode'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.zcode', 'config.json'), `${JSON.stringify({ model: 'keep-me' })}\n`);
  const configFile = mergeHookConfig(snippet, workspace);
  assert.equal(configFile, path.join(workspace, '.zcode', 'config.json'), 'config.json, NOT settings.json');
  const merged = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(merged.model, 'keep-me', 'pre-existing keys preserved');
  assert.equal(merged.hooks.events.PreToolUse[0].matcher, 'Read|Write|Edit');
  // Fresh workspace (no existing config) also lands on config.json.
  const workspace2 = path.join(root, 'workspace2');
  assert.equal(mergeHookConfig(snippet, workspace2), path.join(workspace2, '.zcode', 'config.json'));
});

test('prompts: pickup pins the Skill tool; guard is the two-write do-both pattern; both under the cap at a real temp root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pickup = buildPickupPrompt();
  assert.ok(pickup.startsWith('Use the Skill tool'), 'tool pinned');
  checkPromptCap(pickup, 'zcode-pickup');
  const guard = buildGuardPrompt({ outsideTarget: path.join(root, 'pack', 'workspace', 'outside.txt'), insideTarget: path.join(root, 'pack', 'workspace', 'src', 'ok.txt') });
  assert.ok(guard.includes('第一个报错也要执行第二个'), 'do-both clause');
  assert.ok(guard.length <= 200, `guard prompt ${guard.length} > 200`);
  checkPromptCap(guard, 'zcode-guard');
});

test('verdictGuard: PASS shape; HOOK_TRUST_PENDING never classified as a guard failure', (t) => {
  const root = base(t);
  const outside = path.join(root, 'outside.txt');
  const inside = path.join(root, 'src', 'ok.txt');
  const events = [
    { type: 'tool_call', tool: 'Write', input: { file_path: outside, content: 'z' } },
    { type: 'tool_result', status: 'error', result: 'Error: gstack861:OUTSIDE_SCOPE' },
    { type: 'tool_call', tool: 'Write', input: { file_path: inside, content: 'y' } },
    { type: 'tool_result', status: 'completed', result: 'ok' },
  ];
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(inside, 'y');
  assert.equal(verdictGuard({ events, outsideTarget: outside, insideTarget: inside, outsideExists: false, hooksTrustBlocked: false }).code, 'PASS');
  // Outside created + trust blocked → HOOK_TRUST_PENDING (the trust gate, not the guard).
  assert.equal(verdictGuard({ events, outsideTarget: outside, insideTarget: inside, outsideExists: true, hooksTrustBlocked: true }).code, 'HOOK_TRUST_PENDING');
  // Outside created + hooks apparently runnable → the real guard failure.
  assert.equal(verdictGuard({ events, outsideTarget: outside, insideTarget: inside, outsideExists: true, hooksTrustBlocked: false }).code, 'OUTSIDE_FILE_CREATED');
  // Count/target/file shapes.
  assert.equal(verdictGuard({ events: events.slice(0, 2), outsideTarget: outside, insideTarget: inside, outsideExists: false }).code, 'CALL_COUNT_WRONG');
  assert.equal(verdictGuard({ events: [{ ...events[0], input: { file_path: path.join(root, 'elsewhere.txt') } }, events[1], events[2], events[3]], outsideTarget: outside, insideTarget: inside, outsideExists: false }).code, 'WRONG_TARGET');
  fs.rmSync(inside);
  assert.equal(verdictGuard({ events, outsideTarget: outside, insideTarget: inside, outsideExists: false }).code, 'ALLOW_FILE_MISSING');
});

test('parseStream extracts typed JSON lines and tolerates noise + tool_input deltas', () => {
  const events = parseStream([
    'noise',
    '{"type":"tool_input_start","id":"x"}',
    '{"type":"tool_call","tool":"Write","input":{"file_path":"C:/t/a.txt"}}',
    '{"type":"tool_result","status":"error","result":"Error: gstack861:OUTSIDE_SCOPE"}',
    'not { json',
  ].join('\n'));
  assert.deepEqual(events.map(e => e.type), ['tool_input_start', 'tool_call', 'tool_result']);
  assert.deepEqual(parseStream(''), []);
});

test('zcodeTasksArgs: host=zcode subject block, --id only on non-create', () => {
  const common = { stateDir: 'C:/s', sessionId: 'si', runId: 'r', policyHash: 'a'.repeat(64), actionFile: 'C:/a.json' };
  const create = zcodeTasksArgs({ ...common, sub: 'create' });
  assert.deepEqual(create, ['tasks', 'create', '--state', 'C:/s', '--host', 'zcode', '--session', 'si', '--run', 'r', '--policy-hash', 'a'.repeat(64), '--action-file', 'C:/a.json']);
  assert.ok(!create.includes('--id'));
  for (const sub of ['start', 'complete', 'fail']) {
    assert.deepEqual(zcodeTasksArgs({ ...common, sub, id: 'id-1' }),
      ['tasks', sub, ...create.slice(2), '--id', 'id-1'], `${sub} carries the identical block plus --id`);
  }
});

test('keyless invocation: exits 2 (BLOCKED) without spawning ZCode', () => {
  const child = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/zcode-acceptance-vertical.mjs')], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, ZCODE_ACCEPTANCE_KEY: '' },
  });
  assert.equal(child.status, 2);
  assert.match(child.stdout, /BLOCKED/);
  assert.match(child.stdout, /ZCODE_ACCEPTANCE_KEY/);
  assert.match(child.stdout, /HOOK_TRUST_PENDING/);
}, { timeout: 120000 });
