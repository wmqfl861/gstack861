// Pre-push hook tests (T9). Builds a throwaway local "remote" + working repo,
// drives the hook with realistic stdin ref-lines, and checks: HIGH blocks,
// MEDIUM warns (non-blocking), correct remote..local diff direction, new-branch
// zero-SHA handling, branch-delete skip, escape valve, and hook chaining.
//
// Upstream lineage: gstack test/redact-prepush-hook.test.ts @
// upstream.lock.json commit 5755601dac5d35ebd7dde181fdefe52a023c73d9
// (764 lines). Lane C, batch 23. Adaptation is harness-only (bun:test →
// node:test; spawnSync("bun", [BIN]) → spawnSync(process.execPath, [BIN]);
// ./helpers/git-env inlined; Bun.which → the whichGit() PATH scan). Every
// assert value and every fixture step is untouched.
//
// Harness divergences beyond the bun→node swap (plan 审计划必改落实 5 + 7 + 8):
//   - GSTACK_HOME → GSTACK861_STATE_ROOT for every skip-log assertion, and
//     gitEnv() pins the beforeEach stateHome by default so no spawn can write
//     the real ~/.gstack861; a per-test extra still overrides it.
//   - `git init -b` gets the b20/b22 try/catch fallback for git < 2.28.
//   - The "install UX surfaces" describe is DROPPED, not skipped — see the
//     ledger comment at its original location below.
//   - The signal-kill diff test keeps upstream's win32 skip with a stated
//     reason (node:test {skip}); everything else runs on both platforms
//     (Lane B triage: Git-for-Windows sh/bash runs the wrapper fine).
//
// We invoke bin/gstack861-redact-prepush.mjs directly with the git pre-push
// stdin protocol rather than going through `git push`, which keeps the test
// fast and deterministic while exercising the exact code path git would.
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PREPUSH = fileURLToPath(new URL('../bin/gstack861-redact-prepush.mjs', import.meta.url));
const REDACT = fileURLToPath(new URL('../bin/gstack861-redact.mjs', import.meta.url));

let repo;
let stateHome;

/**
 * Environment for fixture git commands, hook runs and installs (upstream
 * test/helpers/git-env.ts, inlined): /dev/null drops the developer's global
 * config on every platform (Git for Windows rejects the NUL device as a
 * config path, so the literal /dev/null is used), GIT_CONFIG_NOSYSTEM drops
 * the system file, GIT_CONFIG_COUNT=0 and a deleted GIT_CONFIG_PARAMETERS
 * drop env-injected config — a leaked core.hooksPath would otherwise rewrite
 * the developer's own hooks (#3353) or reject fixture pushes (#2967).
 * Harness divergence: GSTACK861_STATE_ROOT defaults to the beforeEach
 * stateHome; `extra` is merged LAST so a test's own state root still wins.
 */
function gitEnv(extra = {}) {
  const env = { ...process.env };
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_COUNT = '0';
  delete env.GIT_CONFIG_PARAMETERS;
  if (stateHome) env.GSTACK861_STATE_ROOT = stateHome;
  return { ...env, ...extra };
}

function git(args, cwd = repo) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
  return r.stdout?.trim() ?? '';
}

function commit(file, content, msg) {
  fs.writeFileSync(path.join(repo, file), content);
  git(['add', file]);
  git(['commit', '-q', '-m', msg]);
  return git(['rev-parse', 'HEAD']);
}

function runHook(stdinLines, env = {}) {
  const r = spawnSync(process.execPath, [PREPUSH], {
    cwd: repo,
    input: Buffer.from(stdinLines),
    encoding: 'utf8',
    env: gitEnv(env),
    timeout: 30_000,
  });
  return { code: r.status ?? 0, stderr: r.stderr ?? '' };
}

/**
 * Env override that puts `binDir` first on the search path, for tests that
 * shadow a real binary with a stub.
 *
 * Two portability details, both of which a hardcoded `PATH: "dir:" + ...`
 * gets wrong (mirrors `prependPath` in test/gstack-brain-context-load.test.ts):
 *   - The separator is `;` on Windows, not `:`. Using the literal produces one
 *     unparseable entry, so the stub is never found and the REAL binary runs —
 *     a test that silently passes through rather than failing loudly.
 *   - Windows env keys are case-insensitive and commonly spelled `Path`. Adding
 *     a second `PATH` key alongside an inherited `Path` leaves which one wins up
 *     to the spawn implementation, so reuse whichever key already exists.
 */
function prependPath(binDir) {
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  return { [pathKey]: `${binDir}${path.delimiter}${process.env[pathKey] || ''}` };
}

const ZERO = '0000000000000000000000000000000000000000';

