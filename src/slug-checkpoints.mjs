// slug-checkpoints — checkpoint bucket bookkeeping for the slug port (batch 21, Lane B).
//
// Upstream lineage: gstack bin/gstack-slug, checkpoint section lines 565-880
// (_checkpoint_fields, _classify_checkpoint, _checkpoint_meta, _norm_title,
// _ticket_tokens, _pointer_target and the stamp/classify/below/point/newer-task/adopt
// modes) plus the .former-slugs machinery at lines 477-535 (_forget_former,
// adopt-from merge, adopt-dismiss) — pinned by upstream.lock.json commit
// 5755601dac5d35ebd7dde181fdefe52a023c73d9. That script is the semantics source
// of truth; this module is its zero-dependency Node port.
//
// Purity contract (docs/plans/2026-10-28-batch21-slug-port.md, Lane B + 审计划
// 必改落实 items 5-6): project identity (remote, projectRoot, slug) and git
// topology (gitCommonDir, cwd toplevel, main-tree dir) are ALWAYS injected
// parameters. This module never imports the Lane A resolver modules; the test
// suite asserts that import surface.
//
// Divergence ledger (deliberate deviations from upstream; everything else verbatim):
//  1. tty→stdin (plan-mandated): upstream's single interactive confirm (line 870,
//     `read -r ans </dev/tty` in adopt review mode) reads from an injected `input`
//     line source here (an async () => next-answer function or an async iterable;
//     Lane C wires process.stdin/readline). Presence of `input` replaces upstream's
//     `[[ -t 0 && -t 1 ]]` interactivity test, making the flow non-TTY testable.
//     One trailing CR is trimmed from an answer so CRLF stdin works.
//  2. Injected resolver: pointFrom's recursive start-dir slug re-resolution
//     (upstream line 756, `cd "$MODE_ARG" && "$0" --get SLUG`) is the injected
//     `resolve` argument (sync or async) — the same purity rule, not a semantic
//     change. A resolve failure or an empty/"."/".." start slug throws
//     POINT_FROM_* errors where upstream exits 1 silently.
//  3. Pointer JSON is read with JSON.parse instead of upstream's sed exact-
//     two-space-indentation line match (lines 649-658); writer and reader live
//     in this module and agree on the same shape and escaping.
//  4. Process exits become values/exceptions for the Lane C CLI: stamp/point
//     argument-validation failures throw; adoptLegacy returns {code, lines,
//     errors} because its nonzero exit on pending merges is a result, not an
//     error. Stderr-bound upstream messages are carried in `errors`.
//  5. adoptLegacy "from" walks the source bucket in sorted order (upstream
//     `find` order is filesystem-dependent); counters, dedup and the
//     never-overwrite rule are unchanged. A destination JSONL lacking a final
//     newline gets one before appended lines (upstream would concatenate the
//     first appended line onto the unterminated last line).
//  6. Bash string comparisons (`[[ ... > ... ]]`, LC_ALL=C sort -r) become
//     code-unit compares; for the ASCII filenames and ticket tokens involved
//     they agree with C-locale byte order.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Shared small helpers (upstream awk/sed shims)
// ---------------------------------------------------------------------------

/** LC_ALL=C descending sort comparator (bytewise for the ASCII inputs here). */
const desc = (a, b) => (a < b ? 1 : a > b ? -1 : 0);

/** awk record semantics: a trailing newline terminates the last record, it is not one. */
function records(text) {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts;
}

/** Upstream val(): strip "key:[ \t]*" prefix then "[ \t\r]+$" suffix. */
function value(line, key) {
  return line.slice(key.length).replace(/^[ \t]*/, '').replace(/[ \t\r]+$/, '');
}

function readFileText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function realpathOr(p, fallback) {
  try { return fs.realpathSync(p); } catch { return fallback; }
}

/** bash -d: a directory (symlinks followed). */
function isRealDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** bash -f: a regular file (symlinks followed). */
function isRegularFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** bash `-f && ! -L`: a regular file that is not itself a symlink. */
function isRegularNonSymlink(p) {
  try { return fs.lstatSync(p).isFile(); } catch { return false; }
}

function isSymlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** Strictly inside parent (not equal). */
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** mktemp+mv parity: write a sibling temp file, then atomically rename over target. */
function writeAtomic(file, content, tag) {
  const tmp = `${file}.${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

/** cp -p parity: copy, then carry the source's timestamps over. */
function copyPreserve(src, dst) {
  fs.copyFileSync(src, dst);
  const st = fs.statSync(src);
  fs.utimesSync(dst, st.atime, st.mtime);
}

function sameBytes(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

// ---------------------------------------------------------------------------
// Pure checkpoint parsing (upstream lines 564-658)
// ---------------------------------------------------------------------------

/**
 * remote/project_root from a checkpoint's LEADING frontmatter only (first
 * occurrence wins, even when the value is empty). Unreadable file → both empty,
 * like upstream's `awk ... || true`.
 */
export function checkpointFields(file) {
  const out = { remote: '', projectRoot: '' };
  const text = readFileText(file);
  if (text === null) return out;
  const lines = records(text);
  if (lines[0] !== '---') return out;
  let seenRemote = false, seenRoot = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '---') break;
    if (!seenRemote && line.startsWith('remote:')) { out.remote = value(line, 'remote:'); seenRemote = true; }
    else if (!seenRoot && line.startsWith('project_root:')) { out.projectRoot = value(line, 'project_root:'); seenRoot = true; }
  }
  return out;
}

/**
 * Four-state checkpoint classification, upstream _classify_checkpoint verbatim:
 * remote mismatch → foreign; same remote + different non-empty root → match-root;
 * when the identity remote is empty (or the checkpoint carries none) roots alone
 * decide; neither field stamped → unstamped.
 */
export function classifyCheckpoint(fields, identity) {
  const remote = fields?.remote ?? '';
  const root = fields?.projectRoot ?? '';
  const idRemote = identity?.remote ?? '';
  const idRoot = identity?.projectRoot ?? '';
  if (idRemote !== '' && remote !== '') {
    if (remote !== idRemote) return 'foreign';
    if (root !== '' && root !== idRoot) return 'match-root';
    return 'match';
  }
  if (root !== '') return root === idRoot ? 'match' : 'foreign';
  if (remote !== '') return 'foreign';
  return 'unstamped';
}

/**
 * branch/project_root/worktree from the leading frontmatter (first seen wins)
 * plus the first `## Working on:` heading OUTSIDE the frontmatter. Title
 * fallback = filename minus ".md" minus `^[0-9]{8}-[0-9]{6}-?` — deliberately
 * NOT the full date-time form normTitle strips (plan review: the two date
 * regexes must stay separate). Unreadable file → all fields empty, no fallback.
 */
export function checkpointMeta(file) {
  const out = { branch: '', projectRoot: '', worktree: '', title: '' };
  const text = readFileText(file);
  if (text === null) return out;
  const name = path.basename(file);
  const fallback = name.endsWith('.md') ? name.slice(0, -3) : name;
  const lines = records(text);
  let fm = false, gotBranch = false, gotRoot = false, gotWorktree = false, title = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && line === '---') { fm = true; continue; } // awk NR==1 rule has `next`
    if (fm) {
      if (line === '---') { fm = false; continue; }
      if (!gotBranch && line.startsWith('branch:')) { out.branch = value(line, 'branch:'); gotBranch = true; }
      else if (!gotRoot && line.startsWith('project_root:')) { out.projectRoot = value(line, 'project_root:'); gotRoot = true; }
      else if (!gotWorktree && line.startsWith('worktree:')) { out.worktree = value(line, 'worktree:'); gotWorktree = true; }
      continue;
    }
    if (line.startsWith('## Working on:')) { title = value(line, '## Working on:'); break; }
  }
  out.title = title === '' ? fallback.replace(/^[0-9]{8}-[0-9]{6}-?/, '') : title;
  return out;
}

/**
 * Task-title normalization, upstream _norm_title verbatim: ASCII-lowercase,
 * strip ONE leading date / date-time form, collapse punctuation and whitespace
 * runs to single spaces, drop generic titles (wip|checkpoint|save|notes|todo).
 */
