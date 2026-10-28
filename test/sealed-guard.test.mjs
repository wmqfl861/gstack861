// sealed-guard — adaptation of upstream/gstack test/sealed-guard.test.ts
// (223 lines, 8 tests) at pinned submodule commit
// 5755601dac5d35ebd7dde181fdefe52a023c73d9. Field wave CD4: the sealed-output
// guard. A repo that declares `sealed` in `.gstack/pregate.json` cannot push
// sealed or eval output to a public destination by accident: the managed
// pre-push hook and `gstack-pregate sealed` enumerate every commit the push
// publishes (local sha minus everything the destination remote already has),
// apply path rules to every added, renamed or copied path (binary and empty
// files, add-then-delete) and text rules to each commit's added lines. The
// policy is the union of the base branch's and the pushed one; waivers come
// only from the base branch's allow file; an unknown visibility counts as
// public. Field incident: a per-cell transcript, a quoted sealed answer, a
// seed and a /home/user path were pushed to a public eval repo with exit 0
// and no output.
//
// Adaptation ledger (bun:test → node:test; assertion values unchanged):
//   1. The hook driver spawns node, not bun: upstream
//      `spawnSync('bun', [PREPUSH, ...])` → `spawnSync(process.execPath,
//      [PREPUSH, ...])` over bin/gstack861-redact-prepush.mjs (Lane B of
//      batch 23). In a worktree where that bin is not merged yet the six
//      hook tests skip with that reason (t.skip, never silently); they run
//      for real — real argv + real stdin ref line, exactly as git invokes a
//      pre-push hook — as soon as Lane B lands.
//   2. DROPPED (plan 审计划必改落实 item 6): the describe
//      'gstack-pregate sealed (the standalone preflight…)' block — the one
//      `--range refuses the same findings…` test driving bin/gstack-pregate.
//      The pregate CLI is a batch-23 non-goal (plan 非目标: "pregate 体系其余
//      部分"); only the library (src/sealed-guard.mjs) and the prepush hook
//      are ported. 7 of the 8 upstream tests are adapted here.
//   3. State-root mapping (src/sealed-guard.mjs ledger 1): the upstream
//      fixture env sets HOME + GSTACK_HOME + GSTACK_STATE_ROOT; this port
//      reads only GSTACK861_STATE_ROOT (never ~/.gstack), so the fixture
//      sets HOME + GSTACK861_STATE_ROOT for the same cache isolation.
//      GIT_CONFIG_GLOBAL/GIT_CONFIG_NOSYSTEM isolation is kept verbatim.
//   4. git fixture mechanics (b20/b22 repo precedent): `git init -q -b main`
//      with the git <2.28 fallback (plain init + symbolic-ref of the unborn
//      HEAD); the upstream `[init] defaultBranch = main` global config is
//      kept, so the fallback is belt-and-braces only.
//   5. bun:test afterEach scratch cleanup → per-scratch t.after (same
//      rmSync recursive force); expect().toBe/toMatch/toContain →
//      assert.equal/match/ok(includes) with the same expected values.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVisibility } from '../src/sealed-guard.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PREPUSH = path.join(ROOT, 'bin', 'gstack861-redact-prepush.mjs');
const SKIP_NO_PREPUSH = 'bin/gstack861-redact-prepush.mjs is Lane B of batch 23 (this lane owns src/sealed-guard.mjs); the hook tests run for real once it merges';
const ZERO = '0'.repeat(40);
const SEALED = {
  paths: ['heldout/**'],
  transcripts: ['runs/**/transcript*.jsonl'],
  answer_markers: ['SEALED ANSWER:'],
  seed_patterns: ['shuffle_seed=\\d+'],
  local_paths: true,
};

