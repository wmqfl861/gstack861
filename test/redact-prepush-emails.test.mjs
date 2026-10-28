// gstack861-redact-prepush: which email addresses the push guard reports, and
// where it says they are (#3060, CEO-7, CEO-23, DX-9, DX-17, ENG-8).
//
// Upstream lineage: gstack test/redact-prepush-emails.test.ts @
// upstream.lock.json commit 5755601dac5d35ebd7dde181fdefe52a023c73d9
// (403 lines). Lane C, batch 23. Adaptation is harness-only (bun:test →
// node:test; spawnSync("bun", [REDACT, …]) → spawnSync(process.execPath,
// [REDACT, …]); Bun.which("git") → the whichGit() PATH scan below;
// ./helpers/git-env semantics kept in baseEnv). Every assert value and every
// fixture step is untouched.
//
// Harness divergences beyond the bun→node swap (plan 审计划必改落实 5 + 7):
//   - baseEnv also pins GSTACK861_STATE_ROOT at a temp dir inside the fixture
//     root: the installed hook runs on every fixture `git push`, and the skip
//     log it could write must never land in the real ~/.gstack861.
//   - `git init -b main` gets the b20/b22 try/catch fallback for
//     git < 2.28.
//   - The two stubGitLog tests keep upstream's win32 skip (node:test
//     {skip: reason} form): the stub is a POSIX `#!/bin/sh` file named `git`
//     placed first on PATH, and Windows CreateProcess cannot exec it — see the
//     comment at the test. Lane B's win32 triage found ZERO skips needed for
//     the sh/bash-hook surfaces (Git-for-Windows ships sh/bash on PATH); these
//     two are the other class: a stub the process launcher itself must exec.
//
// An address that is the pusher's own, or already sits in the destination's
// commit metadata, is not a new leak, so `pii.email` must not report it. Every
// relaxation here has a paired control that still reports: a stranger's
// address, an address only another remote knows, a URL push that cannot vouch
// for tracking refs, and a HIGH secret next to an allowed address.
//
// The fixtures are real repositories with explicit per-commit identities and
// an isolated git config, so the machine's own identity can never leak in.
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PREPUSH = fileURLToPath(new URL('../bin/gstack861-redact-prepush.mjs', import.meta.url));
const REDACT = fileURLToPath(new URL('../bin/gstack861-redact.mjs', import.meta.url));
const ZERO = '0'.repeat(40);
const AWS_KEY = ['AKIA', '1234567890ABCDEF'].join('');
// Fixture addresses are assembled at runtime so this file's own pushed diff
// carries no address literal for the repo's pre-push scan to list.
const at = (name) => `${name}@corp.io`;
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function baseEnv(root) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^GIT_(AUTHOR|COMMITTER)_/.test(k) || k.startsWith('GSTACK_REDACT_PREPUSH')) continue;
    env[k] = v;
  }
  const globalConfig = path.join(root, 'global.gitconfig');
  if (!fs.existsSync(globalConfig)) fs.writeFileSync(globalConfig, '');
  // GSTACK861_STATE_ROOT (harness divergence): any skip log the installed
  // hook writes during fixture pushes stays inside the throwaway root.
  return { ...env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GSTACK861_STATE_ROOT: path.join(root, 'state') };
}

