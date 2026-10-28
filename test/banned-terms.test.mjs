import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The ported binary under test — always a real subprocess, exactly as a
// user or a hook would invoke it.
const SCRIPT = fileURLToPath(new URL('../bin/gstack861-banned-terms.mjs', import.meta.url));
const CFG = '.gstack/banned-terms.json';
const SCHEMA = 'https://github.com/garrytan/gstack/docs/ship-policy.md#banned-terms';

/** Byte-exact expectation for init: upstream exampleBannedTermsJson() ported verbatim. */
const EXAMPLE = JSON.stringify({
  $schema: SCHEMA,
  terms: [
    'blazing fast',
    { term: 'legacy-name', allowed_paths: ['CHANGELOG.md', 'docs/migration/**'], reason: 'the product was renamed; the old name belongs to history only' },
  ],
  allowed_paths: ['docs/glossary.md', 'vendor/**'],
}, null, 2) + '\n';

/** Real git fixture: mkdtemp + init on an explicit 'main' (init.defaultBranch varies by host/CI leg). */
function makeRepo(t, initialFiles) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-bt-')));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'banned-terms-test@example.invalid');
  git('config', 'user.name', 'banned-terms test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  const write = (rel, text) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  const commitAll = (msg) => { git('add', '-A'); git('commit', '--allow-empty', '-m', msg); return git('rev-parse', 'HEAD'); };
  if (initialFiles) { for (const [rel, text] of Object.entries(initialFiles)) write(rel, text); commitAll('fixture'); }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, git, write, commitAll };
}

const run = (cwd, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', timeout: 60_000 });
const writeCfg = (repo, value) => repo.write(CFG, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
const findingLines = (out) => out.split('\n').filter((l) => l.startsWith('BANNED_TERM: '));
const finalLine = (out) => out.split('\n').find((l) => l.startsWith('BANNED_TERMS: '));

// ---------------------------------------------------------------------------
// usage surface: --help, not a repo, unknown command (exit 2)
// ---------------------------------------------------------------------------

test('help prints usage and the verbatim upstream exit table, exit 0', () => {
  for (const h of ['--help', '-h']) {
    const r = run(process.cwd(), h);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /gstack861-banned-terms — scan a diff for banned terms/);
    assert.match(r.stdout, /--policy-from base\|head/);
    assert.ok(r.stdout.includes('Exit codes: 0 ok · 1 fail · 2 usage · 3 refused or needs a flag'));
  }
});

test('outside a git repository: stderr note, exit 2', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-nogit-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = run(dir, 'check');
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'gstack861-banned-terms: not inside a git repository\n');
});

test('unknown command: stderr + help, exit 2', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  const r = run(repo.root, 'frobnicate');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command frobnicate/);
  assert.match(r.stderr, /Exit codes: 0 ok · 1 fail/);
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

test('validate with no config: none line, exit 0', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  const r = run(repo.root, 'validate');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'BANNED_TERMS: none (no .gstack/banned-terms.json)\n');
});

test('validate accepts the example config', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  writeCfg(repo, JSON.parse(EXAMPLE));
  const r = run(repo.root, 'validate');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'BANNED_TERMS_VALID: .gstack/banned-terms.json\n');
  assert.equal(r.stderr, '');
});

test('validate rejects non-object JSON (array, string, number, null): one error, exit 3', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  for (const raw of ['[]', '"hello"', '42', 'null']) {
    writeCfg(repo, raw);
    const r = run(repo.root, 'validate');
    assert.equal(r.status, 3, raw);
    assert.equal(r.stderr.trim(), 'gstack861-banned-terms validate: BANNED_TERMS_INVALID: must be a JSON object at <root>');
  }
});

test('validate on a file that is not valid JSON: exit 3, one stderr line', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  writeCfg(repo, '{"terms": [');
  const r = run(repo.root, 'validate');
  assert.equal(r.status, 3);
  // bin validate passes the raw parser message (upstream line 57); the
  // 'not valid JSON:' wrapper belongs to the lib-level load path (check).
  assert.equal(r.stderr.split('\n').filter(Boolean).length, 1);
  assert.match(r.stderr, /^gstack861-banned-terms validate: BANNED_TERMS_INVALID: /);
});