function sh(cwd, env, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

/** A bare origin with main carrying the given base files, and a clone on branch `results`. */
function scratch(t, baseFiles) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-guard-')));
  const work = path.join(root, 'work'); const origin = path.join(root, 'origin.git'); const state = path.join(root, 'state');
  fs.mkdirSync(work); fs.mkdirSync(state);
  const env = { HOME: root, GSTACK861_STATE_ROOT: state, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  spawnSync('git', ['init', '-q', '--bare', origin], { env: { ...process.env, ...env }, timeout: 30_000 });
  try { sh(work, env, ['init', '-q', '-b', 'main']); }
  catch { sh(work, env, ['init', '-q']); sh(work, env, ['symbolic-ref', 'HEAD', 'refs/heads/main']); }
  write(work, { 'README.md': '# evals\n', ...baseFiles });
  sh(work, env, ['add', '-A']); sh(work, env, ['commit', '-q', '-m', 'base']);
  sh(work, env, ['remote', 'add', 'origin', origin]);
  sh(work, env, ['push', '-q', 'origin', 'main']);
  sh(work, env, ['remote', 'set-head', 'origin', 'main']);
  sh(work, env, ['checkout', '-q', '-b', 'results']);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, work, origin, state, env };
}
function write(work, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(work, rel);
    if (body === null) { fs.rmSync(abs, { force: true }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
}
function commit(s, files, msg = 'results') {
  write(s.work, files);
  sh(s.work, s.env, ['add', '-A']); sh(s.work, s.env, ['commit', '-q', '-m', msg]);
  return sh(s.work, s.env, ['rev-parse', 'HEAD']);
}
const policy = (sealed) => JSON.stringify({ sealed }, null, 2) + '\n';

/** Drive the hook exactly as git does for `git push origin results` (a new remote branch). */
function hook(s, extraEnv = {}) {
  const head = sh(s.work, s.env, ['rev-parse', 'HEAD']);
  const r = spawnSync(process.execPath, [PREPUSH, 'origin', s.origin], { cwd: s.work, input: `refs/heads/results ${head} refs/heads/results ${ZERO}\n`, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...s.env, ...extraEnv } });
  return { code: r.status, err: r.stderr ?? '' };
}

describe('pre-push hook: public destination refuses each kind of sealed output', () => {
  test('a transcript, a sealed answer, a seed and a local home path each refuse, naming file, line and rule, never the matched text', (t) => {
    if (!fs.existsSync(PREPUSH)) return t.skip(SKIP_NO_PREPUSH);
    const cases = [
      [{ 'runs/cat40/cell-07/transcript.jsonl': '{"q":"x"}\n' }, 'sealed.transcript', /sealed\.transcript\s+runs\/cat40\/cell-07\/transcript\.jsonl/],
      [{ 'runs/cat40/summary.md': 'intro\nSEALED ANSWER: fund-a led the round\n' }, 'sealed.answer', /sealed\.answer\s+runs\/cat40\/summary\.md:2/],
      [{ 'runs/cat40/summary.md': 'run with shuffle_seed=42\n' }, 'sealed.seed', /sealed\.seed\s+runs\/cat40\/summary\.md:1/],
      [{ 'runs/cat40/summary.md': 'raw at /home/user/.capy/work/evals/raw.jsonl\n' }, 'sealed.local_path', /sealed\.local_path\s+runs\/cat40\/summary\.md:1/],
    ];
    for (const [files, rule, where] of cases) {
      const s = scratch(t, { '.gstack/pregate.json': policy(SEALED) });
      commit(s, files);
      const r = hook(s);
      assert.equal(r.code, 1);
      assert.match(r.err, where);
      assert.ok(r.err.includes(rule));
      assert.ok(r.err.includes('(SEALED_OUTPUT_REFUSED)'));
      assert.ok(r.err.includes('sealed.visibility'));
      assert.ok(!r.err.includes('fund-a led'));
    }
  });

  test('path rules ignore content: a binary file, an empty transcript, an add-then-delete and a rename into a sealed path all refuse', (t) => {
    if (!fs.existsSync(PREPUSH)) return t.skip(SKIP_NO_PREPUSH);
    const binary = scratch(t, { '.gstack/pregate.json': policy(SEALED) });
    commit(binary, { 'heldout/questions.bin': Buffer.from([0, 1, 2, 0, 255, 0]) });
    assert.match(hook(binary).err, /sealed\.path\s+heldout\/questions\.bin/);
    const empty = scratch(t, { '.gstack/pregate.json': policy(SEALED) });
    commit(empty, { 'runs/c1/transcript.jsonl': '' });
    assert.equal(hook(empty).code, 1);
    const gone = scratch(t, { '.gstack/pregate.json': policy(SEALED) });
    const added = commit(gone, { 'runs/c1/transcript.jsonl': '{"q":1}\n' });
    commit(gone, { 'runs/c1/transcript.jsonl': null }, 'remove it again');
    const g = hook(gone);
    assert.equal(g.code, 1);
    assert.ok(g.err.includes(`sealed.transcript  runs/c1/transcript.jsonl  commit ${added.slice(0, 12)}`));
    const moved = scratch(t, { '.gstack/pregate.json': policy(SEALED) });
    commit(moved, { 'scratch/t.jsonl': '{"q":1}\n{"q":2}\n{"q":3}\n' });
    fs.mkdirSync(path.join(moved.work, 'heldout'));
    sh(moved.work, moved.env, ['mv', 'scratch/t.jsonl', 'heldout/t.jsonl']);
    sh(moved.work, moved.env, ['commit', '-q', '-m', 'move']);
    assert.match(hook(moved).err, /sealed\.path\s+heldout\/t\.jsonl/);
  });

  test('commits the destination already has are not this push: a branch from main that only adds a doc passes', (t) => {
    if (!fs.existsSync(PREPUSH)) return t.skip(SKIP_NO_PREPUSH);
    const s = scratch(t, { 'runs/old/transcript.jsonl': '{"q":"published before the policy"}\n', '.gstack/pregate.json': policy(SEALED) });
    commit(s, { 'docs/notes.md': 'notes\n' });
    const r = hook(s);
    assert.equal(r.code, 0);
    assert.ok(!r.err.includes('sealed.'));
  });
});

describe('policy union, waivers, private destinations and fail-closed parsing', () => {
  test('a push can tighten the policy but never relax it: dropping the base sealed config does not let a transcript through', (t) => {
    if (!fs.existsSync(PREPUSH)) return t.skip(SKIP_NO_PREPUSH);
    const s = scratch(t, { '.gstack/pregate.json': policy(SEALED) });
    commit(s, { '.gstack/pregate.json': '{}\n', 'runs/c1/transcript.jsonl': '{}\n' });
    assert.equal(hook(s).code, 1);
    const tighten = scratch(t, { '.gstack/pregate.json': policy(SEALED) });
    commit(tighten, { '.gstack/pregate.json': policy({ ...SEALED, paths: ['heldout/**', 'cells/**'] }), 'cells/c1.json': '{}\n' });
    assert.match(hook(tighten).err, /sealed\.path\s+cells\/c1\.json/);
  });

  test('a waiver counts only from the base branch allow file and is listed; the same line committed in the push is ignored', (t) => {
    if (!fs.existsSync(PREPUSH)) return t.skip(SKIP_NO_PREPUSH);
    const s = scratch(t, { '.gstack/pregate.json': policy(SEALED) });
    const sha = commit(s, { 'runs/c1/transcript.jsonl': '{}\n' });
    const allow = `# rule\tpath\tsha\treason\nsealed.transcript\truns/c1/transcript.jsonl\t${sha.slice(0, 12)}\tsynthetic fixture, no sealed content\n`;
    commit(s, { '.gstack/sealed-allow.tsv': allow });
    assert.equal(hook(s).code, 1);
    sh(s.work, s.env, ['checkout', '-q', 'main']);
    write(s.work, { '.gstack/sealed-allow.tsv': allow });
    sh(s.work, s.env, ['add', '-A']); sh(s.work, s.env, ['commit', '-q', '-m', 'allow']); sh(s.work, s.env, ['push', '-q', 'origin', 'main']);
    sh(s.work, s.env, ['checkout', '-q', 'results']);
    const r = hook(s);
    assert.equal(r.code, 0);
    assert.ok(r.err.includes('waived sealed.transcript  runs/c1/transcript.jsonl'));
  });

  test('a private destination (base override) warns and passes; a repo without the key sees no change; a malformed sealed policy refuses', (t) => {
    if (!fs.existsSync(PREPUSH)) return t.skip(SKIP_NO_PREPUSH);
    const priv = scratch(t, { '.gstack/pregate.json': policy({ ...SEALED, visibility: 'private' }) });
    commit(priv, { 'runs/c1/transcript.jsonl': '{}\n' });
    const p = hook(priv);
    assert.equal(p.code, 0);
    assert.match(p.err, /warning.*sealed\.transcript\s+runs\/c1\/transcript\.jsonl/s);
    const none = scratch(t, {});
    commit(none, { 'runs/c1/transcript.jsonl': '{}\n' });
    const n = hook(none);
    assert.equal(n.code, 0);
    assert.ok(!n.err.includes('sealed'));
    const bad = scratch(t, { '.gstack/pregate.json': policy(SEALED) });
    commit(bad, { '.gstack/pregate.json': policy({ paths: 'heldout/**' }), 'docs/x.md': 'x\n' });
    const b = hook(bad);
    assert.equal(b.code, 1);
    assert.ok(b.err.includes('(SEALED_OUTPUT_REFUSED)'));
    assert.ok(b.err.includes('sealed policy'));
  });
});

// DROPPED from the upstream file (ledger item 2): upstream's third describe,
// 'gstack-pregate sealed (the standalone preflight before any push or PR
// creation)' — the single test '--range refuses the same findings with exit
// 1; the default range is what origin does not have yet'. It drives
// bin/gstack-pregate, a batch-23 non-goal (plan 非目标: the rest of the
// pregate system). Not replaced by a library-level equivalent: its
// range/default-range CLI behavior belongs to that unported surface.

describe('visibility (cache under the state root; unknown counts as public)', () => {
  test('a public answer is cached; a cached private answer older than an hour is re-queried before it can downgrade; a failed lookup is unknown', () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-vis-'));
    try {
      let calls = 0;
      let answer = 'PUBLIC';
      const gh = () => { calls += 1; return answer === null ? { ok: false, out: '' } : { ok: true, out: JSON.stringify({ visibility: answer }) }; };
      const env = { GSTACK861_STATE_ROOT: state };
      const t0 = Date.parse('2026-10-12T00:00:00Z');
      assert.equal(resolveVisibility('https://github.com/acme-example/evals.git', { env, gh, now: t0 }).visibility, 'public');
      assert.equal(resolveVisibility('https://github.com/acme-example/evals.git', { env, gh, now: t0 + 60_000 }).visibility, 'public');
      assert.equal(calls, 1);
      answer = 'PRIVATE';
      assert.equal(resolveVisibility('git@github.com:acme-example/private-evals.git', { env, gh, now: t0 }).visibility, 'private');
      assert.equal(resolveVisibility('git@github.com:acme-example/private-evals.git', { env, gh, now: t0 + 30 * 60_000 }).visibility, 'private');
      assert.equal(calls, 2);
      answer = null;
      const stale = resolveVisibility('git@github.com:acme-example/private-evals.git', { env, gh, now: t0 + 2 * 3600_000 });
      assert.equal(calls, 3);
      assert.equal(stale.visibility, 'unknown');
      assert.equal(resolveVisibility('/srv/git/evals.git', { env, gh, now: t0 }).visibility, 'unknown');
      assert.equal(calls, 3);
      assert.ok(fs.existsSync(path.join(state, 'sealed-visibility.json')));
    } finally { fs.rmSync(state, { recursive: true, force: true }); }
  });
});
