// issue-links — the PURE-LIB vectors of upstream test/ship-issue-intent.test.ts
// (252 lines, 13 tests) at pinned submodule commit
// 5755601dac5d35ebd7dde181fdefe52a023c73d9, adapted for src/issue-links.mjs
// (batch 24 lane A): bun:test → node:test, expect → assert/strict, TS types
// erased. Vector TEXTS and expected values are verbatim upstream.
//
// Dropped with ledger (plan 审计划必改落实 item 1: adapt upstream vectors +
// ledger the drops, b20/b23 precedent — no self-constructed vectors):
//   - upstream lines 54-56: the `gstack-ship-receipt write --issues @<out>`
//     round-trip inside the first bin test — gstack-ship-receipt is not a
//     port target of this repo (batch-24 non-goal); the receipt `issues`
//     shape itself is asserted at line 53 through the bin's --out file,
//     which moves to lane B's bin test.
//   - upstream lines 207-224: the whole `gstack-ship-receipt ... ISSUE_LINKS_MISSING`
//     e2e test — same ship-receipt non-goal.
//   - upstream lines 37-71, 153-225, 227-252: the three `gstack-issue-links
//     (bin)` describes (gh PATH shim e2e: --out/--json receipt shape,
//     ISSUE_LINKS: none, usage, closing-PR pagination, --no-auto-links,
//     ISSUE_LOOKUP_FAILED polarity, --ci-run refusal listing, app-viewer
//     author chain) — lane B owns bin/gstack861-issue-links.mjs and its
//     offline-subset test file.
// receiptIssues has no upstream pure-lib vector (its shape is asserted only
// through the bin's --out/--json output); it stays uncovered here rather
// than covered by invented vectors.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lineSources, mentionsIn, promotionCandidates, relatedPrs, renderIssueLines,
  resolveLinks, selectFlakes,
} from '../src/issue-links.mjs';

const BOT = { login: 'app/github-actions', is_bot: true };

// ---------------------------------------------------------------------------
// issue intent (pure) — upstream describe, lines 19-35
// ---------------------------------------------------------------------------

test('trailers carry closure; bare mentions, partial fixes, deferred asks and cross-repo ids are references', () => {
  const m = mentionsIn('fix: retry\n\nContext in #12. Partially fixes #13; deferring #17 to a follow-up.\nSee owner/other#9.\n\nFixes #14\nCloses: #15\nResolves GH-18\n');
  assert.deepEqual(m.map(x => [x.repo ? `${x.repo}#${x.issue}` : `#${x.issue}`, x.intent]), [
    ['#12', 'refs'], ['#13', 'refs'], ['#17', 'refs'], ['owner/other#9', 'refs'], ['#14', 'fixes'], ['#15', 'fixes'], ['#18', 'fixes'],
  ]);
  // non-trailer forms never close: the closure regex is line-anchored
  assert.deepEqual(mentionsIn('Fixes #14 and #15 together').map(x => x.intent), ['refs', 'refs']);
  assert.deepEqual(mentionsIn('v1.2.3 (#301) release notes').map(x => x.issue), [301]);
});

test('resolution: explicit --issue is closure, unreadable closure becomes Refs, a flake issue is never a plain Ref', () => {
  const links = resolveLinks(mentionsIn('Fixes #14\nFixes #15\nsee #40 and #16'), [16], n => n !== 15, [{ issue: 40, run: '7' }]);
  assert.deepEqual(links, { fixes: [14, 16], refs: [15], flakes: [{ issue: 40, run: '7' }], cross: [], unreadable: [15] });
  assert.deepEqual(renderIssueLines(links), ['Fixes #14', 'Fixes #16', 'Refs #15 (unreadable through gstack-issue-guard; not auto-closed)', 'Flake: #40 (run 7)']);
  assert.deepEqual(renderIssueLines(resolveLinks([], [], () => true)), []);
});

// ---------------------------------------------------------------------------
// promotion candidates (D1) — upstream describe, lines 76-93
// ---------------------------------------------------------------------------

test('a subject parenthetical is a Refs candidate the owner promotes with fix #N; a Fixes: trailer closes', () => {
  const subject = 'sync groups: a member after an uncommitted member is cancelled, never published ahead of it (#6252)\n\nContributor PR #6253 took the counting.\n';
  const mentions = mentionsIn(subject, 'commit a33b20ea8a');
  const links = resolveLinks(mentions, [], () => true);
  assert.deepEqual(renderIssueLines(links), ['Refs #6252', 'Refs #6253']);
  assert.deepEqual(promotionCandidates(mentions, links), [
    { issue: 6252, source: 'commit a33b20ea8a: sync groups: a member after an uncommitted member is cancelled, never published ahead of it (#6252)' },
    { issue: 6253, source: 'commit a33b20ea8a: Contributor PR #6253 took the counting.' },
  ]);
  const promoted = resolveLinks(mentions, [6252], () => true);
  assert.deepEqual(renderIssueLines(promoted), ['Fixes #6252', 'Refs #6253']);
  assert.deepEqual(promotionCandidates(mentions, promoted).map(c => c.issue), [6253]);
  assert.deepEqual(renderIssueLines(resolveLinks(mentionsIn(`${subject}\nFixes: #6252\n`), [], () => true)), ['Fixes #6252', 'Refs #6253']);
  const unreadable = resolveLinks(mentionsIn('Fixes #9'), [], () => false);
  assert.deepEqual(promotionCandidates(mentionsIn('Fixes #9'), unreadable), []);
});

// ---------------------------------------------------------------------------
// flake issues (D3) — upstream describe, lines 95-124
// ---------------------------------------------------------------------------