/** b20/b22 fixture precedent: `init -b` needs git >= 2.28; fall back below. */
function initRepo(fx, cwd) {
  try { git(fx, cwd, ['init', '-q', '-b', 'main']); }
  catch {
    git(fx, cwd, ['init', '-q']);
    git(fx, cwd, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
}

function initBareMain(fx, cwd, target) {
  try { git(fx, cwd, ['init', '--bare', '-q', '-b', 'main', target]); }
  catch {
    git(fx, cwd, ['init', '--bare', '-q', target]);
    git(fx, target, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
}

function git(fx, cwd, args, extraEnv = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...fx.env, ...extraEnv }, timeout: 60_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function as(email) {
  return { GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: email };
}

let clock = 1_800_000_000;

/**
 * Commit `file` as `email`. The commit object is written by hand rather than
 * by `git commit`, so a git wrapper that exports its own GIT_AUTHOR_* (some CI
 * and agent machines do) cannot replace the identity under test.
 */
function commitFile(fx, cwd, file, body, email = at('me')) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), body);
  git(fx, cwd, ['add', file]);
  const tree = git(fx, cwd, ['write-tree']);
  const parent = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd, encoding: 'utf8', env: fx.env, timeout: 30_000 }).stdout?.trim();
  const stamp = `${clock++} +0000`;
  const object = [`tree ${tree}`, ...(parent ? [`parent ${parent}`] : []), `author Someone <${email}> ${stamp}`, `committer Someone <${email}> ${stamp}`, '', `edit ${file}`, ''].join('\n');
  const made = spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd, input: object, encoding: 'utf8', env: fx.env, timeout: 30_000 });
  if (made.status !== 0) throw new Error(`hash-object failed: ${made.stderr}`);
  const sha = made.stdout.trim();
  git(fx, cwd, ['update-ref', 'HEAD', sha]);
  return sha;
}

/** A working repo with an origin that already holds one seed commit, and the managed hook installed. */
function fixture(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepush-emails-'));
  roots.push(root);
  const fx = { root, repo: path.join(root, 'repo'), origin: path.join(root, 'origin.git'), env: baseEnv(root) };
  fs.mkdirSync(fx.repo);
  initBareMain(fx, root, fx.origin);
  initRepo(fx, fx.repo);
  git(fx, fx.repo, ['config', 'user.name', 'Me']);
  if (opts.selfEmail !== null) git(fx, fx.repo, ['config', 'user.email', opts.selfEmail ?? at('me')]);
  git(fx, fx.repo, ['remote', 'add', 'origin', fx.origin]);
  if (opts.seed !== false) {
    commitFile(fx, fx.repo, 'README.md', 'seed\n', 'seed@example.com');
    git(fx, fx.repo, ['push', '-q', 'origin', 'main']);
  }
  const install = spawnSync(process.execPath, [REDACT, 'install-prepush-hook'], { cwd: fx.repo, encoding: 'utf8', env: fx.env, timeout: 30_000 });
  assert.equal(install.status, 0, install.stderr);
  return fx;
}

function push(fx, args) {
  const r = spawnSync('git', ['push', ...args], { cwd: fx.repo, encoding: 'utf8', env: fx.env, timeout: 60_000 });
  return { code: r.status ?? -1, stderr: r.stderr ?? '' };
}

/** Run the hook binary directly with git's argv and stdin, for fixtures that stub `git`. */
function runHook(fx, stdin, argv, extraEnv = {}) {
  const r = spawnSync(process.execPath, [PREPUSH, ...argv], {
    cwd: fx.repo, input: stdin, encoding: 'utf8', env: { ...fx.env, ...extraEnv }, timeout: 60_000,
  });
  return { code: r.status ?? -1, stderr: r.stderr ?? '' };
}

const mediumLines = (stderr) => stderr.split('\n').filter((l) => /^\s+MEDIUM\s/.test(l));
const limitedLine = /existing-email suppression was limited for this push/;

/** A producer clone that pushes `branch` with one commit by `email` to `remote`. */
function publishForeignBranch(fx, remote, branch, email) {
  const producer = path.join(fx.root, `producer-${branch}`);
  git(fx, fx.root, ['clone', '-q', remote, producer]);
  commitFile(fx, producer, `${branch}.txt`, 'their work\n', email);
  git(fx, producer, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
}

/** Bun.which("git") replacement: first `git` file on PATH (upstream ran these under bun). */
function whichGit() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'git');
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  throw new Error('git not found');
}

