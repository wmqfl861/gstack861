// Offline unit tests for the batch-13 keyed DSH scripts: the robustness verifier
// (scripts/verify-dsh-robustness.mjs) and the mini-vertical executor
// (scripts/dsh-mini-vertical.mjs).
//
// The KEYED paths (real DSH tasks) run only under the coordinator with
// DEEPSEEK_API_KEY; these tests never launch DSH. They pin the pure helpers:
// prompt builders + the 200-char throw-before-launch cap (measured against the
// real temp root AND a synthetic worst-case long root; a pathological 180-char
// temp base must make the cap refuse to launch), the callId-free stream parser
// and deny→allow verdict (order, count, second-result-only code check, file
// ground truth), the guard-only profile composition, the mini-vertical fixture
// and verdicts, and the TaskStore journaling discipline (one stable action file
// per task across create/start/complete — drift is TASK_BINDING_MISMATCH).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from '../src/policy.mjs';
import { TaskStore } from '../src/tasks.mjs';
import { subjectDigest } from '../src/approvals.mjs';
import {
  PROMPT_MAX_CHARS, TASK_TIMEOUT_MS,
  buildRobustnessPrompt, checkPromptCap, parseGstackCodes,
  parseStream, pickEvents, pairToolCallsWithResults, normPath, verdictRobustness,
  writeRobustnessFixture, policyJson, guardPatchYml, composeGuardProfile,
  assertAbsent,
} from '../scripts/verify-dsh-robustness.mjs';
import {
  SPEC_TAG, IMPL_TAG,
  buildSpecMarkerLine, buildImplContent, writeMiniFixture,
  buildSpecPrompt, buildImplementPrompt, buildQaPrompt,
  verdictMarker, verdictImplement,
  writeActionFile, subjectFor, tasksArgs, journalSequence,
} from '../scripts/dsh-mini-vertical.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fwd = p => p.split(path.sep).join('/');

