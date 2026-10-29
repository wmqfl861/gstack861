// Second-pass audit: actual effects and bounded completion, no paid providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runModelReview } from '../src/model-review.mjs';
import { canonical, digest, textDigest } from '../src/json.mjs';
import { installSkills } from '../src/install.mjs';
import { stageRender } from '../src/stage.mjs';

const request = { gateway: { baseUrl: 'https://gateway.example.test/v1', apiKeyEnv: 'FIXTURE_KEY', model: 'fixture', maxTokens: 64 },
  target: { files: [{ path: 'src/example', diff: '+fixture' }] }, env: { GSTACK861_MODEL_CALL: '1', FIXTURE_KEY: 'fixture-not-a-real-credential' } };
const pending = () => new Promise(() => {});
async function bounded(promise, budget = 2000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TEST_OBSERVED_UNBOUNDED_WAIT')), budget); })]); }
  finally { clearTimeout(timer); }
}
function tmp(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g861-recheck-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function staging(root) {
  const staged = path.join(root, 'staged'), dir = path.join(staged, 'review');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'fixture');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, generator: 'gstack861', name: 'review', host: 'zcode', commit: 'b'.repeat(40), sha256: textDigest('fixture') }));
  return staged;
}
function rendered(root) {
  const input = path.join(root, 'rendered'), skills = path.join(input, '.zcode', 'skills');
  const body = '<!-- AUTO-GENERATED -->\nfixture\n';
  for (const dir of ['gstack-review', 'gstack']) {
    fs.mkdirSync(path.join(skills, dir), { recursive: true });
    fs.writeFileSync(path.join(skills, dir, 'SKILL.md'), body);
  }
  const manifestFile = path.join(root, 'render.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ schemaVersion: 1, host: 'zcode', skills: { review: textDigest(body) }, root: { path: 'gstack/SKILL.md', sha256: textDigest(body) } }));
  return { rendered: input, manifestFile, host: 'zcode', staging: path.join(root, 'output'), skills };
}

test('recheck: timeout bounds an injected transport which ignores its abort signal', async () => {
  let signal, calls = 0;
  await assert.rejects(bounded(runModelReview({ ...request, timeoutMs: 30, fetchImpl: async (_, init) => { signal = init.signal; calls++; return pending(); } })), /GATEWAY_TIMEOUT/);
  assert.equal(calls, 1); assert.equal(signal.aborted, true);
});

test('recheck: timeout bounds response.text even when a transport does not forward abort', async () => {
  await assert.rejects(bounded(runModelReview({ ...request, timeoutMs: 30, fetchImpl: async () => ({ ok: true, status: 200, text: pending }) })), /GATEWAY_TIMEOUT/);
});

test('recheck: oversized stream with never-settling cancellation cannot hide its refusal', async () => {
  let cancelled = 0;
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancelled++; return pending(); } });
  await assert.rejects(bounded(runModelReview({ ...request, timeoutMs: 1000, fetchImpl: async () => new Response(stream) })), /REVIEW_OUTPUT_TOO_LARGE/);
  assert.equal(cancelled, 1);
});

test('recheck: rejected HTTP responses cancel their unread bodies', async () => {
  let cancelled = 0;
  const stream = new ReadableStream({ cancel() { cancelled++; return pending(); } });
  await assert.rejects(bounded(runModelReview({ ...request, fetchImpl: async () => new Response(stream, { status: 503 }) })), /GATEWAY_ERROR/);
  assert.equal(cancelled, 1);
});

test('recheck: sparse arrays with an extra enumerable property cannot forge canonical digests', () => {
  const hole = new Array(1); hole.extra = 'not an element';
  assert.throws(() => canonical(hole), /SPARSE_ARRAY/);
  const second = new Array(2); second[1] = 'element'; second.extra = 'not an element';
  assert.throws(() => digest(second), /SPARSE_ARRAY/);
  assert.notEqual(digest([]), digest([null]));
});

