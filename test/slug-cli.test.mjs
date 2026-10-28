import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { physicalPath } from '../src/slug.mjs';

// bin/gstack861-slug.mjs under test — always a real subprocess (the CLI owns
// argv parsing, stdin wiring, exit codes and the state-root mapping, none of
// which are observable in-process). Every run is fully isolated: the state
// root points at a temp dir via GSTACK861_STATE_ROOT and HOME/USERPROFILE are
// redirected to a temp home, so no invocation can ever touch the real
// ~/.gstack861 or ~/.gstack (the final test asserts that for the whole suite).

const script = fileURLToPath(new URL('../bin/gstack861-slug.mjs', import.meta.url));
const GIT_ARGS = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] };
const git = (args, cwd) => execFileSync('git', args, { cwd, ...GIT_ARGS });

/** The real-home watch list snapshot taken before any test ran. */
const realHome = os.homedir();
const HOME_WATCH = [path.join(realHome, '.gstack861'), path.join(realHome, '.gstack')];
const homeSnapshot = () => HOME_WATCH.map((p) => {
  if (!fs.existsSync(p)) return null;
  try { return fs.readdirSync(p).sort().join(','); } catch { return 'unreadable'; }
});
const homeBefore = homeSnapshot();

function tmp(t, tag = 'gstack861-slugcli-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), tag)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** Real git fixture, origin set without any network access (b20/b21 precedent). */
function repo(t, url, name = 'repo', base) {
  const root = path.join(base ?? tmp(t), name);
  fs.mkdirSync(root);
  try { git(['init', '--initial-branch=main'], root); } catch { git(['init'], root); git(['symbolic-ref', 'HEAD', 'refs/heads/main'], root); }
  git(['remote', 'add', 'origin', url], root);
  return root;
}

function commit(root, file, content, message) {
  write(path.join(root, file), content);
  git(['add', '.'], root);
  git(['-c', 'user.name=t', '-c', 'user.email=t@ex.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', message], root);
}

/** CLI harness: temp home (HOME+USERPROFILE) + GSTACK861_STATE_ROOT override. */
function harness(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-slughome-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = path.join(tmp(t), 'state');
  const baseEnv = { ...process.env, HOME: home, USERPROFILE: home };
  const spawn = (args, { cwd, input = '', env = {} } = {}) =>
    spawnSync(process.execPath, [script, ...args], { cwd, input, env, encoding: 'utf8', timeout: 30000 });
  const run = (args, opts = {}) => spawn(args, { ...opts, env: { ...baseEnv, GSTACK861_STATE_ROOT: state, ...opts.env } });
  const runNoOverride = (args, opts = {}) => {
    const env = { ...baseEnv, ...opts.env };
    delete env.GSTACK861_STATE_ROOT;
    return spawn(args, { ...opts, env });
  };
  return { home, state, run, runNoOverride };
}

/** KEY=VALUE lines → object (values may contain '='; keys never do). */
const fields = (out) => Object.fromEntries(
  out.split(/\r?\n/).filter(l => l !== '').map((l) => {
    const at = l.indexOf('=');
    return [l.slice(0, at), l.slice(at + 1)];
  }),
);

/** Inverse of the CLI's %q rule for assertions. */
const unquote = (v) => (v.startsWith("'") && v.endsWith("'") && v.length >= 2
  ? v.slice(1, -1).replaceAll("'\\''", "'")
  : v);

test('1. default mode prints SLUG=/BRANCH= (slash-sanitized branch, env pin, outside-git fallback)', t => {
  const { run } = harness(t);
  const base = tmp(t);
  const root = repo(t, 'https://github.com/garrytan/gstack.git', 'repo', base);
  commit(root, 'README.md', 'x\n', 'fixture');
  const r1 = run([], { cwd: root });
  assert.equal(r1.status, 0);
  assert.equal(r1.stdout, 'SLUG=garrytan-gstack\nBRANCH=main\n');
  git(['checkout', '-b', 'feat/x'], root);
  const r2 = run([], { cwd: root });
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout, 'SLUG=garrytan-gstack\nBRANCH=feat-x\n'); // tr '/' '-' + slug alphabet
  // $GSTACK_PROJECT_SLUG pins and sanitizes through the CLI.
  const r3 = run([], { cwd: root, env: { GSTACK_PROJECT_SLUG: 'my slug!' } });
  assert.equal(r3.status, 0);
  assert.equal(r3.stdout, 'SLUG=myslug\nBRANCH=feat-x\n');
  // Outside git: rule 4 basename + unknown branch.
  const plain = path.join(base, 'plainfolder');
  fs.mkdirSync(plain);
  const r4 = run([], { cwd: plain });
  assert.equal(r4.status, 0);
  assert.equal(r4.stdout, 'SLUG=plainfolder\nBRANCH=unknown\n');
});

