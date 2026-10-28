#!/usr/bin/env node
// gstack861-banned-terms — scan a diff (or whole files) for terms the
// repository forbids outside their named allowed locations.
//
// Port of upstream/gstack bin/gstack-banned-terms (90 lines) +
// lib/banned-terms.ts (167 lines) plus resolveBaseBranch (ship-policy.ts
// lines 420-431) at pinned submodule commit 5755601. The ship-policy
// helpers the scanner leans on — containedRelative / globToRegExp /
// matchesAny (upstream lines 190-227) — were inlined here since the b20
// port and are lifted into the shared src/ship-policy.mjs as of batch 23;
// this bin now imports them (behavior-preserving refactor, the 29 tests
// below are the regression gate). One standalone zero-dependency Node
// executable apart from that intra-repo import.
//
// CLI (upstream shape):
//   gstack861-banned-terms.mjs [check] [--base <ref>] [--diff-base <sha>] [--files <csv>] [--policy-from base|head] [--json]
//   gstack861-banned-terms.mjs init [--force]
//   gstack861-banned-terms.mjs validate
//   gstack861-banned-terms.mjs --help | -h
//
// Semantics (upstream-exact; every deviation is in the ledger below):
//   - Config `.gstack/banned-terms.json` = {$schema?, terms: (string |
//     {term, allowed_paths, reason?})[], allowed_paths: string[]}; caps
//     MAX_TERMS=200 / MAX_TERM=80 / MAX_PATHS=200 (and the ported
//     MAX_PATTERN=256 / MAX_REGEX=512 glob caps); unknown keys are errors;
//     a MISSING file is `none` (ok, never a failure).
//   - validate: schema + C1 containment — no `..` segment, no absolute
//     path, no ~, globs confined to the repository, size caps on the raw
//     pattern and on its regex expansion.
//   - check policy source: `--policy-from base` (default) reads the
//     committed copy via `git show <base>:.gstack/banned-terms.json`; when
//     that copy is absent the BIN falls back to the working tree (RC1 —
//     the lib-level loadBannedTerms itself only ever reports absent);
//     `--policy-from head` reads the working tree directly.
//   - Base resolution (RC4): `--base <ref>` (a leading origin/ is
//     stripped) → `git symbolic-ref refs/remotes/origin/HEAD` → silent
//     fallback `main`; a usage error (exit 2) only when the subsequent
//     merge-base fails.
//   - Diff mode: `git diff --unified=0 --no-color <diffBase>` where
//     diffBase = `--diff-base <sha>` or `git merge-base <base> HEAD`; only
//     ADDED lines count, attributed per-file by the upstream parser
//     verbatim (new-side path from the `+++ ` line with b/ and trailing
//     tab-fields stripped, `/dev/null` clears the file, every `@@` hunk
//     header resets the new-side counter, context lines advance it, `\`
//     no-newline markers do not).
//   - `--files <csv>`: whole files; missing paths, directories and
//     binaries (a NUL in the first 1024 bytes) are dropped silently.
//   - Scan: the config file itself is always skipped — self-exemption
//     (RC2) recorded in result.skipped, so init's own example (which
//     contains "blazing fast") can never self-flag in a diff. Matching is
//     per normalized rule via termRegExp: regex specials escaped, runs of
//     intra-term whitespace → \s+, \b added only at an [A-Za-z0-9_] edge
//     (leading char of the trimmed term / its last char), trimmed, `i`
//     flag; a hit inside a path matching the term's allowed_paths (per-term
//     ∪ global, via matchesAny/globToRegExp) is exempt.
//   - Output: one `BANNED_TERM: <term> <file>:<line> allowed: <paths|nowhere> [(reason)] — <text>`
//     line per finding, then the final
//     `BANNED_TERMS: ok|found=<n> terms=N files=M source=S`; `--json`
//     prints the full result object {source, terms, scanned_files,
//     findings, skipped} (absent → {source, absent: true, findings: []}).
//
// Exit codes (RC3): 0 ok/none · 1 findings or git-diff failure · 2 not a
// repo / unknown command / no merge base · 3 config invalid / init exists
// without --force. NOTE: 3 here is upstream's EXIT.refused — same number
// as this repo's approvals "re-ask pending" exit 3, different binary and
// different meaning.
//
// Divergence ledger (every deviation from the upstream sources):
//   1. resultLine simplified: upstream renders each error as
//      `<context>: <summary> (<detail>); fix: <fix> (<CODE>)` pulling
//      summary/fix from the 786-line RESULT_CODES table
//      (lib/result-codes.ts, not ported); this port prints
//      `<context>: <CODE>: <detail>` keeping the same detail text
//      (`<message> at <path-or-<root>>`, ` (<source>)` on check-load
//      errors, `<n> finding(s)` on BANNED_TERM_FOUND).
//   2. exitTableHelp kept VERBATIM (upstream lib/headless-artifacts.ts
//      line 103 — it is a one-line constant), so --help carries upstream's
//      exact exit table; only the program name in the banner differs.
//      resultLine/exitTableHelp are otherwise the only upstream imports
//      not ported 1:1.
//   3. assertInsideRoot dropped (upstream ship-policy.ts line 542): the
//      working-tree config read realpath-guards against symlink escapes,
//      but this port reads the FIXED constant `.gstack/banned-terms.json`
//      joined to the git-reported root — trivially inside. A `.gstack`
//      directory that is itself a symlink out of the repo would be read
//      through here where upstream refuses; unreachable through any CLI
//      input, recorded for honesty.
//   4. containedRelative absoluteness is platform-stable — now carried by
//      src/ship-policy.mjs (the b20 note, lifted verbatim): upstream tests
//      `path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) ||
//      p.startsWith('\\\\')`, and path.isAbsolute('\foo') is false on
//      POSIX (true on win32); the port rejects a leading '/', a leading
//      '\' (which also covers UNC `\\srv\share`), and `X:[/\\]` drive
//      forms explicitly, so behavior is identical on every platform
//      (win32 behavior unchanged, POSIX tightened to match win32).
//   5. Structural: the upstream lib/bin split is inlined into one
//      zero-dependency .mjs except the three shared ship-policy helpers
//      (src/ship-policy.mjs, re-exported below so the module surface is
//      unchanged); `#!/usr/bin/env -S bun --no-env-file
//      --config=/dev/null` → `#!/usr/bin/env node`; TypeScript types
//      erased. spawnSync git timeouts (15s rev-parse, 30s
//      show/merge-base, 120s diff) and the 256 MiB diff maxBuffer are
//      ported verbatim. `process.exitCode =` (not process.exit) as
//      upstream.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
// The three shared ship-policy helpers, lifted (batch 23) from their b20
// inlining here into src/ship-policy.mjs — re-exported so this bin's module
// surface (and the divergence-4 ledger) is unchanged.
import { containedRelative, globToRegExp, matchesAny } from '../src/ship-policy.mjs';
export { containedRelative, globToRegExp, matchesAny };

