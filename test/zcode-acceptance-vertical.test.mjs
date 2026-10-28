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
  buildPickupPrompt, buildGuardPrompt, verdictPickup, verdictGuard, parseSummary, zcodeTasksArgs,
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

test('verdictPickup: marker verbatim in the summary response, zero guard codes', () => {
  const line = buildMarkerLine();
  assert.equal(verdictPickup({ summary: { response: `intro\n${line}\ntail` }, markerLine: line }).code, 'PASS');
  assert.equal(verdictPickup({ summary: { response: 'no marker' }, markerLine: line }).code, 'PICKUP_MARKER_NOT_VERBATIM');
  assert.equal(verdictPickup({ summary: { response: `${line} gstack861:OUTSIDE_SCOPE` }, markerLine: line }).code, 'PICKUP_MARKER_NOT_VERBATIM');
  assert.equal(verdictPickup({ summary: null, markerLine: line }).code, 'PICKUP_MARKER_NOT_VERBATIM');
});

test('verdictGuard (summary-based): PASS; HOOK_TRUST_PENDING never classified as a guard failure', (t) => {
  const root = base(t);
  const outside = path.join(root, 'outside.txt');
  const inside = path.join(root, 'src', 'ok.txt');
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(inside, 'y');
  const args = { outsideTarget: outside, insideTarget: inside };
  // PASS: deny relayed + outside absent + inside exact.
  assert.equal(verdictGuard({ ...args, outsideExists: false, denyRelayed: true }).code, 'PASS');
  // Outside created + NO deny relayed → the hook never ran (trust gate), NOT a guard failure.
  assert.equal(verdictGuard({ ...args, outsideExists: true, denyRelayed: false }).code, 'HOOK_TRUST_PENDING');
  // Outside created + deny relayed → the real guard failure.
  assert.equal(verdictGuard({ ...args, outsideExists: true, denyRelayed: true }).code, 'OUTSIDE_FILE_CREATED');
  // Deny missing with file absent → observation missing.
  assert.equal(verdictGuard({ ...args, outsideExists: false, denyRelayed: false }).code, 'DENY_NOT_RELAYED');
  fs.rmSync(inside);
  assert.equal(verdictGuard({ ...args, outsideExists: false, denyRelayed: true }).code, 'ALLOW_FILE_MISSING');
  fs.writeFileSync(path.dirname(inside) && (() => { fs.mkdirSync(path.dirname(inside), { recursive: true }); return inside; })(), 'wrong');
  assert.equal(verdictGuard({ ...args, outsideExists: false, denyRelayed: true }).code, 'ALLOW_CONTENT_MISMATCH');
});

test('parseSummary: the --json FINAL summary object (observed live: sessionId/response/usage)', () => {
  const summary = parseSummary(`{"sessionId":"sess_x","response":"OK","usage":{"totalTokens":1},"eventCount":209}\n`);
  assert.equal(summary.sessionId, 'sess_x');
  assert.equal(summary.response, 'OK');
  assert.equal(summary.eventCount, 209);
  assert.equal(parseSummary('not json'), null);
  assert.equal(parseSummary(''), null);
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