test('2. --identity prints the full field set; %q wraps only shell-special values; empty fields stay raw', t => {
  const { run, state } = harness(t);
  const base = tmp(t);
  // A space in the checkout path forces single-quoting on every platform.
  const root = repo(t, 'https://github.com/garrytan/gstack.git', 're po', base);
  commit(root, 'README.md', 'x\n', 'fixture');
  const r = run(['--identity'], { cwd: root });
  assert.equal(r.status, 0);
  const f = fields(r.stdout);
  assert.equal(f.SLUG, 'garrytan-gstack');
  assert.equal(f.BRANCH, 'main');
  assert.equal(f.PROJECT_REMOTE, 'github.com/garrytan/gstack'); // shell-safe ASCII: raw
  assert.ok(f.PROJECT_ROOT.startsWith("'") && f.PROJECT_ROOT.endsWith("'"), 'space → single-quoted');
  assert.equal(unquote(f.PROJECT_ROOT), physicalPath(root));
  assert.equal(f.LEGACY_SLUG, ''); // upstream echo: raw empty, not ''
  assert.equal(f.FORMER_SLUGS, ''); // native field (ledger 5): raw empty
  // 3+-segment remote: LEGACY_SLUG names the pre-#3003 bucket.
  const gl = repo(t, 'https://gitlab.com/customer-a/product/repo.git', 'gl', base);
  const rg = run(['--identity'], { cwd: gl });
  assert.equal(rg.status, 0);
  const fg = fields(rg.stdout);
  assert.equal(fg.SLUG, 'product-repo-5eca1fe041984543');
  assert.equal(fg.LEGACY_SLUG, 'product-repo');
  assert.equal(fg.FORMER_SLUGS, '');
  // Live former buckets surface space-joined.
  write(path.join(state, 'projects', 'garrytan-gstack', '.former-slugs'), 'old-a\nold-b\n');
  write(path.join(state, 'projects', 'old-a', 'checkpoints', 'x.md'), 'x\n');
  write(path.join(state, 'projects', 'old-b', 'checkpoints', 'y.md'), 'y\n');
  const again = run(['--identity'], { cwd: root });
  assert.equal(fields(again.stdout).FORMER_SLUGS, 'old-a old-b');
});