const BANNED_TERMS_PATH = '.gstack/banned-terms.json';
const BANNED_TERMS_SCHEMA = 'https://github.com/garrytan/gstack/docs/ship-policy.md#banned-terms';
const MAX_TERMS = 200;
const MAX_TERM = 80;
const MAX_PATHS = 200;
const EXIT = { ok: 0, fail: 1, usage: 2, refused: 3 }; // headless-artifacts.ts line 102
const EXIT_TABLE_HELP = 'Exit codes: 0 ok · 1 fail · 2 usage · 3 refused or needs a flag'; // headless-artifacts.ts line 104, verbatim

// ---------------------------------------------------------------------------
// ship-policy.ts resolveBaseBranch (upstream lines 420-431)
// ---------------------------------------------------------------------------

function git30(repoRoot, args) {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

/** `--base` when given, else origin/HEAD's branch, else `main`. */
export function resolveBaseBranch(repoRoot, explicit) {
  if (explicit && explicit.trim()) return explicit.trim().replace(/^origin\//, '');
  const r = git30(repoRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (r.ok && r.out) return r.out.replace(/^origin\//, '');
  return 'main';
}

// ---------------------------------------------------------------------------
// lib/banned-terms.ts (upstream-exact)
// ---------------------------------------------------------------------------

export function exampleBannedTermsJson() {
  return JSON.stringify({
    $schema: BANNED_TERMS_SCHEMA,
    terms: [
      'blazing fast',
      { term: 'legacy-name', allowed_paths: ['CHANGELOG.md', 'docs/migration/**'], reason: 'the product was renamed; the old name belongs to history only' },
    ],
    allowed_paths: ['docs/glossary.md', 'vendor/**'],
  }, null, 2) + '\n';
}

function globError(g) {
  if (typeof g !== 'string') return 'must be a string';
  const why = containedRelative(g);
  if (why) return why;
  try { globToRegExp(g); } catch (e) { return e.message; }
  return null;
}

/** Schema and containment: `terms` a non-empty list, every glob repo-relative. Unknown keys are errors. */
export function validateBannedTerms(raw) {
  const errors = [];
  const error = (at, message) => errors.push({ code: 'BANNED_TERMS_INVALID', path: at, message });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [{ code: 'BANNED_TERMS_INVALID', path: '', message: 'must be a JSON object' }];
  const obj = raw;
  for (const key of Object.keys(obj)) if (!['$schema', 'terms', 'allowed_paths'].includes(key)) error(key, 'unknown key; valid keys: terms, allowed_paths');
  if (!Array.isArray(obj.terms) || obj.terms.length === 0) error('terms', 'must be a non-empty array');
  else {
    if (obj.terms.length > MAX_TERMS) error('terms', `more than ${MAX_TERMS} entries`);
    obj.terms.forEach((t, i) => {
      const at = `terms[${i}]`;
      const term = typeof t === 'string' ? t : (t && typeof t === 'object' && !Array.isArray(t)) ? t.term : undefined;
      if (typeof term !== 'string' || !term.trim()) error(at, 'must be a non-empty string or {term, allowed_paths}');
      else if (term.length > MAX_TERM) error(at, `longer than ${MAX_TERM} characters`);
      else if (/[\0\r\n]/.test(term)) error(at, 'contains a control character');
      if (t && typeof t === 'object' && !Array.isArray(t)) {
        const rule = t;
        for (const key of Object.keys(rule)) if (!['term', 'allowed_paths', 'reason'].includes(key)) error(`${at}.${key}`, 'unknown key; valid keys: term, allowed_paths, reason');
        if (rule.allowed_paths !== undefined) checkPaths(`${at}.allowed_paths`, rule.allowed_paths, errors);
      }
    });
  }
  if (obj.allowed_paths !== undefined) checkPaths('allowed_paths', obj.allowed_paths, errors);
  return errors;
}

function checkPaths(at, value, errors) {
  if (!Array.isArray(value)) { errors.push({ code: 'BANNED_TERMS_INVALID', path: at, message: 'must be an array of globs' }); return; }
  if (value.length > MAX_PATHS) errors.push({ code: 'BANNED_TERMS_INVALID', path: at, message: `more than ${MAX_PATHS} entries` });
  value.forEach((g, i) => { const why = globError(g); if (why) errors.push({ code: 'BANNED_TERMS_INVALID', path: `${at}[${i}]`, message: `${JSON.stringify(g)} ${why}` }); });
}

export function normalizeRules(config) {
  return config.terms.map((t) => typeof t === 'string'
    ? { term: t, allowed_paths: [...(config.allowed_paths ?? [])] }
    : { term: t.term, allowed_paths: [...(config.allowed_paths ?? []), ...(t.allowed_paths ?? [])], ...(t.reason ? { reason: t.reason } : {}) });
}

/** The committed copy on `<treeish>` when given (C1's reviewed-base posture), else the working tree. */
export function loadBannedTerms(repoRoot, treeish) {
  let text = null;
  const source = treeish ? `${treeish}:${BANNED_TERMS_PATH}` : BANNED_TERMS_PATH;
  if (treeish) {
    const r = spawnSync('git', ['show', source], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 });
    text = r.status === 0 ? r.stdout : null;
  } else {
    // Divergence 3: assertInsideRoot dropped — fixed constant path joined to the root.
    const file = path.join(repoRoot, BANNED_TERMS_PATH);
    text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  }
  if (text === null) return { config: null, source, absent: true };
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { return { config: null, source, errors: [{ code: 'BANNED_TERMS_INVALID', path: '', message: `not valid JSON: ${e.message}` }] }; }
  const errors = validateBannedTerms(parsed);
  if (errors.length) return { config: null, source, errors };
  return { config: parsed, source };
}

/** termRegExp (upstream lines 114-118): escape specials, whitespace → \s+, \b only at [A-Za-z0-9_] edges, trim, i. */
export function termRegExp(term) {
  const trimmed = term.trim();
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const edge = (s) => (/^[A-Za-z0-9_]/.test(s) ? '\\b' : '');
  return new RegExp(`${edge(trimmed)}${escaped}${edge(trimmed.slice(-1))}`, 'i');
}

/** Added lines per file from a unified diff (new-side line numbers). */
export function addedLines(diff) {
  const out = new Map();
  let file = '';
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) { file = raw.slice(4).replace(/^b\//, '').replace(/\t.*$/, ''); if (file === '/dev/null') file = ''; continue; }
    if (raw.startsWith('--- ') || raw.startsWith('diff --git') || raw.startsWith('index ')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (!file) continue;
    if (raw.startsWith('+')) {
      if (!out.has(file)) out.set(file, []);
      out.get(file).push({ line, text: raw.slice(1) });
      line += 1;
    } else if (!raw.startsWith('-') && !raw.startsWith('\\')) line += 1;
  }
  return out;
}

/** Scan added lines (or whole files) for each term outside its allowed paths. */
export function scanBannedTerms(config, source, files) {
  const rules = normalizeRules(config).map((r) => ({ ...r, re: termRegExp(r.term) }));
  const findings = [];
  const skipped = [];
  for (const [file, lines] of files) {
    if (file === BANNED_TERMS_PATH) { skipped.push(file); continue; } // self-exemption (RC2)
    for (const rule of rules) {
      if (matchesAny(rule.allowed_paths, file)) continue;
      for (const l of lines) if (rule.re.test(l.text)) findings.push({ term: rule.term, file, line: l.line, text: l.text.trim().slice(0, 160), allowed_paths: rule.allowed_paths, ...(rule.reason ? { reason: rule.reason } : {}) });
    }
  }
  return { source, terms: rules.length, scanned_files: files.size, findings, skipped };
}

export function wholeFiles(repoRoot, rels) {
  const out = new Map();
  for (const rel of rels) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) continue; // silently dropped
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 1024).includes(0)) continue; // binary: NUL in the first 1024 bytes
    out.set(rel, buf.toString('utf8').split('\n').map((text, i) => ({ line: i + 1, text })));
  }
  return out;
}