// Assembled at runtime so the LITERAL never appears in a pushed diff — the
// repo's own pre-push scanner (correctly) blocks live-format AWS key shapes,
// and the placeholder-suppressed docs key would defeat these detection tests.
const FAKE_AWS_KEY = ['AKIA', '1234567890ABCDEF'].join('');

/** Bun.which("git") replacement: first `git` file on PATH (upstream ran under bun). */
function whichGit() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'git');
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  throw new Error('git not found');
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'prepush-'));
  stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'prepush-state-'));
  // b20/b22 fixture precedent: `init -b` needs git >= 2.28.
  try { git(['init', '-q', '-b', 'main']); }
  catch {
    git(['init', '-q']);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  commit('README.md', 'hello\n', 'init');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(stateHome, { recursive: true, force: true });
});

describe('pre-push hook gating', () => {
  test('HIGH credential in pushed diff blocks (exit 1)', () => {
    const base = git(['rev-parse', 'HEAD']);
    const head = commit('config.txt', 'key ' + FAKE_AWS_KEY + '\n', 'add key');
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    assert.equal(code, 1);
    assert.ok(stderr.includes('BLOCKED'));
    assert.ok(stderr.includes('aws.access_key'));
  });

  test('clean diff passes (exit 0)', () => {
    const base = git(['rev-parse', 'HEAD']);
    const head = commit('doc.md', 'just documentation\n', 'add doc');
    const { code } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    assert.equal(code, 0);
  });

  test('MEDIUM warns but does not block', () => {
    const base = git(['rev-parse', 'HEAD']);
    const head = commit('notes.md', 'contact bob@corp.io\n', 'add note');
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    assert.equal(code, 0);
    assert.ok(stderr.includes('MEDIUM'));
  });
});

// #2856: a 4-part release version is shaped like a public IPv4 address.
// Assembled at runtime so this file's own pushed diff carries no IP-shaped
// literal for the repo's pre-push scan to warn about.
const RELEASE = ['1', '84', '1', '0'].join('.');
const PUBLIC_IP = ['8', '8', '8', '8'].join('.');

describe('pushed diffs larger than the engine cap are scanned in chunks (#2915)', () => {
  const commitLarge = (tail) => {
    const base = git(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repo, 'large-a.txt'), 'clean-a '.repeat(90_000));
    fs.writeFileSync(path.join(repo, 'large-b.txt'), 'clean-b '.repeat(90_000) + tail);
    git(['add', 'large-a.txt', 'large-b.txt']);
    git(['commit', '-q', '-m', 'large diff']);
    return { base, head: git(['rev-parse', 'HEAD']) };
  };

  test('a clean two-file diff over the cap passes without input_too_large', () => {
    const { base, head } = commitLarge('');
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    assert.equal(code, 0);
    assert.ok(!stderr.includes('engine.input_too_large'));
  });

  test('a credential in a later file\'s chunk still blocks', () => {
    const { base, head } = commitLarge('\n' + FAKE_AWS_KEY + '\n');
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    assert.equal(code, 1);
    assert.ok(stderr.includes('aws.access_key'));
    assert.ok(!stderr.includes('engine.input_too_large'));
  });
});

describe('release version exemption (#2856)', () => {
  const mediums = (stderr) => Number(/(\d+) MEDIUM finding/.exec(stderr)?.[1] ?? 0);
  const commitAll = (files, msg) => {
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), content);
      git(['add', file]);
    }
    git(['commit', '-q', '-m', msg]);
    return git(['rev-parse', 'HEAD']);
  };

  test('exempts only the VERSION file and the CHANGELOG release heading, not the same address elsewhere', () => {
    const base = git(['rev-parse', 'HEAD']);
    const head = commitAll({
      'VERSION': `${RELEASE}\n`,
      'CHANGELOG.md': `## [${RELEASE}] - 2026-10-01\n\n- Fixes.\n`,
      'docs/links.md': `Admin console: http://${RELEASE}/admin\n`,
      'deploy/net.conf': `server = ${RELEASE}\n`,
    }, 'release');
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    assert.equal(code, 0);
    assert.equal(mediums(stderr), 2);
  });

  test('a version-only release push raises nothing, even with diff.noprefix set', () => {
    git(['config', 'diff.noprefix', 'true']);
    const base = git(['rev-parse', 'HEAD']);
    const head = commitAll({ 'VERSION': `${RELEASE}\n`, 'CHANGELOG.md': `## [${RELEASE}] - 2026-10-01\n` }, 'bump');
    const { stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    assert.ok(!stderr.includes('MEDIUM'));
  });

  test('a real public IP next to the word version is still flagged', () => {
    const base = git(['rev-parse', 'HEAD']);
    const head = commitAll({
      'CHANGELOG.md': `## [${RELEASE}] - 2026-10-01 mirror ${PUBLIC_IP}\n- The version endpoint moved to ${PUBLIC_IP}.\n`,
      'config/version.txt': `${RELEASE}\n`,
      'VERSION': `${RELEASE}\nupstream ${PUBLIC_IP}\n`,
    }, 'not a release artifact');
    const { stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    // heading tail + changelog body + config/version.txt + both VERSION lines
    // (a two-line VERSION is not a whole-file version).
    assert.equal(mediums(stderr), 5);
  });
});