const flakeJson = (run, file, test) =>
  `failed on master\n\n<!-- flake:json -->\n\`\`\`json\n${JSON.stringify({ schema: 'flake/v1', file, test, first_seen: { run_id: run } }, null, 2)}\n\`\`\`\n`;

test('keeps only qualifying issues and says why each other one was refused', () => {
  const repo = 'garrytan/gbrain';
  const rows = [
    { number: 6304, title: 'Flake: test/bounded-child-exec.test.ts › keeps stdout', author: BOT, body: flakeJson(37769719459, 'test/bounded-child-exec.test.ts', 'keeps stdout') },
    { number: 6310, title: 'CI is red again', author: { login: 'andreineacsu', is_bot: false }, body: 'see https://github.com/garrytan/gbrain/actions/runs/37769719459' },
    { number: 6311, title: 'Flake: test/a.test.ts', author: { login: 'github-actions[bot]' }, body: 'first seen https://github.com/other/fork/actions/runs/37769719459' },
    { number: 6312, title: 'nightly summary', author: BOT, body: 'run https://github.com/garrytan/gbrain/actions/runs/37769719459' },
    { number: 6313, title: 'Flake: test/b.test.ts', author: BOT, body: 'run https://github.com/garrytan/gbrain/actions/runs/377697194590' },
    { number: 6490, title: 'Flake: test/write-gate-perf.slow.test.ts › p95', author: BOT, body: flakeJson(37769719459, 'test/write-gate-perf.slow.test.ts', 'p95') },
    { number: 6570, title: 'Flake: test/write-gate-perf.slow.test.ts › p95', author: BOT, body: flakeJson(37769719459, 'test/write-gate-perf.slow.test.ts', 'p95') },
    { number: 6600, title: 'Flake: test/c.test.ts', author: { login: 'app/capy-ai', is_bot: true }, body: 'Failed in https://github.com/GarryTan/GBrain/actions/runs/37769719459.' },
  ];
  const picked = selectFlakes('37769719459', repo, [...rows].reverse());
  assert.deepEqual(picked.flakes, [
    { issue: 6304, run: '37769719459', test: 'test/bounded-child-exec.test.ts › keeps stdout' },
    { issue: 6490, run: '37769719459', test: 'test/write-gate-perf.slow.test.ts › p95' },
    { issue: 6600, run: '37769719459', test: 'test/c.test.ts' },
  ]);
  assert.deepEqual(picked.rejected, [
    { issue: 6310, reason: 'opened by @andreineacsu, not a bot' },
    { issue: 6311, reason: 'names run 37769719459 of other/fork, not garrytan/gbrain' },
    { issue: 6312, reason: 'names no test (no flake:json file, no "Flake: <test>" title)' },
    { issue: 6313, reason: 'does not name run 37769719459 of garrytan/gbrain' },
    { issue: 6570, reason: 'duplicate of #6490 (test/write-gate-perf.slow.test.ts › p95)' },
  ]);
  assert.deepEqual(selectFlakes('1', repo, [{ number: 1, title: 'Flake: x', author: BOT, body: '<!-- flake:json -->\n```json\n{not json\n```' }]).rejected, [{ issue: 1, reason: 'does not name run 1 of garrytan/gbrain' }]);
});

// ---------------------------------------------------------------------------
// related PRs (D2) — upstream describe, lines 126-151
// ---------------------------------------------------------------------------

test('open PRs by other authors closing a fixed issue are Related; own, own-branch and closed PRs are not; Supersedes and credit only when confirmed', () => {
  const pr = (number, login, extra = {}) => ({ number, state: 'OPEN', headRefName: `b${number}`, author: { login }, repository: { nameWithOwner: 'garrytan/gbrain' }, ...extra });
  const closing = new Map([
    [6252, [pr(6253, 'andreineacsu'), pr(6279, 'garrytan'), pr(6290, 'someone', { headRefName: 'feature' }), pr(6291, 'x', { state: 'CLOSED' }), pr(12, 'forker', { repository: { nameWithOwner: 'forker/gbrain' } })]],
    [6275, [pr(6253, 'andreineacsu'), pr(6299, 'other', { author: null })]],
  ]);
  const related = relatedPrs(closing, { repo: 'GarryTan/gbrain', viewer: 'GarryTan', branch: 'feature' });
  assert.deepEqual(related, [
    { pr: 6253, author: 'andreineacsu', closes: [6252, 6275] },
    { pr: 6299, author: 'ghost', closes: [6275] },
    { pr: 12, repo: 'forker/gbrain', author: 'forker', closes: [6252] },
  ]);
  const links = resolveLinks(mentionsIn('Fixes #6252\nFixes #6275'), [], () => true, [], related);
  assert.deepEqual(renderIssueLines(links), ['Fixes #6252', 'Fixes #6275', 'Related: #6253 (@andreineacsu)', 'Related: #6299 (@ghost)', 'Related: forker/gbrain#12 (@forker)']);
  related[0].supersedes = true;
  related[0].credit = true;
  assert.deepEqual(renderIssueLines(links).slice(2, 4), ['Supersedes #6253', 'Contributed by @andreineacsu']);
  assert.deepEqual(lineSources(links).slice(0, 2), [
    'Supersedes #6253 ← open PR closing #6252, #6275 by @andreineacsu; owner confirmed --supersedes',
    'Contributed by @andreineacsu ← #6253, open PR closing #6252, #6275; owner confirmed --credit',
  ]);
  assert.equal('related' in resolveLinks([], [], () => true, [], []), false);
});
