// slug — project-slug and branch resolution with the v2 slug cache (batch 21 lane A).
//
// Port of upstream/gstack bin/gstack-slug (880 lines) lines 162-201 (cache-key
// layout + _git_common_dir), 205-471 (rules 0-4, cache read/self-heal/write,
// former-slugs, legacy notice, branch) and 542-562 (_resolve_identity) at
// pinned submodule commit 5755601. Identity consumption only: the checkpoint
// modes (stamp/classify/below/point-from/newer-task/adopt-legacy) are lane B,
// the CLI surface is lane C.
//
// Resolution order (highest precedence first):
//   0. $GSTACK_PROJECT_SLUG env override (sanitized; "."/".." ignored; never cached).
//   1. Walk UP from cwd to the OUTERMOST ancestor with a project-identity
//      marker. Markers are an allow-list, two tiers: STRONG (.git, .project.yaml,
//      package.json, pyproject.toml, Cargo.toml, Gemfile, go.mod) else WEAK
//      (README.md, README, README.rst, LICENSE, LICENSE.md). Build/deploy
//      artifacts (.vercel/.next/dist/node_modules etc.) are NOT markers.
//   2. Slug from the canonical git remote: the OUTERMOST ancestor that is an
//      actual git repo with a resolvable `origin` remote wins. Marker-only
//      ancestors anchor the basename fallback but can never shadow a real
//      remote below (2026-08-17 stray-empty-~/.git fix).
//   3. Basename of the resolved project root.
//   4. Basename of cwd.
//
// Cache (#2767/#3003): keyed on the git common dir read from .git files with
// NO git spawn (gitfile→gitdir→commondir, .git dir realpath'd; depth cap 64).
// Entries are "v2:<slug>". Unversioned entries are recomputed once and keep
// their sticky value (#2212) unless the value is exactly the pre-#3003
// last-two slug of a hosted 3+-segment remote with a differing new slug — then
// it upgrades to the hashed slug and prints a one-time LEGACY_NOTICE (only
// while the old bucket directory still exists). Read order commondir → MAIN
// (parent of a "*.git" common dir) → pwd. Both keys (commondir + pwd) are
// written atomically (tmp+rename). Two provable bug shapes self-heal even on
// v2 hits: cached==basename(pwd) while cwd is not the project root (#1125),
// and cached==basename(project root) with a dead .git at the root while a
// remote-bearing repo lives below (2026-08-17).
//
// Divergence ledger (every deviation from the upstream bash):
//   1. State root: upstream sources bin/gstack-state-root.sh (~/.gstack plus
//      its chain). This port NEVER touches ~/.gstack (the user may run the
//      real gstack); the root is <stateRoot option> → $GSTACK861_STATE_ROOT →
//      path.join(os.homedir(), '.gstack861'). Homedir via os.homedir(), not
//      $HOME (Windows service sessions).
//   2. Cache-key encoding: upstream is `tr '/' '_'` (POSIX-only paths). On
//      win32 the native separator '\' and the drive colon ':' are folded to
//      '_' as well (a ':' cannot appear in a win32 filename; '/','\',':' in
//      one pass: "C:\Users\j" → "C__Users_j"). POSIX keeps the exact upstream
//      single-character tr.
//   3. Absolute-gitdir test in the gitfile walk: upstream accepts a leading
//      "/" or "X:"; this port uses path.isAbsolute (same on POSIX, also
//      accepts win32 UNC "\\\\server\\…" — a superset, never observable from
//      git's own gitdir lines).
//   4. Branch lookup `git rev-parse --abbrev-ref HEAD` is skipped when the
//      .git walk finds no git entry above cwd (upstream spawns and discards
//      the failure; the branch is "unknown" either way). Outside git this
//      keeps a clean v2 cache hit provably git-spawn-free; GIT_DIR-only
//      environments are not supported (upstream would have resolved them).
//   5. The LEGACY_NOTICE line names gstack861-slug, not gstack-slug (native
//      binary name; lane C owns that CLI).
//   6. %q quoting of PROJECT_REMOTE/PROJECT_ROOT for eval consumers is a
//      lane C decision (CLI output layer), deliberately not reimplemented
//      here; resolveIdentity returns raw strings.
//   7. The git runner is injectable (runGit(args, cwd) → stdout, throws on
//      failure) so tests can count spawns; the default wraps execFileSync.
//   8. Upstream resolves the identity fields only in --identity/checkpoint
//      modes; the default SLUG/BRANCH hot path stays remote-walk-free on a
//      cache hit. One library call returns both, so remote/projectRoot/
//      legacySlug/formerSlugs are compute-once lazy getters: reading only
//      slug/branch costs zero remote spawns, reading an identity field pays
//      the upstream --identity cost exactly once.
//   9. pwd -P is fs.realpathSync.native (plain realpathSync fallback): the
//      native call expands win32 8.3 spellings (ADMINI~1 → Administrator) so
//      the common-dir cache key and PROJECT_ROOT are spelling-canonical; bash
//      upstream reaches the same canonical form through its POSIX layer.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalRemote, legacyRemoteSlug, remoteSlug, sanitize } from './remote-identity.mjs';

