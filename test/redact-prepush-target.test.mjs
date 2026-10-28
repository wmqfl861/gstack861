// gstack861-redact-prepush — the installed guard uses the ACTUAL push
// destination, not the origin tracking tip (plus the engine's scan-seam
// guarantees, end-to-end through `git push`).
//
// Upstream lineage: gstack test/redact-prepush-target.test.ts @
// upstream.lock.json commit 5755601dac5d35ebd7dde181fdefe52a023c73d9
// (432 lines). Lane C, batch 23 (moved here from Lane B by 审计划必改落实 1:
// the fixture runs install-prepush-hook and real `git push` on every test).
// Adaptation is harness-only (bun:test → node:test; spawnSync("bun", [REDACT,
// …]) → spawnSync(process.execPath, [REDACT, …]); ./helpers/git-env inlined;
// `import { scan } from "../lib/redact-engine"` → ../src/redact-engine.mjs).
// Every assert value and every fixture step is untouched.
//
// Harness divergences beyond the bun→node swap:
//   - gitEnv() also pins GSTACK861_STATE_ROOT at a per-fixture temp dir
//     (plan 审计划必改落实 5): the installed hook runs on every fixture push
//     and must never touch the real ~/.gstack861.
//   - `git init -b main` gets the b20/b22 try/catch fallback for git < 2.28.
//
// Upstream had no win32 skips in this file, and none were needed here either
// (plan 审计划必改落实 7): Git-for-Windows runs the `#!/usr/bin/env bash`
// wrapper through its bundled sh, and `node` resolves from the inherited PATH.
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/redact-engine.mjs';

const REDACT = fileURLToPath(new URL('../bin/gstack861-redact.mjs', import.meta.url));
const roots = [];
const key = ['AKIA', '1234567890ABCDEF'].join('');
let stateRoot = null;

/**
 * Environment for fixture git commands and install-prepush-hook (upstream
 * test/helpers/git-env.ts, inlined): with the parent environment, a
 * developer's global or system core.hooksPath (or the same key via
 * GIT_CONFIG_COUNT / GIT_CONFIG_PARAMETERS) reaches the fixture — `git
 * rev-parse --git-path hooks` resolves to that directory, so the install
 * rewrites the developer's own pre-push (#3353), and their hook runs on
 * fixture pushes and rejects the local remote (#2967). /dev/null drops the
 * global file on every platform: Git for Windows rejects NUL. Config written
 * inside the fixture repo still applies.
 */
function gitEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_COUNT = '0';
  delete env.GIT_CONFIG_PARAMETERS;
  if (stateRoot) env.GSTACK861_STATE_ROOT = stateRoot;
  return env;
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** b20/b22 fixture precedent: `init -b` needs git >= 2.28; fall back below. */
function initRepoMain(cwd, extra = []) {
  try { git(cwd, 'init', '-q', '-b', 'main', ...extra); }
  catch { git(cwd, 'init', '-q', ...extra); git(cwd, 'symbolic-ref', 'HEAD', 'refs/heads/main'); }
}

function initBareMain(cwd, target, extra = []) {
  try { git(cwd, 'init', '--bare', '-q', '-b', 'main', ...extra, target); }
  catch { git(cwd, 'init', '--bare', '-q', ...extra, target); git(target, 'symbolic-ref', 'HEAD', 'refs/heads/main'); }
}

function fixture(initialSecret = true, sha256 = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepush-target-'));
  roots.push(root);
  stateRoot = path.join(root, 'state');
  const repo = path.join(root, 'repo');
  const origin = path.join(root, 'origin.git');
  const publish = path.join(root, 'publish.git');
  fs.mkdirSync(repo);
  const format = sha256 ? ['--object-format=sha256'] : [];
  initBareMain(root, origin, format);
  initBareMain(root, publish, format);
  initRepoMain(repo, format);
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.test');
  fs.writeFileSync(path.join(repo, 'config.txt'), initialSecret ? `key ${key}\n` : 'clean\n');
  git(repo, 'add', 'config.txt');
  git(repo, 'commit', '-qm', 'seed');
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'remote', 'add', 'publish', publish);
  const install = spawnSync(process.execPath, [REDACT, 'install-prepush-hook'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
  assert.equal(install.status, 0, install.stderr);
  return { repo, origin, publish, head };
}

function seedIndependentRemote(repo, publish) {
  const producer = path.join(path.dirname(repo), 'producer');
  fs.mkdirSync(producer);
  initRepoMain(producer);
  git(producer, 'config', 'user.name', 'Fixture');
  git(producer, 'config', 'user.email', 'fixture@example.test');
  fs.writeFileSync(path.join(producer, 'clean.txt'), 'different history\n');
  git(producer, 'add', 'clean.txt');
  git(producer, 'commit', '-qm', 'remote tip');
  git(producer, 'remote', 'add', 'publish', publish);
  git(producer, 'push', '-q', 'publish', 'main');
  return git(publish, 'rev-parse', 'refs/heads/main');
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  stateRoot = null;
});