test('validate structural matrix: unknown keys, terms shape, size caps, control chars', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  const cases = [
    // [config, regex each stderr line must match]
    [{ foo: 1, terms: ['x'] }, /unknown key; valid keys: terms, allowed_paths at foo$/],
    [{ terms: [] }, /must be a non-empty array at terms$/],
    [{ terms: 'nope' }, /must be a non-empty array at terms$/],
    [{}, /must be a non-empty array at terms$/],
    [{ terms: Array.from({ length: 201 }, (_, i) => `t${i}`) }, /more than 200 entries at terms$/],
    [{ terms: ['x'.repeat(81)] }, /longer than 80 characters at terms\[0\]$/],
    [{ terms: [{ term: 'a\nb' }] }, /contains a control character at terms\[0\]$/],
    [{ terms: [' '] }, /must be a non-empty string or \{term, allowed_paths\} at terms\[0\]$/],
    [{ terms: [{ allowed_paths: [] }] }, /must be a non-empty string or \{term, allowed_paths\} at terms\[0\]$/],
    [{ terms: [{ term: 'x', why: 1 }] }, /unknown key; valid keys: term, allowed_paths, reason at terms\[0\]\.why$/],
    [{ terms: ['x'], allowed_paths: 'nope' }, /must be an array of globs at allowed_paths$/],
    [{ terms: ['x'], allowed_paths: Array.from({ length: 201 }, () => 'a/**') }, /more than 200 entries at allowed_paths$/],
    [{ terms: [{ term: 'x', allowed_paths: [7] }] }, /must be a string at terms\[0\]\.allowed_paths\[0\]$/],
  ];
  for (const [cfg, re] of cases) {
    writeCfg(repo, cfg);
    const r = run(repo.root, 'validate');
    const label = JSON.stringify(cfg).slice(0, 60);
    assert.equal(r.status, 3, label);
    const lines = r.stderr.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, label);
    assert.match(lines[0], /^gstack861-banned-terms validate: BANNED_TERMS_INVALID: /, label);
    assert.match(lines[0], re, label);
  }
  // several errors → one stderr line EACH
  writeCfg(repo, { foo: 1, terms: [] });
  const multi = run(repo.root, 'validate');
  assert.equal(multi.status, 3);
  assert.equal(multi.stderr.split('\n').filter(Boolean).length, 2);
});

test('validate glob containment matrix (C1): .., absolute, UNC, drive, ~, empty, size caps', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  const cases = [
    ['../escape', 'must not contain a `..` segment'],
    ['a/../b', 'must not contain a `..` segment'],
    ['/abs/path', 'must be repo-relative, not absolute'],
    ['\\abs\\path', 'must be repo-relative, not absolute'],
    ['\\\\srv\\share\\x', 'must be repo-relative, not absolute'],
    ['C:\\Users\\x', 'must be repo-relative, not absolute'],
    ['D:/data', 'must be repo-relative, not absolute'],
    ['~home', 'must not start with ~'],
    ['', 'must be a non-empty string'],
    ['a'.repeat(257), 'longer than 256 characters'],
    ['**/'.repeat(80), 'pattern expands past 512 characters'], // 240 raw chars → 642-char regex
  ];
  writeCfg(repo, { terms: ['x'], allowed_paths: cases.map(([g]) => g) });
  const r = run(repo.root, 'validate');
  assert.equal(r.status, 3);
  const lines = r.stderr.split('\n').filter(Boolean);
  assert.equal(lines.length, cases.length);
  cases.forEach(([g, why], i) => {
    assert.match(lines[i], new RegExp(`at allowed_paths\\[${i}\\]$`), g);
    assert.ok(lines[i].includes(why), `${g} → ${why}`);
    assert.ok(lines[i].includes(JSON.stringify(g)), `${g} echoed`);
  });
  // a non-string entry in the list
  writeCfg(repo, { terms: ['x'], allowed_paths: [42] });
  assert.match(run(repo.root, 'validate').stderr.trim(), /42 must be a string at allowed_paths\[0\]$/);
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

test('init writes the exact example (schema URL included) and is refused without --force', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  const first = run(repo.root, 'init');
  assert.equal(first.status, 0);
  assert.equal(first.stdout, 'BANNED_TERMS_INIT: .gstack/banned-terms.json\n');
  assert.equal(fs.readFileSync(path.join(repo.root, CFG), 'utf8'), EXAMPLE);

  const second = run(repo.root, 'init');
  assert.equal(second.status, 3);
  assert.equal(second.stderr, 'gstack861-banned-terms: .gstack/banned-terms.json exists (pass --force to overwrite)\n');

  fs.writeFileSync(path.join(repo.root, CFG), '{"terms": ["mutated"]}');
  const forced = run(repo.root, 'init', '--force');
  assert.equal(forced.status, 0);
  assert.equal(fs.readFileSync(path.join(repo.root, CFG), 'utf8'), EXAMPLE);
});

