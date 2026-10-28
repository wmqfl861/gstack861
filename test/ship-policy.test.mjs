// ship-policy — direct pins for the three shared helpers lifted into
// src/ship-policy.mjs (batch 23, Lane A). Small on purpose: the deep
// behavioral coverage of these helpers already lives in
// test/banned-terms.test.mjs (29 tests, the b20 port whose inlined copies
// were lifted) — the "glob semantics" and "validate glob containment
// matrix" tests there drive the same code through the CLI.
//
// Upstream lineage: gstack lib/ship-policy.ts lines 191-227 at pinned
// submodule commit 5755601dac5d35ebd7dde181fdefe52a023c73d9, via the b20
// port's divergence-4 platform-stable containedRelative (see the module's
// ledger).

import test from 'node:test';
import assert from 'node:assert/strict';
import { containedRelative, globToRegExp, matchesAny } from '../src/ship-policy.mjs';

test('containedRelative accepts repo-relative paths and globs', () => {
  for (const ok of ['a.md', 'docs/a.md', 'docs/**/*.tmp', 'v1.2.txt', 'heldout/**', 'runs/**/transcript*.jsonl']) {
    assert.equal(containedRelative(ok), null, ok);
  }
});

test('containedRelative rejects containment violations (platform-stable absoluteness, ledger 1)', () => {
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
    ['a\rb', 'contains a control character'],
  ];
  for (const [p, why] of cases) assert.equal(containedRelative(p), why, JSON.stringify(p));
  assert.equal(containedRelative(42), 'must be a non-empty string');
});

test('globToRegExp: ** spans directories, * and ? stay in one segment, dots are literal', () => {
  // compared as .source against literal regexes: both sides get the same escaping
  assert.equal(globToRegExp('**/*.md').source, /^(?:.*\/)?[^/]*\.md$/.source);
  assert.equal(globToRegExp('docs/**').source, /^docs\/.*$/.source);
  assert.equal(globToRegExp('docs/?.md').source, /^docs\/[^/]\.md$/.source);
  assert.equal(globToRegExp('v1.2.txt').source, /^v1\.2\.txt$/.source);
  // anchored: a bare name never matches a nested path
  assert.ok(!globToRegExp('a.md').test('x/a.md'));
  assert.ok(globToRegExp('**/*.md').test('a/b/c.md'));
});

test('globToRegExp throws when the expansion passes the 512-character cap', () => {
  assert.throws(() => globToRegExp('**/'.repeat(80)), /pattern expands past 512 characters/);
});

test('matchesAny normalizes separators and a ./ prefix before matching', () => {
  assert.equal(matchesAny(['docs/**'], 'docs/a.md'), true);
  assert.equal(matchesAny(['docs/**'], 'docs\\sub\\a.md'), true); // win32 separators
  assert.equal(matchesAny(['docs/**'], './docs/a.md'), true);
  assert.equal(matchesAny(['docs/**'], 'src/a.md'), false);
  assert.equal(matchesAny(['**/*.jsonl'], 'runs/c1/transcript.jsonl'), true);
  assert.equal(matchesAny([], 'anything/at/all'), false);
});
