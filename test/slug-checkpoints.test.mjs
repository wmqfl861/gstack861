import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkpointFields, classifyCheckpoint, checkpointMeta, normTitle, ticketTokens,
  pointerTarget, stampCheckpoint, classifyCheckpoints, checkpointsBelow,
  pointFrom, newerTask, adoptLegacy,
} from '../src/slug-checkpoints.mjs';

const MODULE = fileURLToPath(new URL('../src/slug-checkpoints.mjs', import.meta.url));

/** Per-test physical temp dir (roots must compare equal, so everything is realpath'd). */
function tmp(t, tag = 'gstack861-ck-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), tag)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** A checkpoint file under <stateRoot>/projects/<slug>/checkpoints/<name>. */
function ck(stateRoot, slug, name, frontmatter = '', body = '## Working on: some task\n') {
  return write(
    path.join(stateRoot, 'projects', slug, 'checkpoints', name),
    frontmatter ? `---\n${frontmatter}---\n${body}` : body,
  );
}

/** Pointer JSON in the exact two-space shape the writer produces. */
function pointerJson(target, bucket, root) {
  return `${JSON.stringify({ checkpoint: target, bucket, project_root: root }, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// checkpointFields: leading frontmatter only, first-seen wins
// ---------------------------------------------------------------------------

test('1. checkpointFields reads remote/project_root from leading frontmatter, first value wins', t => {
  const dir = tmp(t);
  const file = write(path.join(dir, 'a.md'),
    '---\n'
    + 'remote: gitlab.com/grp/prod/repo\n'
    + 'remote: github.com/other/thing\n'          // second occurrence ignored
    + 'project_root: /first/root\n'
    + 'project_root: /second/root\n'
    + '---\n'
    + 'remote: body-value\n'                       // outside frontmatter ignored
    + 'project_root: body-value\n');
  assert.deepEqual(checkpointFields(file), { remote: 'gitlab.com/grp/prod/repo', projectRoot: '/first/root' });
});

test('2. checkpointFields trims [ \\t\\r ] around values and yields empties without frontmatter', t => {
  const dir = tmp(t);
  const stamped = write(path.join(dir, 'b.md'),
    '---\nremote: \t github.com/o/r \t\r\nproject_root:\t/r/x\n---\n');
  assert.deepEqual(checkpointFields(stamped), { remote: 'github.com/o/r', projectRoot: '/r/x' });
  const noFm = write(path.join(dir, 'c.md'), '# just a note\nremote: nope\n');
  assert.deepEqual(checkpointFields(noFm), { remote: '', projectRoot: '' });
  const emptyFm = write(path.join(dir, 'd.md'), '---\nremote:\n---\n');
  assert.deepEqual(checkpointFields(emptyFm), { remote: '', projectRoot: '' }); // first-seen wins even empty
  assert.deepEqual(checkpointFields(path.join(dir, 'missing.md')), { remote: '', projectRoot: '' });
});

// ---------------------------------------------------------------------------
// classifyCheckpoint: the four-state matrix, verbatim precedence
// ---------------------------------------------------------------------------

test('3. classifyCheckpoint four-state matrix (upstream _classify_checkpoint precedence)', () => {
  const id = { remote: 'github.com/o/r', projectRoot: '/repo' };
  const cases = [
    // [fields, identity, expected]
    [{ remote: 'github.com/o/r', projectRoot: '/repo' }, id, 'match'],
    [{ remote: 'github.com/o/r', projectRoot: '' }, id, 'match'],               // empty root is not match-root
    [{ remote: 'github.com/o/r', projectRoot: '/repo' }, id, 'match'],
    [{ remote: 'github.com/o/r', projectRoot: '/other/root' }, id, 'match-root'], // same remote, different non-empty root
    [{ remote: 'gitlab.com/g/p/r', projectRoot: '/repo' }, id, 'foreign'],        // remote mismatch wins over root
    [{ remote: 'gitlab.com/g/p/r', projectRoot: '/other' }, id, 'foreign'],
    [{ remote: '', projectRoot: '/repo' }, id, 'match'],                          // ck remote empty -> root compare
    [{ remote: '', projectRoot: '/other' }, id, 'foreign'],
    [{ remote: '', projectRoot: '' }, id, 'unstamped'],
    // identity remote empty: roots alone decide
    [{ remote: '', projectRoot: '/repo' }, { remote: '', projectRoot: '/repo' }, 'match'],
    [{ remote: '', projectRoot: '/other' }, { remote: '', projectRoot: '/repo' }, 'foreign'],
    [{ remote: 'github.com/o/r', projectRoot: '' }, { remote: '', projectRoot: '/repo' }, 'foreign'], // remote-only ck
    [{ remote: 'github.com/o/r', projectRoot: '/repo' }, { remote: '', projectRoot: '/repo' }, 'match'], // root-only compare
    [{ remote: '', projectRoot: '' }, { remote: '', projectRoot: '/repo' }, 'unstamped'],
  ];
  for (const [fields, identity, expected] of cases) {
    assert.equal(classifyCheckpoint(fields, identity), expected,
      `${JSON.stringify(fields)} vs ${JSON.stringify(identity)} should be ${expected}`);
  }
});

// ---------------------------------------------------------------------------
// checkpointMeta: frontmatter fields + first "## Working on:" outside; date fallback
// ---------------------------------------------------------------------------

test('4. checkpointMeta parses frontmatter and the first body heading; in-frontmatter heading ignored', t => {
  const dir = tmp(t);
  const file = write(path.join(dir, 'x.md'),
    '---\n'
    + 'branch: feat/x\n'
    + 'project_root: /repo\n'
    + 'worktree: /main/.worktrees/feat\n'
    + '## Working on: frontmatter trap\n'         // inside frontmatter: not the title
    + 'branch: second/ignored\n'
    + '---\n'
    + '## Working on: Real Task Name\n'
    + '## Working on: Later ignored\n');
  assert.deepEqual(checkpointMeta(file), {
    branch: 'feat/x', projectRoot: '/repo', worktree: '/main/.worktrees/feat', title: 'Real Task Name',
  });
  const none = write(path.join(dir, 'plain.md'), 'no frontmatter at all\n## Working on: Body Title\n');
  const meta = checkpointMeta(none);
  assert.deepEqual([meta.branch, meta.title], ['', 'Body Title']);
});

test('5. checkpointMeta title fallback strips ^[8digits]-[6digits]-? from the filename, not the date-time form', t => {
  const dir = tmp(t);
  const full = write(path.join(dir, '20261028-093001-branch-title.md'), 'body\n');
  assert.equal(checkpointMeta(full).title, 'branch-title');
  const noDash = write(path.join(dir, '20261028-093001title.md'), 'body\n');
  assert.equal(checkpointMeta(noDash).title, 'title');
  const shortTime = write(path.join(dir, '20261028-0930-title.md'), 'body\n'); // only 4 time digits: NOT stripped
  assert.equal(checkpointMeta(shortTime).title, '20261028-0930-title');
  const looseDate = write(path.join(dir, '2026-1-2-task.md'), 'body\n');        // not 8d-6d: NOT stripped here
  assert.equal(checkpointMeta(looseDate).title, '2026-1-2-task');
  const noMd = write(path.join(dir, '20261028-093001-notes'), 'body\n');        // suffix strip is .md-only
  assert.equal(checkpointMeta(noMd).title, 'notes');
  const emptyHeading = write(path.join(dir, '20261028-120000-t.md'), '## Working on:\n'); // empty heading falls back
  assert.equal(checkpointMeta(emptyHeading).title, 't');
});

test('6. the two date regexes stay separate: normTitle strips what the meta fallback keeps', () => {
  // Dashed dates are normTitle-strippable but NOT meta-fallback-strippable (8digits-6digits only).
  assert.equal(normTitle('2026-10-28-task'), 'task');
  assert.equal(normTitle('2026-1-2 fix'), '2026 1 2 fix'); // single-digit month/day: neither regex strips
  assert.equal(normTitle('20261028 093000 fix'), 'fix'); // compact date-time, colon-less seconds
});

test('7. checkpointMeta of a missing file returns all-empty (no filename fallback)', t => {
  const dir = tmp(t);
  assert.deepEqual(checkpointMeta(path.join(dir, 'gone-20261028-093001-x.md')),
    { branch: '', projectRoot: '', worktree: '', title: '' });
});

// ---------------------------------------------------------------------------
// normTitle / ticketTokens boundaries
// ---------------------------------------------------------------------------

test('8. normTitle: lowercase, date forms, punctuation collapse, generic words', () => {
  assert.equal(normTitle('Fix The LOGIN Page'), 'fix the login page');
  assert.equal(normTitle('2026-10-28 fix login'), 'fix login');
  assert.equal(normTitle('20261028 fix login'), 'fix login');
  assert.equal(normTitle('2026-10-28T09:30:00 fix'), 'fix');
  assert.equal(normTitle('2026-10-28_0930 fix'), 'fix');
  assert.equal(normTitle('  2026-10-28 09:30 fix'), 'fix');
  assert.equal(normTitle('Foo -- Bar!'), 'foo bar');
  assert.equal(normTitle('a_b/c.d'), 'a b c d');
  assert.equal(normTitle('wip'), '');
  assert.equal(normTitle('WIP'), '');
  assert.equal(normTitle('Save'), '');
  assert.equal(normTitle('Checkpoint'), '');
  assert.equal(normTitle('notes'), '');
  assert.equal(normTitle('TODO'), '');
  assert.equal(normTitle('2026-10-28 wip'), '');          // date strip first, then generic
  assert.equal(normTitle('wip: the thing'), 'wip the thing'); // not the bare generic word
  assert.equal(normTitle(''), '');
});

test('9. ticketTokens extracts from BOTH title and branch, dedup + sort, uppercase keys only', () => {
  assert.deepEqual(ticketTokens('fix #123 for PROJ-9', 'feat/ABC-1'), ['#123', 'ABC-1', 'PROJ-9']);
  assert.deepEqual(ticketTokens('same #5 again #5', 'also #5'), ['#5']);
  assert.deepEqual(ticketTokens('nothing here', 'no-tokens-either'), []);
  assert.deepEqual(ticketTokens('abc-4 lower', 'x-7'), []); // [A-Z][A-Z0-9]+- keys only
  assert.deepEqual(ticketTokens('', 'GH-10'), ['GH-10']);   // branch-only extraction
  assert.deepEqual(ticketTokens('multi #9 #1 ABC-2 ABC-10', ''), ['#1', '#9', 'ABC-10', 'ABC-2']);
});

// ---------------------------------------------------------------------------
// pointerTarget
// ---------------------------------------------------------------------------

test('10. pointerTarget parses the checkpoint field, including escapes; absent/invalid give \'\'', () => {
  assert.equal(pointerTarget(pointerJson('/state/projects/b/checkpoints/a.md', 'b', '/r')), '/state/projects/b/checkpoints/a.md');
  assert.equal(pointerTarget('{\n  "checkpoint": "C:\\\\path\\\\with\\\\quotes\\"q",\n  "bucket": "b"\n}'), 'C:\\path\\with\\quotes"q');
  assert.equal(pointerTarget('{\n  "bucket": "b"\n}'), '');
  assert.equal(pointerTarget('not json'), '');
  assert.equal(pointerTarget(''), '');
});

// ---------------------------------------------------------------------------
// stampCheckpoint: refresh-in-place, four fields, worktree conditional
// ---------------------------------------------------------------------------

test('11. stampCheckpoint prepends a frontmatter block to an unstamped file (body preserved)', t => {
  const dir = tmp(t);
  const file = write(path.join(dir, 's1.md'), 'line one\nline two\n');
  stampCheckpoint(file, { remote: 'github.com/o/r', projectRoot: '/repo', head: 'abc123' });
  assert.equal(fs.readFileSync(file, 'utf8'),
    '---\nremote: github.com/o/r\nproject_root: /repo\nhead: abc123\n---\nline one\nline two\n');
});

test('12. stampCheckpoint refreshes in place: old field lines deleted, fresh inserted, head always updated', t => {
  const dir = tmp(t);
  const file = write(path.join(dir, 's2.md'),
    '---\nremote: gitlab.com/old/thing\nproject_root: /old\nworktree: /old-wt\nhead: deadbeef\nbranch: feat/x\n---\n## Working on: t\n');
  stampCheckpoint(file, { remote: 'github.com/o/r', projectRoot: '/repo', worktree: '/wt', head: 'first1' });
  assert.equal(fs.readFileSync(file, 'utf8'),
    '---\nbranch: feat/x\nremote: github.com/o/r\nproject_root: /repo\nworktree: /wt\nhead: first1\n---\n## Working on: t\n');
  stampCheckpoint(file, { remote: 'github.com/o/r', projectRoot: '/repo', worktree: '/wt', head: 'second2' });
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after,
    '---\nbranch: feat/x\nremote: github.com/o/r\nproject_root: /repo\nworktree: /wt\nhead: second2\n---\n## Working on: t\n');
  assert.equal(after.split('\n').filter(l => l.startsWith('head:')).length, 1); // no duplicate fields
  assert.equal(after.split('\n').filter(l => l.startsWith('project_root:')).length, 1);
});

test('13. stampCheckpoint field conditionality: project_root always; remote/worktree/head only when non-empty', t => {
  const dir = tmp(t);
  const noRemote = write(path.join(dir, 's3.md'), 'x\n');
  stampCheckpoint(noRemote, { remote: '', projectRoot: '/r', worktree: '', head: '' });
  assert.equal(fs.readFileSync(noRemote, 'utf8'), '---\nproject_root: /r\n---\nx\n');
  const withWt = write(path.join(dir, 's4.md'), 'x\n');
  stampCheckpoint(withWt, { remote: '', projectRoot: '/r', worktree: '/wt', head: 'h1' });
  assert.equal(fs.readFileSync(withWt, 'utf8'), '---\nproject_root: /r\nworktree: /wt\nhead: h1\n---\nx\n');
  const empty = write(path.join(dir, 's5.md'), '');
  stampCheckpoint(empty, { remote: 'h/x/y', projectRoot: '/r', head: 'h' });
  assert.equal(fs.readFileSync(empty, 'utf8'), '---\nremote: h/x/y\nproject_root: /r\nhead: h\n---\n');
});

test('14. stampCheckpoint quirks: missing file throws; unclosed frontmatter; CRLF opener unrecognized (awk parity)', t => {
  const dir = tmp(t);
  assert.throws(() => stampCheckpoint(path.join(dir, 'nope.md'), { projectRoot: '/r' }), /no such checkpoint file/);
  // Upstream awk: a file starting with --- that never closes gets old stamps dropped and none inserted.
  const unclosed = write(path.join(dir, 's6.md'), '---\nremote: old\nbody\n');
  stampCheckpoint(unclosed, { remote: 'new', projectRoot: '/r' });
  assert.equal(fs.readFileSync(unclosed, 'utf8'), '---\nbody\n');
  // A CRLF file's "---\r" line is not the frontmatter fence (awk compares the whole record).
  const crlf = write(path.join(dir, 's7.md'), '---\r\nremote: old\r\n');
  stampCheckpoint(crlf, { remote: 'new', projectRoot: '/r' });
  assert.equal(fs.readFileSync(crlf, 'utf8'), '---\nremote: new\nproject_root: /r\n---\n---\r\nremote: old\r\n');
});

// ---------------------------------------------------------------------------
// classifyCheckpoints: multi-path status lines
// ---------------------------------------------------------------------------

test('15. classifyCheckpoints maps every path to a "<status>\\t<path>" line, skipping empties', t => {
  const dir = tmp(t);
  const id = { remote: 'github.com/o/r', projectRoot: dir };
  const match = ck(dir, 'b1', 'm.md', `remote: github.com/o/r\nproject_root: ${dir}\n`);
  const foreign = ck(dir, 'b1', 'f.md', 'remote: gitlab.com/g/p/r\n');
  const unstamped = ck(dir, 'b1', 'u.md');
  const lines = classifyCheckpoints([match, '', foreign, unstamped, ''], id);
  assert.deepEqual(lines, [
    `match\t${match}`,
    `foreign\t${foreign}`,
    `unstamped\t${unstamped}`,
  ]);
});

// ---------------------------------------------------------------------------
// checkpointsBelow: inside/outside git shapes, caps, HOME dedup
// ---------------------------------------------------------------------------

test('16. below inside git: only this bucket\'s pointers (other buckets\' checkpoints stay hidden)', t => {
  const state = tmp(t);
  const work = tmp(t);
  const target = ck(state, 'other', 't1.md', `project_root: ${work}\n`);
  write(path.join(state, 'projects', 'mine', 'checkpoint-pointers', 'p1--other.json'),
    pointerJson(target, 'other', work));
  ck(state, 'other', 'below1.md', `project_root: ${work}\n`); // would qualify, but we are inside git
  const out = checkpointsBelow(work, state, { slug: 'mine' }, { gitCommonDir: 'C:/x/.git', home: path.join(state, 'nope') });
  assert.deepEqual(out, [`POINTER ${target}`]);
});

test('17. below outside git: other buckets\' checkpoints strictly under cwd, this bucket excluded', t => {
  const state = tmp(t);
  const work = tmp(t);
  const below1 = ck(state, 'other', 'a-below1.md', `project_root: ${path.join(work, 'alpha')}\n`);
  const below2 = ck(state, 'third', 'b-below2.md', `project_root: ${work}${path.sep}sub\n`);
  ck(state, 'mine', 'c-mine.md', `project_root: ${work}\n`);      // own bucket: never listed by phase 2
  ck(state, 'other', 'd-equal.md', `project_root: ${work}\n`);    // root EQUAL to cwd: not strictly below
  ck(state, 'other', 'e-outside.md', 'project_root: /somewhere/else\n');
  ck(state, 'other', 'f-empty.md');                                // no root: skipped
  const out = checkpointsBelow(work, state, { slug: 'mine' }, { gitCommonDir: '', home: path.join(state, 'nope') });
  // Sorted by basename descending, "BELOW_CWD <path>" payloads only.
  assert.deepEqual(out, [`BELOW_CWD ${below2}`, `BELOW_CWD ${below1}`]);
});

test('18. below pointer phase: invalid targets dropped; a pointer hides the duplicate BELOW_CWD entry', t => {
  const state = tmp(t);
  const work = tmp(t);
  const ptrDir = path.join(state, 'projects', 'mine', 'checkpoint-pointers');
  const target = ck(state, 'other', 'z-pointed.md', `project_root: ${work}\n`);
  write(path.join(ptrDir, 'p1--other.json'), pointerJson(target, 'other', work));
  write(path.join(ptrDir, 'p2--other.json'), pointerJson(path.join(state, 'projects', 'other', 'checkpoints', 'missing.md'), 'other', work));
  const stray = write(path.join(work, 'stray.md'), 'x\n');
  write(path.join(ptrDir, 'p3--other.json'), pointerJson(stray, 'other', work)); // target outside projects/: invalid
  const out = checkpointsBelow(work, state, { slug: 'mine' }, { gitCommonDir: '', home: path.join(state, 'nope') });
  assert.deepEqual(out, [`POINTER ${target}`]); // phase-2 would have re-listed z-pointed.md; seen-set wins
});

test('19. below caps: 200-file read (observable through HOME per-root dedup) and head-20 output', t => {
  const state = tmp(t);
  const work = tmp(t);
  // 200 name-newest files under one shared root + 5 name-older files under unique roots.
  const shared = path.join(work, 'shared');
  for (let i = 0; i < 200; i++) ck(state, 'other', `n${String(i).padStart(3, '0')}.md`, `project_root: ${shared}\n`);
  for (let i = 0; i < 5; i++) {
    const root = write(path.join(work, `oldroot${i}`, 'keep'), '');
    ck(state, 'other', `a${String(i).padStart(3, '0')}.md`, `project_root: ${root}\n`);
  }
  const out = checkpointsBelow(work, state, { slug: 'mine' }, { gitCommonDir: '', home: work });
  // The 5 a-files fall outside the 200-file read cap, so their roots never surface;
  // HOME dedup then collapses the 200 n-files to the newest of their shared root.
  assert.equal(out.length, 1);
  assert.match(out[0], /^BELOW_CWD /);
  assert.ok(out[0].endsWith('n199.md'));

  // head-20: 25 distinct-root checkpoints under a non-HOME cwd all qualify; only 20 surface.
  const state2 = tmp(t);
  const work2 = tmp(t);
  for (let i = 0; i < 25; i++) {
    const root = write(path.join(work2, `r${String(i).padStart(2, '0')}`, 'x'), '');
    ck(state2, 'other', `f${String(i).padStart(2, '0')}.md`, `project_root: ${root}\n`);
  }
  const out2 = checkpointsBelow(work2, state2, { slug: 'mine' }, { gitCommonDir: '', home: path.join(state2, 'nope') });
  assert.equal(out2.length, 20);
  assert.ok(out2[0].endsWith('f24.md')); // newest basename first
  assert.ok(out2[19].endsWith('f05.md'));
});

// ---------------------------------------------------------------------------
// pointFrom: pointer JSON shape, validation, same-bucket silence, injected resolve
// ---------------------------------------------------------------------------

test('20. pointFrom writes {checkpoint,bucket,project_root} at projects/<start>/checkpoint-pointers/<stem>--<bucket>.json', async t => {
  const state = tmp(t);
  const startDir = fs.mkdirSync(path.join(tmp(t), 'start'), { recursive: true });
  const realState = fs.realpathSync(state);
  const target = ck(state, 'other', 'task.md', `project_root: ${path.join(realState, 'work')}\n`);
  const seen = [];
  const out = await pointFrom(startDir, target, state, async dir => { seen.push(dir); return 'start-slug'; });
  assert.deepEqual(seen, [startDir]); // the injected resolver receives the start dir itself
  const expected = path.join(state, 'projects', 'start-slug', 'checkpoint-pointers', 'task--other.json');
  assert.equal(out, expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(expected, 'utf8')), {
    checkpoint: fs.realpathSync(target),
    bucket: 'other',
    project_root: path.join(realState, 'work'),
  });
  assert.ok(fs.readFileSync(expected, 'utf8').endsWith('}\n'));
});

test('21. pointFrom same-bucket start resolves silently: returns \'\' and writes nothing', async t => {
  const state = tmp(t);
  const startDir = fs.mkdirSync(path.join(tmp(t), 'start'), { recursive: true });
  const target = ck(state, 'other', 'task.md');
  const out = await pointFrom(startDir, target, state, () => 'other');
  assert.equal(out, '');
  assert.ok(!fs.existsSync(path.join(state, 'projects', 'other', 'checkpoint-pointers')));
});

test('22. pointFrom validation: bad args, non-checkpoint locations, bad start slugs all throw', async t => {
  const state = tmp(t);
  const startDir = fs.mkdirSync(path.join(tmp(t), 'start'), { recursive: true });
  const target = ck(state, 'other', 'task.md');
  await assert.rejects(pointFrom(path.join(state, 'missing-dir'), target, state, () => 's'), /no such start directory/);
  await assert.rejects(pointFrom(startDir, path.join(state, 'no-file.md'), state, () => 's'), /no such checkpoint file/);
  const misplaced = write(path.join(state, 'projects', 'other', 'not-checkpoints', 'x.md'), 'x\n');
  await assert.rejects(pointFrom(startDir, misplaced, state, () => 's'), /is not a saved checkpoint/);
  const outside = write(path.join(tmp(t), 'loose.md'), 'x\n');
  await assert.rejects(pointFrom(startDir, outside, state, () => 's'), /is not a saved checkpoint/);
  await assert.rejects(pointFrom(startDir, target, state, () => ''), /POINT_FROM_START_SLUG_INVALID/);
  await assert.rejects(pointFrom(startDir, target, state, async () => { throw new Error('boom'); }), /POINT_FROM_RESOLVE_FAILED/);
  // A non-.md stem keeps its full name in the pointer filename.
  const notMd = write(path.join(state, 'projects', 'other', 'checkpoints', 'weird.markdown'), 'x\n');
  const out = await pointFrom(startDir, notMd, state, () => 'start-slug');
  assert.equal(path.basename(out), 'weird.markdown--other.json');
});

// ---------------------------------------------------------------------------
// newerTask: branch gate, 15-char filter, three match arms
// ---------------------------------------------------------------------------

function ntFile(dir, name, branch, title, { worktree = '', root = '/repo' } = {}) {
  const fm = `branch: ${branch}\nproject_root: ${root}\n` + (worktree ? `worktree: ${worktree}\n` : '');
  return write(path.join(dir, name), `---\n${fm}---\n## Working on: ${title}\n`);
}

test('23. newerTask: first candidate must carry the target branch, else silent \'\'', t => {
  const dir = tmp(t);
  const first = ntFile(dir, '20261028-120000-a.md', 'main', 'task one');
  const other = ntFile(dir, '20261028-130000-b.md', 'feat', 'task one');
  assert.equal(newerTask('main', [first, other], { here: '', main: '' }), `NEWER_TASK ${other}`);
  assert.equal(newerTask('main', [other, first], { here: '', main: '' }), ''); // first candidate is not 'main'
  assert.equal(newerTask('', [first], { here: '', main: '' }), '');            // empty branch arg
  assert.equal(newerTask('main', ['', '', first, other], { here: '', main: '' }), `NEWER_TASK ${other}`); // blanks skipped
});

test('24. newerTask: later candidates filtered by first-15-chars filename compare', t => {
  const dir = tmp(t);
  const first = ntFile(dir, '20261028-120000-a.md', 'main', 'shared');
  const older = ntFile(dir, '20261028-115999-b.md', 'feat', 'shared');  // prefix < first: skipped even though matching
  const equal = ntFile(dir, '20261028-120000-c.md', 'feat', 'shared');  // prefix == first: not newer
  const newer = ntFile(dir, '20261028-120001-d.md', 'feat', 'shared');
  assert.equal(newerTask('main', [first, older, equal, newer], { here: '', main: '' }), `NEWER_TASK ${newer}`);
  assert.equal(newerTask('main', [first, older, equal], { here: '', main: '' }), '');
});

test('25. newerTask arm 1: another branch\'s worktree below the main tree while we sit in it', t => {
  const dir = tmp(t);
  const main = write(path.join(tmp(t), 'repo'), '');
  const first = ntFile(dir, '20261028-120000-a.md', 'main', 'unrelated title');
  const wt = ntFile(dir, '20261028-130000-b.md', 'feat', 'totally different', { worktree: path.join(main, '.worktrees', 'feat') });
  assert.equal(newerTask('main', [first, wt], { here: main, main }), `NEWER_TASK ${wt}`);
  assert.equal(newerTask('main', [first, wt], { here: path.join(main, 'sub'), main }), ''); // we are not in the main tree
  assert.equal(newerTask('main', [first, wt], { here: main, main: '' }), '');               // worktree repo: no main
  // Empty worktree falls back to project_root.
  const byRoot = ntFile(dir, '20261028-140000-c.md', 'feat', 'zzz', { worktree: '', root: path.join(main, 'inner') });
  assert.equal(newerTask('main', [first, byRoot], { here: main, main }), `NEWER_TASK ${byRoot}`);
});

test('26. newerTask arm 2: equal non-empty normalized title; arm 3: shared ticket token from title OR branch', t => {
  const dir = tmp(t);
  const first = ntFile(dir, '20261028-120000-a.md', 'main', '2026-10-28 Fix LOGIN!');
  const titleMatch = ntFile(dir, '20261028-130000-b.md', 'feat', 'fix login');
  assert.equal(newerTask('main', [first, titleMatch], { here: '', main: '' }), `NEWER_TASK ${titleMatch}`);
  // Generic normalized titles never match (empty normTitle).
  const genericFirst = ntFile(dir, '20261028-120000-g.md', 'main', 'wip');
  const genericOther = ntFile(dir, '20261028-130000-h.md', 'feat', 'WIP');
  assert.equal(newerTask('main', [genericFirst, genericOther], { here: '', main: '' }), '');
  // Token in both titles.
  const t1 = ntFile(dir, '20261028-120000-i.md', 'main', 'start PROJ-9 kickoff');
  const t2 = ntFile(dir, '20261028-130000-j.md', 'feat', 'wrap PROJ-9 up');
  assert.equal(newerTask('main', [t1, t2], { here: '', main: '' }), `NEWER_TASK ${t2}`);
  // Token only in the first title and the other's BRANCH.
  const t3 = ntFile(dir, '20261028-120000-k.md', 'main', 'ISS-7 fix');
  const t4 = ntFile(dir, '20261028-130000-l.md', 'ISS-7', 'no shared words at all');
  assert.equal(newerTask('main', [t3, t4], { here: '', main: '' }), `NEWER_TASK ${t4}`);
  // Same branch never matches; different branch with nothing shared never matches.
  const same = ntFile(dir, '20261028-130000-m.md', 'main', 'whatever');
  const alien = ntFile(dir, '20261028-130000-n.md', 'feat', 'nothing shared');
  assert.equal(newerTask('main', [first, same, alien], { here: '', main: '' }), '');
});

// ---------------------------------------------------------------------------
// adoptLegacy: review / copy / from / dismiss
// ---------------------------------------------------------------------------

function adoptState(t, { legacy = 'old-bucket', slug = 'new-bucket' } = {}) {
  const state = tmp(t, 'gstack861-adopt-');
  return { state, legacy, slug, oldBucket: path.join(state, 'projects', legacy), newBucket: path.join(state, 'projects', slug) };
}

test('27. adoptLegacy review: nothing-to-adopt short circuits (no legacy slug, no old bucket)', async t => {
  const s = adoptState(t);
  const noLegacy = await adoptLegacy({ mode: 'review', stateRoot: s.state, slug: s.slug, legacySlug: '', identity: {} });
  assert.equal(noLegacy.code, 0);
  assert.deepEqual(noLegacy.lines, [`Nothing to adopt: this project's slug (${s.slug}) did not change.`]);
  const noBucket = await adoptLegacy({
    mode: 'review', stateRoot: s.state, slug: s.slug, legacySlug: 'gone', identity: {},
  });
  assert.equal(noBucket.code, 0);
  assert.deepEqual(noBucket.lines, [`Nothing to adopt: no earlier bucket at ${path.join(s.state, 'projects', 'gone')}.`]);
});

test('28. adoptLegacy review: labels per classification, already-present skip, non-interactive hint', async t => {
  const s = adoptState(t);
  const identity = { remote: 'github.com/o/r', projectRoot: '/repo' };
  ck(s.state, s.legacy, 'match.md', `remote: github.com/o/r\nproject_root: /repo\n`);
  ck(s.state, s.legacy, 'rootonly.md', `project_root: /repo\n`);                     // root-only compare: match, copyable
  ck(s.state, s.legacy, 'nostamp.md');                                                // unstamped: unknown, copyable
  ck(s.state, s.legacy, 'foreign.md', `remote: gitlab.com/g/p/r\n`);
  ck(s.state, s.legacy, 'present.md', `remote: github.com/o/r\n`);                    // already in new bucket
  write(path.join(s.oldBucket, 'logs', 'notes.txt'), 'plain\n');
  ck(s.state, s.slug, 'present.md', `remote: github.com/o/r\n`);                      // new bucket already holds it
  const out = await adoptLegacy({ mode: 'review', stateRoot: s.state, slug: s.slug, legacySlug: s.legacy, identity });
  assert.equal(out.code, 0);
  assert.deepEqual(out.lines, [
    `gstack now files this project under: ${s.newBucket}`,
    `Earlier data (shared nested-group bucket): ${s.oldBucket}`,
    'Nothing is copied unless you confirm it. Files:',
    '  checkpoints/foreign.md  [checkpoint: another project (not copyable)]',
    '  checkpoints/match.md  [checkpoint: matching this project]',
    '  checkpoints/nostamp.md  [checkpoint: unknown project (saved before identity stamps)]',
    '  checkpoints/present.md  [checkpoint: matching this project; already in new bucket (skipped)]',
    '  checkpoints/rootonly.md  [checkpoint: matching this project]',
    '  logs/notes.txt  [no project identity: the old bucket may be shared, check before copying]',
    'Nothing copied. Copy chosen files with: gstack-slug --adopt-legacy --copy <path> [<path>...]',
  ]);
  assert.deepEqual(out.prompts, []);
});

test('29. adoptLegacy review: injected stdin confirm copies on y/Y/yes/YES only (tty→stdin divergence)', async t => {
  const s = adoptState(t);
  const identity = { remote: 'github.com/o/r', projectRoot: '/repo' };
  ck(s.state, s.legacy, 'one.md', `remote: github.com/o/r\n`);
  ck(s.state, s.legacy, 'two.md', `remote: github.com/o/r\n`);
  ck(s.state, s.legacy, 'foreign.md', `remote: gitlab.com/g/p/r\n`);
  const answers = ['y', 'no', 'YES'];
  const out = await adoptLegacy({
    mode: 'review', stateRoot: s.state, slug: s.slug, legacySlug: s.legacy, identity,
    input: async () => answers.shift() ?? '',
  });
  // Listing order is sorted: foreign, one, two. Only the two copyable files prompt.
  assert.deepEqual(out.prompts, ['    copy into the new bucket? [y/N] ', '    copy into the new bucket? [y/N] ']);
  assert.ok(out.lines.includes('COPIED checkpoints/one.md'));
  assert.ok(!out.lines.includes('COPIED checkpoints/two.md'));
  assert.ok(fs.existsSync(path.join(s.newBucket, 'checkpoints', 'one.md')));
  assert.ok(!fs.existsSync(path.join(s.newBucket, 'checkpoints', 'two.md')));
  assert.ok(!out.lines.includes('Nothing copied. Copy chosen files with: gstack-slug --adopt-legacy --copy <path> [<path>...]'));
  // An async-iterable answer source works too.
  const s2 = adoptState(t);
  ck(s2.state, s2.legacy, 'one.md', `remote: github.com/o/r\n`);
  const out2 = await adoptLegacy({
    mode: 'review', stateRoot: s2.state, slug: s2.slug, legacySlug: s2.legacy,
    identity: { remote: 'github.com/o/r', projectRoot: '/repo' },
    input: (async function* () { yield 'yes'; })(),
  });
  assert.ok(out2.lines.includes('COPIED checkpoints/one.md'));
});

test('30. adoptLegacy copy: plain copies with cp -p parity; skips present and foreign files', async t => {
  const s = adoptState(t);
  const identity = { remote: 'github.com/o/r', projectRoot: '/repo' };
  const one = ck(s.state, s.legacy, 'one.md', `remote: github.com/o/r\n`);
  ck(s.state, s.legacy, 'foreign.md', `remote: gitlab.com/g/p/r\n`);
  ck(s.state, s.slug, 'present.md', `remote: github.com/o/r\n`);
  ck(s.state, s.legacy, 'present.md', `remote: github.com/o/r\n`); // matching, but already in the new bucket
  const deep = write(path.join(s.oldBucket, 'nested', 'deep', 'file.txt'), 'deep\n');
  const out = await adoptLegacy({
    mode: 'copy', stateRoot: s.state, slug: s.slug, legacySlug: s.legacy, identity,
    paths: ['checkpoints/one.md', 'checkpoints/present.md', 'checkpoints/foreign.md', 'nested/deep/file.txt'],
  });
  assert.equal(out.code, 0);
  assert.deepEqual(out.lines, [
    'COPIED checkpoints/one.md',
    'SKIPPED checkpoints/present.md (checkpoint: matching this project; already in new bucket (skipped))',
    'SKIPPED checkpoints/foreign.md (checkpoint: another project (not copyable))',
    'COPIED nested/deep/file.txt',
  ]);
  const copiedOne = fs.readFileSync(path.join(s.newBucket, 'checkpoints', 'one.md'), 'utf8');
  assert.equal(copiedOne, fs.readFileSync(one, 'utf8'));
  // cp -p parity: pin the source mtime to a fixed past date; the copy must carry it over.
  const past = new Date('2020-01-02T03:04:05Z');
  fs.utimesSync(one, past, past);
  const oneCopy = path.join(s.newBucket, 'checkpoints', 'one2.md');
  write(path.join(s.oldBucket, 'checkpoints', 'one2.md'), 'two\n');
  fs.utimesSync(path.join(s.oldBucket, 'checkpoints', 'one2.md'), past, past);
  await adoptLegacy({
    mode: 'copy', stateRoot: s.state, slug: s.slug, legacySlug: s.legacy, identity, paths: ['checkpoints/one2.md'],
  });
  assert.equal(fs.statSync(oneCopy).mtimeMs, past.getTime());
  assert.equal(fs.readFileSync(path.join(s.newBucket, 'nested', 'deep', 'file.txt'), 'utf8'), 'deep\n');
});

test('31. adoptLegacy copy: traversal guards and non-inside paths are REFUSED, exit code 1', async t => {
  const s = adoptState(t);
  write(path.join(s.oldBucket, 'plain.md'), 'x\n');
  for (const bad of ['../escape.md', 'a/./b.md', 'a//b.md', '/abs/path.md', '', 'sub/../../up.md']) {
    const out = await adoptLegacy({
      mode: 'copy', stateRoot: s.state, slug: s.slug, legacySlug: s.legacy, identity: {},
      paths: [bad],
    });
    assert.equal(out.code, 1, bad);
    assert.ok(out.lines[0].startsWith(`REFUSED ${bad} (must be a plain path relative to `), bad);
  }
  // A path that is plain but does not exist inside the bucket.
  const missing = await adoptLegacy({
    mode: 'copy', stateRoot: s.state, slug: s.slug, legacySlug: s.legacy, identity: {}, paths: ['nope.md'],
  });
  assert.equal(missing.code, 1);
  assert.match(missing.lines[0], /^REFUSED nope\.md \(not a regular file inside /);
  // A directory (not a regular file) inside the bucket.
  fs.mkdirSync(path.join(s.oldBucket, 'adir'), { recursive: true });
  const dirOut = await adoptLegacy({
    mode: 'copy', stateRoot: s.state, slug: s.slug, legacySlug: s.legacy, identity: {}, paths: ['adir'],
  });
  assert.equal(dirOut.code, 1);
  // An absolute path that happens to point inside the bucket is still refused by the guard.
  const abs = await adoptLegacy({
    mode: 'copy', stateRoot: s.state, slug: s.slug, legacySlug: s.legacy, identity: {},
    paths: [path.join(s.oldBucket, 'plain.md')],
  });
  assert.equal(abs.code, 1);
  // Nothing was copied anywhere by any of the refused runs.
  assert.ok(!fs.existsSync(s.newBucket) || fs.readdirSync(s.newBucket).length === 0);
});

test('32. adoptLegacy copy: a symlink inside the old bucket is refused', { skip: (() => { try { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-')); fs.symlinkSync('.', path.join(d, 'l')); fs.rmSync(d, { recursive: true }); return false; } catch { return 'symlinks unavailable'; } })() }, async t => {
  const s = adoptState(t);
  write(path.join(s.oldBucket, 'real.md'), 'x\n');
  fs.symlinkSync(path.join(s.oldBucket, 'real.md'), path.join(s.oldBucket, 'link.md'));
  const out = await adoptLegacy({
    mode: 'copy', stateRoot: s.state, slug: s.slug, legacySlug: s.legacy, identity: {}, paths: ['link.md'],
  });
  assert.equal(out.code, 1);
  assert.match(out.lines[0], /^REFUSED link\.md \(not a regular file inside /);
  assert.ok(!fs.existsSync(path.join(s.newBucket, 'checkpoints', 'link.md')));
});

test('33. adoptLegacy from: migrate/unchanged/merge/conflict counters; conflicting bytes NEVER overwritten', async t => {
  const s = adoptState(t, { legacy: 'former-bucket' });
  write(path.join(s.oldBucket, 'fresh.md'), 'fresh\n');                                   // dst missing -> migrated
  write(path.join(s.oldBucket, 'same.md'), 'same\n');
  write(path.join(s.newBucket, 'same.md'), 'same\n');                                     // identical -> unchanged
  write(path.join(s.oldBucket, 'log.jsonl'), '{"a":1}\n');
  write(path.join(s.newBucket, 'log.jsonl'), '{"a":1}\n{"b":2}\n');                        // merge appends nothing -> unchanged
  write(path.join(s.oldBucket, 'other.jsonl'), '{"b":2}\n{"c":3}\n');
  write(path.join(s.newBucket, 'other.jsonl'), '{"a":1}\n{"b":2}\n');                      // merge -> migrated
  write(path.join(s.oldBucket, 'conflict.txt'), 'from-version\n');
  write(path.join(s.newBucket, 'conflict.txt'), 'to-version\n');                           // differing non-jsonl -> conflict
  const out = await adoptLegacy({ mode: 'from', stateRoot: s.state, slug: s.slug, from: s.legacy });
  assert.equal(out.code, 0);
  assert.equal(out.lines[0],
    `adopt-legacy --from ${s.legacy} into projects/${s.slug}: migrated 2, pending 0, conflicting 1, unchanged 2`);
  assert.deepEqual(out.lines.slice(1), [
    'Conflicting (both differ; nothing overwritten, compare by hand):',
    '  conflict.txt',
    `projects/${s.legacy} is kept; delete it yourself once you are satisfied.`,
  ]);
  assert.equal(fs.readFileSync(path.join(s.newBucket, 'conflict.txt'), 'utf8'), 'to-version\n'); // kept intact
  assert.equal(fs.readFileSync(path.join(s.newBucket, 'other.jsonl'), 'utf8'), '{"a":1}\n{"b":2}\n{"c":3}\n');
  assert.equal(fs.readFileSync(path.join(s.newBucket, 'fresh.md'), 'utf8'), 'fresh\n');
  assert.ok(fs.existsSync(path.join(s.oldBucket, 'fresh.md'))); // source bucket kept
});

test('34. adoptLegacy from jsonl merge is dedup-ordered: destination order first, then unseen source lines', async t => {
  const s = adoptState(t, { legacy: 'former-bucket' });
  write(path.join(s.oldBucket, 'log.jsonl'), 'b\nc\nc\nd\n');
  write(path.join(s.newBucket, 'log.jsonl'), 'a\nb\n');
  const out = await adoptLegacy({ mode: 'from', stateRoot: s.state, slug: s.slug, from: s.legacy });
  assert.equal(out.code, 0);
  assert.equal(fs.readFileSync(path.join(s.newBucket, 'log.jsonl'), 'utf8'), 'a\nb\nc\nd\n');
  // Source adds nothing but duplicates -> unchanged, no rewrite churn.
  const out2 = await adoptLegacy({
    mode: 'from', stateRoot: s.state, slug: s.slug, from: s.legacy,
  });
  assert.match(out2.lines[0], /unchanged 1$/);
});

test('35. adoptLegacy from: non-regular entries pend (exit 1); own bucket exit 2; missing bucket exit 1', async t => {
  const s = adoptState(t, { legacy: 'former-bucket' });
  const canSymlink = (() => {
    try {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lk2-'));
      fs.symlinkSync('.', path.join(d, 'l'));
      fs.rmSync(d, { recursive: true });
      return true;
    } catch { return false; }
  })();
  write(path.join(s.oldBucket, 'fine.md'), 'x\n');
  if (canSymlink) fs.symlinkSync(path.join(s.oldBucket, 'fine.md'), path.join(s.oldBucket, 'dangling-case.md'));
  const out = await adoptLegacy({ mode: 'from', stateRoot: s.state, slug: s.slug, from: s.legacy });
  if (canSymlink) {
    assert.equal(out.code, 1);
    assert.ok(out.lines.includes('Pending (left in projects/former-bucket):'));
    assert.ok(out.lines.includes('  dangling-case.md (not a regular file; review by hand)'));
  } else {
    assert.equal(out.code, 0);
  }
  const own = await adoptLegacy({ mode: 'from', stateRoot: s.state, slug: s.slug, from: s.slug });
  assert.equal(own.code, 2);
  assert.deepEqual(own.errors, [`gstack-slug: projects/${s.slug} is this project's own bucket.`]);
  const gone = await adoptLegacy({ mode: 'from', stateRoot: s.state, slug: s.slug, from: 'no-such' });
  assert.equal(gone.code, 1);
  assert.deepEqual(gone.errors, [`gstack-slug: no bucket at ${path.join(s.state, 'projects', 'no-such')}.`]);
});

test('36. adoptLegacy from/dismiss: .former-slugs lifecycle — written off after a completed merge, dropped by dismiss', async t => {
  const s = adoptState(t, { legacy: 'former-bucket' });
  write(path.join(s.state, 'projects', s.slug, '.former-slugs'), 'former-bucket\nkeep-me\n');
  write(path.join(s.oldBucket, 'data.md'), 'x\n');
  const out = await adoptLegacy({ mode: 'from', stateRoot: s.state, slug: s.slug, from: s.legacy });
  assert.equal(out.code, 0);
  assert.equal(fs.readFileSync(path.join(s.state, 'projects', s.slug, '.former-slugs'), 'utf8'), 'keep-me\n');

  // dismiss drops the exact slug line (all copies), keeps the rest; a missing list is still success.
  write(path.join(s.state, 'projects', s.slug, '.former-slugs'), 'aaa\nformer-bucket\nbbb\nformer-bucket\n');
  const dismissed = await adoptLegacy({ mode: 'dismiss', stateRoot: s.state, slug: s.slug, dismiss: 'former-bucket' });
  assert.equal(dismissed.code, 0);
  assert.deepEqual(dismissed.lines,
    ['Dismissed projects/former-bucket; its files are kept and skill start no longer names it.']);
  assert.equal(fs.readFileSync(path.join(s.state, 'projects', s.slug, '.former-slugs'), 'utf8'), 'aaa\nbbb\n');
  const noList = await adoptLegacy({ mode: 'dismiss', stateRoot: s.state, slug: 'empty-bucket', dismiss: 'zzz' });
  assert.equal(noList.code, 0);
});

// ---------------------------------------------------------------------------
// purity: identity resolution is injected, never imported
// ---------------------------------------------------------------------------

test('37. import surface: zero imports of the Lane A resolver modules; only node: builtins', () => {
  const src = fs.readFileSync(MODULE, 'utf8');
  const specifiers = [...src.matchAll(/import\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g)].map(m => m[1]);
  const dynamic = [...src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
  const all = [...specifiers, ...dynamic];
  assert.ok(all.length > 0, 'the module imports its node builtins');
  for (const spec of all) {
    assert.ok(spec.startsWith('node:'), `unexpected non-builtin import: ${spec}`);
    assert.ok(!/(^|\/)(slug|remote-identity)\.mjs$/.test(spec), `purity violation: ${spec}`);
  }
});