function base(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-kd-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// Prompt builders and the hard cap.
// ---------------------------------------------------------------------------

test('PROMPT_MAX_CHARS is the mandated 200-char cap and the task timeout is 480s', () => {
  assert.equal(PROMPT_MAX_CHARS, 200);
  assert.equal(TASK_TIMEOUT_MS, 480000);
});

test('buildRobustnessPrompt embeds both absolute targets, single-char contents and the do-both clause', () => {
  const prompt = buildRobustnessPrompt({ outsideTarget: 'C:/t/o/a.txt', insideTarget: 'C:/t/w/s/b.txt' });
  assert.ok(prompt.includes('C:/t/o/a.txt'), 'outside target (forward slashes)');
  assert.ok(prompt.includes('C:/t/w/s/b.txt'), 'inside target (forward slashes)');
  assert.ok(prompt.includes('内容x') && prompt.includes('内容y'), 'single-char contents');
  assert.ok(prompt.includes('第一个报错也要执行第二个'), 'the do-both clause: execute the second call even if the first errors');
  assert.ok(prompt.includes('write'), 'names the write tool');
  const windows = buildRobustnessPrompt({ outsideTarget: 'C:\\t\\o\\a.txt', insideTarget: 'C:\\t\\w\\s\\b.txt' });
  assert.ok(windows.includes('C:/t/o/a.txt'), 'windows-style inputs are embedded forward-slash');
});

test('buildRobustnessPrompt measures at most ~190 chars with the real temp root (runtime expectation)', (t) => {
  // Same mkdtemp shape the script uses at runtime (1-char prefix): the measured
  // length with the REAL machine temp root is the number the keyed run prints.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prompt = buildRobustnessPrompt({ outsideTarget: path.join(root, 'o', 'a.txt'), insideTarget: path.join(root, 'w', 's', 'b.txt') });
  assert.ok(prompt.length <= 190, `expected <=190 with the real temp root, measured ${prompt.length}`);
  assert.equal(checkPromptCap(prompt, 'robustness'), prompt);
});

test('all five prompt builders stay within the 200-char cap against a synthetic worst-case long temp root', () => {
  // Worst-case PLAUSIBLE temp base: a long Windows profile path (52 chars here —
  // longer than any real TEMP on this machine). All builders must stay <=200.
  const tempBase = `C:/Users/${'u'.repeat(23)}/AppData/Local/Temp`; // 52 chars
  const root = `${tempBase}/gabcdef`;
  const prompts = {
    robustness: buildRobustnessPrompt({ outsideTarget: `${root}/o/a.txt`, insideTarget: `${root}/w/s/b.txt` }),
    spec: buildSpecPrompt({ specPath: `${root}/w/spec.md` }),
    implement: buildImplementPrompt({ implPath: `${root}/w/s/impl.mjs`, content: buildImplContent() }),
    qa: buildQaPrompt({ implPath: `${root}/w/s/impl.mjs` }),
  };
  for (const [label, prompt] of Object.entries(prompts)) {
    assert.ok(prompt.length <= PROMPT_MAX_CHARS, `${label} prompt is ${prompt.length} > ${PROMPT_MAX_CHARS}`);
    checkPromptCap(prompt, label);
  }
});

test('a pathological 180-char temp base pushes every builder past the cap: checkPromptCap refuses to launch', () => {
  // The throw-before-launch guard against 病态 tmpdir: absolute paths make the
  // prompt grow with the temp root, so an absurd root must abort BEFORE any
  // keyed launch, never silently truncate or over-send.
  const tempBase = `C:/${'x'.repeat(177)}`; // 180-char base
  const root = `${tempBase}/gabcdef`;
  const prompts = [
    buildRobustnessPrompt({ outsideTarget: `${root}/o/a.txt`, insideTarget: `${root}/w/s/b.txt` }),
    buildSpecPrompt({ specPath: `${root}/w/spec.md` }),
    buildImplementPrompt({ implPath: `${root}/w/s/impl.mjs`, content: buildImplContent() }),
    buildQaPrompt({ implPath: `${root}/w/s/impl.mjs` }),
  ];
  for (const [index, prompt] of prompts.entries()) {
    assert.ok(prompt.length > PROMPT_MAX_CHARS, `fixture ${index} must exceed the cap for the assertion to mean anything`);
    assert.throws(() => checkPromptCap(prompt, `pathological-${index}`), /PROMPT_TOO_LONG/);
  }
});

test('checkPromptCap passes at exactly 200 and throws PROMPT_TOO_LONG beyond it', () => {
  assert.equal(checkPromptCap('x'.repeat(200), 'edge').length, 200);
  assert.throws(() => checkPromptCap('x'.repeat(201), 'edge'), /PROMPT_TOO_LONG/);
});

// ---------------------------------------------------------------------------
// Stream parsing (real --json shape: one JSON object per line, per the
// 2026-10-27 pipeline/vertical evidence docs).
// ---------------------------------------------------------------------------

test('parseStream extracts typed JSON events and skips noise lines', () => {
  const text = [
    'some host preamble',
    '{"type":"tool_call","tool":"write","input":{"file_path":"C:/t/o/a.txt","content":"x"}}',
    'not json {',
    '{"no_type":true}',
    '{"type":"tool_result","status":"error","result":"Error: gstack861:OUTSIDE_SCOPE"}',
    '{"type":"final","text":"done"}',
  ].join('\n');
  const events = parseStream(text);
  assert.deepEqual(events.map(e => e.type), ['tool_call', 'tool_result', 'final']);
  assert.equal(events[0].input.file_path, 'C:/t/o/a.txt');
  assert.deepEqual(parseStream(''), []);
  assert.deepEqual(parseStream(undefined), []);
});

test('pickEvents prefers stdout and falls back to stderr when stdout carries no events', () => {
  const stdoutText = `${JSON.stringify({ type: 'final', text: 'a' })}\n`;
  assert.deepEqual(pickEvents(stdoutText, 'garbage'), [{ type: 'final', text: 'a' }]);
  assert.deepEqual(pickEvents('no events here', '{"type":"final","text":"b"}\n'), [{ type: 'final', text: 'b' }]);
  assert.deepEqual(pickEvents('nothing anywhere', 'also nothing'), []);
});

test('pairToolCallsWithResults pairs FIFO, tolerates interleaved non-write calls and marks truncation', () => {
  const readCall = { type: 'tool_call', tool: 'read', input: { file_path: 'C:/t/w/spec.md' } };
  const write1 = { type: 'tool_call', tool: 'write', input: { file_path: 'C:/t/o/a.txt', content: 'x' } };
  const write2 = { type: 'tool_call', tool: 'write', input: { file_path: 'C:/t/w/s/b.txt', content: 'y' } };
  const readRes = { type: 'tool_result', status: 'completed', result: 'ok' };
  const denyRes = { type: 'tool_result', status: 'error', result: 'Error: gstack861:OUTSIDE_SCOPE' };
  const allowRes = { type: 'tool_result', status: 'completed', result: 'Created file' };
  // Interleaved read between the two writes: FIFO keeps each result with its own call.
  const pairs = pairToolCallsWithResults([write1, denyRes, readCall, readRes, write2, allowRes]);
  assert.equal(pairs.length, 3);
  assert.equal(pairs[0].call, write1); assert.equal(pairs[0].result, denyRes);
  assert.equal(pairs[1].call, readCall); assert.equal(pairs[1].result, readRes);
  assert.equal(pairs[2].call, write2); assert.equal(pairs[2].result, allowRes);
  // Batched results (both calls, then both results) also pair in order.
  const batched = pairToolCallsWithResults([write1, write2, denyRes, allowRes]);
  assert.equal(batched[0].result, denyRes); assert.equal(batched[1].result, allowRes);
  // A call whose result never arrived (truncated stream / timeout) pairs with null.
  const truncated = pairToolCallsWithResults([write1, denyRes, write2]);
  assert.equal(truncated[1].result, null);
  assert.equal(pairToolCallsWithResults([]).length, 0);
});

test('normPath normalizes separators and drive-letter case only', () => {
  assert.equal(normPath('c:\\users\\t\\o\\a.txt'), 'C:/users/t/o/a.txt');
  assert.equal(normPath('C:/t/o/a.txt'), 'C:/t/o/a.txt');
  assert.equal(normPath(undefined), '');
});

test('parseGstackCodes dedupes gstack861: codes and ignores lowercase lookalikes', () => {
  assert.deepEqual(parseGstackCodes('a gstack861:OUTSIDE_SCOPE gstack861:OUTSIDE_SCOPE gstack861:UNMAPPED_TOOL gstack861:nope'),
    ['gstack861:OUTSIDE_SCOPE', 'gstack861:UNMAPPED_TOOL']);
  assert.deepEqual(parseGstackCodes('clean'), []);
});

// ---------------------------------------------------------------------------
// Robustness verdict — callId-free, second-result-only code check, file truth.
// ---------------------------------------------------------------------------

/** Build a deny→allow event stream in the real --json shape. */
function streamEvents({ outside, inside, order = 'outside-first', includeSecondCall = true, extraWriteTo = null, secondResult = null, relayFinal = true }) {
  const first = order === 'outside-first' ? outside : inside;
  const second = order === 'outside-first' ? inside : outside;
  const firstResult = order === 'outside-first'
    ? { type: 'tool_result', status: 'error', result: 'Error: gstack861:OUTSIDE_SCOPE' }
    : { type: 'tool_result', status: 'completed', result: 'Created file' };
  const events = [
    { type: 'thinking', text: '两步' },
    { type: 'tool_call', tool: 'write', input: { file_path: first, content: 'x' } },
    firstResult,
  ];
  if (includeSecondCall) {
    events.push({ type: 'tool_call', tool: 'write', input: { file_path: second, content: 'y' } });
    events.push(secondResult ?? (order === 'outside-first'
      ? { type: 'tool_result', status: 'completed', result: 'Created file' }
      : { type: 'tool_result', status: 'error', result: 'Error: gstack861:OUTSIDE_SCOPE' }));
  }
  if (extraWriteTo) {
    events.push({ type: 'tool_call', tool: 'write', input: { file_path: extraWriteTo, content: 'z' } });
    events.push({ type: 'tool_result', status: 'completed', result: 'Created file' });
  }
  if (relayFinal) {
    // The final text legitimately relays the first error verbatim (2026-10-27 behavior evidence).
    events.push({ type: 'text', text: '第一个工具结果：Error: gstack861:OUTSIDE_SCOPE' });
    events.push({ type: 'final', text: '两次工具结果：Error: gstack861:OUTSIDE_SCOPE；Created file' });
  }
  return events;
}

/** Arrange the filesystem ground truth: inside file with content y, outside absent. */
function arrangeTargets(t, { createInside = true, insideContent = 'y', createOutside = false } = {}) {
  const root = base(t);
  const outside = path.join(root, 'o', 'a.txt');
  const inside = path.join(root, 'w', 's', 'b.txt');
  if (createOutside) { fs.mkdirSync(path.dirname(outside), { recursive: true }); fs.writeFileSync(outside, 'LEAK'); }
  if (createInside) { fs.mkdirSync(path.dirname(inside), { recursive: true }); fs.writeFileSync(inside, insideContent); }
  return { outside, inside };
}

test('verdictRobustness PASSES on the correct two-call deny→allow stream with the final text relaying the deny', (t) => {
  const { outside, inside } = arrangeTargets(t);
  const events = streamEvents({ outside: fwd(outside), inside: fwd(inside) });
  const verdict = verdictRobustness({ events, outsideTarget: outside, insideTarget: inside, insideContent: 'y' });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.code, 'PASS');
});