describe('own and already-public addresses are not reported (#3060)', () => {
  test('the pusher\'s own address (git config user.email) is not reported', () => {
    const fx = fixture({ selfEmail: at('me') });
    commitFile(fx, fx.repo, 'AUTHORS.md', `Maintainer: ${at('me')}\n`, at('colleague'));
    const { code, stderr } = push(fx, ['origin', 'main']);
    assert.equal(code, 0);
    assert.ok(!stderr.includes('MEDIUM'));
  });

  test('an address that authored a commit the remote already has is not reported', () => {
    const fx = fixture();
    commitFile(fx, fx.repo, 'lib.txt', 'code\n', at('colleague'));
    assert.equal(push(fx, ['origin', 'main']).code, 0);
    commitFile(fx, fx.repo, 'CODEOWNERS', `* ${at('colleague')}\n`);
    const { code, stderr } = push(fx, ['origin', 'main']);
    assert.equal(code, 0);
    assert.ok(!stderr.includes('MEDIUM'));
  });

  test('an address that authors one of the pushed commits is not reported', () => {
    const fx = fixture();
    commitFile(fx, fx.repo, 'package.json', `{ "author": "${at('newcomer')}" }\n`, at('newcomer'));
    const { code, stderr } = push(fx, ['origin', 'main']);
    assert.equal(code, 0);
    assert.ok(!stderr.includes('MEDIUM'));
  });

  test('mailmapped author addresses count as already public', () => {
    const fx = fixture();
    commitFile(fx, fx.repo, 'lib.txt', 'code\n', at('old-name'));
    assert.equal(push(fx, ['origin', 'main']).code, 0);
    fs.writeFileSync(path.join(fx.repo, '.mailmap'), `Someone <${at('current')}> <${at('old-name')}>\n`);
    commitFile(fx, fx.repo, 'docs/contact.md', `Ask ${at('current')}\n`);
    const { stderr } = push(fx, ['origin', 'main']);
    assert.ok(!stderr.includes('MEDIUM'));
  });

  test('control: a stranger\'s address is reported with rule, file, line and fix, never the address', () => {
    const fx = fixture();
    commitFile(fx, fx.repo, 'notes.md', `line one\nline two\ncontact ${at('stranger')}\n`);
    const { code, stderr } = push(fx, ['origin', 'main']);
    assert.equal(code, 0);
    assert.match(stderr, /1 MEDIUM finding/);
    const lines = mediumLines(stderr);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('pii.email'));
    assert.ok(lines[0].includes('notes.md:3'));
    assert.ok(lines[0].includes('git config --add gstack.redact.allowEmail <address>'));
    assert.ok(!stderr.includes(at('stranger')));
  });

  test('control: a stranger\'s address in the first push of a repo with no history is reported', () => {
    const fx = fixture({ seed: false });
    commitFile(fx, fx.repo, 'notes.md', `contact ${at('stranger')}\n`);
    const { code, stderr } = push(fx, ['origin', 'main']);
    assert.equal(code, 0);
    const lines = mediumLines(stderr);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('notes.md:1'));
  });
});

