// bin/gstack861-issue-links.mjs e2e — the BIN vectors of upstream
// test/ship-issue-intent.test.ts (252 lines, 13 tests) at pinned submodule
// commit 5755601dac5d35ebd7dde181fdefe52a023c73d9, adapted for this repo's
// harness (batch 24 lane B, plan 审计划必改落实 item 1):
//   - bun:test → node:test; runScriptSync(BIN(name)) executing the bun bin →
//     spawnSync(process.execPath, [BIN, …]). Every assert value is untouched
//     unless noted below.
//   - The pure-lib describes (issue intent / promotion D1 / flakes D3 /
//     related D2) are lane A's against src/issue-links.mjs directly; only the
//     bin describes live here.
//
// Dropped with ledger (plan item 1):
//   - The two gstack-ship-receipt shell-out portions — upstream lines 54-56
//     (receipt write --issues @file --json embedding) and the whole test at
//     lines 207-224 (ISSUE_LINKS_MISSING refusal + body rewrite). gstack-ship-
//     receipt is out of scope for this port; the --out/--json shapes those
//     portions consumed ARE asserted here directly.
//   - Upstream tracker-guard-wiring.test.ts (repo self-scan) — out of scope,
//     no wiring scanner in this repo.
//
// win32 split (plan item 4): the gh PATH shim is a `#!/bin/sh` script named
// gh (ported from upstream test/helpers/pregate-fixture.ts lines 165-205) —
// win32 CreateProcess resolves only .exe/.cmd/.bat on PATH, so the six
// shim-fed vectors run on the POSIX leg and skip on win32 with the reason
// below. The gh-absent subset runs on BOTH legs under a constructed gh-free
// PATH (GitHub hosted runners preinstall gh on both, so absence is built:
// git's directory — shadow-symlinked when git and gh share one — plus node's).
// One upstream test needs no shim at all ("no mentions … usage"): it is
// gh-free by construction (needRepo false → zero gh spawns) and also runs on
// both legs.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TRACKER_ENVELOPE_BEGIN } from '../src/tracker-guard.mjs';

const BIN = fileURLToPath(new URL('../bin/gstack861-issue-links.mjs', import.meta.url));
const GUARD = fileURLToPath(new URL('../bin/gstack861-issue-guard.mjs', import.meta.url));
const EXIT = { ok: 0, fail: 1, usage: 2, refused: 3 };
const SHIM_SKIP = 'RC4 win32 skip: the gh PATH shim is a #!/bin/sh script named gh, and win32 CreateProcess resolves only .exe/.cmd/.bat on PATH — this vector runs on the POSIX CI leg';
const BOT = { login: 'app/github-actions', is_bot: true };
const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Fixture repo (the issue-links-relevant core of upstream
// test/helpers/pregate-fixture.ts: bare origin + working clone on 'feature',
// hermetic git identity under os.tmpdir(), outside any checkout).
// ---------------------------------------------------------------------------

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-issue-links-')));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const env = { GSTACK_HOME: home, GSTACK_STATE_DIR: home, HOME: home, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@test\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  const gitEnv = { ...process.env, ...env };
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: work, encoding: 'utf8', timeout: 30_000, env: gitEnv });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: status=${r.status} stderr=${r.stderr ?? ''}`);
    return (r.stdout ?? '').trim();
  };
  spawnSync('git', ['init', '-q', '--bare', origin], { timeout: 30_000, env: gitEnv });
  git(['init', '-q']); // defaultBranch = main from the hermetic gitconfig
  fs.writeFileSync(path.join(work, 'README.md'), '# fixture\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  git(['remote', 'add', 'origin', origin]);
  git(['push', '-q', 'origin', 'main']);
  git(['remote', 'set-head', 'origin', 'main']);
  git(['checkout', '-q', '-b', 'feature']);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, origin, work, home, env, git };
}

/** Edit files on the feature branch and commit them (the PR's own commits). */
function commit(repo, files, message = 'feat') {
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(repo.work, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', message]);
  return repo.git(['rev-parse', 'HEAD']);
}

function runBin(repo, args, extraEnv = {}, cwd = repo.work) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...repo.env, ...extraEnv } });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ---------------------------------------------------------------------------
// gh PATH shim (upstream test/helpers/pregate-fixture.ts lines 165-205,
// POSIX-only). `gh issue view <n> --json …` from the issues map, `gh issue
// list` filtered by the --search token, `gh repo view` from repo (null fails),
// the closing-PR graphql query from closing (issue → pages of nodes;
// after=c<i> reads page i; a missing issue fails like an API error) and the
// PR-author query (head=) from headAuthor / ownerType.
// ---------------------------------------------------------------------------