test('3. --get whitelist: six names print one raw value; anything else is usage + exit 2', t => {
  const { run, state } = harness(t);
  const base = tmp(t);
  const root = repo(t, 'https://github.com/garrytan/gstack.git', 'repo', base);
  commit(root, 'README.md', 'x\n', 'fixture');
  write(path.join(state, 'projects', 'garrytan-gstack', '.former-slugs'), 'old-a\n');
  write(path.join(state, 'projects', 'old-a', 'checkpoints', 'x.md'), 'x\n');
  // --get always prints the RAW value (upstream printf '%s\n'; %q is --identity-only).
  const cases = [
    ['SLUG', 'garrytan-gstack'],
    ['BRANCH', 'main'],
    ['PROJECT_REMOTE', 'github.com/garrytan/gstack'],
    ['PROJECT_ROOT', physicalPath(root)],
    ['LEGACY_SLUG', ''], // empty identity field still prints ONE empty line (printf '%s\n')
    ['FORMER_SLUGS', 'old-a'], // one slug per line; never joined here
  ];
  for (const [name, value] of cases) {
    const r = run(['--get', name], { cwd: root });
    assert.equal(r.status, 0, name);
    assert.equal(r.stdout, `${value}\n`, name);
  }
  // No former buckets at all: --get FORMER_SLUGS prints NOTHING (upstream while-read shape).
  const plain = path.join(base, 'noformer');
  fs.mkdirSync(plain);
  const none = run(['--get', 'FORMER_SLUGS'], { cwd: plain });
  assert.equal(none.status, 0);
  assert.equal(none.stdout, '');
  // Rejected names (including the empty string) → usage on stderr, exit 2.
  for (const bad of ['BOGUS', 'slug', '']) {
    const r = run(['--get', bad], { cwd: root });
    assert.equal(r.status, 2, bad);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'usage: gstack861-slug --get SLUG|BRANCH|PROJECT_REMOTE|PROJECT_ROOT|LEGACY_SLUG|FORMER_SLUGS\n');
  }
});

test('4. --stamp-checkpoint writes remote/project_root/head and REFRESHES head on the second call', t => {
  const { run } = harness(t);
  const base = tmp(t);
  const root = repo(t, 'https://github.com/garrytan/gstack.git', 'repo', base);
  commit(root, 'README.md', 'x\n', 'first');
  const ckpt = path.join(base, 'ck.md');
  fs.writeFileSync(ckpt, '## Working on: t\n');
  const head1 = git(['rev-parse', 'HEAD'], root).trim();
  const r1 = run(['--stamp-checkpoint', ckpt], { cwd: root });
  assert.equal(r1.status, 0);
  assert.equal(r1.stdout, '');
  // Stamping from the repo root: toplevel == project root → no worktree line.
  assert.equal(fs.readFileSync(ckpt, 'utf8'),
    `---\nremote: github.com/garrytan/gstack\nproject_root: ${physicalPath(root)}\nhead: ${head1}\n---\n## Working on: t\n`);
  commit(root, 'README.md', 'y\n', 'second');
  const r2 = run(['--stamp-checkpoint', ckpt], { cwd: root });
  assert.equal(r2.status, 0);
  const head2 = git(['rev-parse', 'HEAD'], root).trim();
  assert.equal(fs.readFileSync(ckpt, 'utf8'),
    `---\nremote: github.com/garrytan/gstack\nproject_root: ${physicalPath(root)}\nhead: ${head2}\n---\n## Working on: t\n`);
  // Missing file: lib's upstream-parity message on stderr, exit 1.
  const r3 = run(['--stamp-checkpoint', path.join(base, 'nope.md')], { cwd: root });
  assert.equal(r3.status, 1);
  assert.equal(r3.stderr, `gstack-slug: no such checkpoint file: ${path.join(base, 'nope.md')}\n`);
  // Missing argument: usage exit 2.
  const r4 = run(['--stamp-checkpoint'], { cwd: root });
  assert.equal(r4.status, 2);
  assert.equal(r4.stderr, 'usage: gstack861-slug --stamp-checkpoint <file>\n');
});