const STRONG_MARKERS = ['.project.yaml', 'package.json', 'pyproject.toml', 'Cargo.toml', 'Gemfile', 'go.mod'];
const WEAK_MARKERS = ['README.md', 'README', 'README.rst', 'LICENSE', 'LICENSE.md'];
const DEPTH_CAP = 64;

const defaultRunGit = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

/** Default state root: GSTACK861_STATE_ROOT or ~/.gstack861 — never ~/.gstack (ledger 1). */
export function defaultStateRoot(env = process.env) {
  const override = typeof env.GSTACK861_STATE_ROOT === 'string' ? env.GSTACK861_STATE_ROOT.trim() : '';
  return override !== '' ? override : path.join(os.homedir(), '.gstack861');
}

// Cache-key encoding (ledger 2).
const encodeKey = value =>
  process.platform === 'win32' ? value.replace(/[:/\\]/g, '_') : value.replace(/\//g, '_');

const parentOf = dir => {
  const parent = path.dirname(dir);
  return parent === dir ? null : parent; // dirname fixed point (C:\, /, //srv)
};
// Compute-once memoization backing the lazy identity getters.
const lazyOnce = fn => { let done = false, value; return () => { if (!done) { value = fn(); done = true; } return value; }; };

/** pwd -P equivalent. .native first: on win32 it expands 8.3 spellings (ADMINI~1),
 *  so a worktree's gitdir-line spelling and a checkout's cwd spelling of the same
 *  directory produce ONE cache key (upstream gets the same effect from the
 *  cygwin/msys layer under bash's pwd -P). Throws when the path does not exist. */
export function physicalPath(p) {
  try { return fs.realpathSync.native(p); } catch { return fs.realpathSync(p); }
}
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
// Command substitution semantics: strip trailing newlines only.
const chomp = s => String(s).replace(/[\r\n]+$/, '');
const readFileOr = (p, fallback = '') => { try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; } };
const dirNonEmpty = p => { try { return fs.readdirSync(p).length > 0; } catch { return false; } };

// First line of $file matching /^gitdir: */ with the prefix stripped, '' when none.
function readGitdirValue(file) {
  for (const line of readFileOr(file).split(/\r?\n/)) {
    if (/^gitdir: */.test(line)) return line.replace(/^gitdir: */, '');
  }
  return '';
}

// Physical git common dir of the repository holding `start` (nearest .git
// entry), or '' outside git. A worktree's .git file names its gitdir, whose
// `commondir` file points at the shared dir. No git spawn. Exported for the
// lane C CLI (--checkpoints-below's inside-git gate and --newer-task's main
// tree both reuse the exact cache-key derivation).
export function gitCommonDir(start) {
  let dir = start;
  for (let depth = 0; dir && depth < DEPTH_CAP; depth++) {
    const dotgit = path.join(dir, '.git');
    if (isDir(dotgit)) { try { return physicalPath(dotgit); } catch { return ''; } }
    if (isFile(dotgit)) {
      const raw = readGitdirValue(dotgit);
      if (raw === '') return '';
      const gitdir = path.isAbsolute(raw) ? raw : path.join(dir, raw);
      let common = gitdir;
      const commondirFile = path.join(gitdir, 'commondir');
      if (isFile(commondirFile)) {
        const line = readFileOr(commondirFile).split(/\r?\n/)[0];
        common = line === '' ? path.join(gitdir, '') : (path.isAbsolute(line) ? line : path.join(gitdir, line));
      }
      try { return physicalPath(common); } catch { return ''; }
    }
    const parent = parentOf(dir);
    if (!parent) break;
    dir = parent;
  }
  return '';
}