export function renderBannedTerms(r) {
  const lines = r.findings.map((f) => `BANNED_TERM: ${JSON.stringify(f.term)} ${f.file}:${f.line} allowed: ${f.allowed_paths.length ? f.allowed_paths.join(', ') : 'nowhere'}${f.reason ? ` (${f.reason})` : ''} — ${f.text}`);
  lines.push(`BANNED_TERMS: ${r.findings.length ? `found=${r.findings.length}` : 'ok'} terms=${r.terms} files=${r.scanned_files} source=${r.source}`);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// bin/gstack-banned-terms (upstream-exact; divergence 1 for the error lines)
// ---------------------------------------------------------------------------

const HELP = `gstack861-banned-terms — scan a diff for banned terms outside their allowed locations (docs/ship-policy.md#banned-terms)

  check [--base <ref>] [--diff-base <sha>] [--files <csv>] [--policy-from base|head] [--json]
        added lines since the merge base with <ref> (default origin/HEAD), or whole --files; the term list
        is read from the committed copy on the base (default) or the working tree (--policy-from head)
  init [--force]        write a commented ${BANNED_TERMS_PATH} example
  validate              schema and containment check of the working-tree file

${EXIT_TABLE_HELP}`;

/** Divergence 1: upstream resultLine's table-driven `<summary>; fix:` wrapper reduced to `<context>: <CODE>: <detail>`. */
function errLine(context, code, detail) {
  return `${context}: ${code}${detail ? `: ${detail}` : ''}`;
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP + '\n'); return EXIT.ok; }
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'check';
  const rest = cmd === argv[0] ? argv.slice(1) : argv;
  const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 15_000 });
  if (root.status !== 0) { process.stderr.write('gstack861-banned-terms: not inside a git repository\n'); return EXIT.usage; }
  const repoRoot = root.stdout.trim();
  const file = path.join(repoRoot, BANNED_TERMS_PATH);

  if (cmd === 'init') {
    if (fs.existsSync(file) && !rest.includes('--force')) { process.stderr.write(`gstack861-banned-terms: ${BANNED_TERMS_PATH} exists (pass --force to overwrite)\n`); return EXIT.refused; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, exampleBannedTermsJson());
    process.stdout.write(`BANNED_TERMS_INIT: ${BANNED_TERMS_PATH}\n`);
    return EXIT.ok;
  }
  if (cmd === 'validate') {
    if (!fs.existsSync(file)) { process.stdout.write(`BANNED_TERMS: none (no ${BANNED_TERMS_PATH})\n`); return EXIT.ok; }
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { process.stderr.write(errLine('gstack861-banned-terms validate', 'BANNED_TERMS_INVALID', e.message) + '\n'); return EXIT.refused; }
    const errors = validateBannedTerms(parsed);
    for (const e of errors) process.stderr.write(errLine('gstack861-banned-terms validate', e.code, `${e.message} at ${e.path || '<root>'}`) + '\n');
    if (errors.length) return EXIT.refused;
    process.stdout.write(`BANNED_TERMS_VALID: ${BANNED_TERMS_PATH}\n`);
    return EXIT.ok;
  }
  if (cmd !== 'check') { process.stderr.write(`gstack861-banned-terms: unknown command ${cmd}\n${HELP}\n`); return EXIT.usage; }

  const json = rest.includes('--json');
  const base = resolveBaseBranch(repoRoot, flag(rest, '--base'));
  const policyFrom = flag(rest, '--policy-from') ?? 'base';
  let load = loadBannedTerms(repoRoot, policyFrom === 'head' ? undefined : base);
  if (policyFrom !== 'head' && 'absent' in load) load = loadBannedTerms(repoRoot); // bin-level working-tree fallback (RC1)
  if ('absent' in load) {
    process.stdout.write(json ? JSON.stringify({ source: load.source, absent: true, findings: [] }) + '\n' : `BANNED_TERMS: none (no ${BANNED_TERMS_PATH} on ${policyFrom === 'head' ? 'the working tree' : base})\n`);
    return EXIT.ok;
  }
  if ('errors' in load) { for (const e of load.errors) process.stderr.write(errLine('gstack861-banned-terms', e.code, `${e.message} at ${e.path || '<root>'} (${load.source})`) + '\n'); return EXIT.refused; }

  const filesFlag = flag(rest, '--files');
  let files;
  if (filesFlag) files = wholeFiles(repoRoot, filesFlag.split(',').map((s) => s.trim()).filter(Boolean));
  else {
    const diffBase = flag(rest, '--diff-base') ?? (() => { const mb = spawnSync('git', ['merge-base', base, 'HEAD'], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 }); return mb.status === 0 ? mb.stdout.trim() : undefined; })();
    if (!diffBase) { process.stderr.write(`gstack861-banned-terms: no merge base with ${base}; pass --diff-base <sha> or --files <csv>\n`); return EXIT.usage; }
    const diff = spawnSync('git', ['diff', '--unified=0', '--no-color', diffBase], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
    if (diff.status !== 0) { process.stderr.write(`gstack861-banned-terms: git diff ${diffBase} failed\n`); return EXIT.fail; }
    files = addedLines(diff.stdout);
  }
  const result = scanBannedTerms(load.config, load.source, files);
  if (json) process.stdout.write(JSON.stringify(result) + '\n'); else process.stdout.write(renderBannedTerms(result));
  if (result.findings.length) { process.stderr.write(errLine('gstack861-banned-terms', 'BANNED_TERM_FOUND', `${result.findings.length} finding(s)`) + '\n'); return EXIT.fail; }
  return EXIT.ok;
}

process.exitCode = main(process.argv.slice(2));