test('5. --classify-checkpoints reads paths on stdin; empty lines skipped, unterminated tail still read', t => {
  const { run } = harness(t);
  const base = tmp(t);
  const root = repo(t, 'https://github.com/garrytan/gstack.git', 'repo', base);
  commit(root, 'README.md', 'x\n', 'fixture');
  const match = write(path.join(base, 'match.md'),
    `---\nremote: github.com/garrytan/gstack\nproject_root: ${physicalPath(root)}\n---\nbody\n`);
  const foreign = write(path.join(base, 'foreign.md'), '---\nremote: gitlab.com/g/p/r\n---\nbody\n');
  const unstamped = write(path.join(base, 'unstamped.md'), 'no frontmatter\n');
  const r = run(['--classify-checkpoints'], { cwd: root, input: `${match}\n${foreign}\n${unstamped}\n` });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `match\t${match}\nforeign\t${foreign}\nunstamped\t${unstamped}\n`);
  // `read -r || [[ -n ]]` parity: blank lines dropped, final line without \n still classified.
  const r2 = run(['--classify-checkpoints'], { cwd: root, input: `\n${match}\n\n${foreign}` });
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout, `match\t${match}\nforeign\t${foreign}\n`);
});

test('6. --checkpoints-below: inside git only pointers; outside git other buckets surface below the cwd', t => {
  const { run, state } = harness(t);
  const base = tmp(t);
  const root = repo(t, 'https://github.com/garrytan/gstack.git', 'repo', base);
  commit(root, 'README.md', 'x\n', 'fixture');
  const inner = path.join(root, 'inner');
  fs.mkdirSync(inner);
  const target = write(path.join(state, 'projects', 'other', 'checkpoints', 't1.md'),
    `---\nproject_root: ${inner}\n---\nx\n`);
  write(path.join(state, 'projects', 'other', 'checkpoints', 'below1.md'),
    `---\nproject_root: ${inner}\n---\nx\n`);
  write(path.join(state, 'projects', 'garrytan-gstack', 'checkpoint-pointers', 'p1--other.json'),
    `${JSON.stringify({ checkpoint: fs.realpathSync(target), bucket: 'other', project_root: inner }, null, 2)}\n`);
  // Inside git: the pointer always shows; other buckets' checkpoints are hidden.
  const inside = run(['--checkpoints-below'], { cwd: root });
  assert.equal(inside.status, 0);
  assert.equal(inside.stdout, `POINTER ${fs.realpathSync(target)}\n`);
  // Outside git in a plain dir: only checkpoints whose project_root lies strictly below the cwd.
  const work = path.join(base, 'workarea');
  fs.mkdirSync(path.join(work, 'sub'), { recursive: true });
  const b1 = write(path.join(state, 'projects', 'other', 'checkpoints', 'a-b1.md'),
    `---\nproject_root: ${path.join(work, 'sub')}\n---\nx\n`);
  const outside = run(['--checkpoints-below'], { cwd: work });
  assert.equal(outside.status, 0);
  assert.equal(outside.stdout, `BELOW_CWD ${b1}\n`); // t1/below1 root at root/inner, not below workarea
});

test('7. --point-from writes POINTER_WRITTEN via the real resolver; same-bucket start is silent exit 0', t => {
  const { run, state } = harness(t);
  const base = tmp(t);
  const root = repo(t, 'https://github.com/garrytan/gstack.git', 'repo', base);
  commit(root, 'README.md', 'x\n', 'fixture');
  const start = repo(t, 'https://github.com/garrytan/other.git', 'start', base);
  const ckpt = write(path.join(state, 'projects', 'garrytan-gstack', 'checkpoints', 'task.md'), '## Working on: t\n');
  const r = run(['--point-from', start, ckpt], { cwd: base });
  assert.equal(r.status, 0);
  const expected = path.join(state, 'projects', 'garrytan-other', 'checkpoint-pointers', 'task--garrytan-gstack.json');
  assert.equal(r.stdout, `POINTER_WRITTEN ${expected}\n`);
  assert.deepEqual(JSON.parse(fs.readFileSync(expected, 'utf8')), {
    checkpoint: fs.realpathSync(ckpt),
    bucket: 'garrytan-gstack',
    project_root: '', // no frontmatter in the fixture checkpoint
  });
  // Start dir already files into the checkpoint's bucket → silent success.
  const r2 = run(['--point-from', start, ckpt], { cwd: base, env: { GSTACK_PROJECT_SLUG: 'garrytan-gstack' } });
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout, '');
  // Argument validation mirrors upstream: usage exit 2; bad start dir exit 1.
  const r3 = run(['--point-from', start], { cwd: base });
  assert.equal(r3.status, 2);
  assert.equal(r3.stderr, 'usage: gstack861-slug --point-from <start dir> <checkpoint file>\n');
  const r4 = run(['--point-from', path.join(base, 'nodir'), ckpt], { cwd: base });
  assert.equal(r4.status, 1);
  assert.match(r4.stderr, /no such start directory/);
});

