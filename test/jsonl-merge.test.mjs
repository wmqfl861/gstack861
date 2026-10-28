import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// The merge driver under test — always a real subprocess, exactly as git would
// spawn it (node bin/gstack861-jsonl-merge.mjs %O %A %B).
const script = fileURLToPath(new URL('../bin/gstack861-jsonl-merge.mjs', import.meta.url));

/** Per-test temp dir with base/ours/theirs paths; a role left undefined is never created. */
function stage(t, { base, ours, theirs } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-jsonl-')));
  const files = {
    base: path.join(dir, 'base.jsonl'),
    ours: path.join(dir, 'ours.jsonl'),
    theirs: path.join(dir, 'theirs.jsonl'),
  };
  if (base !== undefined) fs.writeFileSync(files.base, base);
  if (ours !== undefined) fs.writeFileSync(files.ours, ours);
  if (theirs !== undefined) fs.writeFileSync(files.theirs, theirs);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return files;
}

const run = (...files) => spawnSync(process.execPath, [script, ...files], { encoding: 'utf8', timeout: 15000 });

/** The hash-group fallback order the spec pins: ascending sha256 hex of the raw line. */
const sha256 = (line) => createHash('sha256').update(line, 'utf8').digest('hex');
const byHash = (a, b) => (sha256(a) < sha256(b) ? [a, b] : [b, a]);

/** Deterministic seeded PRNG (mulberry32) so randomized fixtures reproduce failures. */
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One randomized three-way fixture: ts lines (small ts pool forces equal-ts ties across sides),
 * timestamp aliases, number-ts, CRLF content, exact duplicates, blank lines, junk. */
function buildRandomSet(rand) {
  const tsPool = Array.from({ length: 6 }, (_, i) => `2026-10-28T0${i}:00:00Z`);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const pool = [];
  for (let i = 0; i < 28; i++) {
    const kind = Math.floor(rand() * 6);
    if (kind === 0) pool.push(`{"ts":"${pick(tsPool)}","i":${i}}`);
    else if (kind === 1) pool.push(`{"timestamp":"${pick(tsPool)}","i":${i}}`);
    else if (kind === 2) pool.push(`{"ts":${Math.floor(rand() * 100)},"i":${i}}`);
    else if (kind === 3) pool.push(`plain line ${i}\r`);
    else if (kind === 4) pool.push(pool.length ? pick(pool) : `seed line ${i}`);
    else pool.push(rand() < 0.3 ? '' : `not json ${i}`);
  }
  const subset = (chance) => pool.filter(() => rand() < chance);
  const baseLines = subset(0.5);
  const shared = subset(0.4);
  return {
    base: baseLines,
    ours: [...baseLines, ...shared.filter(() => rand() < 0.5), `{"ts":"${pick(tsPool)}","side":"ours"}`],
    theirs: [...baseLines, ...shared.filter(() => rand() < 0.5), `{"ts":"${pick(tsPool)}","side":"theirs"}`],
  };
}

test('1. contract main path rewrites ours deduped and sorted: ts group first, then hash group', t => {
  const shared = '{"ts":"2026-10-28T09:00:00Z","shared":true}'; // in all three inputs → one copy
  const theirsTs = '{"ts":"2026-10-28T10:30:00Z","side":"theirs"}';
  const oursTs = '{"ts":"2026-10-28T11:00:00Z","side":"ours"}';
  const tie1 = '{"ts":"2026-10-28T12:00:00Z","n":1}'; // equal ts with tie2: raw line decides
  const tie2 = '{"ts":"2026-10-28T12:00:00Z","n":2}';
  const hashA = 'plain-hash-line-a'; // non-JSON → hash group
  const hashB = 'zzz-plain-hash-line-b';
  const f = stage(t, {
    base: `${shared}\n${hashA}\n`,
    ours: `${shared}\n${oursTs}\n${tie2}\n${hashB}\n`,
    theirs: `${shared}\n${theirsTs}\n${tie1}\n`,
  });
  const child = run(f.base, f.ours, f.theirs);
  assert.equal(child.status, 0, child.stderr);
  const [firstHash, secondHash] = byHash(hashA, hashB);
  assert.equal(
    fs.readFileSync(f.ours, 'utf8'),
    [shared, theirsTs, oursTs, tie1, tie2, firstHash, secondHash].map(l => `${l}\n`).join(''),
  );
});

test('2. tail-append conflict (upstream motivating case): both appends survive, earlier ts first', t => {
  const l1 = '{"ts":"2026-10-28T08:00:00Z","seq":1}';
  const l2 = '{"ts":"2026-10-28T08:30:00Z","seq":2}';
  const theirsAppend = '{"ts":"2026-10-28T09:00:00Z","seq":"B"}'; // T1
  const oursAppend = '{"ts":"2026-10-28T09:30:00Z","seq":"A"}'; // T2
  const f = stage(t, {
    base: `${l1}\n${l2}\n`,
    ours: `${l1}\n${l2}\n${oursAppend}\n`,
    theirs: `${l1}\n${l2}\n${theirsAppend}\n`,
  });
  const child = run(f.base, f.ours, f.theirs);
  assert.equal(child.status, 0, child.stderr);
  // Two machines each appended one line to the same tail: no conflict, no loss, wall-clock order.
  assert.equal(fs.readFileSync(f.ours, 'utf8'), [l1, l2, theirsAppend, oursAppend].map(l => `${l}\n`).join(''));
});

