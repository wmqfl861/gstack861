// Upstream lineage: gstack test/redact-span-binding.test.ts @
// upstream.lock.json commit 5755601dac5d35ebd7dde181fdefe52a023c73d9.
// Syntax-only adaptation bun:test → node:test; assertion values untouched,
// EXCEPT (plan 审计划必改落实 item 2): the final test's two lib/cso/process
// assertions (redact + sanitizeForJson) are dropped — 随 cso 批次回填.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { redactFindingSpans, scan } from '../src/redact-engine.mjs';
// 随 cso 批次回填：上游此处 import { redact, sanitizeForJson } from "../lib/cso/process"。

const secret = ['8Fk2pQ9vXz4wL7mN', '3rT6yB1cD5eG0hJq'].join('');
const marker = '<REDACTED-env.kv>';

describe('redaction binds each finding to its original span', () => {
  test('never masks a later unflagged assignment instead of the flagged value', () => {
    const input = `DB_PASSWORD=${secret}\nOTHER_API_KEY="your-api-key-here"`;
    assert.deepEqual(scan(input).findings.map((f) => f.id), ['env.kv']);
    assert.equal(redactFindingSpans(input), `DB_PASSWORD=${marker}\nOTHER_API_KEY="your-api-key-here"`);
  });

  test('literal example values are suppressed before redaction', () => {
    const input = 'DB_PASSWORD=synthetic-example-secret\nOTHER_API_KEY="your-api-key-here"';
    assert.deepEqual(scan(input).findings, []);
    assert.equal(redactFindingSpans(input), input);
  });

  for (const [name, prefix, suffix] of [
    ['first line', '', ''],
    ['later line', 'unrelated line\n', '\nend'],
    ['indented', 'header\n    ', ''],
    ['CRLF', 'header\r\n', '\r\nend'],
  ]) {
    test(`${name}: masks the captured value and keeps surrounding text`, () => {
      const input = `${prefix}DB_PASSWORD=${secret}${suffix}`;
      assert.deepEqual(scan(input).findings.map((f) => f.id), ['env.kv']);
      assert.equal(redactFindingSpans(input), `${prefix}DB_PASSWORD=${marker}${suffix}`);
    });
  }

  test('repeated identical values map independently, preserving unflagged neighbors', () => {
    const input = `DB_PASSWORD=${secret}\nOTHER_API_KEY="your-api-key-here"\nAPI_KEY=${secret}`;
    assert.deepEqual(scan(input).findings.map((f) => f.id), ['env.kv', 'env.kv']);
    assert.equal(redactFindingSpans(input), `DB_PASSWORD=${marker}\nOTHER_API_KEY="your-api-key-here"\nAPI_KEY=${marker}`);
  });

  test('many findings retain exact order without per-finding raw rescans', () => {
    const input = Array.from({ length: 300 }, (_, i) => `API_KEY=${secret}${i.toString(36)}`).join('\n');
    const output = redactFindingSpans(input);
    assert.equal(scan(input).findings.length, 300);
    assert.equal(output, Array.from({ length: 300 }, () => `API_KEY=${marker}`).join('\n'));
  });

  test('normalization maps fullwidth Unicode, entity text, and zero-width bytes back to original span', () => {
    const encoded = `${secret.slice(0, 9)}＆${secret.slice(9)}`;
    const entity = `${secret.slice(0, 9)}&amp;${secret.slice(9)}`;
    const invisible = `${secret.slice(0, 9)}\u200b${secret.slice(9)}`;
    for (const value of [encoded, entity, invisible]) {
      const input = `DB_PASSWORD=${value}\nOTHER_API_KEY="your-api-key-here"`;
      assert.deepEqual(scan(input).findings.map((f) => f.id), ['env.kv']);
      assert.equal(redactFindingSpans(input), `DB_PASSWORD=${marker}\nOTHER_API_KEY="your-api-key-here"`);
    }
  });

  test('overlapping JWT and Bearer findings coalesce; marker-only and unlocated oversize finding still withhold', () => {
    const part = 'Ab3dE6fGh8Ij9Kl0Mn1O';
    const jwt = `eyJ${part}.eyJ${part}.${part}`;
    assert.deepEqual(scan(`Authorization: Bearer ${jwt}`).findings.map((f) => f.id), ['auth.bearer', 'jwt']);
    assert.match(redactFindingSpans(`Authorization: Bearer ${jwt}`), /^Authorization: Bearer <REDACTED-[a-z.+]+>$/);
    assert.equal(redactFindingSpans('-----BEGIN ' + 'PRIVATE KEY-----\nbody'), null);
    assert.equal(redactFindingSpans(`DB_PASSWORD=${secret}`, { maxBytes: 10 }), null);
  });

  // 随 cso 批次回填：上游尾部测试 "CSO process and JSON output use the exact
  // span, without dropping safe context" 的两条断言
  //   expect(redact(input)).toBe(`DB_PASSWORD=${marker}\nOTHER_API_KEY="your-api-key-here"`);
  //   expect(sanitizeForJson({ output: input })).toEqual({ output: `DB_PASSWORD=${marker}\nOTHER_API_KEY="your-api-key-here"` });
  // 依赖 lib/cso/process（未移植），随 cso 批次一并回填。
});