test('recheck: failed installation preserves pre-existing temporary-prefix user content', t => {
  const root = tmp(t), staged = staging(root), target = path.join(root, 'target');
  fs.mkdirSync(target);
  const notes = path.join(target, '.gstack861-tmp-my-notes'); fs.mkdirSync(notes);
  fs.writeFileSync(path.join(notes, 'notes.txt'), 'operator-owned');
  fs.mkdirSync(path.join(target, 'review')); fs.writeFileSync(path.join(target, 'review', 'notes.txt'), 'existing foreign skill');
  assert.throws(() => installSkills({ staging: staged, target }), /USER_FILE_REFUSED/);
  assert.equal(fs.readFileSync(path.join(notes, 'notes.txt'), 'utf8'), 'operator-owned');
});

test('recheck: successful install does not delete unproven UUID-shaped orphan content', t => {
  const root = tmp(t), staged = staging(root), target = path.join(root, 'target'); fs.mkdirSync(target);
  const orphan = path.join(target, '.gstack861-tmp-00000000-0000-4000-8000-000000000000'); fs.mkdirSync(orphan);
  fs.writeFileSync(path.join(orphan, 'notes.txt'), 'do not guess ownership');
  installSkills({ staging: staged, target });
  assert.equal(fs.readFileSync(path.join(orphan, 'notes.txt'), 'utf8'), 'do not guess ownership');
});

for (const component of ['.zcode', 'skills']) test(`recheck: stage refuses a symlinked ${component} input ancestor before writing`, t => {
  const root = tmp(t), f = rendered(root);
  const source = component === '.zcode' ? path.join(f.rendered, '.zcode') : f.skills;
  const outside = path.join(root, 'external'); fs.renameSync(source, outside);
  fs.symlinkSync(outside, source, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => stageRender(f), /RENDER_TREE_INVALID/);
  assert.equal(fs.existsSync(f.staging), false);
});

test('recheck: stage refuses output aliased inside its input tree before mutation', t => {
  const root = tmp(t), f = rendered(root), alias = path.join(root, 'alias');
  fs.symlinkSync(f.rendered, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => stageRender({ ...f, staging: path.join(alias, 'new-output') }), /OVERLAPPING_PATHS/);
  assert.equal(fs.existsSync(path.join(f.rendered, 'new-output')), false);
});

test('recheck: stage rejects case-colliding auxiliary file paths before output', t => {
  const root = tmp(t), f = rendered(root), dir = path.join(f.skills, 'gstack-review');
  // Names differing only in DIRECTORY case can be represented on every platform.
  fs.mkdirSync(path.join(dir, 'Sections'));
  fs.writeFileSync(path.join(dir, 'Sections', 'a.md'), 'a');
  fs.mkdirSync(path.join(dir, 'sections'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sections', 'b.md'), 'b');
  // On case-insensitive hosts these are one actual directory; no collision remains.
  const entries = fs.readdirSync(dir);
  if (entries.includes('Sections') && entries.includes('sections')) {
    assert.throws(() => stageRender(f), /RENDER_TREE_INVALID/);
    assert.equal(fs.existsSync(f.staging), false);
  } else {
    assert.equal(stageRender(f).files, 2);
  }
});

test('recheck: streamed body timeout cancels a reader which never delivers a chunk', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; return pending(); } });
  await assert.rejects(bounded(runModelReview({ ...request, timeoutMs: 30, fetchImpl: async () => new Response(stream) })), /GATEWAY_TIMEOUT/);
  assert.equal(cancelled, true);
});

test('recheck: late response from an aborted transport has its body disposed, no retry', async () => {
  let deliver, cancelled = false, calls = 0;
  const transport = new Promise(resolve => { deliver = resolve; });
  await assert.rejects(bounded(runModelReview({ ...request, timeoutMs: 30, fetchImpl: () => { calls++; return transport; } })), /GATEWAY_TIMEOUT/);
  deliver(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true); assert.equal(calls, 1);
});

test('recheck: invalid wait budgets refuse before any request', async () => {
  for (const timeoutMs of [0, -1, NaN, Infinity, '30', 1.5, 2147483648]) {
    let calls = 0;
    await assert.rejects(runModelReview({ ...request, timeoutMs, fetchImpl: async () => { calls++; return new Response('{}'); } }), /INVALID_REVIEW_TIMEOUT/);
    assert.equal(calls, 0);
  }
});

test('recheck: caller-supplied valid budget clears timer after success', async () => {
  const result = await runModelReview({ ...request, timeoutMs: 1000, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"approve","findings":[]}' } }] })) });
  assert.equal(result.verdict, 'approve');
  assert.deepEqual(result.findings, []);
});