function ghShim(repo, data) {
  const dir = path.join(repo.root, 'gh-shim');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ issues: {}, issueList: [], runs: {}, repo: 'owner/repo', viewer: 'me', closing: {}, headAuthor: null, ownerType: 'User', ...data }));
  fs.writeFileSync(path.join(dir, 'api.js'), [
    'const d = require(process.argv[2]); const a = process.argv.slice(3);',
    'const arg = k => { const i = a.findIndex(x => x.startsWith(k + "=")); return i < 0 ? undefined : a[i].slice(k.length + 1); };',
    'if (a[0] === "repo") { if (d.repo === null) { console.error("no git remotes found"); process.exit(1); } console.log(JSON.stringify({ nameWithOwner: d.repo })); process.exit(0); }',
    'if (arg("head") !== undefined) { console.log(JSON.stringify({ data: { repository: { owner: { __typename: d.ownerType, login: d.repo.split("/")[0] }, object: d.headAuthor === null ? null : { author: { user: { login: d.headAuthor } } } } } })); process.exit(0); }',
    'const pages = d.closing[arg("number")]; if (!pages) { console.error("HTTP 502: Bad Gateway (https://api.github.com/graphql)"); process.exit(1); }',
    'const i = Number((arg("after") || "c0").slice(1));',
    'console.log(JSON.stringify({ data: { viewer: { login: d.viewer }, repository: { issue: { closedByPullRequestsReferences: { nodes: pages[i] || [], pageInfo: { hasNextPage: i + 1 < pages.length, endCursor: "c" + (i + 1) } } } } } }));',
    '',
  ].join('\n'));
  const script = [
    '#!/bin/sh',
    `DATA="${path.join(dir, 'data.json')}"`,
    'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
    '  node -e "const d=require(process.argv[1]);const p=d.issues[process.argv[2]];if(!p){console.error(\'GraphQL: Could not resolve to an Issue\');process.exit(1)}console.log(JSON.stringify(p))" "$DATA" "$3"',
    '  exit $?',
    'fi',
    '# issue list: entries whose body contains the quoted --search token (number, title, body, author: what gstack861-issue-links asks for)',
    'if [ "$1" = "issue" ] && [ "$2" = "list" ]; then node -e "const a=process.argv.slice(2);const q=(a[a.indexOf(\'--search\')+1]||\'\').replace(/^\\"|\\" in:body$/g,\'\');console.log(JSON.stringify(require(process.argv[1]).issueList.filter(i=>!q||String(i.body||\'\').includes(q))))" "$DATA" "$@"; exit $?; fi',
    `if [ "$1" = "repo" ] && [ "$2" = "view" ]; then exec node "${path.join(dir, 'api.js')}" "$DATA" repo; fi`,
    `if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then shift 2; exec node "${path.join(dir, 'api.js')}" "$DATA" "$@"; fi`,
    'echo "gh shim: unsupported $*" >&2; exit 1',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'gh'), script, { mode: 0o755 });
  return { PATH: `${dir}:${process.env.PATH ?? ''}` };
}

// ---------------------------------------------------------------------------
// A gh-free PATH for the gh-absent polarity vectors (both CI legs — GitHub
// hosted runners preinstall gh, so absence is constructed): git's directory
// (shadow-symlinked when git and gh share one, e.g. /usr/bin on ubuntu) plus
// node's. On win32 git and gh install apart; if a host defeats that, the
// tests below skip with the reason instead of lying.
// ---------------------------------------------------------------------------

function dirOnPath(name) {
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try { fs.accessSync(path.join(dir, name + ext), fs.constants.X_OK); return dir; } catch { /* keep scanning */ }
    }
  }
  return null;
}

