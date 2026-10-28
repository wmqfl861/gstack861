#!/usr/bin/env node
// gstack861-slug — print SLUG=<project slug> and BRANCH=<branch> for the cwd.
//
// Thin CLI wiring the two batch-21 libraries: src/slug.mjs (identity
// resolution + v2 cache, lane A) and src/slug-checkpoints.mjs (checkpoint
// bucket bookkeeping, lane B). Port of upstream/gstack/bin/gstack-slug at the
// pinned submodule commit 5755601dac5d35ebd7dde181defe52a023c73d9: mode
// parsing, --get whitelist and every usage string from lines 100-165, the
// early get-SLUG/BRANCH/FORMER_SLUGS and adopt-from/adopt-dismiss dispatches
// from 473-535, and the mode bodies from 536-880. All resolution and
// classification semantics live in the libraries; this file only parses
// arguments, computes the two pieces of git topology the libs cannot (cwd
// toplevel for stamp/newer-task, HEAD for stamping) and shapes output.
//
// Usage: eval "$(gstack861-slug)"          → sets SLUG and BRANCH
//        gstack861-slug                    → prints SLUG=... and BRANCH=... lines
//        gstack861-slug --get NAME         → one raw value (see --help)
//        gstack861-slug --identity         → + PROJECT_REMOTE/PROJECT_ROOT/LEGACY_SLUG/FORMER_SLUGS
//        checkpoint modes: --stamp-checkpoint <file> | --classify-checkpoints |
//        --checkpoints-below | --point-from <dir> <file> | --newer-task <branch> |
//        --adopt-legacy [--copy <relpath>... | --from <slug> | --dismiss <slug>]
//
// Divergence ledger (CLI layer; the two libraries carry their own ledgers):
//   1. State root: $GSTACK861_STATE_ROOT → ~/.gstack861 default, via the lib's
//      defaultStateRoot; ~/.gstack is NEVER touched (native safety mapping —
//      the user may run the real upstream gstack; lib ledger 1). Upstream
//      instead sources bin/gstack-state-root.sh here.
//   2. %q quoting: upstream prints PROJECT_REMOTE/PROJECT_ROOT through
//      `printf '%q'`. Node equivalent chosen here: a value consisting solely
//      of shell-safe ASCII [A-Za-z0-9_@%+=:,./-] prints raw; anything else —
//      spaces, win32 backslashes, brackets, non-ASCII, and the EMPTY string —
//      prints single-quoted with '\'' escaping. For every value these modes
//      can emit this matches bash %q byte-for-byte (canonical remotes and
//      POSIX paths are raw; the empty remote is ''); non-ASCII gets plain
//      single quotes where bash %q would choose $'…' (both eval to the same
//      literal). SLUG/BRANCH/LEGACY_SLUG/FORMER_SLUGS stay unquoted (upstream
//      echo; slug-alphabet values only).
//   3. tty→stdin (lib slug-checkpoints.mjs ledger 1): upstream's adopt-review
//      confirm tests `-t 0 && -t 1` and reads /dev/tty; this CLI ALWAYS wires
//      a stdin line source so the flow is non-TTY testable. Consequences:
//      prompts print to stdout whenever a copyable file exists (upstream only
//      on a terminal), EOF stdin declines every copy, and the non-interactive
//      "Nothing copied. Copy chosen files with: …" hint is unreachable here
//      (that hint text names gstack-slug anyway).
//   4. Output batching: upstream streams the adopt listing with prompts and
//      COPIED lines interleaved; the lib returns line arrays after the run,
//      so prompts (printed live by the answer source) precede the final
//      listing flush. Same lines, different interleaving.
//   5. FORMER_SLUGS= in --identity (space-joined) is a native addition —
//      upstream --identity prints only SLUG/BRANCH/PROJECT_REMOTE/
//      PROJECT_ROOT/LEGACY_SLUG. --get FORMER_SLUGS keeps the upstream shape:
//      one slug per line, and NO output at all when there are none (so, unlike
//      --get LEGACY_SLUG, no empty line).
//   6. --adopt-legacy --from/--dismiss slug arguments are sanitized to the
//      slug alphabet before use (upstream `tr -cd 'a-zA-Z0-9._-'`); ""/"."/
//      ".." after sanitizing are usage errors (exit 2) — upstream parity.
//   7. --get SLUG/BRANCH upstream early-exits before identity resolution;
//      here the same cost split comes from the lib's lazy identity getters —
//      reading only slug/branch never pays the remote walk (lib ledger 8).
//   8. Below-argument error strings come from the libraries verbatim, so they
//      still say "gstack-slug:" (upstream-parity strings, slug-checkpoints
//      ledger 4); the CLI's own usage/unknown-argument strings say
//      gstack861-slug.
//   9. gitCommonDir is imported from src/slug.mjs (exported for this CLI, was
//      lane-A-internal) so --checkpoints-below and --newer-task reuse the
//      exact cache-key derivation instead of re-walking .git files. The cwd
//      toplevel (upstream _git_toplevel) has no lib counterpart and is
//      ported here.
//  10. classify/newer-task read ALL of stdin up front (upstream `while read`
//      streams); candidates arrive complete from skills in practice.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { resolveIdentity, defaultStateRoot, physicalPath, gitCommonDir } from '../src/slug.mjs';
import {
  stampCheckpoint, classifyCheckpoints, checkpointsBelow, pointFrom, newerTask, adoptLegacy,
} from '../src/slug-checkpoints.mjs';