describe('fixture installs ignore the developer\'s hook config (#3353)', () => {
  test('a global, system or environment core.hooksPath is neither rewritten nor run', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepush-target-global-'));
    roots.push(root);
    const hooks = path.join(root, 'global-hooks');
    fs.mkdirSync(hooks);
    const original = '#!/bin/sh\necho developer-hook >&2\nexit 1\n';
    fs.writeFileSync(path.join(hooks, 'pre-push'), original, { mode: 0o755 });
    const config = path.join(root, 'gitconfig');
    fs.writeFileSync(config, `[core]\n\thooksPath = ${JSON.stringify(hooks)}\n`);
    const keys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_PARAMETERS'];
    const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.GIT_CONFIG_GLOBAL = config;
      process.env.GIT_CONFIG_SYSTEM = config;
      delete process.env.GIT_CONFIG_NOSYSTEM;
      process.env.GIT_CONFIG_COUNT = '1';
      process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
      process.env.GIT_CONFIG_VALUE_0 = hooks;
      process.env.GIT_CONFIG_PARAMETERS = `'core.hooksPath=${hooks}'`;
      const { repo } = fixture(false);
      assert.deepEqual(fs.readdirSync(hooks), ['pre-push']);
      assert.equal(fs.readFileSync(path.join(hooks, 'pre-push'), 'utf8'), original);
      const installed = git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-push');
      assert.ok(fs.readFileSync(installed, 'utf8').includes('gstack861-redact pre-push (managed)'));
      const push = spawnSync('git', ['push', 'origin', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
      assert.equal(push.status, 0, push.stderr);
      assert.ok(!push.stderr.includes('developer-hook'));
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('installed pre-push guard uses the actual destination', () => {
  test('origin tracking at HEAD cannot excuse the same credential on first push to publish', () => {
    const { repo, publish, head } = fixture();
    assert.equal(git(repo, 'rev-parse', 'origin/main'), head);
    const push = spawnSync('git', ['push', 'publish', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(push.status, 1, push.stderr);
    assert.ok(push.stderr.includes('aws.access_key'));
    assert.equal(git(publish, 'for-each-ref', '--format=%(refname)'), '');
  });

  test('a configured remote\'s different push URL cannot reuse its fetch tracking tip', () => {
    const { repo, publish } = fixture();
    git(repo, 'remote', 'set-url', '--push', 'origin', publish);
    const push = spawnSync('git', ['push', 'origin', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(push.status, 1, push.stderr);
    assert.ok(push.stderr.includes('aws.access_key'));
    assert.equal(git(publish, 'for-each-ref', '--format=%(refname)'), '');
  });

  for (const [name, symbolicHead] of [
    ['a local branch cannot shadow the target\'s qualified remote-tracking base', true],
    ['the main fallback cannot resolve to a colliding local branch', false],
  ]) {
    test(name, () => {
      const { repo, publish, head: base } = fixture(false);
      fs.writeFileSync(path.join(repo, 'leak.txt'), `key ${key}\n`);
      git(repo, 'add', 'leak.txt');
      git(repo, 'commit', '-qm', 'secret after target base');
      const tip = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'update-ref', 'refs/remotes/publish/main', base);
      if (symbolicHead) git(repo, 'symbolic-ref', 'refs/remotes/publish/HEAD', 'refs/remotes/publish/main');
      git(repo, 'update-ref', 'refs/heads/publish/main', tip);
      assert.equal(git(repo, 'rev-parse', 'publish/main'), tip);
      assert.equal(git(repo, 'rev-parse', 'refs/remotes/publish/main'), base);
      const push = spawnSync('git', ['push', 'publish', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
      assert.equal(push.status, 1, push.stderr);
      assert.ok(push.stderr.includes('aws.access_key'));
      assert.equal(git(publish, 'for-each-ref', '--format=%(refname)'), '');
    });
  }

  test('the second fetch URL is not represented by the first URL\'s tracking ref', () => {
    const { repo, origin, publish } = fixture();
    const second = path.join(path.dirname(repo), 'second.git');
    initBareMain(path.dirname(repo), second);
    git(publish, 'fetch', '-q', origin, 'main:refs/heads/main');
    git(repo, 'fetch', '-q', 'publish');
    assert.equal(git(repo, 'rev-parse', 'refs/remotes/publish/main'), git(repo, 'rev-parse', 'HEAD'));
    git(repo, 'remote', 'set-url', '--add', 'publish', second);
    assert.equal(git(repo, 'remote', 'get-url', 'publish'), publish);
    const push = spawnSync('git', ['push', 'publish', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(push.status, 1, push.stderr);
    assert.ok(push.stderr.includes('aws.access_key'));
    assert.equal(git(second, 'for-each-ref', '--format=%(refname)'), '');
  });

  test('direct URL push cannot borrow origin\'s tracking history', () => {
    const { repo, publish } = fixture();
    const push = spawnSync('git', ['push', publish, 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(push.status, 1, push.stderr);
    assert.ok(push.stderr.includes('aws.access_key'));
    assert.equal(git(publish, 'for-each-ref', '--format=%(refname)'), '');
  });

  test('an advertised remote tip absent from local objects cannot justify a guessed base', () => {
    const { repo, publish } = fixture();
    const remoteTip = seedIndependentRemote(repo, publish);
    assert.notEqual(spawnSync('git', ['cat-file', '-e', remoteTip], { cwd: repo, timeout: 30_000, env: gitEnv() }).status, 0);
    const push = spawnSync('git', ['push', '--force', 'publish', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(push.status, 1, push.stderr);
    assert.ok(push.stderr.includes('aws.access_key'));
    assert.equal(git(publish, 'rev-parse', 'refs/heads/main'), remoteTip);
  });

  test('an absent advertised tip permits a clean forced update after conservative scanning', () => {
    const { repo, publish, head } = fixture(false);
    const remoteTip = seedIndependentRemote(repo, publish);
    assert.notEqual(spawnSync('git', ['cat-file', '-e', remoteTip], { cwd: repo, timeout: 30_000, env: gitEnv() }).status, 0);
    const push = spawnSync('git', ['push', '--force', 'publish', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(push.status, 0, push.stderr);
    assert.equal(git(publish, 'rev-parse', 'refs/heads/main'), head);
  });

  test('new SHA-256 branch scans the correct empty tree and allows a clean push', () => {
    const { repo, publish } = fixture(false, true);
    const push = spawnSync('git', ['push', 'publish', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(push.status, 0, push.stderr);
    assert.equal(git(publish, 'rev-parse', 'refs/heads/main').length, 64);
    fs.writeFileSync(path.join(repo, 'leak.txt'), `key ${key}\n`);
    git(repo, 'add', 'leak.txt');
    git(repo, 'commit', '-qm', 'new secret');
    const blocked = spawnSync('git', ['push', 'origin', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(blocked.status, 1);
    assert.ok(blocked.stderr.includes('aws.access_key'));
  });

  test('one leaky ref blocks a multi-ref push without updating its clean neighbor', () => {
    const { repo, origin, head } = fixture(false);
    git(repo, 'checkout', '-q', '-b', 'leak');
    fs.writeFileSync(path.join(repo, 'leak.txt'), `key ${key}\n`);
    git(repo, 'add', 'leak.txt');
    git(repo, 'commit', '-qm', 'leaky branch');
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'clean.txt'), 'safe update\n');
    git(repo, 'add', 'clean.txt');
    git(repo, 'commit', '-qm', 'clean branch');
    const push = spawnSync('git', ['push', 'origin', 'main', 'leak'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(push.status, 1);
    assert.ok(push.stderr.includes('aws.access_key'));
    assert.equal(git(origin, 'rev-parse', 'refs/heads/main'), head);
    assert.equal(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/leak'), '');
  });

  test('a deleted ref alongside a clean update is permitted', () => {
    const { repo, origin } = fixture(false);
    git(repo, 'checkout', '-q', '-b', 'disposable');
    fs.writeFileSync(path.join(repo, 'disposable.txt'), 'safe\n');
    git(repo, 'add', 'disposable.txt');
    git(repo, 'commit', '-qm', 'temporary branch');
    git(repo, 'push', '-q', 'origin', 'disposable');
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'clean.txt'), 'safe update\n');
    git(repo, 'add', 'clean.txt');
    git(repo, 'commit', '-qm', 'clean update');
    const head = git(repo, 'rev-parse', 'HEAD');
    const push = spawnSync('git', ['push', 'origin', 'main', ':disposable'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(push.status, 0, push.stderr);
    assert.equal(git(origin, 'rev-parse', 'refs/heads/main'), head);
    assert.equal(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/disposable'), '');
  });

  test('installed wrapper forwards refs and rejects malformed input instead of passing it on', () => {
    const { repo, origin, head } = fixture(false);
    const hook = git(repo, 'rev-parse', '--git-path', 'hooks/pre-push');
    const result = spawnSync('bash', [hook, 'origin', origin], {
      cwd: repo, input: 'refs/heads/main malformed\n', encoding: 'utf8', timeout: 30_000, env: gitEnv(),
    });
    assert.equal(result.status, 1, result.stderr || result.error?.message);
    assert.ok(result.stderr.includes('could not parse a pre-push ref line'));
    assert.equal(git(origin, 'rev-parse', 'refs/heads/main'), head);
  });

  test('a HIGH proximity finding across line-aligned scan slices cannot pass', () => {
    const { repo } = fixture(false);
    const value = ['AbCdEfGhIjKlMnOpQrStU', 'vWxYz0123456789AbCd'].join('');
    const payload = `${'x'.repeat(768 * 1024 - 43)}\naws_secret_access_key=\n${value}\n`;
    assert.ok(scan(payload).findings.map((finding) => finding.id).includes('aws.secret_key'));
    fs.writeFileSync(path.join(repo, 'payload.txt'), payload);
    git(repo, 'add', 'payload.txt');
    git(repo, 'commit', '-qm', 'near seam');
    const push = spawnSync('git', ['push', 'origin', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(push.status, 1);
    assert.ok(push.stderr.includes('aws.secret_key'));
  });

  test('an unlabeled high-entropy value near a seam stays clean', () => {
    const { repo } = fixture(false);
    const value = ['AbCdEfGhIjKlMnOpQrStU', 'vWxYz0123456789AbCd'].join('');
    const payload = `${'x'.repeat(768 * 1024 - 43)}\nordinary description\n${value}\n`;
    assert.ok(!scan(payload).findings.map((finding) => finding.id).includes('aws.secret_key'));
    fs.writeFileSync(path.join(repo, 'payload.txt'), payload);
    git(repo, 'add', 'payload.txt');
    git(repo, 'commit', '-qm', 'unlabeled seam');
    const push = spawnSync('git', ['push', 'origin', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(push.status, 0, push.stderr);
    assert.ok(!push.stderr.includes('aws.secret_key'));
  });

  test('overlap does not count a single finding twice', () => {
    const { repo } = fixture(false);
    const payload = `${'x'.repeat(768 * 1024 - 75)}\nkey ${key}\n${'x'.repeat(100)}\n`;
    fs.writeFileSync(path.join(repo, 'payload.txt'), payload);
    git(repo, 'add', 'payload.txt');
    git(repo, 'commit', '-qm', 'one finding at seam');
    const push = spawnSync('git', ['push', 'origin', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(push.status, 1);
    assert.equal((push.stderr.match(/HIGH  aws\.access_key/g) || []).length, 1);
  });

  test('supplementary NFKC expansion cannot move a seam finding out of its owning core', () => {
    const { repo, origin, head } = fixture(false);
    const prefix = ''.repeat(64);
    const credential = `key ${key}\n`;
    const padding = 'x'.repeat(768 * 1024 - Buffer.byteLength(prefix) - credential.length - 1);
    const payload = `${prefix}${padding}\n${credential}${'z'.repeat(100)}\n`;
    assert.ok(scan(payload).findings.map((finding) => finding.id).includes('aws.access_key'));
    fs.writeFileSync(path.join(repo, 'payload.txt'), payload);
    git(repo, 'add', 'payload.txt');
    git(repo, 'commit', '-qm', 'supplementary normalization seam');
    const push = spawnSync('git', ['push', 'origin', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(push.status, 1);
    assert.equal((push.stderr.match(/HIGH  aws\.access_key/g) || []).length, 1);
    assert.equal(git(origin, 'rev-parse', 'refs/heads/main'), head);
  });

  test('a partial-line overlap cannot manufacture an anchored assignment finding', () => {
    const { repo } = fixture(false);
    const value = ['8Fk2pQ9vXz4wL7mN', '3rT6yB1cD5eG0hJq'].join('');
    const assignment = `API_KEY=${value} `;
    const suffix = 'z'.repeat(16 * 1024 - assignment.length - 6);
    const first = '!' + 'x'.repeat(768 * 1024 - 61 - assignment.length - suffix.length) + assignment + suffix;
    const payload = `${first}\nshort\n${'z'.repeat(100)}\n`;
    assert.ok(!scan(payload).findings.map((finding) => finding.id).includes('env.kv'));
    fs.writeFileSync(path.join(repo, 'payload.txt'), payload);
    git(repo, 'add', 'payload.txt');
    git(repo, 'commit', '-qm', 'mid-line control');
    const push = spawnSync('git', ['push', 'origin', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(push.status, 0, push.stderr);
    assert.ok(!push.stderr.includes('MEDIUM finding'));
  });

  test('mid-line carry cannot create a HIGH word boundary around an embedded key', () => {
    const { repo, origin, head } = fixture(false);
    const first = 'x'.repeat(768 * 1024 - 1 - 16_384) + key + ' '.repeat(16_384 - key.length);
    const payload = `${first}\nordinary\n`;
    assert.ok(!scan(payload).findings.map((finding) => finding.id).includes('aws.access_key'));
    fs.writeFileSync(path.join(repo, 'payload.txt'), payload);
    git(repo, 'add', 'payload.txt');
    git(repo, 'commit', '-qm', 'embedded key control');
    const push = spawnSync('git', ['push', 'origin', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(push.status, 0, push.stderr);
    assert.ok(!push.stderr.includes('aws.access_key'));
    assert.notEqual(git(origin, 'rev-parse', 'refs/heads/main'), head);
  });

  test('a long Bearer span retains its later Authorization context across the seam', () => {
    const { repo, origin } = fixture(false);
    const alphabet = '7pFb4ZaCuG8wDsVk2EnHy6Qt9Jr5Lx0M';
    const token = Array.from({ length: 20_480 }, (_, i) => alphabet[(i * 7 + Math.floor(i / 31)) % 32]).join('');
    const bearerLine = `Bearer ${token}`;
    const payload = `${'x'.repeat(768 * 1024 - bearerLine.length - 2)}\n${bearerLine}\nAuthorization\n`;
    assert.ok(scan(payload).findings.map((finding) => finding.id).includes('auth.bearer'));
    fs.writeFileSync(path.join(repo, 'payload.txt'), payload);
    git(repo, 'add', 'payload.txt');
    git(repo, 'commit', '-qm', 'long bearer advisory');
    const tip = git(repo, 'rev-parse', 'HEAD');
    const push = spawnSync('git', ['push', 'origin', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(push.status, 0, push.stderr);
    assert.ok(push.stderr.includes('MEDIUM finding'));
    assert.equal(git(origin, 'rev-parse', 'refs/heads/main'), tip);
  });

  test('zero-width padding cannot move normalized proximity context out of the overlap', () => {
    const { repo } = fixture(false);
    const value = ['AbCdEfGhIjKlMnOpQrStU', 'vWxYz0123456789AbCd'].join('');
    const payload = `${'x'.repeat(768 * 1024 - 43)}\naws_secret_access_key=\n${'​'.repeat(35_000)}\n${value}\n`;
    assert.ok(scan(payload).findings.map((finding) => finding.id).includes('aws.secret_key'));
    fs.writeFileSync(path.join(repo, 'payload.txt'), payload);
    git(repo, 'add', 'payload.txt');
    git(repo, 'commit', '-qm', 'invisible seam');
    const push = spawnSync('git', ['push', 'origin', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(push.status, 1);
    assert.ok(push.stderr.includes('aws.secret_key'));
  });

  test('context needing more than the engine byte cap blocks instead of scanning a truncated window', () => {
    const { repo, origin, head } = fixture(false);
    const value = ['AbCdEfGhIjKlMnOpQrStU', 'vWxYz0123456789AbCd'].join('');
    const payload = `${'x'.repeat(768 * 1024 - 43)}\naws_secret_access_key=\n${'​'.repeat(450_000)}\n${value}\n`;
    fs.writeFileSync(path.join(repo, 'payload.txt'), payload);
    git(repo, 'add', 'payload.txt');
    git(repo, 'commit', '-qm', 'unscannable context');
    const push = spawnSync('git', ['push', 'origin', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(push.status, 1);
    assert.ok(push.stderr.includes('engine.input_too_large'));
    assert.equal(git(origin, 'rev-parse', 'refs/heads/main'), head);
  });

  for (const [name, label, expected] of [
    ['HTML entity', 'aws&amp;secret_access_key=', true],
    ['fullwidth Unicode', 'aws＿secret_access_key=', true],
    ['broken entity separated by zero-width', 'aws&​amp;secret_access_key=', false],
  ]) {
    test(`${name} near a seam keeps the detector's exact normalization semantics`, () => {
      const { repo } = fixture(false);
      const value = ['AbCdEfGhIjKlMnOpQrStU', 'vWxYz0123456789AbCd'].join('');
      const payload = `${'x'.repeat(768 * 1024 - 43)}\n${label}\n${value}\n`;
      assert.equal(scan(payload).findings.some((finding) => finding.id === 'aws.secret_key'), expected);
      fs.writeFileSync(path.join(repo, 'payload.txt'), payload);
      git(repo, 'add', 'payload.txt');
      git(repo, 'commit', '-qm', 'normalization seam');
      const push = spawnSync('git', ['push', 'origin', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
      assert.equal(push.status, expected ? 1 : 0, push.stderr);
      assert.equal(push.stderr.includes('aws.secret_key'), expected);
    });
  }

  test('a large clean diff and a sub-cap long line pass, while an over-cap line fails closed', () => {
    const { repo, origin, head } = fixture(false);
    fs.writeFileSync(path.join(repo, 'large.txt'), 'ordinary content\n'.repeat(160_000));
    git(repo, 'add', 'large.txt');
    git(repo, 'commit', '-qm', 'large clean diff');
    let push = spawnSync('git', ['push', 'origin', 'main'], { cwd: repo, encoding: 'utf8', timeout: 60_000, env: gitEnv() });
    assert.equal(push.status, 0, push.stderr);
    fs.writeFileSync(path.join(repo, 'long.txt'), 'x'.repeat(900_000) + '\n');
    git(repo, 'add', 'long.txt');
    git(repo, 'commit', '-qm', 'long clean line');
    push = spawnSync('git', ['push', 'origin', 'main'], { cwd: repo, encoding: 'utf8', timeout: 60_000, env: gitEnv() });
    assert.equal(push.status, 0, push.stderr);
    const priorTip = git(origin, 'rev-parse', 'refs/heads/main');
    assert.notEqual(priorTip, head);
    fs.writeFileSync(path.join(repo, 'too-long.txt'), 'x'.repeat(1_100_000) + '\n');
    git(repo, 'add', 'too-long.txt');
    git(repo, 'commit', '-qm', 'over cap line');
    push = spawnSync('git', ['push', 'origin', 'main'], { cwd: repo, encoding: 'utf8', timeout: 60_000, env: gitEnv() });
    assert.equal(push.status, 1);
    assert.ok(push.stderr.includes('engine.input_too_large'));
    assert.equal(git(origin, 'rev-parse', 'refs/heads/main'), priorTip);
  });

  test('a detectable credential at the end of a long single line is still blocked', () => {
    const { repo, origin, head } = fixture(false);
    fs.writeFileSync(path.join(repo, 'long.txt'), `${'x'.repeat(900_000)} key ${key}\n`);
    git(repo, 'add', 'long.txt');
    git(repo, 'commit', '-qm', 'long line with key');
    const push = spawnSync('git', ['push', 'origin', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(push.status, 1);
    assert.ok(push.stderr.includes('aws.access_key'));
    assert.equal(git(origin, 'rev-parse', 'refs/heads/main'), head);
  });

  test('neighboring individually scannable long clean lines do not force an oversize failure', () => {
    const { repo, origin } = fixture(false);
    fs.writeFileSync(path.join(repo, 'long.txt'), `${'x'.repeat(900_000)}\n${'y'.repeat(900_000)}\n`);
    git(repo, 'add', 'long.txt');
    git(repo, 'commit', '-qm', 'neighboring long lines');
    const tip = git(repo, 'rev-parse', 'HEAD');
    const push = spawnSync('git', ['push', 'origin', 'main'], { cwd: repo, encoding: 'utf8', timeout: 30_000, env: gitEnv() });
    assert.equal(push.status, 0, push.stderr);
    assert.ok(!push.stderr.includes('engine.input_too_large'));
    assert.equal(git(origin, 'rev-parse', 'refs/heads/main'), tip);
  });
});