describe('history scope follows the push destination (CEO-7, ENG-8)', () => {
  test('a new branch to a configured remote counts authors on that remote\'s tracking refs', () => {
    const fx = fixture();
    publishForeignBranch(fx, fx.origin, 'other', at('colleague'));
    git(fx, fx.repo, ['fetch', '-q', 'origin']);
    git(fx, fx.repo, ['checkout', '-q', '-b', 'feature']);
    commitFile(fx, fx.repo, 'CODEOWNERS', `* ${at('colleague')}\n`);
    const { code, stderr } = push(fx, ['origin', 'feature']);
    assert.equal(code, 0);
    assert.ok(!stderr.includes('MEDIUM'));
  });

  test('control: a URL push does not count the tracking refs of a remote that happens to match', () => {
    const fx = fixture();
    publishForeignBranch(fx, fx.origin, 'other', at('colleague'));
    git(fx, fx.repo, ['fetch', '-q', 'origin']);
    git(fx, fx.repo, ['checkout', '-q', '-b', 'feature']);
    commitFile(fx, fx.repo, 'CODEOWNERS', `* ${at('colleague')}\n`);
    const { code, stderr } = push(fx, [fx.origin, 'feature']);
    assert.equal(code, 0);
    assert.equal(mediumLines(stderr).length, 1);
  });

  test('control: an address only another remote\'s history holds is still reported', () => {
    const fx = fixture();
    const upstream = path.join(fx.root, 'upstream.git');
    initBareMain(fx, fx.root, upstream);
    git(fx, fx.repo, ['push', '-q', upstream, 'main']);
    publishForeignBranch(fx, upstream, 'other', at('private-colleague'));
    git(fx, fx.repo, ['remote', 'add', 'upstream', upstream]);
    git(fx, fx.repo, ['fetch', '-q', 'upstream']);
    git(fx, fx.repo, ['checkout', '-q', '-b', 'feature']);
    commitFile(fx, fx.repo, 'CODEOWNERS', `* ${at('private-colleague')}\n`);
    const { code, stderr } = push(fx, ['origin', 'feature']);
    assert.equal(code, 0);
    assert.equal(mediumLines(stderr).length, 1);
  });

  test('a force-push counts authors in the history of the remote tip it replaces', () => {
    const fx = fixture();
    commitFile(fx, fx.repo, 'draft.txt', 'draft\n', at('reviewer'));
    assert.equal(push(fx, ['origin', 'main']).code, 0);
    git(fx, fx.repo, ['reset', '-q', '--hard', 'HEAD~1']);
    commitFile(fx, fx.repo, 'CODEOWNERS', `* ${at('reviewer')}\n`);
    const { code, stderr } = push(fx, ['--force', 'origin', 'main']);
    assert.equal(code, 0);
    assert.ok(!stderr.includes('MEDIUM'));
  });

  test('hitting the 50,000-commit cap uses the newest authors and stays quiet about it', { timeout: 120_000 }, () => {
    const fx = fixture({ seed: false });
    const count = 50_001;
    const lines = [];
    for (let i = 1; i <= count; i++) {
      const email = i === 1 ? at('oldest') : 'filler@example.com';
      lines.push('commit refs/heads/main', `mark :${i}`, `committer Someone <${email}> ${1_700_000_000 + i} +0000`, 'data 1', 'c');
      if (i > 1) lines.push(`from :${i - 1}`);
      lines.push('');
    }
    const imported = spawnSync('git', ['fast-import', '--quiet'], {
      cwd: fx.repo, input: lines.join('\n'), encoding: 'utf8', env: fx.env, timeout: 120_000,
    });
    assert.equal(imported.status, 0, imported.stderr);
    git(fx, fx.repo, ['reset', '-q', '--hard', 'main']);
    const head = commitFile(fx, fx.repo, 'CODEOWNERS', `* ${at('oldest')}\n* ${at('newest')}\n`, at('newest'));
    const { code, stderr } = runHook(fx, `refs/heads/main ${head} refs/heads/main ${ZERO}\n`, []);
    assert.equal(code, 0);
    const found = mediumLines(stderr);
    assert.equal(found.length, 1);
    assert.ok(found[0].includes('CODEOWNERS:1'));
    assert.ok(!limitedLine.test(stderr));
  });
});