describe('committed allowlist (.gstack-redact-allowlist)', () => {
  const HOOK_ALLOWLIST = '.gstack-redact-allowlist';
  const pushOf = (base, head) => `refs/heads/main ${head} refs/heads/main ${base}\n`;
  const commitAllowlist = (content) => {
    return commit(HOOK_ALLOWLIST, content, 'allowlist');
  };
  const DEV_URL = ['postgres://', 'app:devpass', '@db:5432'].join('');

  test('an exact committed span passes and the suppression is listed', () => {
    const base = git(['rev-parse', 'HEAD']);
    commit('config.txt', 'key ' + FAKE_AWS_KEY + '\n', 'add key');
    const head = commitAllowlist('# docs sample key\n' + FAKE_AWS_KEY + '\n');
    const { code, stderr } = runHook(pushOf(base, head));
    assert.equal(code, 0);
    assert.ok(!stderr.includes('BLOCKED'));
    assert.ok(stderr.includes('.gstack-redact-allowlist (1 entry) suppressed 2 finding(s) in this push:'));
    assert.ok(stderr.includes('HIGH  aws.access_key  config.txt:1'));
    assert.ok(stderr.includes('HIGH  aws.access_key  .gstack-redact-allowlist:2'));
  });

  test('a different credential still blocks next to an allowlisted one', () => {
    const base = git(['rev-parse', 'HEAD']);
    const otherKey = ['AKIA', 'FEDCBA0987654321'].join('');
    commit('config.txt', 'ok ' + FAKE_AWS_KEY + '\nleak ' + otherKey + '\n', 'one benign one real');
    const head = commitAllowlist(FAKE_AWS_KEY + '\n');
    const { code, stderr } = runHook(pushOf(base, head));
    assert.equal(code, 1);
    assert.ok(stderr.includes('BLOCKED'));
    assert.ok(stderr.includes('suppressed 2 finding(s)'));
    const blocked = stderr.slice(stderr.indexOf('BLOCKED'));
    assert.equal((blocked.match(/HIGH {2}aws\.access_key/g) || []).length, 1);
  });

  test('a substring of the matched span does not suppress it', () => {
    const base = git(['rev-parse', 'HEAD']);
    commit('compose.txt', 'DATABASE_URL=' + DEV_URL + '\n', 'dev url');
    const head = commitAllowlist('app:devpass\n');
    const { code, stderr } = runHook(pushOf(base, head));
    assert.equal(code, 1);
    assert.ok(stderr.includes('db.url_with_password'));
    assert.ok(stderr.includes('suppressed 0 finding(s) in this push.'));
  });

  test('the whole matched URL suppresses that URL only', () => {
    const base = git(['rev-parse', 'HEAD']);
    const prodUrl = ['postgres://', 'app:devpass', '@prod.internal:5432'].join('');
    commit('compose.txt', 'DATABASE_URL=' + DEV_URL + '\nPROD_URL=' + prodUrl + '\n', 'two urls');
    const head = commitAllowlist(DEV_URL + '\n');
    const { code, stderr } = runHook(pushOf(base, head));
    assert.equal(code, 1);
    assert.ok(stderr.includes('HIGH  db.url_with_password  compose.txt:1'));
    assert.match(stderr, /BLOCKED[\s\S]*HIGH {2}db\.url_with_password/);
  });

  test('an uncommitted allowlist in the working tree suppresses nothing', () => {
    const base = git(['rev-parse', 'HEAD']);
    const head = commit('config.txt', 'key ' + FAKE_AWS_KEY + '\n', 'add key');
    fs.writeFileSync(path.join(repo, HOOK_ALLOWLIST), FAKE_AWS_KEY + '\n');
    const { code, stderr } = runHook(pushOf(base, head));
    assert.equal(code, 1);
    assert.ok(!stderr.includes('suppressed'));
  });

  test('an oversized allowlist is ignored and the scan stays strict', () => {
    const base = git(['rev-parse', 'HEAD']);
    commit('config.txt', 'key ' + FAKE_AWS_KEY + '\n', 'add key');
    const head = commitAllowlist(FAKE_AWS_KEY + '\n' + '#'.repeat(65 * 1024) + '\n');
    const { code, stderr } = runHook(pushOf(base, head));
    assert.equal(code, 1);
    assert.ok(stderr.includes('is over 65536 bytes; ignoring it'));
  });

  test('entries cover MEDIUM emails alongside gstack.redact.allowEmail', () => {
    const base = git(['rev-parse', 'HEAD']);
    git(['config', '--add', 'gstack.redact.allowEmail', 'carol@corp.io']);
    commit('notes.md', 'contact bob@corp.io or carol@corp.io or dave@corp.io\n', 'contacts');
    const head = commitAllowlist('  bob@corp.io  \n');
    const { code, stderr } = runHook(pushOf(base, head));
    assert.equal(code, 0);
    assert.ok(stderr.includes('MEDIUM  pii.email  notes.md:1'));
    assert.ok(stderr.includes('suppressed 2 finding(s)'));
    assert.ok(stderr.includes('1 MEDIUM finding(s) in pushed diff'));
  });

  test('the block message names the allowlist without one present', () => {
    const base = git(['rev-parse', 'HEAD']);
    const head = commit('config.txt', 'key ' + FAKE_AWS_KEY + '\n', 'add key');
    const { code, stderr } = runHook(pushOf(base, head));
    assert.equal(code, 1);
    assert.ok(stderr.includes('commit its exact matched text as a line of .gstack-redact-allowlist'));
    assert.ok(!stderr.includes('suppressed'));
  });
});

