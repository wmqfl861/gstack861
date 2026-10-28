#!/usr/bin/env node
// gstack861-issue-links — issue links by intent for /ship Step 18 (plan C6).
//
//   gstack861-issue-links.mjs [--base <ref>] [--issue <n>]... [--ci-run <id>]... [--supersedes <pr>]... [--credit <pr>]...
//                             [--no-auto-links] [--author <login>] [--repo <owner/repo>] [--out <issues.json>] [--json]
//
// Port of upstream/gstack bin/gstack-issue-links (202 lines) at pinned
// submodule commit 5755601dac5d35ebd7dde181fdefe52a023c73d9 (batch 24 lane B).
//
// Semantics (upstream-exact): reads `git log origin/<base>..HEAD` and
// classifies every issue mention — `Fixes #N` only on explicit closure intent
// (a Fixes/Closes/Resolves trailer or --issue), `Refs #N` for everything else
// (bare mentions, partial fixes, deferred asks, cross-repo ids). Each closure
// issue is read through gstack861-issue-guard; unreadable ones are downgraded
// to Refs (ISSUE_UNREADABLE). Same-repo references are listed as promotion
// candidates (`fix #N` → --issue N). Each --ci-run id is searched among open
// issues whose body names it and kept only for bot flake issues of this repo
// naming that run and a test: `Flake: #N (run <id>)`. Open PRs by other
// authors closing a fixed issue are `Related: #N (@author)` unless
// --no-auto-links; --supersedes / --credit record the owner's confirmation.
// Prints the `## Issues` lines; --json / --out emit the receipt's `issues`
// object. Logic: src/issue-links.mjs (the lane A port of lib/issue-links.ts).
//
// Exit codes (upstream): 0 with links or none (a failed lookup prints
// ISSUE_LOOKUP_FAILED); 1 when a closure issue was unreadable (its link is
// Refs); 2 usage.
//
// Divergence ledger (every deviation from the upstream source):
//   1. Bun.fileURLToPath(import.meta.url) → node:url fileURLToPath.
//   2. The gstack-issue-guard child probe spawns
//      `process.execPath [bin/gstack861-issue-guard.mjs, 'issue', n]` instead
//      of executing the bun bin directly — same argv contract, and the
//      upstream caps are kept: cwd repoRoot, 60s timeout, 16 MiB maxBuffer.
//   3. Result codes (plan item 3): upstream imports resultLineWithDocs /
//      resultLine from the 786-line lib/result-codes.ts table. ONLY the two
//      codes this bin prints are ported, in upstream format with their exact
//      summary/fix/anchor rows (lines 420-430) — ISSUE_LOOKUP_FAILED carries
//      the docs-link suffix `(<CODE>; https://github.com/garrytan/gstack/
//      blob/main/docs/troubleshooting.md#<anchor>)` — plus EXIT and the
//      byte-identical exit table (lib/headless-artifacts.ts lines 102-105).
//      The `context` argument stays the upstream 'gstack-issue-links' string
//      so every result-line byte (and the upstream test vectors) matches.
//      Not the full table; no other consumers here.
//   4. resolveBaseBranch imported from src/ship-policy.mjs (the batch-24 lane
//      A lift of ship-policy.ts lines 425-431, 2-arg shape).
//   5. The HELP banner title is renamed gstack861-issue-links; the rest of
//      the HELP text (including the exit table line) is verbatim.
//   6. Structural: bun shebang → `#!/usr/bin/env node`; TypeScript types
//      erased; process.exit(main(...)) as upstream. Everything else — flag
//      parsing, the git runner, the gh runner (GraphQL pagination MAX_PAGES
//      = 10, ISSUE_LOOKUP_FAILED collection), the flake/related/author
//      flows, --out (mkdir recursive, 2-space JSON, trailing newline) and
//      --json shapes, stdout/stderr text, exit triggers — is verbatim.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineSources, mentionsIn, promotionCandidates, receiptIssues, relatedPrs, renderIssueLines, resolveLinks, selectFlakes } from '../src/issue-links.mjs';
import { resolveBaseBranch } from '../src/ship-policy.mjs';

const EXIT = { ok: 0, fail: 1, usage: 2, refused: 3 }; // headless-artifacts.ts line 102, verbatim
const EXIT_TABLE_HELP = 'Exit codes: 0 ok · 1 fail · 2 usage · 3 refused or needs a flag'; // headless-artifacts.ts line 104, byte-identical (upstream asserts the full string)

