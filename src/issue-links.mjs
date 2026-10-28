// issue-links — pure issue-intent classification for the /ship Step 18
// issue block (batch 24, Lane A). The bin layer (Lane B's
// bin/gstack861-issue-links.mjs) owns the git log / gh / issue-guard calls.
//
// Port of upstream/gstack lib/issue-links.ts (188 lines) at pinned submodule
// commit 5755601dac5d35ebd7dde181fdefe52a023c73d9, verbatim apart from the
// ledger below. Upstream imports NOTHING (zero-dependency classifier over
// plain strings and gh row shapes) — the port keeps zero imports.
//
// Divergence ledger (every deviation from the upstream source):
//   1. Structural only: TypeScript types erased to JSDoc typedefs (no runtime
//      change); non-null assertions dropped (`block[1]!` → `block[1]`);
//      the module lives at src/issue-links.mjs, not lib/issue-links.ts.
//      Every regex, sort, dedupe key, rejection string and spread-conditional
//      is byte-identical upstream behavior; the vectors live in
//      test/issue-links.test.mjs (adapted from upstream
//      test/ship-issue-intent.test.ts' pure-lib describes).
//
// Type shapes (upstream lines 27-37, erased):
//   IssueIntent   = 'fixes' | 'refs'
//   IssueMention  { issue: number, intent: IssueIntent, repo?: string, source: string }
//   FlakeLink     { issue: number, run: string, test?: string }
//   RelatedPr     { pr: number, repo?: string, author: string, closes: number[],
//                   supersedes?: boolean, credit?: boolean }
//   IssueLinks    { fixes: number[], refs: number[], flakes: FlakeLink[],
//                   cross: string[], unreadable: number[], related?: RelatedPr[] }
//   IssueRow      { number: number, title?: string, body?: string,
//                   author?: { login?: string, is_bot?: boolean } }
//   ClosingPr     { number: number, state?: string, headRefName?: string,
//                   author?: { login?: string } | null,
//                   repository?: { nameWithOwner?: string } }
//
// Upstream doc comment (verbatim, lines 1-25):
//
//   Issue links for /ship Step 18 (plan C6). Pure classification over commit
//   messages and explicit flags; the bin (bin/gstack-issue-links) owns the
//   gh / gstack-issue-guard calls.
//
//   Intent rules:
//     - `Fixes #N` is written only on explicit closure intent: a `Fixes|Closes|
//       Resolves #N` trailer line in a commit of the branch, or `--issue N`.
//     - A bare `#N` mention, a `Refs|See|Part of|Partially fixes|Related` line, a
//       deferred ask (`defer`, `follow-up`) and every cross-repo id
//       (`owner/repo#N`) are `Refs #N` — never auto-closed.
//     - A closure issue that cannot be read through gstack-issue-guard is
//       downgraded to `Refs #N` with ISSUE_UNREADABLE (never Fixes).
//     - Same-repo references are promotion candidates: the owner's `fix #N`
//       reply becomes `--issue N`; unattended runs keep them as Refs.
//     - Failing CI run ids map to bot-opened flake issues of this repository
//       that name the run (their `flake:json` first_seen.run_id or this repo's
//       actions/runs/<id> URL) and a test (`flake:json` file › test or a
//       `Flake: <test>` title): `Flake: #N (run <id>)`. Duplicate test names
//       keep the lowest issue number.
//     - Open PRs by other authors that close an issue this PR fixes are
//       `Related: #N (@author)`; `Supersedes #N` and `Contributed by @author`
//       (lib/contributor-mode.ts credit lines) only with the owner's
//       confirmation (--supersedes / --credit).