export function normTitle(title) {
  let t = String(title ?? '').replace(/[A-Z]/g, c => c.toLowerCase())
    // [[:space:]]* then YYYY-?MM-?DD then optional ([-_t ]?HH:?MM(:?SS)?) — once, no /g.
    .replace(/^[ \t\n\v\f\r]*[0-9]{4}-?[0-9]{2}-?[0-9]{2}([-_t ]?[0-9]{2}:?[0-9]{2}(:?[0-9]{2})?)?/, '');
  // [[:punct:][:space:]]+ → single space (POSIX punct is exactly these four ASCII ranges).
  t = t.replace(/[!-/:-@[-`{-~ \t\n\v\f\r]+/g, ' ').replace(/^ /, '').replace(/ $/, '');
  if (t === 'wip' || t === 'checkpoint' || t === 'save' || t === 'notes' || t === 'todo') return '';
  return t;
}

/**
 * Ticket tokens (`#123`, `ABC-123`) extracted from BOTH the title and the
 * branch, deduplicated and sorted (upstream pipes both args through one
 * grep -oE | sort -u).
 */
export function ticketTokens(title, branch) {
  const text = `${title ?? ''}\n${branch ?? ''}`;
  return [...new Set(text.match(/#[0-9]+|[A-Z][A-Z0-9]+-[0-9]+/g) ?? [])].sort();
}

/**
 * The `checkpoint` field of a pointer JSON document ('' when absent or
 * unparseable). See ledger #3 for the JSON.parse native mapping.
 */
export function pointerTarget(json) {
  if (typeof json !== 'string' || json === '') return '';
  try {
    const v = JSON.parse(json).checkpoint;
    return typeof v === 'string' ? v : '';
  } catch { return ''; }
}

// ---------------------------------------------------------------------------
// stamp / classify modes (upstream lines 680-712)
// ---------------------------------------------------------------------------

/**
 * Write identity stamps into a checkpoint's frontmatter: remote (only when
 * non-empty), project_root (always), worktree (only when provided — the CLI
 * passes it just when the stamping cwd's git toplevel differs from the project
 * root), head (only when non-empty). REFRESH-IN-PLACE like the upstream awk
 * rewrite: old remote:/project_root:/worktree:/head: frontmatter lines are
 * deleted and fresh values inserted before the closing `---` (or a new
 * frontmatter block is opened); head therefore updates on every call — this is
 * NOT skip-if-stamped (plan review fix #5).
 */
export function stampCheckpoint(file, stamps) {
  const { remote = '', projectRoot = '', worktree = '', head = '' } = stamps ?? {};
  if (!isRegularFile(file)) throw new Error(`gstack-slug: no such checkpoint file: ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  const lines = records(text);
  const ids = [];
  if (remote !== '') ids.push(`remote: ${remote}`);
  ids.push(`project_root: ${projectRoot}`);
  if (worktree !== '') ids.push(`worktree: ${worktree}`);
  if (head !== '') ids.push(`head: ${head}`);
  const out = [];
  let infm = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0) {
      if (line === '---') { infm = true; out.push(line); continue; }
      out.push('---', ...ids, '---'); // then fall through: line 1 is body
    } else if (infm) {
      if (line === '---') { out.push(...ids, line); infm = false; continue; }
      if (line.startsWith('remote:') || line.startsWith('project_root:')
        || line.startsWith('worktree:') || line.startsWith('head:')) continue;
    }
    out.push(line);
  }
  if (lines.length === 0) out.push('---', ...ids, '---');
  writeAtomic(file, `${out.join('\n')}\n`, 'stamp');
}

/**
 * Classify mode: one "<status>\t<path>" line per non-empty path, upstream
 * `--classify-checkpoints` stdin semantics. Identity is injected.
 */
export function classifyCheckpoints(paths, identity) {
  const out = [];
  for (const p of paths ?? []) {
    if (p === '') continue;
    out.push(`${classifyCheckpoint(checkpointFields(p), identity)}\t${p}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// checkpointsBelow (upstream lines 714-745)
// ---------------------------------------------------------------------------

/** Pointer target that names a regular file inside <stateRoot>/projects/<bucket>/checkpoints/. */
function validPointerTarget(target, statePhys) {
  if (target === '' || !isRegularNonSymlink(target)) return '';
  const dir = realpathOr(path.dirname(target), '');
  if (dir === '' || path.basename(dir) !== 'checkpoints') return '';
  if (path.dirname(path.dirname(dir)) !== path.join(statePhys, 'projects')) return '';
  return target;
}

/** projects/<bucket>/checkpoints/*.md of every bucket except this one (find depth-3 shape). */
function otherBucketCheckpoints(projectsDir, slug) {
  const out = [];
  let buckets;
  try { buckets = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return out; }
  for (const bucket of buckets) {
    if (!bucket.isDirectory() || bucket.name === slug) continue;
    const ckDir = path.join(projectsDir, bucket.name, 'checkpoints');
    let files;
    try { files = fs.readdirSync(ckDir, { withFileTypes: true }); } catch { continue; }
    for (const f of files) if (f.isFile() && f.name.endsWith('.md')) out.push(path.join(ckDir, f.name));
  }
  return out;
}

/**
 * Checkpoints saved below a directory: THIS bucket's pointer targets always,
 * plus — only when gitCommonDir is empty, i.e. the cwd is outside git — other
 * buckets' checkpoints whose frontmatter project_root lies strictly below cwd.
 * Pointer files are read newest-by-name first (cap 200); other buckets' files
 * are sorted filename-descending (cap 200); output is the 20 newest lines
 * ("POINTER <path>" / "BELOW_CWD <path>"), sorted by the checkpoint's basename.
 * When cwd is HOME each project root shows only its newest checkpoint.
 * `home` overrides the HOME comparison root (defaults to os.homedir()).
 */
export function checkpointsBelow(cwd, stateRoot, identity, { gitCommonDir = '', home } = {}) {
  const slug = identity?.slug ?? '';
  const cwdPhys = realpathOr(cwd, cwd);
  const statePhys = realpathOr(stateRoot, stateRoot);
  const seen = new Set();
  const out = [];

  // Phase 1: this bucket's pointers — always.
  const pointerDir = path.join(statePhys, 'projects', slug, 'checkpoint-pointers');
  let pointerFiles = [];
  try {
    pointerFiles = fs.readdirSync(pointerDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.json'))
      .map(e => path.join(pointerDir, e.name));
  } catch { /* no pointer directory: nothing filed from here */ }
  for (const ptr of pointerFiles.sort(desc).slice(0, 200)) {
    const text = readFileText(ptr);
    if (text === null) continue;
    const target = validPointerTarget(pointerTarget(text), statePhys);
    if (target === '' || seen.has(target)) continue;
    seen.add(target);
    out.push(`${path.basename(target)}\tPOINTER ${target}`);
  }

  // Phase 2: other buckets' checkpoints — only outside git.
  if (gitCommonDir === '') {
    const homeRaw = home === undefined ? os.homedir() : home;
    const homePhys = homeRaw ? realpathOr(homeRaw, '') : '';
    const files = otherBucketCheckpoints(path.join(statePhys, 'projects'), slug)
      .map(f => ({ key: `${path.basename(f)}\t${f}`, f }))
      .sort((a, b) => desc(a.key, b.key))
      .slice(0, 200);
    const rootsSeen = new Set();
    for (const { f } of files) {
      if (seen.has(f)) continue;
      const root = checkpointMeta(f).projectRoot;
      if (root === '' || !root.startsWith(cwdPhys + path.sep)) continue;
      if (cwdPhys === homePhys) {
        if (rootsSeen.has(root)) continue;
        rootsSeen.add(root);
      }
      out.push(`${path.basename(f)}\tBELOW_CWD ${f}`);
    }
  }

  return out.sort(desc).slice(0, 20).map(l => l.slice(l.indexOf('\t') + 1));
}

// ---------------------------------------------------------------------------
// pointFrom (upstream lines 747-766)
// ---------------------------------------------------------------------------

/**
 * A /context-save that started in startDir but filed elsewhere leaves a JSON
 * pointer in startDir's bucket so /context-restore there finds it. Writes
 * projects/<start-slug>/checkpoint-pointers/<stem>--<bucket>.json containing
 * {checkpoint, bucket, project_root} and returns its path; returns '' (silent
 * success) when the start bucket already is the checkpoint's bucket. The start
 * directory's slug comes from the INJECTED resolve function (sync or async) —
 * upstream re-executes itself in that directory; see ledger #2.
 */
export async function pointFrom(startDir, checkpointFile, stateRoot, resolve) {
  if (!isRealDirectory(startDir)) throw new Error(`gstack-slug: no such start directory: ${startDir}`);
  if (!isRegularNonSymlink(checkpointFile)) throw new Error(`gstack-slug: no such checkpoint file: ${checkpointFile}`);
  const ptFile = path.join(fs.realpathSync(path.dirname(checkpointFile)), path.basename(checkpointFile));
  const ptBucket = path.basename(path.dirname(path.dirname(ptFile)));
  const statePhys = realpathOr(stateRoot, stateRoot);
  if (path.basename(path.dirname(ptFile)) !== 'checkpoints'
    || path.dirname(path.dirname(path.dirname(ptFile))) !== path.join(statePhys, 'projects')) {
    throw new Error(`gstack-slug: ${checkpointFile} is not a saved checkpoint under ${stateRoot}${path.sep}projects`);
  }
  let start;
  try {
    start = await resolve(startDir);
  } catch (err) {
    throw new Error('POINT_FROM_RESOLVE_FAILED', { cause: err });
  }
  if (start === '' || start === '.' || start === '..') throw new Error('POINT_FROM_START_SLUG_INVALID');
  if (start === ptBucket) return '';
  const ptRoot = checkpointMeta(ptFile).projectRoot;
  const ptDir = path.join(stateRoot, 'projects', start, 'checkpoint-pointers');
  fs.mkdirSync(ptDir, { recursive: true });
  const base = path.basename(checkpointFile);
  const ptOut = path.join(ptDir, `${base.endsWith('.md') ? base.slice(0, -3) : base}--${ptBucket}.json`);
  // Upstream writes exactly this two-space shape with a trailing newline.
  writeAtomic(ptOut, `${JSON.stringify({ checkpoint: ptFile, bucket: ptBucket, project_root: ptRoot }, null, 2)}\n`, 'pointer');
  return ptOut;
}

// ---------------------------------------------------------------------------
// newerTask (upstream lines 768-800)
// ---------------------------------------------------------------------------

/**
 * Restore candidates arrive current-branch first; name a NEWER same-task
 * checkpoint filed under another branch of this repository. `here` is the cwd's
 * git toplevel, `main` the main tree's directory (dirname of the commondir when
 * its basename is ".git", '' in a worktree). The first candidate must carry the
 * target branch (else silent ''), later ones are kept only when the first 15
 * filename characters exceed the first candidate's. A match is a different
 * branch plus any of: worktree below the main tree while we sit in it, an
 * equal non-empty normalized title, or a shared ticket token (extracted from
 * title AND branch). Returns "NEWER_TASK <path>" or ''. The `identity` field is
 * accepted for signature symmetry; upstream newer-task uses no identity fields.
 */
export function newerTask(branch, candidates, { here = '', main = '', identity } = {}) {
  void identity;
  let first = '', firstBranch = '', firstTitle = '', firstTokens = [];
  for (const f of candidates ?? []) {
    if (f === '') continue;
    if (first !== '') {
      const nb = path.basename(f).slice(0, 15), fb = path.basename(first).slice(0, 15);
      if (!(nb > fb)) continue; // not newer than the first candidate: skip
    }
    const meta = checkpointMeta(f);
    if (first === '') {
      if (!branch || meta.branch !== branch) return ''; // not the target branch: silent exit
      first = f;
      firstBranch = meta.branch;
      firstTitle = normTitle(meta.title);
      firstTokens = ticketTokens(meta.title, meta.branch);
      continue;
    }
    if (meta.branch === firstBranch) continue;
    const wt = meta.worktree !== '' ? meta.worktree : meta.projectRoot;
    if (main !== '' && here === main && wt.startsWith(main + path.sep)) return `NEWER_TASK ${f}`;
    const nt = normTitle(meta.title);
    if (nt !== '' && nt === firstTitle) return `NEWER_TASK ${f}`;
    if (firstTokens.length > 0 && ticketTokens(meta.title, meta.branch).some(t => firstTokens.includes(t))) return `NEWER_TASK ${f}`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// adoptLegacy (upstream lines 802-878 + 477-535)
// ---------------------------------------------------------------------------

/**
 * One bucket entry of an adopt review: upstream's _adopt_label. Checkpoints are
 * classified against the injected identity; only match/match-root checkpoints
 * (and identity-free files) are copyable, and never when the new bucket
 * already holds the same path.
 */
function adoptLabel(rel, oldBucket, newBucket, identity) {
  let label, copyable = true;
  if (rel.startsWith('checkpoints/') && rel.endsWith('.md')) {
    const status = classifyCheckpoint(checkpointFields(path.join(oldBucket, rel)), identity);
    if (status === 'match' || status === 'match-root') label = 'checkpoint: matching this project';
    else if (status === 'foreign') { label = 'checkpoint: another project (not copyable)'; copyable = false; }
    else label = 'checkpoint: unknown project (saved before identity stamps)';
  } else {
    label = 'no project identity: the old bucket may be shared, check before copying';
  }
  if (copyable && fs.existsSync(path.join(newBucket, rel))) {
    label = `${label}; already in new bucket (skipped)`;
    copyable = false;
  }
  return { label, copyable };
}

/** Upstream _adopt_copy: mkdir -p + cp -p + "COPIED <rel>"; false on failure. */
function adoptCopy(rel, oldBucket, newBucket, lines) {
  try {
    const dst = path.join(newBucket, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    copyPreserve(path.join(oldBucket, rel), dst);
    lines.push(`COPIED ${rel}`);
    return true;
  } catch { return false; }
}

/**
 * Upstream's `case "/$rel/" in <dotdot-slash> | <dot-slash> | <double-slash>)`
 * guard: no empty, "." or ".." segments and no double slashes — a plain
 * relative path only.
 */
function plainRelativePath(rel) {
  if (typeof rel !== 'string' || rel === '') return false;
  const segments = rel.split('/');
  return !segments.includes('') && !segments.includes('.') && !segments.includes('..');
}

/** find . -type f / (-type f -o -type l) as '/'-joined relative paths, C-sorted. Symlinked directories are not descended. */
function walkBucket(dir, { symlinks = false, excludeFormerSlugs = false } = {}) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try { entries = fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (excludeFormerSlugs && entry.name === '.former-slugs') continue;
      if (entry.isFile() || (symlinks && entry.isSymbolicLink())) { out.push(childRel); continue; }
      if (entry.isDirectory()) walk(childRel);
    }
  };
  walk('');
  return out.sort();
}

/**
 * Append-only JSONL merge, upstream line 519 awk: destination lines keep their
 * order, then the source lines the destination lacks (deduped within the
 * source too). Atomic temp+rename; 'unchanged' when the source adds nothing.
 */
function jsonlMergeInto(dst, src) {
  const dstText = fs.readFileSync(dst, 'utf8');
  const srcText = fs.readFileSync(src, 'utf8');
  const seen = new Set(records(dstText));
  const additions = [];
  for (const line of records(srcText)) {
    if (seen.has(line)) continue;
    seen.add(line);
    additions.push(line);
  }
  if (additions.length === 0) return 'unchanged';
  const joiner = dstText === '' || dstText.endsWith('\n') ? '' : '\n'; // ledger #5
  writeAtomic(dst, dstText + joiner + additions.map(l => `${l}\n`).join(''), 'merge');
  return 'merged';
}

/**
 * Drop every exact `slug` line from projects/<owner>/.former-slugs (atomic
 * rewrite; a missing list is success). Returns false only when the rewrite fails.
 */
function forgetFormer(stateRoot, slug, target) {
  const file = path.join(stateRoot, 'projects', slug, '.former-slugs');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return true; }
  const kept = records(text).filter(l => l !== target); // grep -vxF: one line out per kept line
  try {
    writeAtomic(file, kept.map(l => `${l}\n`).join(''), 'forget');
    return true;
  } catch { return false; }
}

/** The injected answer source for the review-mode confirm (ledger #1). */
function lineSource(input) {
  if (typeof input === 'function') return input;
  const iterator = input[Symbol.asyncIterator]();
  return async () => {
    const { value, done } = await iterator.next();
    return done ? '' : String(value ?? '');
  };
}

/** adopt-from merge (upstream lines 498-535): see adoptLegacy. */
function adoptFrom({ stateRoot, slug, from }) {
  const fromBucket = path.join(stateRoot, 'projects', from);
  const toBucket = path.join(stateRoot, 'projects', slug);
  if (from === slug) {
    return { code: 2, lines: [], errors: [`gstack-slug: projects/${from} is this project's own bucket.`], prompts: [] };
  }
  if (!isRealDirectory(fromBucket) || isSymlink(fromBucket)) {
    return { code: 1, lines: [], errors: [`gstack-slug: no bucket at ${fromBucket}.`], prompts: [] };
  }
  fs.mkdirSync(toBucket, { recursive: true });
  let migrated = 0, pending = 0, conflicting = 0, unchanged = 0;
  const pendings = [], conflicts = [];
  for (const rel of walkBucket(fromBucket, { symlinks: true, excludeFormerSlugs: true })) {
    const src = path.join(fromBucket, rel), dst = path.join(toBucket, rel);
    if (!isRegularNonSymlink(src)) {
      pending += 1;
      pendings.push(`  ${rel} (not a regular file; review by hand)`);
      continue;
    }
    let dstExists = true;
    try { fs.lstatSync(dst); } catch { dstExists = false; }
    if (!dstExists) {
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        copyPreserve(src, dst);
        migrated += 1;
      } catch {
        pending += 1;
        pendings.push(`  ${rel} (copy failed)`);
      }
      continue;
    }
    if (sameBytes(src, dst)) { unchanged += 1; continue; } // cmp -s follows symlinks
    if (rel.endsWith('.jsonl') && isRegularNonSymlink(dst)) {
      let result;
      try { result = jsonlMergeInto(dst, src); } catch { result = 'failed'; }
      if (result === 'merged') migrated += 1;
      else if (result === 'unchanged') unchanged += 1;
      else {
        pending += 1;
        pendings.push(`  ${rel} (merge failed)`);
      }
      continue;
    }
    conflicting += 1; // differing content is NEVER overwritten
    conflicts.push(`  ${rel}`);
  }
  const lines = [`adopt-legacy --from ${from} into projects/${slug}: migrated ${migrated}, pending ${pending}, conflicting ${conflicting}, unchanged ${unchanged}`];
  if (pendings.length > 0) lines.push(`Pending (left in projects/${from}):`, ...pendings);
  if (conflicts.length > 0) lines.push('Conflicting (both differ; nothing overwritten, compare by hand):', ...conflicts);
  lines.push(`projects/${from} is kept; delete it yourself once you are satisfied.`);
  forgetFormer(stateRoot, slug, from); // upstream line 532: unconditional at end of a completed run
  return { code: pending === 0 ? 0 : 1, lines, errors: [], prompts: [] };
}

/**
 * Pre-#3003 bucket adoption. Identity, roots and slugs are all injected.
 *
 *  - review: list the old bucket's files with per-file labels; with an injected
 *    `input` line source each copyable file is confirmed (y/Y/yes/YES copies —
 *    the upstream /dev/tty read; ledger #1), without it the listing ends with
 *    the "Nothing copied." hint. code 0; "Nothing to adopt" short-circuits when
 *    legacySlug is empty or the old bucket is gone.
 *  - copy: copy the given relative paths. Traversal-guard, non-regular and
 *    non-inside refusals set code 1 (upstream ADOPT_RC); already-present and
 *    foreign files are SKIPPED. An empty paths array falls through to review,
 *    like upstream's `${#COPY_PATHS[@]} -gt 0` gate.
 *  - from: merge another bucket into this one — missing files copy, identical
 *    files stay, JSONL logs merge with dedup, differing files are listed as
 *    conflicts and NEVER overwritten, non-regular files pend. code = pending
 *    count semantics (0 only when nothing pends); upstream's unconditional
 *    end-of-run .former-slugs cleanup runs on every completed merge.
 *  - dismiss: drop a slug from this bucket's .former-slugs (its files are kept).
 *
 * Returns {code, lines, errors, prompts}: `lines` are stdout lines, `errors`
 * stderr lines, `prompts` the confirm prompts issued in order.
 */
export async function adoptLegacy(opts) {
  const mode = opts?.mode ?? 'review';
  if (mode === 'from') return adoptFrom(opts);
  if (mode === 'dismiss') {
    const ok = forgetFormer(opts.stateRoot, opts.slug, opts.dismiss);
    if (!ok) return { code: 1, lines: [], errors: [], prompts: [] };
    return {
      code: 0,
      lines: [`Dismissed projects/${opts.dismiss}; its files are kept and skill start no longer names it.`],
      errors: [],
      prompts: [],
    };
  }

  const { stateRoot, slug, identity = {} } = opts;
  const legacySlug = opts.legacySlug ?? '';
  const paths = opts.paths ?? [];
  const oldBucket = path.join(stateRoot, 'projects', legacySlug);
  const newBucket = path.join(stateRoot, 'projects', slug);
  if (legacySlug === '') {
    return { code: 0, lines: [`Nothing to adopt: this project's slug (${slug}) did not change.`], errors: [], prompts: [] };
  }
  if (!isRealDirectory(oldBucket)) {
    return { code: 0, lines: [`Nothing to adopt: no earlier bucket at ${oldBucket}.`], errors: [], prompts: [] };
  }
  const oldReal = realpathOr(oldBucket, '');

  if (paths.length > 0) {
    let code = 0;
    const lines = [];
    for (const rel of paths) {
      if (!plainRelativePath(rel)) {
        lines.push(`REFUSED ${rel} (must be a plain path relative to ${oldBucket})`);
        code = 1;
        continue;
      }
      const src = path.join(oldBucket, rel);
      const srcDir = realpathOr(path.dirname(src), '');
      const insideBucket = isRegularNonSymlink(src) && srcDir !== '' && oldReal !== ''
        && (srcDir === oldReal || inside(oldReal, srcDir));
      if (!insideBucket) {
        lines.push(`REFUSED ${rel} (not a regular file inside ${oldBucket})`);
        code = 1;
        continue;
      }
      const info = adoptLabel(rel, oldBucket, newBucket, identity);
      if (!info.copyable) {
        lines.push(`SKIPPED ${rel} (${info.label})`);
        continue;
      }
      if (!adoptCopy(rel, oldBucket, newBucket, lines)) code = 1;
    }
    return { code, lines, errors: [], prompts: [] };
  }

  const lines = [], prompts = [];
  const answer = opts.input ? lineSource(opts.input) : null;
  lines.push(`gstack now files this project under: ${newBucket}`);
  lines.push(`Earlier data (shared nested-group bucket): ${oldBucket}`);
  lines.push('Nothing is copied unless you confirm it. Files:');
  for (const rel of walkBucket(oldBucket)) {
    const info = adoptLabel(rel, oldBucket, newBucket, identity);
    lines.push(`  ${rel}  [${info.label}]`);
    if (answer && info.copyable) {
      prompts.push('    copy into the new bucket? [y/N] ');
      const ans = String((await answer()) ?? '').replace(/\r$/, '');
      if (ans === 'y' || ans === 'Y' || ans === 'yes' || ans === 'YES') adoptCopy(rel, oldBucket, newBucket, lines);
    }
  }
  if (!answer) {
    lines.push('Nothing copied. Copy chosen files with: gstack-slug --adopt-legacy --copy <path> [<path>...]');
  }
  return { code: 0, lines, errors: [], prompts };
}