describe('diff direction + special refs', () => {
  test('only NEW content is scanned (remote..local), not pre-existing', () => {
    // Put a secret in the FIRST commit (already on remote), then push a clean commit.
    const withSecret = commit('old.txt', FAKE_AWS_KEY + '\n', 'old secret already pushed');
    const clean = commit('new.txt', 'totally clean\n', 'new clean commit');
    // remote already has withSecret; we push only the clean commit on top.
    const { code } = runHook(`refs/heads/main ${clean} refs/heads/main ${withSecret}\n`);
    assert.equal(code, 0); // pre-existing secret is not in the pushed delta
  });

  test('new branch (zero remote sha) scans commits unique to the branch', () => {
    const head = commit('feature.txt', 'ghp_' + 'a'.repeat(36) + '\n', 'feature with token');
    const { code, stderr } = runHook(`refs/heads/feat ${head} refs/heads/feat ${ZERO}\n`);
    assert.equal(code, 1);
    assert.ok(stderr.includes('github.pat'));
  });

  test('branch delete (zero local sha) is skipped', () => {
    const { code } = runHook(`(delete) ${ZERO} refs/heads/old ${git(['rev-parse', 'HEAD'])}\n`);
    assert.equal(code, 0);
  });
});

describe('fail closed on unscannable diffs (#1946)', () => {
  test('a diff git cannot compute BLOCKS the push and names the escape valve', () => {
    // Bogus-but-well-formed SHAs: git diff exits non-zero, the old git()
    // helper returned "" and the push sailed through unscanned.
    const bogusLocal = 'a'.repeat(40);
    const bogusRemote = 'b'.repeat(40);
    const { code, stderr } = runHook(
      `refs/heads/main ${bogusLocal} refs/heads/main ${bogusRemote}\n`,
    );
    assert.equal(code, 1);
    assert.ok(stderr.includes('could not compute the pushed diff'));
    assert.ok(stderr.includes('GSTACK_REDACT_PREPUSH=skip'));
  });

  test('an empty-but-successful diff still passes (no-op push)', () => {
    const head = git(['rev-parse', 'HEAD']);
    // remote == local: diff succeeds and is empty — must NOT block.
    const { code } = runHook(`refs/heads/main ${head} refs/heads/main ${head}\n`);
    assert.equal(code, 0);
  });

  test('a remote sha absent locally (shallow clone / stale fetch) falls back to scanning MORE, not blocking', () => {
    // Adversarial review finding 8: remote..local can't resolve when the
    // remote tip object isn't in the local odb. The fallback scans the
    // merge-base/empty-tree range — a secret in the pushed content still
    // blocks; a clean push passes instead of hard-failing.
    const fakeRemoteSha = 'c'.repeat(40);
    const head = commit('secrets.txt', 'key ' + FAKE_AWS_KEY + '\n', 'leaky commit');
    const { code, stderr } = runHook(`refs/heads/main ${head} refs/heads/main ${fakeRemoteSha}\n`);
    assert.equal(code, 1); // fallback range still catches the credential
    assert.ok(stderr.includes('aws.access_key'));
    assert.ok(!stderr.includes('could not compute the pushed diff'));
  });

  // POSIX-only, for two independent reasons. `spawnSync` reports
  // `status === null` only when a child dies from a signal, and Windows has no
  // equivalent — a force-killed process surfaces a non-zero exit code there — so
  // the branch this test names is unreachable. The stub below is also a
  // `#!/bin/sh` file named `git`, which Windows will not execute at all, since
  // process creation resolves commands through PATHEXT (.exe/.cmd/.bat) and
  // ignores the shebang. A Windows variant would have to assert the non-zero
  // exit path instead, i.e. a different branch than the name claims, so it is
  // skipped rather than rewritten (upstream test.skipIf(win32); kept with
  // reason per plan 审计划必改落实 7).
  test(
    'a diff killed by a signal (null status — the maxBuffer/kill class) BLOCKS',
    {
      skip: process.platform === 'win32' ? 'POSIX-shell git stub on PATH + signal-death null-status are both unreachable on win32' : false,
    },
    () => {
      // Stub git: probes delegate to the real git; the diff invocation kills
      // itself, producing spawnSync status === null. This is the exact branch
      // gitStrict's docstring names (oversized-diff overflow is delivered the
      // same way) — pre-landing review flagged it as untested.
      const realGit = whichGit() || '/usr/bin/git';
      const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepush-stubgit-'));
      try {
        const stub = `#!/bin/sh\nif [ "$1" = "diff" ]; then kill -KILL $$; fi\nexec "${realGit}" "$@"\n`;
        fs.writeFileSync(path.join(stubDir, 'git'), stub);
        fs.chmodSync(path.join(stubDir, 'git'), 0o755);

        const base = git(['rev-parse', 'HEAD']);
        const head = commit('clean.txt', 'clean content\n', 'clean commit');
        const { code, stderr } = runHook(
          `refs/heads/main ${head} refs/heads/main ${base}\n`,
          prependPath(stubDir),
        );
        assert.equal(code, 1);
        assert.ok(stderr.includes('could not compute the pushed diff'));
        assert.ok(stderr.includes('GSTACK_REDACT_PREPUSH=skip'));
      } finally {
        fs.rmSync(stubDir, { recursive: true, force: true });
      }
    },
  );
});