test('init creates the .gstack directory when missing', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  const r = run(repo.root, 'init');
  assert.equal(r.status, 0);
  assert.ok(fs.statSync(path.join(repo.root, '.gstack')).isDirectory());
});

// ---------------------------------------------------------------------------
// check: the none path and the base resolution chain (RC4)
// ---------------------------------------------------------------------------

test('check with no config anywhere: none line naming the resolved base, exit 0', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  // no --base, no origin/HEAD → silent fallback 'main'
  const r = run(repo.root, 'check');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'BANNED_TERMS: none (no .gstack/banned-terms.json on main)\n');
  // --base origin/main → the origin/ prefix is stripped
  assert.equal(run(repo.root, 'check', '--base', 'origin/main').stdout,
    'BANNED_TERMS: none (no .gstack/banned-terms.json on main)\n');
  // --policy-from head names the working tree; any other value behaves as base (upstream)
  assert.equal(run(repo.root, 'check', '--policy-from', 'head').stdout,
    'BANNED_TERMS: none (no .gstack/banned-terms.json on the working tree)\n');
  assert.equal(run(repo.root, 'check', '--policy-from', 'sideways').stdout,
    'BANNED_TERMS: none (no .gstack/banned-terms.json on main)\n');
});

test('check --json with no config: absent shape', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  const r = run(repo.root, 'check', '--json');
  assert.equal(r.status, 0);
  // the bin-level worktree fallback REASSIGNED the load before printing, so the
  // absent json names the fallback source (upstream bin lines 70-71), not the base.
  assert.deepEqual(JSON.parse(r.stdout), { source: '.gstack/banned-terms.json', absent: true, findings: [] });
});

test('base chain consults origin/HEAD before the main fallback', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  repo.git('update-ref', 'refs/remotes/origin/release-x', repo.git('rev-parse', 'HEAD'));
  repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release-x');
  const r = run(repo.root, 'check');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'BANNED_TERMS: none (no .gstack/banned-terms.json on release-x)\n');
});

// ---------------------------------------------------------------------------
// check --files: whole-file mode, exemptions, render format
// ---------------------------------------------------------------------------

test('--files scans whole files with per-term and global allowed_paths exemptions', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  writeCfg(repo, {
    terms: [{ term: 'blazing fast', allowed_paths: ['docs/**'] }, 'legacy-name'],
    allowed_paths: ['vendor/**'],
  });
  repo.write('docs/a.md', 'has blazing fast inside\n');
  repo.write('src/b.md', 'this is BLAZING fast now\n');
  repo.write('vendor/c.md', 'legacy-name lives here\n');
  repo.write('src/d.md', 'the legacy-name too\n');
  // csv entries are trimmed (spaces after commas)
  const r = run(repo.root, 'check', '--files', 'docs/a.md, src/b.md,vendor/c.md, src/d.md');
  assert.equal(r.status, 1);
  // normalizeRules merges GLOBAL paths first, then the term's own (upstream line 88)
  assert.deepEqual(findingLines(r.stdout), [
    'BANNED_TERM: "blazing fast" src/b.md:1 allowed: vendor/**, docs/** — this is BLAZING fast now',
    'BANNED_TERM: "legacy-name" src/d.md:1 allowed: vendor/** — the legacy-name too',
  ]);
  // base copy absent → bin-level working-tree fallback (RC1) shows as the worktree source
  assert.equal(finalLine(r.stdout), 'BANNED_TERMS: found=2 terms=2 files=4 source=.gstack/banned-terms.json');
  assert.match(r.stderr, /BANNED_TERM_FOUND: 2 finding\(s\)/);
});

test('--files with no hits: ok final line, exit 0', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  writeCfg(repo, { terms: ['needle'], allowed_paths: [] });
  repo.write('a.txt', 'nothing to see\n');
  repo.write('b.txt', 'move along\n');
  const r = run(repo.root, 'check', '--files', 'a.txt,b.txt');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'BANNED_TERMS: ok terms=1 files=2 source=.gstack/banned-terms.json\n');
});