const HELP = `gstack861-issue-links — Fixes only on explicit closure intent; everything else is Refs (docs/pregate.md#issue-links)

  --base <ref>        base branch (default: origin/HEAD, else main); commits origin/<base>..HEAD are read
  --issue <n>         explicit closure intent (repeatable); still read through gstack-issue-guard
  --ci-run <id>       a failing CI run id (repeatable); bot flake issues of this repo naming it and a test become Flake: #N (run <id>)
  --supersedes <pr>   owner confirmed this PR supersedes a Related PR: Supersedes #N (repeatable)
  --credit <pr>       owner confirmed crediting a Related PR's author: Contributed by @author (repeatable)
  --no-auto-links     no Related lookup (open PRs by other authors closing a fixed issue)
  --author <login>    this PR's author for that lookup (default: the gh viewer; for an app viewer, the HEAD commit's
                      GitHub user, else a user-owned repository's owner)
  --repo <owner/repo> repository for gh (default: the current remote)
  --out <file>        write the issues object (fixes, refs, flakes, related) for gstack-ship-receipt write --issues @file
  --json              JSON only on stdout

Same-repo references print as promotion candidates; the owner's \`fix #N\` reply reruns with --issue N.
Exit 0 with links or none (a failed lookup prints ISSUE_LOOKUP_FAILED); 1 when a closure issue was unreadable (its link is Refs); 2 usage.
${EXIT_TABLE_HELP}`;

// ---------------------------------------------------------------------------
// Result codes (plan item 3): exactly the two rows this bin prints,
// verbatim from lib/result-codes.ts lines 420-430, plus the line renderers
// (lines 780-798) in upstream format.
// ---------------------------------------------------------------------------

const TROUBLESHOOTING_DOC = 'https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md'; // result-codes.ts line 780
const RESULT_CODES = {
  ISSUE_UNREADABLE: {
    anchor: 'issue-unreadable',
    summary: 'an issue a closure trailer or --issue names could not be read through gstack-issue-guard, so its link is Refs, never Fixes',
    fix: 'check `gh auth status` and the issue number; rerun gstack-issue-links once the issue reads',
  },
  ISSUE_LOOKUP_FAILED: {
    anchor: 'issue-lookup-failed',
    summary: `gstack-issue-links could not read the repository, this PR's author, the open PRs closing a fixed issue, or the flake issues naming a CI run, so Related or Flake lines may be missing or list the owner's own PRs`,
    fix: 'check `gh auth status` and the repository (`--repo <owner/repo>`), pass `--author <login>` when gh runs as an app, then rerun gstack-issue-links; report the gap in the handoff if it still fails',
  },
};

/** The installer form: `<context>: <summary>[ — <detail>]; fix: <fix> (<CODE>; <doc>#anchor)`. */
function resultLineWithDocs(context, code, detail) {
  const row = RESULT_CODES[code];
  return `${context}: ${row.summary}${detail ? ` — ${detail}` : ''}; fix: ${row.fix} (${code}; ${TROUBLESHOOTING_DOC}#${row.anchor})`;
}

/** One error line: `<context>: <summary>[ (<detail>)]; fix: <fix> (<CODE>)`. */
function resultLine(context, code, detail) {
  const row = RESULT_CODES[code];
  const what = detail ? `${row.summary} (${detail})` : row.summary;
  return `${context}: ${what}; fix: ${row.fix} (${code})`;
}

// ---------------------------------------------------------------------------
// bin/gstack-issue-links (upstream-exact below)
// ---------------------------------------------------------------------------

const MAX_PAGES = 10;
const CLOSING_QUERY = 'query($owner:String!,$name:String!,$number:Int!,$after:String){viewer{login} repository(owner:$owner,name:$name){issue(number:$number){closedByPullRequestsReferences(first:50,after:$after,includeClosedPrs:false){nodes{number state headRefName author{login} repository{nameWithOwner}} pageInfo{hasNextPage endCursor}}}}}';

function flags(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name && args[i + 1] !== undefined) out.push(args[++i]);
  return out;
}
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : undefined;
}

/** gh calls whose failures are reported once as ISSUE_LOOKUP_FAILED and collected for --json. */
function ghLookups(cwd) {
  const unavailable = [];
  const failed = (what, why) => {
    unavailable.push(`${what}: ${why}`);
    process.stderr.write(resultLineWithDocs('gstack-issue-links', 'ISSUE_LOOKUP_FAILED', `${what}: ${why}`) + '\n');
  };
  function json(what, args) {
    const r = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) { failed(what, (r.stderr ?? '').trim().split('\n')[0] || `gh exited ${r.status}`); return undefined; }
    try { return JSON.parse(r.stdout); } catch { failed(what, 'gh returned no JSON'); return undefined; }
  }
  return { unavailable, failed, json };
}