// ── DROPPED, with reasons (plan 审计划必改落实 8; RC8) ─────────────────────────
// Upstream describe("install UX surfaces (#1946 / eng review D3+D10)") is NOT
// ported, and this is the explicit ledger for each dropped test — none may be
// silently skipped:
//
//   1. "setup carries the hint only — never a per-repo install (it runs in
//      the wrong repo)" — reads `<upstream repo>/setup` from disk and asserts
//      on its content. This repo has no `setup` script; there is nothing to
//      assert against.
//   2. "ship template owns per-repo install: silent-install path + one-time
//      offer marker" — reads `ship/SKILL.md.tmpl`. No ship/ templates exist
//      in this port; the surface under test does not exist here.
//   3. "prompt is gated on key ABSENCE and a real TTY, with a timed default-N
//      read" — parses the consent BLOCK out of upstream `setup`'s text.
//      No setup ⇒ no block.
//   4. "an explicit answer persists true/false; timeout persists NOTHING" —
//      same upstream-`setup` text fixture.
//   5. "non-interactive setup keeps the hint-only posture (no prompt, no key
//      write)" — SOURCES upstream `bin/gstack-config` into a bash script and
//      runs the consent flow against it. This repo has no gstack-config
//      binary and no consent flow.
//   6. "a recorded answer is never re-asked (key present → silent)" — same
//      gstack-config dependency.
//
// The plan counted "5" install-UX tests; the upstream block actually contains
// the 6 test() bodies enumerated above (2 install-surface + 4 consent-flow).
// All 6 read artifacts that exist only in the upstream repository, so all 6
// are dropped rather than adapted or skipped. The hook install/uninstall
// MECHANISM they surround is covered by the "install / chaining" describe
// below, which is ported in full.
// ─────────────────────────────────────────────────────────────────────────────