test('8. --newer-task: equal normalized title names the newer other-branch save; branch gate stays silent', t => {
  const { run, state } = harness(t);
  const base = tmp(t);
  const plain = path.join(base, 'plain'); // outside git → here='' main='' (title arm only)
  fs.mkdirSync(plain);
  const dir = path.join(state, 'projects', 'x', 'checkpoints');
  const first = write(path.join(dir, '20261028-120000-a.md'), '---\nbranch: main\n---\n## Working on: Fix LOGIN!\n');
  const newer = write(path.join(dir, '20261028-130000-b.md'), '---\nbranch: feat\n---\n## Working on: fix login\n');
  const r = run(['--newer-task', 'main'], { cwd: plain, input: `${first}\n${newer}\n` });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `NEWER_TASK ${newer}\n`);
  // The FIRST candidate must carry the target branch, else silent exit 0.
  const gate = run(['--newer-task', 'main'], { cwd: plain, input: `${newer}\n${first}\n` });
  assert.equal(gate.status, 0);
  assert.equal(gate.stdout, '');
});

test('9. --adopt-legacy: review confirms on stdin; usage errors exit 2; --from codes; --dismiss drops the slug', t => {
  const { run, state } = harness(t);
  const base = tmp(t);
  const gl = repo(t, 'https://gitlab.com/customer-a/product/repo.git', 'gl', base);
  commit(gl, 'README.md', 'x\n', 'fixture');
  const slug = 'product-repo-5eca1fe041984543';
  const legacy = 'product-repo';
  write(path.join(state, 'projects', legacy, 'checkpoints', 'match.md'),
    `---\nremote: gitlab.com/customer-a/product/repo\nproject_root: ${physicalPath(gl)}\n---\nx\n`);
  write(path.join(state, 'projects', legacy, 'checkpoints', 'foreign.md'), '---\nremote: github.com/o/r\n---\nx\n');
  write(path.join(state, 'projects', legacy, 'logs', 'note.txt'), 'n\n');
  // Review: the match checkpoint and the identity-free note prompt; 'y' copies only the first.
  const r = run(['--adopt-legacy'], { cwd: gl, input: 'y\nn\n' });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('    copy into the new bucket? [y/N] '), 'stdin-wired prompt');
  assert.ok(r.stdout.includes('COPIED checkpoints/match.md'));
  assert.ok(!r.stdout.includes('COPIED logs/note.txt'));
  assert.ok(r.stdout.includes('[checkpoint: another project (not copyable)]'));
  assert.ok(fs.existsSync(path.join(state, 'projects', slug, 'checkpoints', 'match.md')));
  // A declined second review copies nothing (match.md is now already-present → skipped, no prompt).
  const r2 = run(['--adopt-legacy'], { cwd: gl, input: 'no\n' });
  assert.equal(r2.status, 0);
  assert.ok(!r2.stdout.includes('COPIED '));
  // Usage errors: --copy without paths, unknown sub-arg, missing/empty/dot slug.
  for (const args of [['--adopt-legacy', '--copy'], ['--adopt-legacy', '--bogus'],
    ['--adopt-legacy', '--from'], ['--adopt-legacy', '--from', '.'], ['--adopt-legacy', '--dismiss', '']]) {
    const u = run(args, { cwd: gl });
    assert.equal(u.status, 2, args.join(' '));
    assert.match(u.stderr, /^usage: gstack861-slug --adopt-legacy/);
  }
  // --from: missing bucket exit 1 (stderr), own bucket exit 2, happy merge exit 0.
  const missing = run(['--adopt-legacy', '--from', 'no-such-bucket'], { cwd: gl });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no bucket at/);
  const own = run(['--adopt-legacy', '--from', slug], { cwd: gl });
  assert.equal(own.status, 2);
  assert.match(own.stderr, /own bucket/);
  const former = 'former-bucket';
  write(path.join(state, 'projects', former, 'data.md'), 'd\n');
  const merge = run(['--adopt-legacy', '--from', former], { cwd: gl });
  assert.equal(merge.status, 0);
  assert.match(merge.stdout,
    new RegExp(`adopt-legacy --from ${former} into projects/${slug}: migrated 1, pending 0, conflicting 0, unchanged 0`));
  assert.ok(fs.existsSync(path.join(state, 'projects', slug, 'data.md')));
  // --dismiss drops the exact slug line; message + exit 0.
  write(path.join(state, 'projects', slug, '.former-slugs'), `${former}\nkeep-me\n`);
  const dis = run(['--adopt-legacy', '--dismiss', former], { cwd: gl });
  assert.equal(dis.status, 0);
  assert.equal(dis.stdout, `Dismissed projects/${former}; its files are kept and skill start no longer names it.\n`);
  assert.equal(fs.readFileSync(path.join(state, 'projects', slug, '.former-slugs'), 'utf8'), 'keep-me\n');
});