/** Every open PR closing each fixed issue, page by page; undefined when any page fails. */
function closingPrs(gh, repo, fixes) {
  const [owner, name] = repo.split('/');
  const closing = new Map();
  let viewer = '';
  for (const issue of fixes) {
    const what = `open PRs closing #${issue}`;
    const prs = [];
    let after;
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) { gh.failed(what, `more than ${MAX_PAGES} pages`); return undefined; }
      const res = gh.json(what, ['api', 'graphql', '-f', `query=${CLOSING_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${issue}`, ...(after ? ['-f', `after=${after}`] : [])]);
      if (!res) return undefined;
      const conn = res.data?.repository?.issue?.closedByPullRequestsReferences;
      if (!conn) { gh.failed(what, 'the reply has no closedByPullRequestsReferences'); return undefined; }
      viewer ||= res.data?.viewer?.login ?? '';
      prs.push(...(conn.nodes ?? []));
      if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
      after = conn.pageInfo.endCursor;
    }
    closing.set(issue, prs);
  }
  return { closing, viewer };
}

const AUTHOR_QUERY = 'query($owner:String!,$name:String!,$head:String!){repository(owner:$owner,name:$name){owner{__typename login} object(expression:$head){... on Commit{author{user{login}}}}}}';

/**
 * Whose PRs are not "other authors": --author, else the gh viewer unless it is
 * an app (`…[bot]`), in which case the HEAD commit's GitHub user, else the
 * owner of a user-owned repository. With none, the app viewer stays and the
 * gap is reported, since the owner's own PRs would then be listed as Related.
 */