let shadowDir = null;
const BARE = (() => {
  const gitDir = dirOnPath('git');
  if (!gitDir) return { reason: 'no git executable found on PATH' };
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat'] : [''];
  const ghBesideGit = exts.some((e) => { try { fs.accessSync(path.join(gitDir, 'gh' + e), fs.constants.X_OK); return true; } catch { return false; } });
  const dirs = [];
  if (!ghBesideGit) dirs.push(gitDir);
  else if (!IS_WIN) {
    shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-gitshadow-'));
    fs.symlinkSync(path.join(gitDir, 'git'), path.join(shadowDir, 'git'));
    dirs.push(shadowDir);
  } else return { reason: 'git and gh share a PATH directory on this win32 host' };
  dirs.push(path.dirname(process.execPath));
  if (IS_WIN && process.env.SystemRoot) dirs.push(path.join(process.env.SystemRoot, 'System32'));
  return { path: dirs.join(path.delimiter) };
})();
after(() => { if (shadowDir) fs.rmSync(shadowDir, { recursive: true, force: true }); });

/** The fixture env under the gh-free PATH, or a skip reason when it could not be built. */
function ghAbsentEnv() {
  if (BARE.reason) return { reason: BARE.reason };
  const env = { PATH: BARE.path };
  if (spawnSync('gh', ['--version'], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...env } }).status !== null) {
    return { reason: 'gh still resolves under the constructed gh-free PATH on this host' };
  }
  return { env };
}

// ---------------------------------------------------------------------------
// gstack861-issue-links (bin, gh shim — POSIX leg)
// ---------------------------------------------------------------------------