test('--files silently drops missing paths, directories and binaries (NUL in first 1024 bytes)', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  writeCfg(repo, { terms: ['needle'] });
  repo.write('sub/inner.txt', 'needle in the directory\n');
  const binary = Buffer.concat([Buffer.from('n\0'), Buffer.from('needle needle '.repeat(200))]);
  fs.writeFileSync(path.join(repo.root, 'bin.dat'), binary); // NUL at byte 1, term present throughout
  repo.write('good.txt', 'needle here\n');
  const r = run(repo.root, 'check', '--files', 'missing.md,sub,bin.dat,good.txt', '--json');
  assert.equal(r.status, 1);
  const result = JSON.parse(r.stdout);
  assert.equal(result.scanned_files, 1);
  assert.deepEqual(result.findings.map((f) => f.file), ['good.txt']);
  assert.deepEqual(result.skipped, []);
});

// ---------------------------------------------------------------------------
// check diff mode
// ---------------------------------------------------------------------------

function diffRepo(t) {
  const repo = makeRepo(t, {});
  writeCfg(repo, { terms: ['blazing fast'] });
  repo.write('src/a.md', 'line one\nblazing fast stays\nline three\n');
  const base = repo.commitAll('base');
  repo.git('checkout', '-b', 'feature');
  repo.write('src/a.md', 'line one\nblazing fast stays\nADDED blazing fast here\nline three\n');
  repo.commitAll('adds the term');
  return { repo, base };
}

test('diff mode: only ADDED lines hit, with file:line and the allowed locations', (t) => {
  const { repo, base } = diffRepo(t);
  for (const args of [['check'], ['check', '--diff-base', base]]) {
    const r = run(repo.root, ...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.deepEqual(findingLines(r.stdout), [
      'BANNED_TERM: "blazing fast" src/a.md:3 allowed: nowhere — ADDED blazing fast here',
    ]);
    assert.equal(finalLine(r.stdout), 'BANNED_TERMS: found=1 terms=1 files=1 source=main:.gstack/banned-terms.json');
  }
});

test('diff mode: unchanged lines that already contain the term do not hit', (t) => {
  const { repo, base } = diffRepo(t);
  const r = run(repo.root, 'check', '--diff-base', base, '--json');
  assert.equal(r.status, 1);
  const result = JSON.parse(r.stdout);
  assert.deepEqual(result.findings.map((f) => f.line), [3]); // line 2 'blazing fast stays' untouched
  assert.deepEqual(result.skipped, []); // the config was not part of this diff
});

test('diff mode exit 2 when merge-base fails and no --diff-base/--files is given', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  writeCfg(repo, { terms: ['x'] }); // a valid worktree config so loading gets past the policy stage
  const r = run(repo.root, 'check', '--base', 'no-such-branch');
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'gstack861-banned-terms: no merge base with no-such-branch; pass --diff-base <sha> or --files <csv>\n');
});

// ---------------------------------------------------------------------------
// self-exemption (RC2) + bin-level policy fallback (RC1)
// ---------------------------------------------------------------------------

test('the config file never flags itself: init → commit → diff check skips it (RC2)', (t) => {
  const repo = makeRepo(t, {});
  repo.write('src/x.md', 'clean baseline\n');
  repo.commitAll('base');
  repo.git('checkout', '-b', 'feature');
  assert.equal(run(repo.root, 'init').status, 0); // example contains "blazing fast" and "legacy-name"
  repo.write('src/new.md', 'make it blazing fast please\n');
  repo.commitAll('adds config and a hit');

  // main has no config copy → bin falls back to the working tree (RC1), then the
  // config's own added lines are self-exempt and land in skipped (RC2).
  const r = run(repo.root, 'check', '--base', 'main', '--json');
  assert.equal(r.status, 1);
  const result = JSON.parse(r.stdout);
  assert.deepEqual(result.skipped, [CFG]);
  assert.deepEqual(result.findings.map((f) => f.file), ['src/new.md']);
  assert.equal(result.source, CFG);
  // text mode: no BANNED_TERM line for the config path
  const plain = run(repo.root, 'check', '--base', 'main');
  assert.equal(findingLines(plain.stdout).length, 1);
  assert.ok(!findingLines(plain.stdout)[0].includes(CFG));
});