// Nearest ancestor holding any .git entry (branch-lookup guard, ledger 4).
function hasDotGit(start) {
  let dir = start;
  for (let depth = 0; dir && depth < DEPTH_CAP; depth++) {
    let exists = false;
    try { exists = fs.existsSync(path.join(dir, '.git')); } catch { exists = false; }
    if (exists) return true;
    const parent = parentOf(dir);
    if (!parent) break;
    dir = parent;
  }
  return false;
}

// Rule 1: outermost STRONG marker ancestor, else outermost WEAK. Allow-list
// only — artifact names never appear here on purpose.
function outermostProjectRoot(start) {
  let strong = '';
  let weak = '';
  let dir = start;
  for (let depth = 0; dir && dir !== '/' && depth < DEPTH_CAP; depth++) {
    const dotgit = path.join(dir, '.git');
    let hasDot = false;
    try { hasDot = fs.existsSync(dotgit); } catch { hasDot = false; }
    if (hasDot || STRONG_MARKERS.some(m => isFile(path.join(dir, m)))) strong = dir;
    else if (WEAK_MARKERS.some(m => isFile(path.join(dir, m)))) weak = dir;
    const parent = parentOf(dir);
    if (!parent) break;
    dir = parent;
  }
  return strong !== '' ? strong : weak;
}

// Rule 1a: outermost ancestor that is a real repo (.git dir or gitfile) whose
// `origin` resolves. git spawns only at .git-bearing ancestors.
function outermostRemoteRepo(start, runGit) {
  let outermost = '';
  let dir = start;
  for (let depth = 0; dir && dir !== '/' && depth < DEPTH_CAP; depth++) {
    let hasDot = false;
    try { hasDot = fs.existsSync(path.join(dir, '.git')); } catch { hasDot = false; }
    if (hasDot) { try { runGit(['remote', 'get-url', 'origin'], dir); outermost = dir; } catch { /* no origin here */ } }
    const parent = parentOf(dir);
    if (!parent) break;
    dir = parent;
  }
  return outermost;
}

/**
 * Resolve the project identity for a directory.
 * @returns {{ slug, branch, remote, projectRoot, legacySlug, formerSlugs }}
 * remote is the canonical remote string (e.g. "github.com/owner/repo"), not a
 * slug; projectRoot is physical (realpath); legacySlug is the pre-#3003 bucket
 * only when it differs from slug. The last four are compute-once lazy getters
 * (ledger 8): slug/branch alone never pays the remote walk.
 */