test('3. side symmetry: merge(base, ours, theirs) === merge(base, theirs, ours), byte-identical', t => {
  for (const seed of [11, 202, 5755601]) {
    const { base, ours, theirs } = buildRandomSet(mulberry32(seed));
    const f = stage(t, { base: `${base.join('\n')}\n`, ours: `${ours.join('\n')}\n`, theirs: `${theirs.join('\n')}\n` });
    const forward = run(f.base, f.ours, f.theirs);
    assert.equal(forward.status, 0, forward.stderr);
    const forwardOut = fs.readFileSync(f.ours, 'utf8');
    assert.ok(forwardOut.length > 0, `fixture seed ${seed} must produce output (not a vacuous pass)`);

    // Fresh copies with ours/theirs contents swapped; output written to the swapped ours.
    const g = stage(t, { base: `${base.join('\n')}\n`, ours: `${theirs.join('\n')}\n`, theirs: `${ours.join('\n')}\n` });
    const swapped = run(g.base, g.ours, g.theirs);
    assert.equal(swapped.status, 0, swapped.stderr);
    assert.equal(fs.readFileSync(g.ours, 'utf8'), forwardOut, `seed ${seed}: the two sides must converge`);
  }
});

test('4. ts key semantics: "timestamp" alias sorts in the ts group; number ts and junk hash, verbatim', t => {
  const alias = '{"timestamp":"2026-10-28T07:00:00Z","alias":true}';
  const tsLine = '{"ts":"2026-10-28T08:00:00Z","plain":true}';
  const numTs = '{"ts":123}'; // ts present but not a string → hash group
  const junk = 'not json at all'; // unparseable → hash group, preserved byte-for-byte
  const f = stage(t, {
    base: `${alias}\n`,
    ours: `${tsLine}\n${numTs}\n`,
    theirs: `${junk}\n`,
  });
  const child = run(f.base, f.ours, f.theirs);
  assert.equal(child.status, 0, child.stderr);
  const [firstHash, secondHash] = byHash(numTs, junk);
  assert.equal(fs.readFileSync(f.ours, 'utf8'), [alias, tsLine, firstHash, secondHash].map(l => `${l}\n`).join(''));
});

test('5. blank lines never survive; a CRLF line keeps its CR as content, distinct from its LF twin', t => {
  const tsLine = '{"ts":"2026-10-28T06:00:00Z","blank":true}';
  const lfTwin = 'crlf-line';
  const crlfTwin = 'crlf-line\r'; // file bytes "crlf-line\r\n": the \r is content, the \n the terminator
  const f = stage(t, {
    base: `\n\n${tsLine}`, // blank lines, and no final newline at all
    ours: `${lfTwin}\n`,
    theirs: `${crlfTwin}\n`,
  });
  const child = run(f.base, f.ours, f.theirs);
  assert.equal(child.status, 0, child.stderr);
  const out = fs.readFileSync(f.ours, 'utf8');
  const pieces = out.split('\n');
  assert.equal(pieces[pieces.length - 1], '', 'output ends with exactly one terminator newline');
  const lines = pieces.slice(0, -1);
  assert.ok(!lines.includes(''), 'no empty lines in output');
  assert.deepEqual(new Set(lines), new Set([tsLine, lfTwin, crlfTwin]));
  assert.ok(lines.includes('crlf-line\r'), 'the CR survives as line content');
  assert.ok(lines.includes('crlf-line'), 'the LF twin is a distinct line, not deduped away');
});

test('6. absent base (ENOENT) is an empty input: ours becomes the merge of ours+theirs, exit 0', t => {
  const a = '{"ts":"2026-10-28T01:00:00Z","src":"ours"}';
  const b = '{"ts":"2026-10-28T02:00:00Z","src":"theirs"}';
  const f = stage(t, { ours: `${a}\n`, theirs: `${b}\n` }); // base role never created
  const child = run(f.base, f.ours, f.theirs);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(fs.readFileSync(f.ours, 'utf8'), `${a}\n${b}\n`);
});

test('6b. an unreadable input (a directory where a file belongs) exits 1 and leaves ours untouched', { skip: process.platform === 'win32' }, t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-jsonl-dir-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = stage(t, { ours: 'sentinel\n', theirs: '{"ts":"2026-10-28T00:00:00Z"}\n' });
  const child = run(dir, f.ours, f.theirs); // EISDIR, not ENOENT: fatal, not empty
  assert.equal(child.status, 1);
  assert.match(child.stderr, /gstack861-jsonl-merge/);
  assert.equal(fs.readFileSync(f.ours, 'utf8'), 'sentinel\n');
});

test('7. fewer than 3 args exits 1 with a stderr message and writes nothing', t => {
  const f = stage(t, { ours: 'sentinel\n' });
  for (const argv of [[f.base, f.ours], []]) {
    const child = run(...argv);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /expected 3 args/);
  }
  assert.equal(fs.readFileSync(f.ours, 'utf8'), 'sentinel\n');
});

test('8. determinism: identical inputs run twice produce byte-identical output', t => {
  const inputs = {
    base: '{"ts":"2026-10-28T03:00:00Z","a":1}\nplain-a\n',
    ours: 'plain-b\n',
    theirs: '{"ts":"2026-10-28T02:00:00Z","a":0}\nplain-a\n',
  };
  const outs = [];
  for (let i = 0; i < 2; i++) {
    const f = stage(t, inputs);
    const child = run(f.base, f.ours, f.theirs);
    assert.equal(child.status, 0, child.stderr);
    outs.push(fs.readFileSync(f.ours, 'utf8'));
  }
  assert.equal(outs[0], outs[1]);
  assert.ok(outs[0].length > 0);
});