const PROG = 'gstack861-slug';
const GET_WHITELIST = ['SLUG', 'BRANCH', 'PROJECT_REMOTE', 'PROJECT_ROOT', 'LEGACY_SLUG', 'FORMER_SLUGS'];

const HELP = `gstack861-slug — print SLUG=<project slug> and BRANCH=<branch> for the current directory.
  eval "$(gstack861-slug)"                 set SLUG and BRANCH
  SLUG=$(gstack861-slug --get SLUG)        print one raw value (SLUG, BRANCH, or an --identity
                                        field); no eval needed
  gstack861-slug --identity                also print PROJECT_REMOTE (canonical, credential-free),
                                        PROJECT_ROOT, LEGACY_SLUG (pre-#3003 bucket, if different)
                                        and FORMER_SLUGS (earlier buckets still holding data)
  gstack861-slug --stamp-checkpoint FILE   write remote:/project_root:/head: into FILE's frontmatter
  gstack861-slug --classify-checkpoints    read checkpoint paths on stdin; print "<status><TAB><path>",
                                        status = match | match-root | foreign | unstamped
  gstack861-slug --checkpoints-below       outside git: other buckets' checkpoints whose project_root
                                        is below the cwd (newest 200 read); always: this bucket's
                                        pointers. Prints "BELOW_CWD <path>" / "POINTER <path>"
  gstack861-slug --point-from DIR FILE     record FILE in DIR's bucket when DIR files elsewhere
  gstack861-slug --newer-task BRANCH       read restore candidates on stdin (BRANCH's first); print
                                        "NEWER_TASK <path>" for a newer same-task other-branch save
  gstack861-slug --adopt-legacy            list the old bucket's files (checkpoints marked
                                        matching/foreign/unknown); asks per file on stdin
  gstack861-slug --adopt-legacy --copy P…  copy the named files (paths relative to the old bucket)
  gstack861-slug --adopt-legacy --from S   merge bucket S into this project's: JSONL logs merge with
                                        de-duplication, missing files copy, differing files are
                                        listed as conflicts and never overwritten; S is kept
  gstack861-slug --adopt-legacy --dismiss S  stop naming former bucket S at skill start
Env: GSTACK_PROJECT_SLUG pins the slug (ssh host aliases, vendored sub-repos); never cached.
Env: GSTACK861_STATE_ROOT overrides the state root (default ~/.gstack861; ~/.gstack is never touched).
`;

const die = (message, code = 2) => { process.stderr.write(`${message}\n`); process.exit(code); };
const usage = (text) => die(`usage: ${text}`);
const writeLines = (lines) => { for (const line of lines) process.stdout.write(`${line}\n`); };

// Upstream _git_toplevel (lines 597-610): nearest ancestor holding any .git
// entry, physical; '' outside git. Not the same as the lib's gitCommonDir —
// this is the checkout dir, not the shared git dir.
function gitToplevel(start) {
  let dir = start;
  for (let depth = 0; dir && depth < 64; depth++) {
    let has = false;
    try { has = fs.existsSync(path.join(dir, '.git')); } catch { has = false; }
    if (has) { try { return physicalPath(dir); } catch { return ''; } }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

// The one live-git need the libs do not cover: the commit a stamp describes
// (upstream `git rev-parse --verify -q HEAD`). Throws-on-failure → ''.
function gitHead(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).replace(/[\r\n]+$/, '');
  } catch { return ''; }
}

