import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The subcommand under test, always as a real subprocess: it resolves the repo root
// through git in the child's cwd, which an in-process import could not exercise.
const cli = fileURLToPath(new URL('../bin/gstack861.mjs', import.meta.url));
const run = (argv, cwd) => spawnSync(process.execPath, [cli, ...argv], { cwd, encoding: 'utf8', timeout: 15000 });
const agentsMd = root => path.join(root, 'AGENTS.md');

/** Real git fixture (the mapping's default root source is git unless --root bypasses it). */
function repo(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-teaminit-')));
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git('add', '.');
  git('-c', 'user.name=gstack861 test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root };
}

/** Plain non-git temp dir, for the --root bypass and the not-a-repo refusal. */
function plainDir(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-teaminit-')));
  const root = path.join(base, 'plain');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root };
}

// Mapping purity, pinned once: the generated text never names Claude-side surfaces.
function assertNoClaudeSurfaces(content, label) {
  assert.ok(!content.includes('CLAUDE.md'), `${label} must not mention CLAUDE.md`);
  assert.ok(!content.includes('.claude'), `${label} must not mention .claude`);
}

test('1. optional mode creates AGENTS.md with the recommended section and no Claude surfaces', t => {
  const r = repo(t);
  const child = run(['team-init', 'optional'], r.root);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /TEAM_INIT: optional/);
  assert.match(child.stdout, /generated: AGENTS\.md/);
  const content = fs.readFileSync(agentsMd(r.root), 'utf8');
  assert.match(content, /## gstack861 \(recommended\)/);
  // install/verify command, verbatim
  assert.ok(content.includes('node bin/gstack861.mjs doctor'));
  // acceptance-pack pointer
  assert.ok(content.includes('acceptance-pack'), 'optional section must point at the acceptance pack');
  // RC6 provenance: AGENTS.md labelled a host-side convention, never asserted as host-read
  assert.ok(content.includes('host-side convention'), 'provenance must carry the host-side-convention marker');
  assert.ok(content.includes('宿主侧约定[验收项]'), 'provenance must carry the 宿主侧约定[验收项] marker');
  assertNoClaudeSurfaces(content, 'optional section');
});

test('2. required mode: verify-first section with both wiring commands verbatim; stdout also prints them', t => {
  const r = repo(t);
  const child = run(['team-init', 'required'], r.root);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /TEAM_INIT: required/);
  const content = fs.readFileSync(agentsMd(r.root), 'utf8');
  assert.match(content, /## gstack861 \(REQUIRED\)/);
  // verify-first wording: run doctor before ANY work, stop if hosts look wrong
  assert.match(content, /Before doing ANY work/);
  assert.ok(content.includes('node bin/gstack861.mjs doctor'));
  assert.ok(content.includes('STOP'), 'verify-first wording must say STOP');
  // both host wiring commands, verbatim (only --policy/--matcher exist on zcode-config)
  assert.ok(content.includes('gstack861 zcode-config --policy <ABS_PATH>'), 'zcode wiring string must be verbatim');
  assert.ok(content.includes('docs/integration/dsh-local-findings.md'), 'DSH wiring must reference the guard-profile findings doc');
  assertNoClaudeSurfaces(content, 'required section');
  // wiring printed to stdout too, for immediate use
  assert.ok(child.stdout.includes('gstack861 zcode-config --policy <ABS_PATH>'));
  assert.ok(child.stdout.includes('docs/integration/dsh-local-findings.md'));
});

test('3. idempotence: a second run skips (no duplicate section, skip message), cross-mode too', t => {
  const r = repo(t);
  const first = run(['team-init', 'optional'], r.root);
  assert.equal(first.status, 0, first.stderr);
  const once = fs.readFileSync(agentsMd(r.root), 'utf8');
  assert.equal(once.split('## gstack861').length - 1, 1, 'exactly one section header after the first run');
  const second = run(['team-init', 'optional'], r.root);
  assert.equal(second.status, 0, second.stderr); // skip is still success, like upstream
  assert.match(second.stdout, /AGENTS\.md already has a gstack861 section/);
  assert.match(second.stdout, /remove the existing ## gstack861 section and re-run/);
  assert.match(second.stdout, /generated: \(none\)/);
  assert.equal(fs.readFileSync(agentsMd(r.root), 'utf8'), once, 'skip must not touch the file');
  // upstream's grep-skip is mode-agnostic: a later required run appends nothing either
  const third = run(['team-init', 'required'], r.root);
  assert.equal(third.status, 0, third.stderr);
  assert.equal(fs.readFileSync(agentsMd(r.root), 'utf8'), once);
  // ...but required mode still prints the wiring commands on stdout
  assert.ok(third.stdout.includes('gstack861 zcode-config --policy <ABS_PATH>'));
});

test('4. existing AGENTS.md with unrelated content: appended, original bytes preserved', t => {
  // A fresh run pins the canonical section bytes; the append run must reproduce them
  // after exactly one separating newline, with the original bytes untouched.
  const fresh = repo(t);
  assert.equal(run(['team-init', 'optional'], fresh.root).status, 0);
  const snippet = fs.readFileSync(agentsMd(fresh.root), 'utf8');

  const r = repo(t);
  const original = 'Project notes\n\nunrelated content — 中文与空格   \nlast line has no trailing newline';
  fs.writeFileSync(agentsMd(r.root), original, 'utf8');
  const child = run(['team-init', 'optional'], r.root);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(fs.readFileSync(agentsMd(r.root), 'utf8'), original + '\n' + snippet,
    'upstream echo-separator semantics: original bytes + exactly one \\n + the section');
});

test('5. existing "## gstack861" section: skipped, file bytes unchanged', t => {
  const r = repo(t);
  const before = Buffer.from('intro\n\n## gstack861 (recommended)\nstale content\n');
  fs.writeFileSync(agentsMd(r.root), before);
  const child = run(['team-init', 'optional'], r.root);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /already has a gstack861 section/);
  assert.deepEqual(fs.readFileSync(agentsMd(r.root)), before, 'skip must be byte-inert');
});

test('6. --root DIR on a non-git dir works and bypasses the git cwd', t => {
  const r = plainDir(t);
  // cwd stays inside a real git repo (the test process's worktree): --root must win,
  // and nothing may land in the git cwd's root.
  const child = run(['team-init', 'optional', '--root', r.root]);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /TEAM_INIT: optional/);
  const content = fs.readFileSync(agentsMd(r.root), 'utf8');
  assert.match(content, /## gstack861 \(recommended\)/);
  assert.ok(!fs.existsSync(path.join(process.cwd(), 'AGENTS.md')), 'the git cwd root must stay untouched');
});

test('7. bad args (no mode / unknown mode) print usage and exit 1, writing nothing', t => {
  const r = repo(t);
  for (const argv of [['team-init'], ['team-init', 'nope']]) {
    const child = run(argv, r.root);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /Usage: gstack861 team-init \{optional\|required\}/);
  }
  assert.ok(!fs.existsSync(agentsMd(r.root)), 'refused invocation must write nothing');
  // A stray positional after the mode goes through the shared flags() refusal.
  const stray = run(['team-init', 'optional', 'extra'], r.root);
  assert.equal(stray.status, 1);
  assert.match(stray.stderr, /INVALID_ARGUMENTS/);
});

test('8. non-git cwd without --root: exit 1 via the catch-all, no files written', t => {
  const r = plainDir(t);
  const child = run(['team-init', 'optional'], r.root);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /NOT_A_GIT_REPO/);
  assert.deepEqual(fs.readdirSync(r.root), [], 'no files may be written on refusal');
});
