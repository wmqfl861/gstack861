// ReDoS guard (T10) — fails CI if any taxonomy pattern has a catastrophic-
// backtracking shape, and asserts the engine's oversize-input path fails CLOSED.
//
// We do two things:
//   1. Static lint: reject nested unbounded quantifiers like (a+)+ / (a*)* /
//      (a+)* in any pattern source. These are the classic ReDoS forms.
//   2. Runtime budget: run every pattern against a pathological input and assert
//      no single pattern takes more than a generous wall-clock budget. This
//      catches catastrophic forms the static check might miss.
//
// Upstream lineage: gstack test/redact-pattern-lint.test.ts @
// upstream.lock.json commit 5755601dac5d35ebd7dde181fdefe52a023c73d9.
// Syntax-only adaptation bun:test → node:test; assertion values untouched
// (performance.now() is a Node global).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PATTERNS } from '../src/redact-patterns.mjs';
import { scan } from '../src/redact-engine.mjs';

// Nested-quantifier ReDoS shapes: a group ending in +/*/{n,} that is itself
// immediately quantified by +/*/{n,}. e.g. (x+)+  (x*)*  (x+)*  (?:x+){2,}
const NESTED_QUANTIFIER = /\([^)]*[+*]\)[+*]|\([^)]*[+*]\)\{\d+,?\}|\([^)]*\{\d+,\}\)[+*]/;

describe('pattern lint — no catastrophic backtracking', () => {
  for (const p of PATTERNS) {
    test(`${p.id} has no nested unbounded quantifier`, () => {
      assert.equal(NESTED_QUANTIFIER.test(p.regex.source), false);
    });
  }

  test('a planted catastrophic pattern WOULD be caught by the linter', () => {
    // meta-test: prove the linter actually detects the bad shape
    assert.equal(NESTED_QUANTIFIER.test('(a+)+'), true);
    assert.equal(NESTED_QUANTIFIER.test('(\\d*)*'), true);
  });
});

describe('runtime budget — pathological inputs do not hang', () => {
  // Inputs designed to stress backtracking on the real patterns.
  const adversarial = [
    'a'.repeat(5000) + '!',
    'AKIA' + 'A'.repeat(5000),
    'eyJ' + 'a'.repeat(2000) + '.' + 'b'.repeat(2000),
    'x@' + 'a'.repeat(3000),
    '/Users/' + 'a'.repeat(4000),
    ('1'.repeat(19) + ' ').repeat(200),
  ];

  for (const [i, input] of adversarial.entries()) {
    test(`adversarial input #${i} scans within budget`, () => {
      const start = performance.now();
      scan(input, { repoVisibility: 'private', maxBytes: 1024 * 1024 });
      const elapsed = performance.now() - start;
      // Generous: full taxonomy over a 5KB pathological string should be well
      // under 1s on any CI box. A catastrophic pattern would blow past this.
      assert.ok(elapsed < 1000);
    });
  }
});

describe('oversize fails closed (the real ReDoS backstop)', () => {
  test('input over cap returns blocking HIGH, never runs the patterns', () => {
    const r = scan('a'.repeat(50_000), { maxBytes: 10_000 });
    assert.equal(r.oversize, true);
    assert.equal(r.counts.HIGH, 1);
    assert.equal(r.findings[0].id, 'engine.input_too_large');
  });
});