// bash printf %q equivalent — ledger 2.
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const quoteSh = (v) => (SHELL_SAFE.test(v) ? v : `'${v.replaceAll("'", `'\\''`)}'`);

// Whole stdin as one string (classify/newer-task candidate lists, ledger 10).
const readStdin = () => new Promise((resolve) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
  process.stdin.on('error', () => resolve(data));
});

// awk record semantics: a trailing newline terminates the last record.
function stdinRecords(text) {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts;
}

// Lazy one-line-at-a-time stdin source for the adopt-review confirms
// (ledger 3): prints upstream's prompt to stdout before each read (ledger 4).
function stdinAnswerSource() {
  const queue = [];
  const waiters = [];
  let closed = false;
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line); else queue.push(line);
  });
  rl.on('close', () => { closed = true; for (const w of waiters.splice(0)) w(''); });
  return async () => {
    if (queue.length > 0) return queue.shift();
    if (closed) return '';
    return await new Promise((resolve) => waiters.push(resolve));
  };
}

// ---------------------------------------------------------------------------
// Mode parsing — upstream lines 100-165, usage strings adapted to PROG
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
let mode = 'default';
let modeArg = '';
let modeArg2 = '';
let copyPaths = [];

switch (argv[0]) {
  case undefined:
    break;
  case '--identity':
    mode = 'identity';
    break;
  case '--get':
    mode = 'get';
    modeArg = argv[1] ?? '';
    if (!GET_WHITELIST.includes(modeArg)) {
      usage(`${PROG} --get SLUG|BRANCH|PROJECT_REMOTE|PROJECT_ROOT|LEGACY_SLUG|FORMER_SLUGS`);
    }
    break;
  case '--stamp-checkpoint':
    mode = 'stamp';
    modeArg = argv[1] ?? '';
    if (modeArg === '') usage(`${PROG} --stamp-checkpoint <file>`);
    break;
  case '--classify-checkpoints':
    mode = 'classify';
    break;
  case '--checkpoints-below':
    mode = 'below';
    break;
  case '--newer-task':
    mode = 'newer-task';
    modeArg = argv[1] ?? '';
    break;
  case '--point-from':
    mode = 'point';
    modeArg = argv[1] ?? '';
    modeArg2 = argv[2] ?? '';
    if (modeArg === '' || modeArg2 === '') usage(`${PROG} --point-from <start dir> <checkpoint file>`);
    break;
  case '--adopt-legacy': {
    mode = 'adopt';
    const rest = argv.slice(1);
    const [sub = ''] = rest;
    if (sub === '--copy') {
      copyPaths = rest.slice(1);
      if (copyPaths.length === 0) usage(`${PROG} --adopt-legacy --copy <relpath>...`);
    } else if (sub === '--from' || sub === '--dismiss') {
      mode = sub === '--from' ? 'adopt-from' : 'adopt-dismiss';
      modeArg = (rest[1] ?? '').replace(/[^a-zA-Z0-9._-]/g, ''); // ledger 6
      if (modeArg === '' || modeArg === '.' || modeArg === '..') usage(`${PROG} --adopt-legacy ${sub} <slug>`);
    } else if (sub !== '') {
      usage(`${PROG} --adopt-legacy [--copy <relpath>... | --from <slug> | --dismiss <slug>]`);
    }
    break;
  }
  case '-h':
  case '--help':
    process.stdout.write(HELP);
    process.exit(0);
    break;
  default:
    die(`${PROG}: unknown argument: ${argv[0]} (try --help)`);
    break;
}

// ---------------------------------------------------------------------------
// Mode bodies — upstream lines 536-880 (+ early dispatches 473-535)
// ---------------------------------------------------------------------------

async function main() {
  const env = process.env;
  const stateRoot = defaultStateRoot(env); // ledger 1
  const cwd = process.cwd();
  // Lazy identity (lib ledger 8): modes that read only slug/branch never pay
  // the remote walk; the getters fire exactly when an identity field is used.
  const id = resolveIdentity({ cwd, env, stateRoot });

  switch (mode) {
    case 'default': // upstream line 536
      writeLines([`SLUG=${id.slug}`, `BRANCH=${id.branch}`]);
      break;

    case 'identity': // upstream lines 672-678 + native FORMER_SLUGS (ledger 5)
      writeLines([
        `SLUG=${id.slug}`,
        `BRANCH=${id.branch}`,
        `PROJECT_REMOTE=${quoteSh(id.remote)}`,
        `PROJECT_ROOT=${quoteSh(id.projectRoot)}`,
        `LEGACY_SLUG=${id.legacySlug}`,
        `FORMER_SLUGS=${id.formerSlugs.join(' ')}`,
      ]);
      break;

    case 'get': {
      if (modeArg === 'FORMER_SLUGS') { // upstream lines 478-486: one per line, none → no output
        writeLines(id.formerSlugs);
        break;
      }
      const values = {
        SLUG: id.slug, BRANCH: id.branch,
        PROJECT_REMOTE: id.remote, PROJECT_ROOT: id.projectRoot, LEGACY_SLUG: id.legacySlug,
      };
      writeLines([values[modeArg]]); // empty value still prints one empty line (printf '%s\n')
      break;
    }

    case 'stamp': { // upstream lines 680-707
      const toplevel = gitToplevel(cwd);
      try {
        stampCheckpoint(modeArg, {
          remote: id.remote,
          projectRoot: id.projectRoot,
          worktree: toplevel !== '' && toplevel !== id.projectRoot ? toplevel : '',
          head: gitHead(cwd),
        });
      } catch (err) {
        process.stderr.write(`${err.message}\n`); // ledger 8
        process.exit(1);
      }
      break;
    }

    case 'classify': { // upstream lines 709-714
      const paths = stdinRecords(await readStdin()).filter(p => p !== '');
      writeLines(classifyCheckpoints(paths, { remote: id.remote, projectRoot: id.projectRoot }));
      break;
    }

    case 'below': // upstream lines 716-745
      writeLines(checkpointsBelow(cwd, stateRoot, id, { gitCommonDir: gitCommonDir(cwd) }));
      break;

    case 'point': { // upstream lines 747-766
      let out;
      try {
        out = await pointFrom(modeArg, modeArg2, stateRoot,
          (dir) => resolveIdentity({ cwd: dir, env, stateRoot }).slug);
      } catch (err) {
        process.stderr.write(`${err.message}\n`); // ledger 8
        process.exit(1);
      }
      if (out !== '') writeLines([`POINTER_WRITTEN ${out}`]); // same bucket: silent exit 0
      break;
    }

    case 'newer-task': { // upstream lines 768-800
      const candidates = stdinRecords(await readStdin()).filter(p => p !== '');
      const common = gitCommonDir(cwd); // ledger 9
      const mainTree = common !== '' && path.basename(common) === '.git' ? path.dirname(common) : '';
      const result = newerTask(modeArg, candidates, { here: gitToplevel(cwd), main: mainTree });
      if (result !== '') writeLines([result]);
      break;
    }

    case 'adopt-from':
    case 'adopt-dismiss': { // upstream lines 491-535 (early, before identity resolution)
      const out = mode === 'adopt-from'
        ? await adoptLegacy({ mode: 'from', stateRoot, slug: id.slug, from: modeArg })
        : await adoptLegacy({ mode: 'dismiss', stateRoot, slug: id.slug, dismiss: modeArg });
      writeLines(out.lines);
      for (const e of out.errors) process.stderr.write(`${e}\n`); // ledger 8
      process.exit(out.code);
      break;
    }

    case 'adopt': { // upstream lines 802-878
      const opts = {
        stateRoot, slug: id.slug, legacySlug: id.legacySlug,
        identity: { remote: id.remote, projectRoot: id.projectRoot },
      };
      if (copyPaths.length > 0) {
        const out = await adoptLegacy({ ...opts, mode: 'copy', paths: copyPaths });
        writeLines(out.lines);
        process.exit(out.code);
      }
      const answers = stdinAnswerSource(); // ledger 3
      const out = await adoptLegacy({
        ...opts, mode: 'review',
        input: async () => {
          process.stdout.write('    copy into the new bucket? [y/N] '); // ledger 4
          return answers();
        },
      });
      writeLines(out.lines);
      process.exit(out.code);
      break;
    }

    default:
      break;
  }
}

main().catch((err) => {
  process.stderr.write(`${PROG}: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