function prAuthor(gh, repo, viewer, explicit, head) {
  if (explicit) return { login: explicit, source: '--author' };
  if (!/\[bot\]$/.test(viewer)) return { login: viewer, source: 'gh viewer' };
  const [owner, name] = repo.split('/');
  const res = head ? gh.json(`this PR's author`, ['api', 'graphql', '-f', `query=${AUTHOR_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `head=${head}`]) : undefined;
  const commitUser = res?.data?.repository?.object?.author?.user?.login;
  if (commitUser) return { login: commitUser, source: 'HEAD commit author' };
  const repoOwner = res?.data?.repository?.owner;
  if (repoOwner?.__typename === 'User' && repoOwner.login) return { login: repoOwner.login, source: 'repository owner' };
  if (res) gh.failed(`this PR's author`, `gh runs as ${viewer} and neither the HEAD commit nor the repository owner names a user; pass --author <login>`);
  return { login: viewer, source: 'gh viewer' };
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP + '\n'); return EXIT.ok; }
  const json = argv.includes('--json');
  const repoRoot = git(['rev-parse', '--show-toplevel'], process.cwd())?.trim() ?? process.cwd();
  const base = flags(argv, '--base')[0] ?? resolveBaseBranch(repoRoot);
  const explicit = [];
  for (const raw of flags(argv, '--issue')) {
    if (!/^\d+$/.test(raw)) { process.stderr.write(`gstack861-issue-links: --issue must be a positive integer, got ${JSON.stringify(raw)}\n`); return EXIT.usage; }
    explicit.push(Number(raw));
  }
  const runs = flags(argv, '--ci-run');
  if (runs.some(r => !/^[A-Za-z0-9_.-]{1,64}$/.test(r))) { process.stderr.write('gstack861-issue-links: --ci-run ids are alphanumeric\n'); return EXIT.usage; }
  const confirmed = { supersedes: flags(argv, '--supersedes'), credit: flags(argv, '--credit') };
  if ([...confirmed.supersedes, ...confirmed.credit].some(r => !/^\d+$/.test(r))) { process.stderr.write('gstack861-issue-links: --supersedes and --credit take a PR number\n'); return EXIT.usage; }
  const autoLinks = !argv.includes('--no-auto-links');
  const binDir = path.dirname(fileURLToPath(import.meta.url));

  const log = git(['log', '--format=%H%n%B%x00', `origin/${base}..HEAD`], repoRoot) ?? git(['log', '--format=%H%n%B%x00', `${base}..HEAD`], repoRoot);
  if (log === undefined) { process.stderr.write(`gstack861-issue-links: cannot read commits ${base}..HEAD (fetch origin/${base} first)\n`); return EXIT.usage; }
  const mentions = [];
  for (const entry of log.split('\0')) {
    const nl = entry.indexOf('\n');
    if (nl < 0) continue;
    mentions.push(...mentionsIn(entry.slice(nl + 1), `commit ${entry.slice(0, nl).trim().slice(0, 12)}`));
  }
  const readable = (issue) => {
    // Divergence 2: the guard child runs under our own node with the ported .mjs; upstream caps kept.
    const r = spawnSync(process.execPath, [path.join(binDir, 'gstack861-issue-guard.mjs'), 'issue', String(issue)], { cwd: repoRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    return r.status === 0 && r.stdout.length > 0;
  };
  const gh = ghLookups(repoRoot);
  const needRepo = runs.length > 0 || explicit.length > 0 || (autoLinks && mentions.some(m => m.intent === 'fixes'));
  const repo = flags(argv, '--repo')[0] ?? (needRepo ? gh.json('repository', ['repo', 'view', '--json', 'nameWithOwner'])?.nameWithOwner : undefined);

  const flakes = [];
  const rejectedFlakes = [];
  for (const run of repo ? runs : []) {
    const rows = gh.json(`flake issues naming run ${run}`, ['issue', 'list', '--repo', repo, '--state', 'open', '--search', `"${run}" in:body`, '--limit', '100', '--json', 'number,title,body,author']);
    if (!rows) continue;
    const picked = selectFlakes(run, repo, rows);
    for (const f of picked.flakes) if (!flakes.some(x => x.issue === f.issue)) flakes.push(f);
    rejectedFlakes.push(...picked.rejected.map(x => ({ ...x, run })));
  }
  const links = resolveLinks(mentions, explicit, readable, flakes);
  const found = autoLinks && repo && links.fixes.length ? closingPrs(gh, repo, links.fixes) : undefined;
  const author = found ? prAuthor(gh, repo, found.viewer, flags(argv, '--author')[0], git(['rev-parse', 'HEAD'], repoRoot)?.trim()) : undefined;
  if (found && author) {
    const related = relatedPrs(found.closing, { repo, viewer: author.login, branch: git(['branch', '--show-current'], repoRoot)?.trim() || undefined });
    if (related.length) links.related = related;
  }
  for (const [kind, list] of Object.entries(confirmed)) {
    for (const raw of list) {
      const row = links.related?.find(r => !r.repo && r.pr === Number(raw));
      if (!row) { process.stderr.write(`gstack861-issue-links: --${kind} #${raw} is not a Related PR (${(links.related ?? []).map(r => `${r.repo ?? ''}#${r.pr}`).join(', ') || 'none found'})\n`); return EXIT.usage; }
      if (kind === 'supersedes') row.supersedes = true; else row.credit = true;
    }
  }
  for (const n of links.unreadable) process.stderr.write(resultLine('gstack-issue-links', 'ISSUE_UNREADABLE', `#${n}`) + '\n');
  const candidates = promotionCandidates(mentions, links);
  const lines = renderIssueLines(links);
  const out = flags(argv, '--out')[0];
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(receiptIssues(links), null, 2) + '\n'); }
  if (json) process.stdout.write(JSON.stringify({ ...receiptIssues(links), cross: links.cross, unreadable: links.unreadable, candidates, flake_tests: links.flakes, rejected_flakes: rejectedFlakes, ...(author ? { author } : {}), unavailable: gh.unavailable, lines }) + '\n');
  else {
    process.stdout.write(lines.length ? lines.join('\n') + '\n' : 'ISSUE_LINKS: none\n');
    for (const m of mentions) {
      const promote = candidates.some(c => c.issue === m.issue) && m.intent === 'refs' && !m.repo ? ` (promote: fix #${m.issue})` : '';
      process.stderr.write(`  ${m.intent === 'fixes' ? 'closure' : 'reference'} ${m.repo ? `${m.repo}#` : '#'}${m.issue} ← ${m.source}${promote}\n`);
    }
    if (author && author.source !== 'gh viewer') process.stderr.write(`  Related excludes @${author.login} (${author.source})\n`);
    for (const line of lineSources(links)) process.stderr.write(`  ${line}\n`);
    for (const r of rejectedFlakes) process.stderr.write(`  not a flake link: #${r.issue} (run ${r.run}) ← ${r.reason}\n`);
  }
  return links.unreadable.length ? EXIT.fail : EXIT.ok;
}

process.exit(main(process.argv.slice(2)));