test('self-exemption also holds when the policy comes from a committed base copy', (t) => {
  const repo = makeRepo(t, {});
  repo.write('src/x.md', 'clean\n');
  const base = repo.commitAll('base');
  assert.equal(run(repo.root, 'init').status, 0);
  repo.write('src/y.md', 'the legacy-name appears\n');
  repo.commitAll('adds config and a hit');
  const r = run(repo.root, 'check', '--diff-base', base, '--json');
  assert.equal(r.status, 1);
  const result = JSON.parse(r.stdout);
  assert.equal(result.source, `main:${CFG}`);
  assert.deepEqual(result.skipped, [CFG]);
  assert.deepEqual(result.findings.map((f) => [f.file, f.term]), [['src/y.md', 'legacy-name']]);
  // the example's rule carries global-then-own allowed_paths + reason into the finding
  assert.deepEqual(result.findings[0].allowed_paths, ['docs/glossary.md', 'vendor/**', 'CHANGELOG.md', 'docs/migration/**']);
  assert.equal(result.findings[0].reason, 'the product was renamed; the old name belongs to history only');
});

// ---------------------------------------------------------------------------
// --policy-from base vs head
// ---------------------------------------------------------------------------

test('--policy-from base reads the committed base copy; head reads the working tree', (t) => {
  const repo = makeRepo(t, {});
  writeCfg(repo, { terms: ['alpha-term'] });
  repo.write('src/a.md', 'clean\n');
  repo.commitAll('base with alpha-term policy');
  repo.git('checkout', '-b', 'feature');
  writeCfg(repo, { terms: ['beta-term'] }); // committed on feature only
  repo.write('src/a.md', 'clean\nuses alpha-term here\n');
  repo.commitAll('adds an alpha-term line under a beta-term policy');

  const fromBase = run(repo.root, 'check', '--base', 'main', '--json');
  assert.equal(fromBase.status, 1);
  const baseResult = JSON.parse(fromBase.stdout);
  assert.equal(baseResult.source, 'main:.gstack/banned-terms.json');
  assert.deepEqual(baseResult.findings.map((f) => f.term), ['alpha-term']);

  const fromHead = run(repo.root, 'check', '--base', 'main', '--policy-from', 'head', '--json');
  assert.equal(fromHead.status, 0);
  const headResult = JSON.parse(fromHead.stdout);
  assert.equal(headResult.source, '.gstack/banned-terms.json');
  assert.deepEqual(headResult.findings, []);
  assert.equal(headResult.terms, 1); // beta-term loaded, just not matched
});

// ---------------------------------------------------------------------------
// matching semantics: whitespace → \s+, word boundaries, case, literal specials
// ---------------------------------------------------------------------------

test('intra-term whitespace matches any whitespace run (blazing fast vs multi-space/tab)', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  writeCfg(repo, { terms: ['blazing fast'] });
  repo.write('w.txt', 'blazing  fast\nblazing\tfast\nblazing fast\nno match blazingfast\n');
  const r = run(repo.root, 'check', '--files', 'w.txt', '--json');
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stdout).findings.map((f) => f.line), [1, 2, 3]);
});

test('word boundaries: \\b only at [A-Za-z0-9_] edges of the term', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  writeCfg(repo, { terms: ['legacy-name', '!!urgent'] });
  repo.write('wb.txt', 'legacy-names\nxlegacy-name\nlegacy-name!\nx!!urgent\n!!urgentx\n');
  const r = run(repo.root, 'check', '--files', 'wb.txt', '--json');
  assert.equal(r.status, 1);
  const hits = JSON.parse(r.stdout).findings.map((f) => [f.term, f.line]);
  // 'legacy-name' has word-char edges → not inside legacy-names / xlegacy-name.
  // '!!urgent' has a NON-word leading edge (no \b → 'x!!urgent' hits) but its
  // trailing char 't' is a word char → \b → '!!urgentx' does NOT hit.
  assert.deepEqual(hits, [['legacy-name', 3], ['!!urgent', 4]]);
});

test('regex specials in a term are literal; finding text is trimmed and capped at 160', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  writeCfg(repo, { terms: ['a.b*c'] });
  repo.write('re.txt', 'aXbYc\naxbyc\n   a.b*c   \n');
  repo.write('long.txt', `${'x'.repeat(170)} a.b*c\n`);
  const r = run(repo.root, 'check', '--files', 're.txt,long.txt', '--json');
  assert.equal(r.status, 1);
  const findings = JSON.parse(r.stdout).findings;
  assert.deepEqual(findings.filter((f) => f.file === 're.txt').map((f) => [f.line, f.text]), [[3, 'a.b*c']]);
  const long = findings.find((f) => f.file === 'long.txt');
  assert.equal(long.text.length, 160); // trimmed, then slice(0, 160)
  assert.equal(long.text, 'x'.repeat(160));
});

