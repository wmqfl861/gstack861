#!/usr/bin/env node
// gstack861-jsonl-merge — git merge driver for append-only JSONL files.
//
// Port of upstream/gstack/bin/gstack-jsonl-merge (pinned submodule commit
// 5755601), the only zero-premise upstream binary that gstack861 ports
// verbatim-semantics: GBrain-style append-only logs merge cleanly instead of
// conflicting at the file tail.
//
// Git merge-driver contract (called by git, not by users):
//   gstack861-jsonl-merge.mjs <base> <ours> <theirs>    # %O %A %B
//   result is written to OURS (the %A file in git's work area);
//   exit 0 = merge succeeded, exit 1 = failure (git treats as conflict).
//
// Semantics (upstream-exact):
//   - Concatenate lines base → ours → theirs. Split on '\n'; a trailing empty
//     piece from a final newline is a terminator, not a line. Only the line's
//     '\n' terminator is stripped — a CRLF line keeps its '\r' as content.
//   - Empty lines are skipped entirely (upstream `if not line: continue`).
//   - Dedup exact byte-equal lines.
//   - Sort by composite key: JSON-parse the line; if it is a non-array object
//     whose `ts` (or `timestamp` alias) is a string → key (0, ts, line);
//     otherwise (unparseable / missing / non-string ts) → key
//     (1, sha256hex(line), line). The ts group sorts strictly before the hash
//     group; the raw line is the final tiebreaker.
//   - ENOENT on any input reads as EMPTY (an absent base is the common
//     merge-driver invocation); any other IO error exits 1 without writing.
//   - Output: every surviving line terminated by exactly one '\n' (upstream
//     print-per-line); an empty result writes an empty file.
//
// Side-symmetry property (the point of the composite key): merging is
// order-insensitive in ours/theirs — merge(base, ours, theirs) is
// byte-identical to merge(base, theirs, ours). Two machines that append to
// the same JSONL between pushes would otherwise produce divergent results
// depending on which side runs the merge; the line-content tiebreaker makes
// the order total so both sides converge. Pinned by
// test/jsonl-merge.test.mjs.
//
// Recorded divergences from upstream (batch 19 lane B):
//   1. Empty-line skip is NOT a divergence — upstream-exact, recorded here
//      because the batch-19 plan draft originally said to preserve them.
//   2. Direct write to OURS replaces upstream's mktemp + trap + mv. Git
//      already holds %A in its own work area, so the temp file buys nothing;
//      semantics are identical with one less failure mode.
//   3. Upstream's embedded python3 premise is eliminated: this is a
//      standalone zero-dependency Node executable (node:crypto for sha256),
//      so no interpreter beyond the Node that runs the rest of gstack861.
//   4. Upstream's bash 3.2/5.2 compat hack (BASH_COMPAT=50 heredoc-pipe guard)
//      is N/A — there is no bash and no heredoc.

import fs from 'node:fs';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
if (args.length < 3) {
  process.stderr.write(`gstack861-jsonl-merge: expected 3 args (base ours theirs), got ${args.length}\n`);
  process.exit(1);
}
const [base, ours, theirs] = args;

const fail = (message) => {
  process.stderr.write(`gstack861-jsonl-merge: ${message}\n`);
  process.exit(1);
};

// ENOENT (absent base/ours/theirs are all valid) reads as an empty input;
// any other IO error is fatal before OURS is ever written.
const readInput = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return '';
    fail(`cannot read ${file}: ${err && err.code ? err.code : err.message}`);
  }
};

// Composite sort key: (0, ts, line) for a usable string ts; (1, sha256hex, line) otherwise.
const sortKey = (line) => {
  let ts;
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ts = parsed.ts ?? parsed.timestamp;
  } catch { /* unparseable line: hash group */ }
  if (typeof ts === 'string') return [0, ts, line];
  return [1, createHash('sha256').update(line, 'utf8').digest('hex'), line];
};

const keyed = [];
const seen = new Set();
for (const text of [readInput(base), readInput(ours), readInput(theirs)]) {
  const pieces = text.split('\n');
  if (pieces[pieces.length - 1] === '') pieces.pop(); // final newline is a terminator, not a line
  for (const line of pieces) {
    if (line === '') continue; // upstream: empty lines are dropped
    if (seen.has(line)) continue; // exact byte-equal dedup
    seen.add(line);
    keyed.push(sortKey(line));
  }
}

// All-ts group (0) strictly before all-hash group (1); ties broken by the raw
// line. Lines are unique after dedup, so the comparator never sees equality —
// the order is total and Node's stable sort has nothing left to decide.
keyed.sort((a, b) => {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return a[2] < b[2] ? -1 : 1;
});

try {
  fs.writeFileSync(ours, keyed.map((entry) => `${entry[2]}\n`).join(''));
} catch (err) {
  fail(`cannot write ${ours}: ${err && err.code ? err.code : err.message}`);
}
process.exit(0);