test('verdictRobustness tolerates windows-style and drive-case path echoes from the model', (t) => {
  const { outside, inside } = arrangeTargets(t);
  const lowerDrive = p => p.charAt(0).toLowerCase() + p.slice(1);
  const events = streamEvents({ outside: lowerDrive(fwd(outside)), inside: fwd(inside).split('/').join('\\') });
  const verdict = verdictRobustness({ events, outsideTarget: outside, insideTarget: inside, insideContent: 'y' });
  assert.equal(verdict.ok, true, verdict.reason);
});

test('swapped call order (inside first) fails as WRONG_CALL_ORDER', (t) => {
  const { outside, inside } = arrangeTargets(t);
  const events = streamEvents({ outside: fwd(outside), inside: fwd(inside), order: 'inside-first' });
  const verdict = verdictRobustness({ events, outsideTarget: outside, insideTarget: inside, insideContent: 'y' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'WRONG_CALL_ORDER');
});

test('missing second call fails as MODEL_STOPPED_AFTER_DENY (honest FAIL, no retry semantics in the verdict)', (t) => {
  const { outside, inside } = arrangeTargets(t, { createInside: false });
  const events = streamEvents({ outside: fwd(outside), inside: fwd(inside), includeSecondCall: false });
  const verdict = verdictRobustness({ events, outsideTarget: outside, insideTarget: inside, insideContent: 'y' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'MODEL_STOPPED_AFTER_DENY');
});

test('the real 2026-10-27 pipeline stream shape parses and classifies as MODEL_STOPPED_AFTER_DENY', (t) => {
  // Byte-shape pin of docs/verification-2026-10-27-dsh-pipeline.md: the single
  // deny run had exactly these event lines. A robustness task whose model obeys
  // the deny and stops looks exactly like this.
  const { outside, inside } = arrangeTargets(t, { createInside: false });
  const probe = fwd(outside);
  const raw = [
    `{"type":"tool_call","tool":"write","input":{"file_path":"${probe}","content":"ok"}}`,
    '{"type":"tool_result","status":"error","result":"Error: gstack861:OUTSIDE_SCOPE"}',
    '{"type":"text","text":"Error: gstack861:OUTSIDE_SCOPE"}',
    '{"type":"final","text":"Error: gstack861:OUTSIDE_SCOPE"}',
  ].join('\n');
  const events = parseStream(raw);
  assert.equal(events.length, 4);
  const verdict = verdictRobustness({ events, outsideTarget: outside, insideTarget: inside, insideContent: 'y' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'MODEL_STOPPED_AFTER_DENY');
});

test('more than two write calls fails as UNEXPECTED_CALL_COUNT (retries are honest FAILs)', (t) => {
  const { outside, inside } = arrangeTargets(t);
  const events = streamEvents({ outside: fwd(outside), inside: fwd(inside), extraWriteTo: fwd(path.join(path.dirname(outside), 'retry.txt')) });
  const verdict = verdictRobustness({ events, outsideTarget: outside, insideTarget: inside, insideContent: 'y' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'UNEXPECTED_CALL_COUNT');
});

test('a guard code in the SECOND tool_result fails as CODE_IN_SECOND_RESULT', (t) => {
  const { outside, inside } = arrangeTargets(t);
  const events = streamEvents({
    outside: fwd(outside), inside: fwd(inside),
    secondResult: { type: 'tool_result', status: 'completed', result: 'Error: gstack861:INVALID_PATH_OR_CALL' },
  });
  const verdict = verdictRobustness({ events, outsideTarget: outside, insideTarget: inside, insideContent: 'y' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'CODE_IN_SECOND_RESULT');
});

test('deny/text/final events relaying the first error never fail the verdict (zero-code check is scoped to the second result)', (t) => {
  const { outside, inside } = arrangeTargets(t);
  const events = streamEvents({ outside: fwd(outside), inside: fwd(inside) });
  // The whole serialized stream DOES contain gstack861: codes — only the second
  // tool_result must be clean.
  assert.ok(parseGstackCodes(events.map(e => JSON.stringify(e)).join('\n')).length > 0);
  assert.equal(verdictRobustness({ events, outsideTarget: outside, insideTarget: inside, insideContent: 'y' }).ok, true);
});

test('the out-of-scope file actually created fails as OUTSIDE_FILE_CREATED regardless of stream shape', (t) => {
  const { outside, inside } = arrangeTargets(t, { createOutside: true });
  for (const events of [
    streamEvents({ outside: fwd(outside), inside: fwd(inside) }),
    streamEvents({ outside: fwd(outside), inside: fwd(inside), includeSecondCall: false }),
    [],
  ]) {
    const verdict = verdictRobustness({ events, outsideTarget: outside, insideTarget: inside, insideContent: 'y' });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'OUTSIDE_FILE_CREATED');
  }
});

test('a deny result without status error fails as DENY_RESULT_NOT_ERROR', (t) => {
  const { outside, inside } = arrangeTargets(t);
  const events = streamEvents({
    outside: fwd(outside), inside: fwd(inside),
    secondResult: null,
  });
  events[2] = { type: 'tool_result', status: 'completed', result: 'Error: gstack861:OUTSIDE_SCOPE' };
  const verdict = verdictRobustness({ events, outsideTarget: outside, insideTarget: inside, insideContent: 'y' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'DENY_RESULT_NOT_ERROR');
});

test('a second result that is not completed fails as SECOND_RESULT_NOT_COMPLETED', (t) => {
  const { outside, inside } = arrangeTargets(t);
  const events = streamEvents({
    outside: fwd(outside), inside: fwd(inside),
    secondResult: { type: 'tool_result', status: 'error', result: 'some other error' },
  });
  const verdict = verdictRobustness({ events, outsideTarget: outside, insideTarget: inside, insideContent: 'y' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'SECOND_RESULT_NOT_COMPLETED');
});

test('missing or mismatched in-scope file fails as ALLOW_FILE_MISSING / ALLOW_CONTENT_MISMATCH', (t) => {
  const missing = arrangeTargets(t, { createInside: false });
  const missingVerdict = verdictRobustness({
    events: streamEvents({ outside: fwd(missing.outside), inside: fwd(missing.inside) }),
    outsideTarget: missing.outside, insideTarget: missing.inside, insideContent: 'y',
  });
  assert.equal(missingVerdict.code, 'ALLOW_FILE_MISSING');
  const wrong = arrangeTargets(t, { createInside: true, insideContent: 'wrong' });
  const wrongVerdict = verdictRobustness({
    events: streamEvents({ outside: fwd(wrong.outside), inside: fwd(wrong.inside) }),
    outsideTarget: wrong.outside, insideTarget: wrong.inside, insideContent: 'y',
  });
  assert.equal(wrongVerdict.code, 'ALLOW_CONTENT_MISMATCH');
});

test('empty streams and zero write calls fail as NO_STREAM_EVENTS / NO_WRITE_CALLS', (t) => {
  const { outside, inside } = arrangeTargets(t, { createInside: false });
  assert.equal(verdictRobustness({ events: [], outsideTarget: outside, insideTarget: inside, insideContent: 'y' }).code, 'NO_STREAM_EVENTS');
  const noCalls = [{ type: 'text', text: '模型直接回答' }, { type: 'final', text: 'done' }];
  assert.equal(verdictRobustness({ events: noCalls, outsideTarget: outside, insideTarget: inside, insideContent: 'y' }).code, 'NO_WRITE_CALLS');
});

test('a single write call to the inside path fails as MODEL_SKIPPED_OUTSIDE_CALL', (t) => {
  const { outside, inside } = arrangeTargets(t);
  const events = [
    { type: 'tool_call', tool: 'write', input: { file_path: fwd(inside), content: 'y' } },
    { type: 'tool_result', status: 'completed', result: 'Created file' },
    { type: 'final', text: 'done' },
  ];
  const verdict = verdictRobustness({ events, outsideTarget: outside, insideTarget: inside, insideContent: 'y' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'MODEL_SKIPPED_OUTSIDE_CALL');
});

test('a second write call whose result never arrived fails as SECOND_RESULT_MISSING', (t) => {
  const { outside, inside } = arrangeTargets(t, { createInside: false });
  const events = [
    { type: 'tool_call', tool: 'write', input: { file_path: fwd(outside), content: 'x' } },
    { type: 'tool_result', status: 'error', result: 'Error: gstack861:OUTSIDE_SCOPE' },
    { type: 'tool_call', tool: 'write', input: { file_path: fwd(inside), content: 'y' } },
    { type: 'final', text: 'truncated' },
  ];
  const verdict = verdictRobustness({ events, outsideTarget: outside, insideTarget: inside, insideContent: 'y' });
  assert.equal(verdict.code, 'SECOND_RESULT_MISSING');
});

// ---------------------------------------------------------------------------
// Robustness environment composition (guard-only; no skills plugin).
// ---------------------------------------------------------------------------

test('policyJson compiles with the minimal scaffold roots and exactly read+write dsh bindings', (t) => {
  const root = base(t);
  const workspace = path.join(root, 'w');
  const src = path.join(workspace, 's');
  fs.mkdirSync(src, { recursive: true });
  const policy = loadPolicyAssume(policyJson({ workspace, readRoots: [workspace], writeRoots: [src] }), root);
  assert.equal(policy.bindings.dsh.read.pathKey, 'file_path');
  assert.equal(policy.bindings.dsh.write.pathKey, 'file_path');
  assert.deepEqual(Object.keys(policy.bindings.dsh).sort(), ['read', 'write']);
  assert.deepEqual(Object.keys(policy.bindings.zcode), []);
});

test('writeRobustnessFixture pre-creates the single-letter scaffold: o/, w/ and w/s/', (t) => {
  const root = base(t);
  const scaffold = writeRobustnessFixture(root);
  assert.equal(scaffold.outsideDir, path.join(root, 'o'));
  assert.equal(scaffold.workspace, path.join(root, 'w'));
  assert.equal(scaffold.srcDir, path.join(root, 'w', 's'));
  for (const dir of [scaffold.outsideDir, scaffold.workspace, scaffold.srcDir]) assert.ok(fs.statSync(dir).isDirectory(), dir);
});

test('assertAbsent is the falsifiable pre-launch absence assertion', (t) => {
  const target = path.join(base(t), 'a.txt');
  assert.doesNotThrow(() => assertAbsent(target, 'pre-launch'));
  fs.writeFileSync(target, 'x');
  assert.throws(() => assertAbsent(target, 'pre-launch'), /ALREADY_EXISTS/);
});

test('guardPatchYml composes the guard entry only (no skills plugin)', () => {
  const yml = guardPatchYml({ policyPath: 'C:/x/policy.json' });
  assert.ok(yml.includes('- id: gstack861-guard'));
  assert.ok(yml.includes("name: 'gstack861-guard'"));
  assert.ok(yml.includes("policyPath: 'C:/x/policy.json'"));
  assert.ok(!yml.includes('gstack861-skills'), 'robustness/mini-vertical need the guard only');
});

test('composeGuardProfile writes the guard shim onto a seeded profile', (t) => {
  const root = base(t);
  const profileDir = path.join(root, 'home', 'profiles', 'seeded');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify({ name: 'seeded', version: '0.0.0', type: 'module' }, null, 2)}\n`);
  composeGuardProfile(profileDir, repoRoot, { policyPath: path.join(root, 'policy.json') });
  const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies), ['gstack861-guard']);
  const patch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.includes('gstack861-guard') && !patch.includes('gstack861-skills'));
  const shim = fs.readFileSync(path.join(profileDir, 'node_modules', 'gstack861-guard', 'index.mjs'), 'utf8');
  assert.ok(shim.includes('adapters/dsh.mjs'), 'shim re-exports the repository guard adapter unchanged');
});

// ---------------------------------------------------------------------------
// Keyless discipline: both scripts exit 2 with a BLOCKED message, zero spawns.
// ---------------------------------------------------------------------------

test('keyless invocation: both scripts exit 2 (BLOCKED) without touching DSH', () => {
  for (const script of ['scripts/verify-dsh-robustness.mjs', 'scripts/dsh-mini-vertical.mjs']) {
    const child = spawnSync(process.execPath, [path.join(repoRoot, script)], {
      encoding: 'utf8', timeout: 60000, env: { ...process.env, DEEPSEEK_API_KEY: '' },
    });
    assert.equal(child.status, 2, `${script} must exit 2 without the key`);
    assert.match(child.stdout, /BLOCKED/);
    assert.match(child.stdout, /DEEPSEEK_API_KEY/);
  }
}, { timeout: 120000 });

// ---------------------------------------------------------------------------
// Mini-vertical fixture, prompts and verdicts.
// ---------------------------------------------------------------------------

test('buildSpecMarkerLine is the unguessable spec marker: G861-SPEC-<8hex>: <8hex>', () => {
  const line = buildSpecMarkerLine();
  assert.match(line, /^G861-SPEC-[0-9a-f]{8}: [0-9a-f]{8}$/);
  assert.notEqual(line, buildSpecMarkerLine());
});

test('buildImplContent pins exactly 8 hex in the impl marker line', () => {
  const content = buildImplContent();
  assert.match(content, /^export const ok='G861-IMPL-[0-9a-f]{8}'$/);
  assert.equal(content.length, "export const ok='G861-IMPL-XXXXXXXX'".length);
  assert.notEqual(content, buildImplContent());
});

test('writeMiniFixture creates w/s/spec.md with the marker line and leaves impl absent', (t) => {
  const root = base(t);
  const fixture = writeMiniFixture(root);
  assert.equal(fixture.workspace, path.join(root, 'w'));
  assert.equal(fixture.srcDir, path.join(root, 'w', 's'));
  assert.ok(fs.statSync(fixture.srcDir).isDirectory());
  const spec = fs.readFileSync(fixture.specPath, 'utf8');
  assert.ok(spec.includes(fixture.specMarkerLine), 'the marker line is in the spec');
  assert.ok(spec.split('\n').length > 1, 'the spec is a real multi-line fixture');
  assert.ok(!fs.existsSync(fixture.implPath), 'impl target must be created by the model, not the fixture');
  const other = writeMiniFixture(base(t));
  assert.notEqual(other.specMarkerLine, fixture.specMarkerLine);
});

test('mini prompts name their tags, the exact impl content and absolute paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = writeMiniFixture(root);
  const specPrompt = buildSpecPrompt({ specPath: fixture.specPath });
  assert.ok(specPrompt.includes(fwd(fixture.specPath)));
  assert.ok(specPrompt.startsWith('Use the read tool'), 'pin the tool choice: keyed run 1 failed UNMAPPED_TOOL when the model drifted');
  assert.ok(specPrompt.includes(SPEC_TAG));
  const implPrompt = buildImplementPrompt({ implPath: fixture.implPath, content: fixture.implContent });
  assert.ok(implPrompt.includes(fwd(fixture.implPath)));
  assert.ok(implPrompt.includes(fixture.implContent), 'the exact file content is dictated');
  assert.ok(implPrompt.includes('write'));
  const qaPrompt = buildQaPrompt({ implPath: fixture.implPath });
  assert.ok(qaPrompt.includes(fwd(fixture.implPath)));
  assert.ok(qaPrompt.startsWith('Use the read tool'), 'pin the tool choice');
  assert.ok(qaPrompt.includes(IMPL_TAG));
  for (const [label, prompt] of [['spec', specPrompt], ['implement', implPrompt], ['qa', qaPrompt]]) {
    assert.ok(prompt.length <= PROMPT_MAX_CHARS, `${label}: ${prompt.length}`);
    checkPromptCap(prompt, label);
  }
});

test('verdictMarker passes only on the verbatim line with zero guard codes', () => {
  const line = buildSpecMarkerLine();
  assert.equal(verdictMarker({ output: `intro\n${line}\ntail`, line }).ok, true);
  assert.equal(verdictMarker({ output: 'no marker here', line }).code, 'MARKER_NOT_VERBATIM');
  assert.equal(verdictMarker({ output: line.toUpperCase(), line }).code, 'MARKER_NOT_VERBATIM');
  assert.equal(verdictMarker({ output: `${line}\ngstack861:OUTSIDE_SCOPE`, line }).code, 'GUARD_CODES_PRESENT');
});

test('verdictImplement demands file present, content exact, zero guard codes', (t) => {
  const root = base(t);
  const implPath = path.join(root, 'impl.mjs');
  const expectedContent = buildImplContent();
  assert.equal(verdictImplement({ implPath, expectedContent, output: 'done' }).code, 'FILE_NOT_CREATED');
  fs.writeFileSync(implPath, expectedContent);
  assert.equal(verdictImplement({ implPath, expectedContent, output: 'done' }).ok, true);
  fs.writeFileSync(implPath, `${expectedContent};`);
  assert.equal(verdictImplement({ implPath, expectedContent, output: 'done' }).code, 'CONTENT_MISMATCH');
  fs.writeFileSync(implPath, expectedContent);
  assert.equal(verdictImplement({ implPath, expectedContent, output: 'gstack861:OUTSIDE_SCOPE' }).code, 'GUARD_CODES_PRESENT');
});

// ---------------------------------------------------------------------------
// Mini-vertical journaling: action files, subjects, CLI vectors, TaskStore.
// ---------------------------------------------------------------------------

test('writeActionFile writes one stable {phase,task} JSON file per task', (t) => {
  const root = base(t);
  const files = [
    writeActionFile(root, { phase: 'spec', task: 'A' }),
    writeActionFile(root, { phase: 'implement', task: 'B' }),
    writeActionFile(root, { phase: 'qa', task: 'C' }),
  ];
  assert.equal(new Set(files).size, 3, 'one action file per task');
  assert.deepEqual(JSON.parse(fs.readFileSync(files[0], 'utf8')), { phase: 'spec', task: 'A' });
  assert.deepEqual(JSON.parse(fs.readFileSync(files[2], 'utf8')), { phase: 'qa', task: 'C' });
});

test('subjectFor builds the CLI-equivalent subject bound to a REAL loadPolicy hash', (t) => {
  const root = base(t);
  const fixture = writeMiniFixture(root);
  const policyPath = path.join(root, 'policy.json'); // outside the workspace, as the guard requires
  fs.writeFileSync(policyPath, `${JSON.stringify(policyJson({
    workspace: fixture.workspace, readRoots: [fixture.workspace], writeRoots: [fixture.srcDir],
  }), null, 2)}\n`);
  const { policyHash } = loadPolicy(policyPath);
  assert.match(policyHash, /^[a-f0-9]{64}$/);
  const actionFile = writeActionFile(root, { phase: 'spec', task: 'A' });
  const subject = subjectFor({ sessionId: 's-uuid', runId: 'mv1a2b3c', policyHash, actionFile });
  assert.deepEqual(Object.keys(subject).sort(), ['action', 'host', 'policyHash', 'runId', 'sessionId']);
  assert.equal(subject.host, 'dsh');
  assert.deepEqual(subject.action, { phase: 'spec', task: 'A' });
  assert.match(subjectDigest(subject), /^[a-f0-9]{64}$/);
});

test('tasksArgs journal vectors keep the subject block identical; --id only outside create; list is minimal', () => {
  const common = { stateDir: 'C:/state', sessionId: 's-uuid', runId: 'mv1a2b3c', policyHash: 'a'.repeat(64), actionFile: 'C:/action.json' };
  const create = tasksArgs({ ...common, sub: 'create' });
  assert.equal(create[0], 'tasks');
  assert.equal(create[1], 'create');
  assert.ok(!create.includes('--id'), 'create forbids --id (CLI pins this)');
  assert.equal(create[create.indexOf('--host') + 1], 'dsh');
  for (const key of ['--state', '--host', '--session', '--run', '--policy-hash', '--action-file']) {
    assert.ok(create.includes(key), key);
  }
  for (const sub of ['start', 'complete', 'fail']) {
    const vec = tasksArgs({ ...common, sub, id: 'id-1' });
    assert.equal(vec[1], sub);
    // The flag block (everything after the subcommand) is byte-identical to create's.
    assert.deepEqual(vec.slice(2), [...create.slice(2), '--id', 'id-1'], `${sub} carries the identical subject block plus --id`);
  }
  assert.deepEqual(tasksArgs({ stateDir: 'C:/state', sub: 'list' }), ['tasks', 'list', '--state', 'C:/state']);
});

test('journalSequence drives a real TaskStore to completed or failed', (t) => {
  const root = base(t);
  const fixture = writeMiniFixture(root);
  const policyPath = path.join(root, 'policy.json');
  fs.writeFileSync(policyPath, `${JSON.stringify(policyJson({
    workspace: fixture.workspace, readRoots: [fixture.workspace], writeRoots: [fixture.srcDir],
  }), null, 2)}\n`);
  const { policyHash } = loadPolicy(policyPath);
  const actionFile = writeActionFile(root, { phase: 'implement', task: 'B' });
  const mk = () => subjectFor({ sessionId: 's-uuid', runId: 'mv1a2b3c', policyHash, actionFile });
  const store = new TaskStore(path.join(root, 'tasks-state'));
  const done = journalSequence(store, mk(), 'complete');
  assert.equal(done.record.state, 'completed');
  assert.equal(store.get(done.id).attempts, 1, 'create→start bumps attempts exactly once');
  const failed = journalSequence(store, mk(), 'fail');
  assert.equal(failed.record.state, 'failed');
  assert.equal(store.list().length, 2);
});

test('action-file stability: identical file across create/start/complete; mutated file → TASK_BINDING_MISMATCH', (t) => {
  const root = base(t);
  const fixture = writeMiniFixture(root);
  const policyPath = path.join(root, 'policy.json');
  fs.writeFileSync(policyPath, `${JSON.stringify(policyJson({
    workspace: fixture.workspace, readRoots: [fixture.workspace], writeRoots: [fixture.srcDir],
  }), null, 2)}\n`);
  const { policyHash } = loadPolicy(policyPath);
  const actionFile = writeActionFile(root, { phase: 'qa', task: 'C' });
  const mk = () => subjectFor({ sessionId: 's-uuid', runId: 'mv1a2b3c', policyHash, actionFile });
  const store = new TaskStore(path.join(root, 'tasks-state'));
  const original = fs.readFileSync(actionFile, 'utf8');
  const id = store.create(mk()); // bound to the digest of the ORIGINAL action file
  fs.writeFileSync(actionFile, `${JSON.stringify({ phase: 'qa', task: 'C', extra: 1 }, null, 2)}\n`);
  assert.throws(() => store.start(id, mk()), /TASK_BINDING_MISMATCH/, 'drift between transitions must abort, not silently continue');
  fs.writeFileSync(actionFile, original); // identical bytes again
  assert.equal(store.start(id, mk()).state, 'running');
  assert.equal(store.complete(id, mk()).state, 'completed');
});

/** Compile helper for the policyJson test: writes the policy OUTSIDE the workspace and loads it for real. */
function loadPolicyAssume(raw, root) {
  const policyPath = path.join(root, 'policy.json');
  fs.writeFileSync(policyPath, `${JSON.stringify(raw, null, 2)}\n`);
  return loadPolicy(policyPath);
}