test('10. --help/-h port the usage block; unknown argument is exit 2', t => {
  const { run } = harness(t);
  for (const flag of ['--help', '-h']) {
    const r = run([flag], { cwd: os.tmpdir() });
    assert.equal(r.status, 0, flag);
    assert.ok(r.stdout.includes('gstack861-slug — print SLUG=<project slug> and BRANCH=<branch>'));
    assert.ok(r.stdout.includes('--adopt-legacy --dismiss S'));
    assert.ok(r.stdout.includes('GSTACK861_STATE_ROOT'), 'state-root mapping documented');
    assert.ok(r.stdout.endsWith('\n'));
  }
  const bad = run(['--bogus'], { cwd: os.tmpdir() });
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, '');
  assert.equal(bad.stderr, 'gstack861-slug: unknown argument: --bogus (try --help)\n');
});

test('11. isolation: writes land in GSTACK861_STATE_ROOT or the redirected default, never the real home', t => {
  const { home, state, run, runNoOverride } = harness(t);
  const base = tmp(t);
  const root = repo(t, 'https://github.com/garrytan/gstack.git', 'repo', base);
  commit(root, 'README.md', 'x\n', 'fixture');
  // Override active: state goes to the temp root; the redirected home grows nothing.
  const r = run([], { cwd: root });
  assert.equal(r.status, 0);
  assert.ok(fs.existsSync(path.join(state, 'slug-cache')), 'cache written under the override root');
  assert.ok(!fs.existsSync(path.join(home, '.gstack861')), 'env override wins over the default root');
  assert.ok(!fs.existsSync(path.join(home, '.gstack')), 'never ~/.gstack');
  // Override absent: the default root maps to <home>/.gstack861 with the redirected home.
  const d = runNoOverride([], { cwd: root });
  assert.equal(d.status, 0);
  assert.ok(fs.readdirSync(path.join(home, '.gstack861', 'slug-cache')).length > 0, 'default root is ~/.gstack861');
  assert.ok(!fs.existsSync(path.join(home, '.gstack')));
  // The REAL home watched locations are exactly what they were before the suite ran.
  assert.deepEqual(homeSnapshot(), homeBefore, 'real ~/.gstack861 and ~/.gstack untouched by this suite');
});