describe('each input fails on its own (CEO-23, DX-9)', () => {
  /** A `git` that fails or hangs only for `git log`, so every other call is real. */
  function stubGitLog(fx, behavior) {
    const realGit = whichGit();
    if (!realGit) throw new Error('git not found');
    const bin = path.join(fx.root, 'stub-bin');
    fs.mkdirSync(bin, { recursive: true });
    const action = behavior === 'fail' ? 'echo "fatal: stub" >&2; exit 128' : 'exec sleep 30';
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nif [ "$1" = "log" ]; then ${action}; fi\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    const pathKey = Object.keys(fx.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    return { [pathKey]: `${bin}${path.delimiter}${fx.env[pathKey] ?? ''}` };
  }

  function pushedRange(fx) {
    const base = git(fx, fx.repo, ['rev-parse', 'origin/main']);
    const head = git(fx, fx.repo, ['rev-parse', 'HEAD']);
    return `refs/heads/main ${head} refs/heads/main ${base}\n`;
  }

  test('without user.email, already-public authors are still not reported', () => {
    const fx = fixture({ selfEmail: null });
    commitFile(fx, fx.repo, 'lib.txt', 'code\n', at('colleague'));
    assert.equal(push(fx, ['origin', 'main']).code, 0);
    commitFile(fx, fx.repo, 'CODEOWNERS', `* ${at('colleague')}\n* ${at('stranger')}\n`, at('colleague'));
    const { code, stderr } = push(fx, ['origin', 'main']);
    assert.equal(code, 0);
    const found = mediumLines(stderr);
    assert.equal(found.length, 1);
    assert.ok(found[0].includes('CODEOWNERS:2'));
  });

  // stubGitLog puts a POSIX shell `git` wrapper first on PATH; Windows
  // CreateProcess cannot exec it (upstream test.skipIf(win32); kept with
  // reason per plan 审计划必改落实 7 — the stub must be exec'd by the process
  // launcher itself, which sh-on-PATH does not help, so it is structurally
  // win32-only). These two still run on the POSIX CI leg.
  for (const behavior of ['fail', 'hang']) {
    test(
      `a history read that ${behavior === 'fail' ? 'errors' : 'times out'} still honors the pusher's own address and says suppression was limited`,
      {
        timeout: 40_000,
        skip: process.platform === 'win32' ? 'POSIX-shell git stub on PATH cannot be CreateProcess-ed on win32' : false,
      },
      () => {
        const fx = fixture({ selfEmail: at('me') });
        commitFile(fx, fx.repo, 'lib.txt', 'code\n', at('colleague'));
        assert.equal(push(fx, ['origin', 'main']).code, 0);
        git(fx, fx.repo, ['fetch', '-q', 'origin']);
        commitFile(fx, fx.repo, 'CODEOWNERS', `* ${at('me')}\n* ${at('colleague')}\n`, at('colleague'));
        const started = Date.now();
        const { code, stderr } = runHook(fx, pushedRange(fx), ['origin', fx.origin], stubGitLog(fx, behavior));
        assert.ok(Date.now() - started < 25_000);
        assert.equal(code, 0);
        const found = mediumLines(stderr);
        assert.equal(found.length, 1);
        assert.ok(found[0].includes('CODEOWNERS:2'));
        assert.equal(stderr.split('\n').filter((l) => limitedLine.test(l)).length, 1);
        assert.ok(stderr.includes(behavior === 'fail' ? 'reading commit history failed' : 'reading commit history took over 5 s'));
      },
    );
  }
});

describe('per-address allowlist (DX-17)', () => {
  test('an allowed address is not reported; a different address still is', () => {
    const fx = fixture();
    git(fx, fx.repo, ['config', '--add', 'gstack.redact.allowEmail', at('Team')]);
    commitFile(fx, fx.repo, 'CONTACT.md', `${at('team')}\n${at('other')}\n`);
    const { code, stderr } = push(fx, ['origin', 'main']);
    assert.equal(code, 0);
    const found = mediumLines(stderr);
    assert.equal(found.length, 1);
    assert.ok(found[0].includes('CONTACT.md:2'));
  });

  test('a HIGH secret next to an allowed address still blocks', () => {
    const fx = fixture();
    git(fx, fx.repo, ['config', '--add', 'gstack.redact.allowEmail', at('team')]);
    commitFile(fx, fx.repo, 'deploy.env', `OWNER=${at('team')}\nkey ${AWS_KEY}\n`);
    const { code, stderr } = push(fx, ['origin', 'main']);
    assert.equal(code, 1);
    assert.ok(stderr.includes('aws.access_key'));
  });
});

describe('MEDIUM lines point at the real file line (ENG-8)', () => {
  test('separated hunks in one file report each hunk\'s own line', () => {
    const fx = fixture();
    const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    commitFile(fx, fx.repo, 'notes.md', body.join('\n') + '\n');
    assert.equal(push(fx, ['origin', 'main']).code, 0);
    body[4] = `ask ${at('first')}`;
    body[24] = `ask ${at('second')}`;
    commitFile(fx, fx.repo, 'notes.md', body.join('\n') + '\n');
    const found = mediumLines(push(fx, ['origin', 'main']).stderr);
    assert.equal(found.length, 2);
    assert.ok(found[0].includes('notes.md:5'));
    assert.ok(found[1].includes('notes.md:25'));
  });

  test('a finding past a scan chunk boundary reports its file line', () => {
    const fx = fixture();
    const filler = Array.from({ length: 20_000 }, (_, i) => `filler line ${i} ${'x'.repeat(40)}`);
    filler.push(`ask ${at('late')}`);
    commitFile(fx, fx.repo, 'big.txt', filler.join('\n') + '\n');
    const found = mediumLines(push(fx, ['origin', 'main']).stderr);
    assert.equal(found.length, 1);
    assert.ok(found[0].includes('big.txt:20001'));
  });

  test('a merge that resolves a release bump does not read its version strings as public IPs', () => {
    const fx = fixture();
    const release = (v) => `# Changelog\n\n## [${v}] - 2026-01-02\n\n- change\n`;
    commitFile(fx, fx.repo, 'VERSION', '1.0.0.0\n');
    commitFile(fx, fx.repo, 'CHANGELOG.md', release('1.0.0.0'));
    assert.equal(push(fx, ['origin', 'main']).code, 0);
    git(fx, fx.repo, ['checkout', '-q', '-b', 'feature']);
    commitFile(fx, fx.repo, 'VERSION', '1.0.1.0\n');
    const featureTip = commitFile(fx, fx.repo, 'CHANGELOG.md', release('1.0.1.0'));
    assert.equal(push(fx, ['origin', 'feature']).code, 0);
    git(fx, fx.repo, ['checkout', '-q', 'main']);
    commitFile(fx, fx.repo, 'VERSION', '1.0.2.0\n');
    const mainTip = commitFile(fx, fx.repo, 'CHANGELOG.md', release('1.0.2.0'));
    assert.equal(push(fx, ['origin', 'main']).code, 0);
    git(fx, fx.repo, ['checkout', '-q', 'feature']);
    fs.writeFileSync(path.join(fx.repo, 'VERSION'), '1.0.3.0\n');
    fs.writeFileSync(path.join(fx.repo, 'CHANGELOG.md'), release('1.0.3.0'));
    git(fx, fx.repo, ['add', 'VERSION', 'CHANGELOG.md']);
    const tree = git(fx, fx.repo, ['write-tree']);
    const stamp = `${clock++} +0000`;
    const object = [`tree ${tree}`, `parent ${featureTip}`, `parent ${mainTip}`, `author Someone <${at('me')}> ${stamp}`,
      `committer Someone <${at('me')}> ${stamp}`, '', 'merge main and re-slot', ''].join('\n');
    const merge = spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: fx.repo, input: object, encoding: 'utf8', env: fx.env, timeout: 30_000 });
    git(fx, fx.repo, ['update-ref', 'HEAD', merge.stdout.trim()]);
    const { code, stderr } = push(fx, ['origin', 'feature']);
    assert.equal(code, 0);
    assert.ok(!stderr.includes('pii.ip_public'));
  });

  test('content removed before the pushed tip names the commit that added it', () => {
    const fx = fixture();
    git(fx, fx.repo, ['checkout', '-q', '-b', 'feature']);
    commitFile(fx, fx.repo, 'notes.md', 'start\n');
    assert.equal(push(fx, ['origin', 'feature']).code, 0);
    git(fx, fx.repo, ['checkout', '-q', 'main']);
    commitFile(fx, fx.repo, 'upstream.txt', 'landed upstream\n');
    assert.equal(push(fx, ['origin', 'main']).code, 0);
    git(fx, fx.repo, ['checkout', '-q', 'feature']);
    const added = commitFile(fx, fx.repo, 'notes.md', `start\nask ${at('gone')}\n`);
    commitFile(fx, fx.repo, 'notes.md', 'start\n');
    git(fx, fx.repo, ['merge', '-q', '--no-edit', 'main'], as(at('me')));
    const found = mediumLines(push(fx, ['origin', 'feature']).stderr);
    assert.equal(found.length, 1);
    assert.ok(found[0].includes('notes.md:2'));
    assert.ok(found[0].includes(added.slice(0, 12)));
  });
});