// ---------------------------------------------------------------------------
// globToRegExp semantics, pinned behaviorally through exemptions
// ---------------------------------------------------------------------------

test('glob semantics: **/*.md, docs/**, ?, and literal dots (upstream globToRegExp)', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  const files = {
    'a.md': 'needle\n', 'a.txt': 'needle\n', 'docs/a.md': 'needle\n',
    'docs/ab.md': 'needle\n', 'docs/sub/b.md': 'needle\n', 'v1.2.txt': 'needle\n', 'v1x2.txt': 'needle\n',
  };
  for (const [rel, text] of Object.entries(files)) repo.write(rel, text);
  const csv = Object.keys(files).join(',');
  const hitsFor = (glob) => {
    writeCfg(repo, { terms: ['needle'], allowed_paths: [glob] });
    const r = run(repo.root, 'check', '--files', csv, '--json');
    return JSON.parse(r.stdout).findings.map((f) => f.file).sort();
  };
  // '**/*.md' → ^(?:.*/)?[^/]*\.md$ — any depth, .md only, the dot is literal
  assert.deepEqual(hitsFor('**/*.md'), ['a.txt', 'v1.2.txt', 'v1x2.txt']);
  // 'docs/**' → ^docs/.*$ — everything under docs/, nothing outside
  assert.deepEqual(hitsFor('docs/**'), ['a.md', 'a.txt', 'v1.2.txt', 'v1x2.txt']);
  // 'docs/?.md' → ? is exactly one non-separator character
  assert.deepEqual(hitsFor('docs/?.md'), ['a.md', 'a.txt', 'docs/ab.md', 'docs/sub/b.md', 'v1.2.txt', 'v1x2.txt']);
  // 'v1.2.txt' — the dot is literal, not ?
  assert.deepEqual(hitsFor('v1.2.txt'), ['a.md', 'a.txt', 'docs/a.md', 'docs/ab.md', 'docs/sub/b.md', 'v1x2.txt']);
});

// ---------------------------------------------------------------------------
// exit matrix (RC3) and --json result shape
// ---------------------------------------------------------------------------

test('exit matrix: 0 ok/none · 1 findings · 2 usage · 3 invalid config / init exists', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  assert.equal(run(repo.root, 'validate').status, 0); // 0: none
  writeCfg(repo, { terms: ['needle'] });
  repo.write('hit.txt', 'needle\n');
  assert.equal(run(repo.root, 'check', '--files', 'hit.txt').status, 1); // 1: findings
  assert.equal(run(repo.root, 'no-such-command').status, 2); // 2: usage
  writeCfg(repo, 'not json at all');
  const invalid = run(repo.root, 'check', '--files', 'hit.txt');
  assert.equal(invalid.status, 3); // 3: config invalid on check
  assert.match(invalid.stderr, /BANNED_TERMS_INVALID: not valid JSON/);
  writeCfg(repo, { terms: ['needle'] });
  assert.equal(run(repo.root, 'init').status, 3); // 3: init exists without --force
  repo.write('clean.txt', 'fine\n');
  assert.equal(run(repo.root, 'check', '--files', 'clean.txt').status, 0); // 0: ok
});

test('--json result shape: source/terms/scanned_files/findings/skipped', (t) => {
  const repo = makeRepo(t, { 'README.md': 'x' });
  writeCfg(repo, { terms: [{ term: 'needle', reason: 'glossary only' }] });
  repo.write('hit.txt', 'a needle appears\n');
  const r = run(repo.root, 'check', '--files', 'hit.txt', '--json');
  assert.equal(r.status, 1);
  const result = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(result), ['source', 'terms', 'scanned_files', 'findings', 'skipped']);
  assert.equal(result.source, '.gstack/banned-terms.json');
  assert.equal(result.terms, 1);
  assert.equal(result.scanned_files, 1);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(Object.keys(result.findings[0]), ['term', 'file', 'line', 'text', 'allowed_paths', 'reason']);
  assert.equal(result.findings[0].term, 'needle');
  assert.equal(result.findings[0].file, 'hit.txt');
  assert.equal(result.findings[0].line, 1);
  assert.equal(result.findings[0].allowed_paths.length, 0);
  // the same finding renders with "nowhere" and the reason in text mode
  const plain = run(repo.root, 'check', '--files', 'hit.txt');
  assert.ok(plain.stdout.includes('allowed: nowhere (glossary only) — a needle appears'));
});