const CLOSURE = /^\s*(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s*:?\s+(?:#|GH-)(\d+)\s*$/i;
const PARTIAL = /\b(?:partial(?:ly)?|part of|defer(?:red)?|follow-?up|related|refs?|see|context)\b/i;
const CROSS = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/g;
const BARE = /(?<![A-Za-z0-9_./-])#(\d+)\b/g;

/** Mentions in one commit message: trailer lines carry closure intent, everything else is a reference. */
export function mentionsIn(message, source = 'commit') {
  const out = [];
  const seen = new Set();
  const add = (m) => { const k = `${m.repo ?? ''}#${m.issue}:${m.intent}`; if (!seen.has(k)) { seen.add(k); out.push(m); } };
  for (const raw of message.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const trailer = CLOSURE.exec(line);
    if (trailer && !PARTIAL.test(line)) { add({ issue: Number(trailer[1]), intent: 'fixes', source: `${source}: ${line.trim()}` }); continue; }
    for (const c of line.matchAll(CROSS)) add({ issue: Number(c[2]), intent: 'refs', repo: c[1], source: `${source}: ${line.trim()}` });
    const stripped = line.replace(CROSS, '');
    for (const b of stripped.matchAll(BARE)) add({ issue: Number(b[1]), intent: 'refs', source: `${source}: ${line.trim()}` });
  }
  return out;
}

/**
 * Resolve the final link set. `readable(n)` is the gstack-issue-guard probe
 * for a closure candidate; a false answer downgrades it to Refs.
 */
export function resolveLinks(mentions, explicit, readable, flakes = [], related = []) {
  const fixes = new Set(explicit);
  const refs = new Set();
  const cross = new Set();
  for (const m of mentions) {
    if (m.repo) { cross.add(`${m.repo}#${m.issue}`); continue; }
    if (m.intent === 'fixes') fixes.add(m.issue); else refs.add(m.issue);
  }
  const unreadable = [];
  for (const n of [...fixes]) if (!readable(n)) { fixes.delete(n); refs.add(n); unreadable.push(n); }
  for (const n of fixes) refs.delete(n);
  for (const f of flakes) refs.delete(f.issue);
  const asc = (a, b) => a - b;
  return {
    fixes: [...fixes].sort(asc), refs: [...refs].sort(asc), flakes: [...flakes].sort((a, b) => a.issue - b.issue), cross: [...cross].sort(), unreadable: unreadable.sort(asc),
    ...(related.length ? { related } : {}),
  };
}

/** Same-repo references the owner may promote with `fix #N` (unreadable closure issues excluded), with the first line naming each. */
export function promotionCandidates(mentions, links) {
  const out = [];
  for (const m of mentions) {
    if (!m.repo && links.refs.includes(m.issue) && !links.unreadable.includes(m.issue) && !out.some(c => c.issue === m.issue)) out.push({ issue: m.issue, source: m.source });
  }
  return out.sort((a, b) => a.issue - b.issue);
}

const isBot = (author) => author?.is_bot === true || /^app\/|\[bot\]$/.test(author?.login ?? '');
const FLAKE_JSON = /<!--\s*flake:json\s*-->\s*```json\s*\r?\n([\s\S]*?)\r?\n```/;
const RUN_URL = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/(\d+)(?!\d)/g;

/** The test an issue is a flake of and the runs it names; undefined test when it names none. */
function flakeIdentity(row) {
  const block = FLAKE_JSON.exec(row.body ?? '');
  if (block) {
    try {
      const j = JSON.parse(block[1]);
      if (typeof j.file === 'string' && j.file) {
        return { test: typeof j.test === 'string' && j.test ? `${j.file} › ${j.test}` : j.file, jsonRun: j.first_seen?.run_id === undefined ? undefined : String(j.first_seen.run_id) };
      }
    } catch { /* an unparsable block names no test; the title may */ }
  }
  const title = /^flake:\s*(\S.*)$/i.exec((row.title ?? '').trim());
  return { test: title?.[1] };
}

/**
 * The open issues a `"<run>" in:body` search returned, narrowed to bot-opened
 * flake issues of `repo` that name this run and a test. Every other row is
 * rejected with its reason; two issues for the same test keep the lowest number.
 */
export function selectFlakes(run, repo, rows) {
  const flakes = [];
  const rejected = [];
  for (const row of [...rows].sort((a, b) => a.number - b.number)) {
    if (!isBot(row.author)) { rejected.push({ issue: row.number, reason: `opened by @${row.author?.login ?? 'unknown'}, not a bot` }); continue; }
    const { test, jsonRun } = flakeIdentity(row);
    if (!test) { rejected.push({ issue: row.number, reason: 'names no test (no flake:json file, no "Flake: <test>" title)' }); continue; }
    const urls = [...(row.body ?? '').matchAll(RUN_URL)].filter(m => m[2] === run).map(m => m[1]);
    if (jsonRun !== run && !urls.some(u => u.toLowerCase() === repo.toLowerCase())) {
      rejected.push({ issue: row.number, reason: urls.length ? `names run ${run} of ${[...new Set(urls)].join(', ')}, not ${repo}` : `does not name run ${run} of ${repo}` });
      continue;
    }
    const first = flakes.find(f => f.test === test);
    if (first) { rejected.push({ issue: row.number, reason: `duplicate of #${first.issue} (${test})` }); continue; }
    flakes.push({ issue: row.number, run, test });
  }
  return { flakes, rejected };
}

/**
 * Open PRs by other authors whose closing set overlaps `fixes`. `closing`
 * maps each fixed issue to the PRs that close it; this branch's own PR and the
 * viewer's PRs are excluded. A PR in another repository keeps its repo.
 */
export function relatedPrs(closing, ctx) {
  const byKey = new Map();
  for (const [issue, prs] of closing) {
    for (const pr of prs) {
      const prRepo = pr.repository?.nameWithOwner;
      const same = !prRepo || prRepo.toLowerCase() === ctx.repo.toLowerCase();
      const author = pr.author?.login ?? 'ghost';
      if ((pr.state ?? 'OPEN') !== 'OPEN' || author.toLowerCase() === ctx.viewer.toLowerCase() || (same && ctx.branch && pr.headRefName === ctx.branch)) continue;
      const key = `${same ? '' : prRepo}#${pr.number}`;
      const row = byKey.get(key) ?? { pr: pr.number, ...(same ? {} : { repo: prRepo }), author, closes: [] };
      if (!row.closes.includes(issue)) row.closes.push(issue);
      byKey.set(key, row);
    }
  }
  return [...byKey.values()].map(r => ({ ...r, closes: r.closes.sort((a, b) => a - b) })).sort((a, b) => (a.repo ?? '').localeCompare(b.repo ?? '') || a.pr - b.pr);
}

const prId = (r) => `${r.repo ?? ''}#${r.pr}`;

/** The `## Issues` lines for the PR body; an empty set renders nothing. */
export function renderIssueLines(links) {
  const lines = [];
  for (const n of links.fixes) lines.push(`Fixes #${n}`);
  for (const n of links.refs) lines.push(links.unreadable.includes(n) ? `Refs #${n} (unreadable through gstack-issue-guard; not auto-closed)` : `Refs #${n}`);
  for (const c of links.cross) lines.push(`Refs ${c}`);
  for (const f of links.flakes) lines.push(`Flake: #${f.issue} (run ${f.run})`);
  for (const r of links.related ?? []) {
    lines.push(r.supersedes ? `Supersedes ${prId(r)}` : `Related: ${prId(r)} (@${r.author})`);
    if (r.credit) lines.push(`Contributed by @${r.author}`);
  }
  return lines;
}

/** Where each added line came from, for the PR-body preview (one `<line> ← <source>` per Related/Supersedes/Contributed/Flake line). */
export function lineSources(links) {
  const out = [];
  for (const f of links.flakes) out.push(`Flake: #${f.issue} (run ${f.run}) ← bot flake issue for ${f.test ?? 'an unnamed test'}`);
  for (const r of links.related ?? []) {
    const closes = `open PR closing ${r.closes.map(n => `#${n}`).join(', ')}`;
    out.push(r.supersedes ? `Supersedes ${prId(r)} ← ${closes} by @${r.author}; owner confirmed --supersedes` : `Related: ${prId(r)} (@${r.author}) ← ${closes}`);
    if (r.credit) out.push(`Contributed by @${r.author} ← ${prId(r)}, ${closes}; owner confirmed --credit`);
  }
  return out;
}

/** The receipt's `issues` field (lib/headless-artifacts.ts ship-receipt schema); `related` only when a PR is listed. */
export function receiptIssues(links) {
  return { fixes: links.fixes, refs: links.refs, flakes: links.flakes.map(f => ({ issue: f.issue, run: f.run })), ...(links.related ? { related: links.related } : {}) };
}