describe('gstack861-issue-links (bin, gh shim — POSIX leg)', () => {
  test('reads origin/<base>..HEAD, probes closure issues through gstack861-issue-guard, maps CI run ids to flake issues, writes the receipt object', (t) => {
    if (IS_WIN) return t.skip(SHIM_SKIP);
    const repo = fixture(t);
    commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' }, 'fix add\n\nSee #12 for context, partially fixes #13.\n\nFixes #14\nCloses: #15\nRefs other/repo#9\n');
    const env = ghShim(repo, {
      issues: { '14': { title: 't', body: 'b', comments: [] }, '16': { title: 'u', body: '', comments: [] } },
      issueList: [{ number: 40, title: 'Flake: test/util.test.js', author: BOT, body: 'Flake in https://github.com/owner/repo/actions/runs/123456' }, { number: 41, body: 'unrelated' }],
      closing: { '14': [[]], '16': [[]] },
    });
    const out = path.join(repo.work, '.gstack/tmp/issues.json');
    const r = runBin(repo, ['--base', 'main', '--ci-run', '123456', '--issue', '16', '--out', out], env);
    assert.equal(r.status, EXIT.fail);
    assert.equal(r.stdout, ['Fixes #14', 'Fixes #16', 'Refs #12', 'Refs #13', 'Refs #15 (unreadable through gstack-issue-guard; not auto-closed)', 'Refs other/repo#9', 'Flake: #40 (run 123456)', ''].join('\n'));
    assert.ok(r.stderr.includes('(#15)'));
    assert.ok(r.stderr.includes('(ISSUE_UNREADABLE)'));
    assert.ok(r.stderr.includes('closure #14 ← commit '));
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { fixes: [14, 16], refs: [12, 13, 15], flakes: [{ issue: 40, run: '123456' }] });
    // upstream lines 54-56 (gstack-ship-receipt write embedding) DROPPED — ship-receipt is out of scope; ledger in the header.
  });

  test('pages through open PRs closing a fixed issue, prints Related lines with their sources, and records owner-confirmed credit', (t) => {
    if (IS_WIN) return t.skip(SHIM_SKIP);
    const repo = fixture(t);
    commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' }, 'fix: cancel members after an uncommitted head (#30)\n\nFixes #14\n');
    const env = ghShim(repo, { issues: { '14': { title: 't', body: 'b', comments: [] }, '30': { title: 'c', body: '', comments: [] } }, closing: { '14': [[{ number: 7, state: 'OPEN', headRefName: 'contrib', author: { login: 'alice' } }, { number: 8, state: 'OPEN', headRefName: 'feature', author: { login: 'bob' } }], [{ number: 9, state: 'OPEN', headRefName: 'x', author: { login: 'me' } }, { number: 11, state: 'OPEN', headRefName: 'y', author: { login: 'carol' }, repository: { nameWithOwner: 'carol/repo' } }]] } });
    const r = runBin(repo, ['--base', 'main'], env);
    assert.equal(r.status, EXIT.ok);
    assert.equal(r.stdout, 'Fixes #14\nRefs #30\nRelated: #7 (@alice)\nRelated: carol/repo#11 (@carol)\n');
    assert.ok(r.stderr.includes('reference #30 ← commit '));
    assert.ok(r.stderr.includes('(promote: fix #30)'));
    assert.ok(r.stderr.includes('  Related: #7 (@alice) ← open PR closing #14\n'));
    const out = path.join(repo.work, '.gstack/tmp/issues.json');
    const credited = runBin(repo, ['--base', 'main', '--supersedes', '7', '--credit', '7', '--out', out, '--json'], env);
    assert.equal(credited.status, EXIT.ok);
    const j = JSON.parse(credited.stdout);
    assert.deepEqual(j.lines, ['Fixes #14', 'Refs #30', 'Supersedes #7', 'Contributed by @alice', 'Related: carol/repo#11 (@carol)']);
    assert.deepEqual(j.candidates.map((c) => c.issue), [30]);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { fixes: [14], refs: [30], flakes: [], related: [{ pr: 7, author: 'alice', closes: [14], supersedes: true, credit: true }, { pr: 11, repo: 'carol/repo', author: 'carol', closes: [14] }] });
    assert.equal(runBin(repo, ['--base', 'main', '--author', 'Alice'], env).stdout, 'Fixes #14\nRefs #30\nRelated: #9 (@me)\nRelated: carol/repo#11 (@carol)\n');
    const s99 = runBin(repo, ['--base', 'main', '--supersedes', '99'], env);
    assert.equal(s99.status, EXIT.usage);
    assert.ok(s99.stderr.includes('--supersedes #99 is not a Related PR (#7, carol/repo#11)'));
  });

  test('--no-auto-links makes no Related lookup; a failed lookup is ISSUE_LOOKUP_FAILED with its anchor and leaves the closure lines', (t) => {
    if (IS_WIN) return t.skip(SHIM_SKIP);
    const repo = fixture(t);
    commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' }, 'fix: cancel members after an uncommitted head (#30)\n\nFixes #14\n');
    const env = ghShim(repo, { issues: { '14': { title: 't', body: 'b', comments: [] }, '30': { title: 'c', body: '', comments: [] } } });
    const off = runBin(repo, ['--base', 'main', '--no-auto-links'], env);
    assert.equal(off.status, EXIT.ok);
    assert.equal(off.stdout, 'Fixes #14\nRefs #30\n');
    assert.ok(!off.stderr.includes('ISSUE_LOOKUP_FAILED'));
    const failed = runBin(repo, ['--base', 'main', '--json'], env);
    assert.equal(failed.status, EXIT.ok);
    const jf = JSON.parse(failed.stdout);
    assert.deepEqual(jf.fixes, [14]);
    assert.deepEqual(jf.unavailable, ['open PRs closing #14: HTTP 502: Bad Gateway (https://api.github.com/graphql)']);
    assert.ok(failed.stderr.includes('gstack-issue-links: gstack-issue-links could not read'));
    assert.ok(failed.stderr.includes('(ISSUE_LOOKUP_FAILED; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#issue-lookup-failed)'));
    const noRepo = ghShim(repo, { repo: null, issues: { '14': { title: 't', body: 'b', comments: [] } } });
    const r = runBin(repo, ['--base', 'main', '--ci-run', '123456', '--json'], noRepo);
    const jr = JSON.parse(r.stdout);
    assert.deepEqual(jr.flakes, []);
    assert.deepEqual(jr.unavailable, ['repository: no git remotes found']);
  });

  test('--ci-run keeps the bot flake issue and lists the refused matches', (t) => {
    if (IS_WIN) return t.skip(SHIM_SKIP);
    const repo = fixture(t);
    commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' }, 'fix: cancel members after an uncommitted head (#30)\n\nFixes #14\n');
    const env = ghShim(repo, {
      issues: { '14': { title: 't', body: 'b', comments: [] }, '30': { title: 'c', body: '', comments: [] } },
      closing: { '14': [[]] },
      issueList: [
        { number: 40, title: 'Flake: test/util.test.js', author: BOT, body: 'https://github.com/owner/repo/actions/runs/123456' },
        { number: 41, title: 'me too', author: { login: 'dev', is_bot: false }, body: 'https://github.com/owner/repo/actions/runs/123456' },
        { number: 42, title: 'Flake: test/util.test.js', author: BOT, body: 'https://github.com/elsewhere/repo/actions/runs/123456' },
      ],
    });
    const r = runBin(repo, ['--base', 'main', '--ci-run', '123456'], env);
    assert.equal(r.stdout, 'Fixes #14\nRefs #30\nFlake: #40 (run 123456)\n');
    assert.ok(r.stderr.includes('  Flake: #40 (run 123456) ← bot flake issue for test/util.test.js\n'));
    assert.ok(r.stderr.includes('  not a flake link: #41 (run 123456) ← opened by @dev, not a bot\n'));
    assert.ok(r.stderr.includes('  not a flake link: #42 (run 123456) ← names run 123456 of elsewhere/repo, not owner/repo\n'));
  });

  describe("this PR's author when gh runs as an app", () => {
    const ownPr = { number: 8, state: 'OPEN', headRefName: 'other-wave', author: { login: 'garrytan' } };
    const contrib = { number: 7, state: 'OPEN', headRefName: 'contrib', author: { login: 'alice' } };
    const setup = (t, data) => {
      const repo = fixture(t);
      commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' }, 'fix: tidy\n\nFixes #14\n');
      return { repo, env: ghShim(repo, { repo: 'garrytan/gbrain', viewer: 'capy-ai[bot]', issues: { '14': { title: 't', body: 'b', comments: [] } }, closing: { '14': [[contrib, ownPr]] }, ...data }) };
    };

    test("an app viewer is replaced by the HEAD commit author, else a user-owned repository's owner, so the owner's own PRs are not Related", (t) => {
      if (IS_WIN) return t.skip(SHIM_SKIP);
      const byCommit = setup(t, { headAuthor: 'GarryTan', ownerType: 'Organization' });
      const r = runBin(byCommit.repo, ['--base', 'main', '--json'], byCommit.env);
      const j = JSON.parse(r.stdout);
      assert.deepEqual(j.lines, ['Fixes #14', 'Related: #7 (@alice)']);
      assert.deepEqual(j.author, { login: 'GarryTan', source: 'HEAD commit author' });
      assert.deepEqual(j.unavailable, []);
      const byOwner = setup(t, {});
      const jo = JSON.parse(runBin(byOwner.repo, ['--base', 'main', '--json'], byOwner.env).stdout);
      assert.deepEqual(jo.lines, ['Fixes #14', 'Related: #7 (@alice)']);
      assert.deepEqual(jo.author, { login: 'garrytan', source: 'repository owner' });
      const ja = JSON.parse(runBin(byOwner.repo, ['--base', 'main', '--author', 'alice', '--json'], byOwner.env).stdout);
      assert.deepEqual(ja.lines, ['Fixes #14', 'Related: #8 (@garrytan)']);
      assert.deepEqual(ja.author, { login: 'alice', source: '--author' });
    });

    test('an app viewer with no user to stand in keeps every PR and reports the gap as ISSUE_LOOKUP_FAILED', (t) => {
      if (IS_WIN) return t.skip(SHIM_SKIP);
      const { repo, env } = setup(t, { ownerType: 'Organization' });
      const r = runBin(repo, ['--base', 'main', '--json'], env);
      assert.equal(r.status, EXIT.ok);
      const j = JSON.parse(r.stdout);
      assert.deepEqual(j.lines, ['Fixes #14', 'Related: #7 (@alice)', 'Related: #8 (@garrytan)']);
      assert.deepEqual(j.author, { login: 'capy-ai[bot]', source: 'gh viewer' });
      assert.deepEqual(j.unavailable, ["this PR's author: gh runs as capy-ai[bot] and neither the HEAD commit nor the repository owner names a user; pass --author <login>"]);
    });
  });
});

// ---------------------------------------------------------------------------
// gstack861-issue-links (bin, gh absent — both legs)
// ---------------------------------------------------------------------------

describe('gstack861-issue-links (bin, gh absent — both legs)', () => {
  // Upstream runs this through the shim env; every run here is gh-free by
  // construction (no --issue/--ci-run/Fixes trailer → needRepo false → zero
  // gh spawns), so it needs no shim and runs on both legs as-is.
  test('no mentions prints ISSUE_LINKS: none with exit 0; a bare mention never closes; bad flags are usage', (t) => {
    const repo = fixture(t);
    commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' }, 'tidy\n\nmentions #12 only\n');
    const r = runBin(repo, ['--base', 'main', '--json']);
    assert.equal(r.status, EXIT.ok);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(j.fixes, []);
    assert.deepEqual(j.refs, [12]);
    assert.deepEqual(j.flakes, []);
    const none = fixture(t);
    assert.equal(runBin(none, ['--base', 'main']).stdout, 'ISSUE_LINKS: none\n');
    assert.equal(runBin(none, ['--base', 'main', '--issue', 'abc']).status, EXIT.usage);
    assert.ok(runBin(none, ['--help']).stdout.includes('Exit codes: 0 ok · 1 fail · 2 usage · 3 refused or needs a flag'));
  });

  // The pinned offline --issue sequence: needRepo (explicit --issue) fails its
  // repository lookup once — ISSUE_LOOKUP_FAILED with the gh-absent polarity
  // `gh exited null` — the explicit closure issue is then unreadable through
  // the guard child (gh absent → non-zero, no envelope) and downgraded to
  // Refs; --out is mkdir-recursive + 2-space JSON + trailing newline.
  test('--issue with gh absent: repository lookup fails once (gh exited null), the closure issue downgrades to Refs (ISSUE_UNREADABLE), exit 1, --out written', (t) => {
    const bare = ghAbsentEnv();
    if (bare.reason) return t.skip(bare.reason);
    const repo = fixture(t);
    commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' }, 'fix add\n\nSee #12 for context.\n');
    const out = path.join(repo.work, '.gstack/tmp/issues.json');
    const r = runBin(repo, ['--base', 'main', '--issue', '16', '--out', out], bare.env);
    assert.equal(r.status, EXIT.fail);
    assert.ok(r.stderr.includes('gstack-issue-links could not read'));
    assert.ok(r.stderr.includes('— repository: gh exited null;'));
    assert.ok(r.stderr.includes('(ISSUE_LOOKUP_FAILED; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#issue-lookup-failed)'));
    assert.ok(r.stderr.includes('(#16)'));
    assert.ok(r.stderr.includes('(ISSUE_UNREADABLE)'));
    assert.equal(r.stdout, 'Refs #12\nRefs #16 (unreadable through gstack-issue-guard; not auto-closed)\n');
    assert.ok(r.stderr.includes('(promote: fix #12)'));
    assert.equal(fs.readFileSync(out, 'utf8'), JSON.stringify({ fixes: [], refs: [12, 16], flakes: [] }, null, 2) + '\n');
    assert.ok(fs.statSync(path.join(repo.work, '.gstack', 'tmp')).isDirectory());
  });

  // Negative assertion: without --issue / --ci-run / a Fixes trailer the bin
  // spawns NO gh at all — under a gh-free PATH any spawn would have pushed a
  // failure into `unavailable` and stderr.
  test('without closure intent the bin spawns no gh at all (unavailable stays empty, no ISSUE_LOOKUP_FAILED)', (t) => {
    const bare = ghAbsentEnv();
    if (bare.reason) return t.skip(bare.reason);
    const repo = fixture(t);
    commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' }, 'tidy\n\nmentions #12 only\n');
    const r = runBin(repo, ['--base', 'main', '--json'], bare.env);
    assert.equal(r.status, EXIT.ok);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(j.unavailable, []);
    assert.ok(!r.stderr.includes('ISSUE_LOOKUP_FAILED'));
  });

  test('the guard --stdin envelope path (offline) wraps piped tracker text', () => {
    const r = spawnSync(process.execPath, [GUARD, '--stdin', '--source', 'flake-search'], { input: 'Flake: #40 (run 123456)\n', encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes(`${TRACKER_ENVELOPE_BEGIN} (flake-search)`));
    assert.ok(r.stdout.includes('Flake: #40 (run 123456)'));
  });
});
