// ship-policy — the shared path/glob helpers of upstream lib/ship-policy.ts
// (batch 23, lifted from the b20 banned-terms port) plus resolveBaseBranch
// (batch 24, lifted from the same port's bin).
//
// Upstream lineage: gstack lib/ship-policy.ts lines 191-227
// (hasDotDot/containedRelative/globToRegExp/matchesAny) and lines 419-431
// (git + resolveBaseBranch) at pinned submodule commit
// 5755601dac5d35ebd7dde181fdefe52a023c73d9. The b20 port
// (bin/gstack861-banned-terms.mjs, batch 20) inlined them; batch 23 lifted
// the three helpers and batch 24 lifts resolveBaseBranch verbatim into this
// shared module so sealed-guard/issue-links-era ports (and later ones) and
// banned-terms import ONE copy. The deep behavioral coverage lives in
// test/banned-terms.test.mjs (29 tests) and test/ship-policy.test.mjs.
//
// Divergence ledger (every deviation from the upstream source):
//   1. containedRelative absoluteness is platform-stable (INHERITED from the
//      b20 port, upstream ship-policy.ts line 200): upstream tests
//      `path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) ||
//      p.startsWith('\\\\')`, and path.isAbsolute('\foo') is false on POSIX
//      (true on win32); the port rejects a leading '/', a leading '\'
//      (which also covers UNC `\\srv\share`), and `X:[/\\]` drive forms
//      explicitly, so behavior is identical on every platform (win32
//      behavior unchanged, POSIX tightened to match win32).
//   2. Structural: TypeScript types erased; the module lives at src/ (a
//      shared library import for bins and libs), not inlined in a bin.
//   3. resolveBaseBranch (batch 24) is lifted as it stood in the b20 port,
//      not re-translated from upstream: upstream's private `git` helper
//      (ship-policy.ts lines 419-422) also trims stderr into an unused
//      `err` field; the port's `git30` keeps the same spawnSync shape
//      (30 s timeout, trimmed stdout) without it, and the export keeps the
//      b20 2-arg form (repoRoot, explicit) with identical behavior —
//      `--base` wins (leading origin/ stripped), else
//      `git symbolic-ref refs/remotes/origin/HEAD`, else `main`.

import { spawnSync } from 'node:child_process';

const MAX_PATTERN = 256; // ship-policy.ts line 183
const MAX_REGEX = 512; // ship-policy.ts line 184

function hasDotDot(p) {
  return p.split(/[\\/]+/).some((seg) => seg === '..');
}

/** A repo-relative path or glob: no absolute paths, drive letters, `..` segments, NULs or control bytes. */
export function containedRelative(p) {
  if (typeof p !== 'string' || p.length === 0) return 'must be a non-empty string';
  if (p.length > MAX_PATTERN) return `longer than ${MAX_PATTERN} characters`;
  if (/[\0\r\n]/.test(p)) return 'contains a control character';
  // Divergence 1: explicit platform-stable absoluteness (leading '/', leading '\' incl. UNC, drive letters).
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p)) return 'must be repo-relative, not absolute';
  if (p.startsWith('~')) return 'must not start with ~';
  if (hasDotDot(p)) return 'must not contain a `..` segment';
  return null;
}

/** Glob → anchored RegExp. `**` spans directories, `*` and `?` stay inside one segment. Size-capped. */
export function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') { i += 1; out += '(?:.*/)?'; } else out += '.*';
      } else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  out += '$';
  if (out.length > MAX_REGEX) throw new Error(`pattern expands past ${MAX_REGEX} characters`);
  return new RegExp(out);
}

export function matchesAny(globs, rel) {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  return globs.some((g) => globToRegExp(g).test(norm));
}

// ---------------------------------------------------------------------------
// ship-policy.ts resolveBaseBranch (upstream lines 419-431, via the b20 port)
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