describe('escape valve', () => {
  test('GSTACK_REDACT_PREPUSH=skip bypasses + logs', () => {
    const base = git(['rev-parse', 'HEAD']);
    const head = commit('config.txt', 'key ' + FAKE_AWS_KEY + '\n', 'add key');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghome-'));
    const { code } = runHook(`refs/heads/main ${head} refs/heads/main ${base}\n`, {
      GSTACK_REDACT_PREPUSH: 'skip',
      GSTACK861_STATE_ROOT: home,
    });
    assert.equal(code, 0);
    const log = fs.readFileSync(path.join(home, 'security', 'prepush-skip.jsonl'), 'utf8');
    assert.ok(log.includes('env-skip'));
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('install / chaining', () => {
  test('install creates a managed hook; existing hook preserved + chained', () => {
    const hookDir = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    const existing = path.join(hookDir, 'pre-push');
    fs.writeFileSync(existing, '#!/usr/bin/env bash\necho mine\n', { mode: 0o755 });

    const r = spawnSync(process.execPath, [REDACT, 'install-prepush-hook'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(r.status, 0, r.stderr);
    const installed = fs.readFileSync(existing, 'utf8');
    assert.ok(installed.includes('gstack861-redact pre-push (managed)'));
    assert.ok(fs.existsSync(path.join(hookDir, 'pre-push.local')));
    assert.ok(fs.readFileSync(path.join(hookDir, 'pre-push.local'), 'utf8').includes('echo mine'));
  });

  // Regression: `_input="$(cat)"` strips the trailing newline, so a chained
  // shell hook using `while read` never entered its loop body for the final
  // (often only) ref line — it saw zero refs and exited 0, failing OPEN.
  test('chained pre-push.local receives the final ref line (trailing newline preserved)', () => {
    const hookDir = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    spawnSync(process.execPath, [REDACT, 'install-prepush-hook'], { cwd: repo, timeout: 30_000, env: gitEnv() });

    const seen = path.join(repo, 'seen.txt');
    fs.writeFileSync(
      path.join(hookDir, 'pre-push.local'),
      `#!/usr/bin/env bash\nwhile read -r a b c d; do echo "$a $b $c $d" >> ${JSON.stringify(seen)}; done\nexit 0\n`,
      { mode: 0o755 },
    );

    const sha = 'a'.repeat(40);
    const line = `refs/heads/main ${sha} refs/heads/main ${ZERO}\n`;
    const r = spawnSync('bash', [path.join(hookDir, 'pre-push')], {
      cwd: repo,
      input: Buffer.from(line),
      encoding: 'utf8',
      env: gitEnv({ GSTACK_REDACT_PREPUSH: 'skip', GSTACK861_STATE_ROOT: stateHome }),
      timeout: 30_000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.readFileSync(path.join(stateHome, 'security', 'prepush-skip.jsonl'), 'utf8').includes('env-skip'));
    assert.ok(fs.existsSync(seen));
    assert.equal(
      fs.readFileSync(seen, 'utf8').trim(),
      `refs/heads/main ${sha} refs/heads/main ${ZERO}`,
    );
  });

  test('a blocking pre-push.local still short-circuits the push', () => {
    const hookDir = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    spawnSync(process.execPath, [REDACT, 'install-prepush-hook'], { cwd: repo, timeout: 30_000, env: gitEnv() });
    fs.writeFileSync(
      path.join(hookDir, 'pre-push.local'),
      '#!/usr/bin/env bash\nwhile read -r _a _b _c _d || [ -n "${_a:-}" ]; do exit 1; done\nexit 0\n',
      { mode: 0o755 },
    );
    const r = spawnSync('bash', [path.join(hookDir, 'pre-push')], {
      cwd: repo,
      input: Buffer.from(`refs/heads/main ${'b'.repeat(40)} refs/heads/main ${ZERO}\n`),
      encoding: 'utf8',
      env: gitEnv({ GSTACK_REDACT_PREPUSH: 'skip', GSTACK861_STATE_ROOT: stateHome }),
      timeout: 30_000,
    });
    assert.equal(r.status, 1);
  });

  // Regression: install returned early on ANY hook carrying the managed marker,
  // so the only writer was unreachable once a hook existed. Every fix to the
  // wrapper — including the `printf x` fail-open fix of v1.64.0.0 — stopped at
  // repos that had never had the hook. The pre-existing newline test above
  // cannot catch this: it installs into a repo with no prior managed hook, which
  // is the one case that was never broken.
  test('a stale managed hook is rewritten, and the refresh delivers the newline fix', () => {
    const hookDir = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    const hook = path.join(hookDir, 'pre-push');

    // The v1.63-era wrapper, verbatim: same marker, `$(cat)` with no sentinel.
    // (The bun line stays bun and the marker is this port's gstack861 one —
    // ledger 2 of bin/gstack861-redact.mjs: the fixture represents an install
    // written by an OLDER VERSION OF THIS INSTALLER, and it is never executed;
    // the refresh below rewrites it before any run.)
    fs.writeFileSync(
      hook,
      [
        '#!/usr/bin/env bash',
        '# gstack861-redact pre-push (managed)',
        'set -euo pipefail',
        '_input="$(cat)"',
        '_local="$(git rev-parse --git-path hooks/pre-push.local)"',
        'if [ -x "$_local" ]; then',
        `  printf '%s' "$_input" | "$_local" "$@" || exit $?`,
        'fi',
        `printf '%s' "$_input" | bun ${JSON.stringify(PREPUSH)} "$@"`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    // A chained local hook of the shape the old wrapper starved: a bare
    // `while read`, which never enters its body without a trailing newline.
    const seen = path.join(repo, 'seen.txt');
    fs.writeFileSync(
      path.join(hookDir, 'pre-push.local'),
      `#!/usr/bin/env bash\nwhile read -r a _b _c _d; do echo "$a" >> ${JSON.stringify(seen)}; done\nexit 0\n`,
      { mode: 0o755 },
    );

    const r = spawnSync(process.execPath, [REDACT, 'install-prepush-hook'], {
      timeout: 30_000,
      cwd: repo,
      encoding: 'utf8',
      env: gitEnv(),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('refreshed stale managed pre-push hook'));
    assert.ok(fs.readFileSync(hook, 'utf8').includes('printf x'));

    // The chained hook is the user's; a refresh must not rename or rewrite it.
    assert.ok(fs.readFileSync(path.join(hookDir, 'pre-push.local'), 'utf8').includes('while read'));

    // Behavioural half: the refreshed wrapper actually feeds the final ref line.
    const sha = 'c'.repeat(40);
    const run = spawnSync('bash', [hook], {
      timeout: 30_000,
      cwd: repo,
      input: Buffer.from(`refs/heads/main ${sha} refs/heads/main ${ZERO}\n`),
      encoding: 'utf8',
      env: gitEnv({ GSTACK_REDACT_PREPUSH: 'skip', GSTACK861_STATE_ROOT: stateHome }),
    });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(fs.readFileSync(path.join(stateHome, 'security', 'prepush-skip.jsonl'), 'utf8').includes('env-skip'));
    assert.equal(fs.readFileSync(seen, 'utf8').trim(), 'refs/heads/main');
  });

  test('install stays idempotent: an up-to-date managed hook is not rewritten', () => {
    const hookDir = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    const hook = path.join(hookDir, 'pre-push');

    spawnSync(process.execPath, [REDACT, 'install-prepush-hook'], { cwd: repo, env: gitEnv() });
    const first = fs.readFileSync(hook, 'utf8');
    const stamp = fs.statSync(hook).mtimeMs;

    const again = spawnSync(process.execPath, [REDACT, 'install-prepush-hook'], {
      cwd: repo,
      encoding: 'utf8',
      env: gitEnv(),
    });
    assert.equal(again.status, 0, again.stderr);
    assert.ok(again.stdout.includes('already installed'));
    assert.ok(!again.stdout.includes('refreshed'));
    assert.equal(fs.readFileSync(hook, 'utf8'), first);
    assert.equal(fs.statSync(hook).mtimeMs, stamp);
  });

  test('uninstall restores the chained original', () => {
    const hookDir = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, 'pre-push'), '#!/usr/bin/env bash\necho mine\n', {
      mode: 0o755,
    });
    spawnSync(process.execPath, [REDACT, 'install-prepush-hook'], { cwd: repo, timeout: 30_000, env: gitEnv() });
    spawnSync(process.execPath, [REDACT, 'uninstall-prepush-hook'], { cwd: repo, timeout: 30_000, env: gitEnv() });
    const restored = fs.readFileSync(path.join(hookDir, 'pre-push'), 'utf8');
    assert.ok(restored.includes('echo mine'));
    assert.ok(!restored.includes('managed'));
  });
});

describe('base resolution when the default branch is neither main nor master', () => {
  test('a new branch scans its own commits, not the whole repository', () => {
    // The remote's default branch is `trunk` and origin/HEAD is unset, so
    // defaultRemoteBranch() falls through to `origin/main` — a ref that does
    // not exist — and merge-base fails. The EMPTY_TREE fallback then treats the
    // WHOLE repository as added lines, re-scanning history that is already on
    // the remote. Two consequences, both bad: a secret long since pushed gets
    // re-reported as if this push introduced it, and on any real repository the
    // input blows past the engine's byte cap, so `engine.input_too_large`
    // blocks the push having scanned NOTHING — the "scans more, never less"
    // fallback inverting into "scans nothing".
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'prepush-remote-'));
    try {
      // b20/b22 fixture precedent: `init -b` needs git >= 2.28.
      const initBare = spawnSync('git', ['init', '-q', '--bare', '-b', 'trunk', bare], { timeout: 30_000, env: gitEnv() });
      if (initBare.status !== 0) {
        spawnSync('git', ['init', '-q', '--bare', bare], { timeout: 30_000, env: gitEnv() });
        spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/trunk'], { cwd: bare, timeout: 30_000, env: gitEnv() });
      }

      git(['branch', '-M', 'trunk']);
      const old = commit('legacy.txt', FAKE_AWS_KEY + '\n', 'secret already on the remote');
      git(['remote', 'add', 'origin', bare]);
      git(['push', '-q', 'origin', 'trunk']);

      // The remote HAS the old commit, and the default-branch guess is unresolvable.
      assert.equal(git(['rev-parse', 'origin/trunk']), old);
      assert.equal(git(['rev-parse', '--verify', 'origin/main']), '');
      assert.equal(git(['symbolic-ref', 'refs/remotes/origin/HEAD']), '');

      git(['checkout', '-q', '-b', 'feat']);
      const head = commit('feature.txt', 'totally clean\n', 'clean feature commit');

      const { code, stderr } = runHook(`refs/heads/feat ${head} refs/heads/feat ${ZERO}\n`);

      // The only NEW content is a clean file. The already-pushed secret must not
      // be attributed to this push.
      assert.ok(!stderr.includes('aws.access_key'));
      assert.equal(code, 0);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  test('a genuinely new repository with no remote refs still scans everything', () => {
    // Nothing is on any remote, so every commit IS new content: scanning the
    // full history is correct here. The narrowing must not open a hole in the
    // case the EMPTY_TREE fallback exists for.
    const head = commit('secrets.txt', FAKE_AWS_KEY + '\n', 'secret in a fresh repo');
    const { code, stderr } = runHook(`refs/heads/feat ${head} refs/heads/feat ${ZERO}\n`);
    assert.equal(code, 1);
    assert.ok(stderr.includes('aws.access_key'));
  });
});

describe('diff-extraction bypasses (#2498, minimal reimplementation)', () => {
  test('a diff.external driver cannot blank the scanned diff', () => {
    // With diff.external set, plain `git diff` emits the driver's output —
    // typically zero '+' lines — so an unhardened scanner reads an empty diff
    // and allows a push full of secrets. --no-ext-diff must neutralize it.
    const head = commit('leak.txt', FAKE_AWS_KEY + '\n', 'secret behind ext driver');
    git(['config', 'diff.external', '/usr/bin/true']);
    const { code, stderr } = runHook(`refs/heads/feat ${head} refs/heads/feat ${ZERO}\n`);
    git(['config', '--unset', 'diff.external']);
    assert.equal(code, 1);
    assert.ok(stderr.includes('aws.access_key'));
  });

  test('an added content line starting with ++ is still scanned', () => {
    // Content "++AKIA…" renders in the diff as "+++AKIA…", which a blanket
    // startsWith('+++') header skip silently dropped from the scan.
    const head = commit('notes.txt', '++' + FAKE_AWS_KEY + '\n', 'content line looks like a header');
    const { code, stderr } = runHook(`refs/heads/feat ${head} refs/heads/feat ${ZERO}\n`);
    assert.equal(code, 1);
    assert.ok(stderr.includes('aws.access_key'));
  });

  test('an unparseable pre-push ref line fails closed', () => {
    commit('ok.txt', 'clean\n', 'clean commit');
    const { code, stderr } = runHook('refs/heads/feat not-a-sha\n');
    assert.equal(code, 1);
    assert.ok(stderr.includes('could not parse'));
  });
});

describe('#3048: the pushed diff is scanned per file, so TS/JSX source syntax is not a secret', () => {
  const mediums = (stderr) => Number(/(\d+) MEDIUM finding/.exec(stderr)?.[1] ?? 0);
  test('a TS parameter type and a JSX expression raise nothing; the same shape in YAML still does', () => {
    const base = git(['rev-parse', 'HEAD']);
    for (const [file, content] of [
      ['src/coach.ts', 'export function issue(\n  session: SessionState,\n): void {}\n'],
      ['src/Turn.tsx', '<Row key={turn.requestId + turn.role} />\n'],
    ]) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), content);
      git(['add', file]);
    }
    git(['commit', '-q', '-m', 'ts']);
    const tsHead = git(['rev-parse', 'HEAD']);
    assert.equal(mediums(runHook(`refs/heads/main ${tsHead} refs/heads/main ${base}\n`).stderr), 0);
    fs.mkdirSync(path.join(repo, 'deploy'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'deploy', 'values.yaml'), '  session: SessionState,\n');
    git(['add', 'deploy/values.yaml']);
    git(['commit', '-q', '-m', 'yaml']);
    const yamlHead = git(['rev-parse', 'HEAD']);
    assert.equal(mediums(runHook(`refs/heads/main ${yamlHead} refs/heads/main ${tsHead}\n`).stderr), 1);
  });
});
