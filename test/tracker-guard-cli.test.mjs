// bin/gstack861-issue-guard.mjs — the seven upstream bin tests of
// test/tracker-guard.test.ts describe('bin/gstack-issue-guard') at pinned
// submodule commit 5755601dac5d35ebd7dde181fdefe52a023c73d9, adapted for this
// repo's harness (batch 24 lane B):
//   - bun:test → node:test; spawnSync(GUARD, …) executing the bun bin via its
//     shebang → spawnSync(process.execPath, [GUARD, …]) for the ported .mjs.
//     Every assert value is untouched.
//   - makeGhShimPath ported verbatim from upstream test/helpers/scratch-repo.ts
//     lines 56-66: a `#!/bin/sh` script named `gh` prepended to PATH. win32
//     CreateProcess only resolves .exe/.cmd/.bat when spawnSync searches PATH,
//     so the four shim vectors (gh failure polarity, issue-mode assembly,
//     pr-body success, unparseable JSON) run on the POSIX leg and skip on
//     win32 with the reason below (plan 审计划必改落实 item 4).
//   - The three gh-absent vectors (--stdin envelope, non-numeric issue
//     rejection before any gh spawn, unknown-mode usage) need no gh at all
//     and run on BOTH CI legs (win32 included).
// The lib-level tracker-guard tests (describe('lib/tracker-guard')) are lane
// A's, in this repo's port of that suite; this file covers the bin only.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TRACKER_ENVELOPE_BEGIN } from '../src/tracker-guard.mjs';

const GUARD = fileURLToPath(new URL('../bin/gstack861-issue-guard.mjs', import.meta.url));
const SHIM_SKIP = 'RC4 win32 skip: the gh PATH shim is a #!/bin/sh script named gh, and win32 CreateProcess resolves only .exe/.cmd/.bat on PATH — this vector runs on the POSIX CI leg';

function runGuard(args, input) {
  const r = spawnSync(process.execPath, [GUARD, ...args], { input, encoding: 'utf-8', timeout: 30000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Upstream makeGhShimPath (scratch-repo.ts lines 56-66), verbatim. */
function makeGhShimPath(mode, jsonPayload = '{}') {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-gh-shim-'));
  const body =
    mode === 'fail'
      ? '#!/bin/sh\necho "shim: gh failed" >&2\nexit 1\n'
      : mode === 'garbage'
        ? '#!/bin/sh\necho "this is not json"\nexit 0\n'
        : `#!/bin/sh\ncat <<'SHIM_JSON'\n${jsonPayload}\nSHIM_JSON\nexit 0\n`;
  fs.writeFileSync(path.join(shimDir, 'gh'), body, { mode: 0o755 });
  return { pathEnv: `${shimDir}:${process.env.PATH ?? ''}`, shimDir };
}

describe('bin/gstack861-issue-guard (gh absent — runs on both legs)', () => {
  test('--stdin envelopes piped text with a source label', () => {
    const r = runGuard(['--stdin', '--source', 'unit-test'], 'hello tracker');
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes(`${TRACKER_ENVELOPE_BEGIN} (unit-test)`));
    assert.ok(r.stdout.includes('hello tracker'));
  });

  test('a non-numeric issue argument is rejected before any gh spawn', () => {
    const r = runGuard(['issue', '42; rm -rf /']);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('numeric'));
    assert.ok(!r.stdout.includes(TRACKER_ENVELOPE_BEGIN));
  });

  test('unknown mode exits non-zero with usage', () => {
    const r = runGuard(['bogus-mode']);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('usage'));
  });
});

describe('bin/gstack861-issue-guard (gh shim — POSIX leg)', () => {
  test('gh failure emits NO envelope (never a fake-trusted empty one)', (t) => {
    if (process.platform === 'win32') return t.skip(SHIM_SKIP);
    // A PATH gh shim that exits 1 — the REAL gh-failure branch runs (killing
    // the whole PATH would break PATH-resolved children before they ran,
    // which made an earlier upstream version of this test vacuous).
    const { pathEnv, shimDir } = makeGhShimPath('fail');
    try {
      const r = spawnSync(process.execPath, [GUARD, 'pr-body'], { encoding: 'utf-8', timeout: 30000, env: { ...process.env, PATH: pathEnv } });
      assert.notEqual(r.status ?? 1, 0);
      assert.ok((r.stderr ?? '').includes('gh pr view failed'));
      assert.ok(!(r.stdout ?? '').includes(TRACKER_ENVELOPE_BEGIN));
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  test('issue mode assembles title + body + comments from gh JSON (shimmed)', (t) => {
    if (process.platform === 'win32') return t.skip(SHIM_SKIP);
    const payload = JSON.stringify({
      title: 'Widget breaks',
      body: 'It fails on save.',
      comments: [{ author: { login: 'alice' }, body: 'repro attached' }],
    });
    const { pathEnv, shimDir } = makeGhShimPath('json', payload);
    try {
      const r = spawnSync(process.execPath, [GUARD, 'issue', '42'], { encoding: 'utf-8', timeout: 30000, env: { ...process.env, PATH: pathEnv } });
      assert.equal(r.status, 0);
      assert.ok(r.stdout.includes(`${TRACKER_ENVELOPE_BEGIN} (issue #42)`));
      assert.ok(r.stdout.includes('TITLE: Widget breaks'));
      assert.ok(r.stdout.includes('It fails on save.'));
      assert.ok(r.stdout.includes('--- comment by alice ---'));
      assert.ok(r.stdout.includes('repro attached'));
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  test('pr-body success envelopes the body (shimmed)', (t) => {
    if (process.platform === 'win32') return t.skip(SHIM_SKIP);
    const { pathEnv, shimDir } = makeGhShimPath('json', 'the pr body text');
    try {
      const r = spawnSync(process.execPath, [GUARD, 'pr-body'], { encoding: 'utf-8', timeout: 30000, env: { ...process.env, PATH: pathEnv } });
      assert.equal(r.status, 0);
      assert.ok(r.stdout.includes('the pr body text'));
      assert.ok(r.stdout.includes(TRACKER_ENVELOPE_BEGIN));
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  test('unparseable gh JSON in issue mode fails with NO envelope (shimmed)', (t) => {
    if (process.platform === 'win32') return t.skip(SHIM_SKIP);
    const { pathEnv, shimDir } = makeGhShimPath('garbage');
    try {
      const r = spawnSync(process.execPath, [GUARD, 'issue', '42'], { encoding: 'utf-8', timeout: 30000, env: { ...process.env, PATH: pathEnv } });
      assert.notEqual(r.status, 0);
      assert.ok((r.stderr ?? '').includes('unparseable'));
      assert.ok(!(r.stdout ?? '').includes(TRACKER_ENVELOPE_BEGIN));
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });
});