export function resolveIdentity({ cwd = process.cwd(), env = process.env, stateRoot, runGit = defaultRunGit, stderr = process.stderr } = {}) {
  const root = stateRoot !== undefined ? stateRoot : defaultStateRoot(env);
  const projectDir = cwd;
  const cacheDir = path.join(root, 'slug-cache');
  const legacyCacheFile = path.join(cacheDir, encodeKey(projectDir));

  let cacheFile = legacyCacheFile;
  let mainCacheFile = '';
  const commonDir = gitCommonDir(projectDir);
  if (commonDir !== '') {
    cacheFile = path.join(cacheDir, encodeKey(commonDir));
    if (path.basename(commonDir) === '.git') {
      mainCacheFile = path.join(cacheDir, encodeKey(path.dirname(commonDir)));
    }
  }

  // 0. Explicit env override — wins over everything; a per-invocation escape
  //    hatch, never a durable identity (persisting it would rebind this cwd's
  //    slug for every later env-less run).
  let slug = '';
  let slugFromEnv = false;
  if (typeof env.GSTACK_PROJECT_SLUG === 'string' && env.GSTACK_PROJECT_SLUG !== '') {
    slug = sanitize(env.GSTACK_PROJECT_SLUG);
    if (slug === '.' || slug === '..') slug = ''; // would file state outside projects/
    // Upstream flags the override even when it sanitizes to nothing: a set-but
    // unusable pin still never becomes a durable cache identity.
    slugFromEnv = true;
  }

  // 1. Marker walk-up (only when the env override did not already pin the slug).
  let projectRoot = '';
  if (slug === '') projectRoot = outermostProjectRoot(projectDir);

  // Lazy, memoized remote discovery — gating it keeps ordinary cache hits git-spawn-free.
  let remoteRoot = '';
  let remoteUrl = '';
  let remoteResolved = false;
  const resolveRemote = () => {
    if (remoteResolved) return;
    remoteResolved = true;
    remoteRoot = outermostRemoteRepo(projectDir, runGit);
    if (remoteRoot !== '') {
      try { remoteUrl = chomp(runGit(['remote', 'get-url', 'origin'], remoteRoot)); } catch { remoteUrl = ''; }
    }
  };

  // 1b. Cache read: commondir → MAIN → pwd. Sticky identity (#2212) with two
  //     self-heal exemptions; unversioned entries recompute once (upgrade to
  //     the hashed slug only at the #3003 bucket-migration point).
  let cacheV2 = false;
  let legacyNoticeSlug = '';
  let entryFile = '';
  for (const f of [cacheFile, mainCacheFile, legacyCacheFile]) {
    if (f !== '' && isFile(f)) { entryFile = f; break; }
  }
  if (slug === '' && entryFile !== '') {
    let raw = readFileOr(entryFile);
    if (raw.startsWith('v2:')) { cacheV2 = true; raw = raw.slice(3); }
    const cached = sanitize(raw);
    if (cached !== '') {
      const pwdBase = sanitize(path.basename(projectDir));
      const rootBase = projectRoot !== '' ? sanitize(path.basename(projectRoot)) : '';
      const originResolvable = dir => { try { runGit(['remote', 'get-url', 'origin'], dir); return true; } catch { return false; } };
      let heal = false;
      if (cached === pwdBase && projectRoot !== '' && projectRoot !== projectDir) {
        heal = true; // old-bug shape (#1125): cached basename(pwd) for a subdirectory
      } else if (projectRoot !== '' && cached === rootBase && fs.existsSync(path.join(projectRoot, '.git'))
        && !originResolvable(projectRoot)) {
        resolveRemote();
        if (remoteUrl !== '' && remoteRoot !== projectRoot) heal = true; // degraded-ancestor (stray-repo) shape
      }
      if (heal) {
        // fall through to recompute; the cache write below self-heals
      } else if (cacheV2) {
        slug = cached;
      } else {
        // Unversioned (pre-#3003) entry: keep the sticky value unless it is
        // exactly the old last-two slug of a 3+-segment remote.
        slug = cached;
        resolveRemote();
        if (remoteUrl !== '') {
          const fresh = remoteSlug(remoteUrl);
          const legacy = legacyRemoteSlug(remoteUrl);
          if (fresh !== '' && fresh !== legacy && cached === legacy) {
            slug = fresh;
            legacyNoticeSlug = legacy;
          }
        }
      }
    }
  }

  // 2. Canonical remote-derived slug (with the degenerate-origin guard).
  if (slug === '') {
    resolveRemote();
    if (remoteUrl !== '') {
      slug = remoteSlug(remoteUrl);
      const legacy = legacyRemoteSlug(remoteUrl);
      if (slug !== '' && slug !== legacy) legacyNoticeSlug = legacy;
      if (slug === '' || slug === '.' || slug === '..' || slug.includes('/')) slug = '';
    }
  }

  // 3. No remote: project root basename.
  if (slug === '' && projectRoot !== '') slug = sanitize(path.basename(projectRoot));
  // 4. Final fallback: pwd basename.
  if (slug === '') slug = sanitize(path.basename(projectDir));
  slug = sanitize(slug);

  // A worktree's own pre-#2767 entry naming a different, still-populated
  // bucket: remember it so skill start can name the merge command. Read
  // BEFORE the cache write overwrites the old value.
  if (slug !== '' && !slugFromEnv && entryFile !== legacyCacheFile && isFile(legacyCacheFile)) {
    const own = sanitize(readFileOr(legacyCacheFile).replace(/^v2:/, ''));
    const formerFile = path.join(root, 'projects', slug, '.former-slugs');
    if (own !== '' && own !== slug && own !== '.' && own !== '..' && dirNonEmpty(path.join(root, 'projects', own))
      && !readFileOr(formerFile).split(/\r?\n/).includes(own)) {
      try {
        fs.mkdirSync(path.dirname(formerFile), { recursive: true });
        fs.appendFileSync(formerFile, `${own}\n`);
      } catch { /* best effort, like upstream's || true */ }
    }
  }

  // Cache write — both keys, atomic (tmp+rename), single-shot key-local.
  if (slug !== '' && !slugFromEnv) {
    for (const f of [cacheFile, legacyCacheFile]) {
      const current = isFile(f) ? readFileOr(f) : '';
      if (current !== `v2:${slug}`) {
        try {
          fs.mkdirSync(cacheDir, { recursive: true });
          const tmp = path.join(cacheDir, `.slug-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
          fs.writeFileSync(tmp, `v2:${slug}`);
          fs.renameSync(tmp, f);
        } catch { /* best effort */ }
      }
      if (cacheFile === legacyCacheFile) break;
    }
  }

  // One notice on the resolve that first files this project under its new
  // nested-group slug while the old shared bucket still exists.
  if (legacyNoticeSlug !== '' && slug !== legacyNoticeSlug && isDir(path.join(root, 'projects', legacyNoticeSlug))) {
    stderr.write(`gstack861 now files this project under projects/${slug}; earlier data is still in projects/${legacyNoticeSlug} (review and copy it with: gstack861-slug --adopt-legacy)\n`);
  }

  let branch = '';
  if (hasDotGit(projectDir)) {
    try { branch = chomp(runGit(['rev-parse', '--abbrev-ref', 'HEAD'], projectDir)); } catch { branch = ''; }
  }
  branch = sanitize(branch.replace(/\//g, '-')) || 'unknown';

  // Identity (#3003): the canonical remote; the root is identity only when
  // there is no remote. Physical so a symlinked spelling compares equal.
  // Upstream resolves this only for --identity/checkpoint modes — the default
  // SLUG/BRANCH path never pays the remote walk on a cache hit. Mirror that
  // split: remote/projectRoot/legacySlug/formerSlugs are compute-once lazy
  // getters, so touching only slug/branch keeps a v2 hit git-spawn-free.
  const identityFields = lazyOnce(() => {
    let idRemote = '';
    let idRoot = '';
    let idLegacy = '';
    resolveRemote();
    if (remoteUrl !== '') {
      idRemote = canonicalRemote(remoteUrl).canonical;
      idRoot = remoteRoot;
      const legacy = legacyRemoteSlug(remoteUrl);
      if (legacy !== '' && remoteSlug(remoteUrl) !== legacy && legacy !== slug) idLegacy = legacy;
    } else {
      idRoot = projectRoot !== '' ? projectRoot : outermostProjectRoot(projectDir);
      if (idRoot === '') idRoot = projectDir;
    }
    try { idRoot = physicalPath(idRoot); } catch { idRoot = projectDir; }
    // Former buckets still holding data and not yet adopted or dismissed.
    let formerSlugs = [];
    if (slug !== '') {
      formerSlugs = readFileOr(path.join(root, 'projects', slug, '.former-slugs'))
        .split(/\r?\n/)
        .map(sanitize)
        .filter(s => s !== '' && s !== '.' && s !== '..')
        .filter(s => dirNonEmpty(path.join(root, 'projects', s)));
    }
    return { remote: idRemote, projectRoot: idRoot, legacySlug: idLegacy, formerSlugs };
  });

  return {
    slug,
    branch,
    get remote() { return identityFields().remote; },
    get projectRoot() { return identityFields().projectRoot; },
    get legacySlug() { return identityFields().legacySlug; },
    get formerSlugs() { return identityFields().formerSlugs; },
  };
}
