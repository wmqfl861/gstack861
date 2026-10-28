// Upstream lineage: gstack test/redact-unicode-offsets.test.ts @
// upstream.lock.json commit 5755601dac5d35ebd7dde181fdefe52a023c73d9.
// Syntax-only adaptation bun:test → node:test; assertion values untouched,
// EXCEPT (plan 审计划必改落实 item 2):
//  - the `redact` / `sanitizeForJson` assertions from lib/cso/process are
//    dropped here (随 cso 批次回填 — that module is not ported in this repo yet).
//  - the tail test spawning the real bin/gstack-redact CLI via Bun.spawnSync is
//    dropped (回填于 lane C — the CLI is Lane C of this batch).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRedactions, normalizeWithMap, redactFindingSpans, scan } from '../src/redact-engine.mjs';
// 随 cso 批次回填：上游此处 import { redact, sanitizeForJson } from "../lib/cso/process"
// （各 1-2 条断言随 cso 批次一并回填）。

const secret = ['8Fk2pQ9vXz4wL7mN', '3rT6yB1cD5eG0hJq'].join('');

describe('normalized redaction offsets use UTF-16 units', () => {
  test('every BMP input maps every emitted UTF-16 unit and the end sentinel', () => {
    const mismatches = [];
    for (let code = 0; code <= 0xffff; code++) {
      const { normalized, map } = normalizeWithMap(String.fromCharCode(code));
      if (map.length !== normalized.length + 1
        || map[normalized.length] !== 1
        || map.slice(0, -1).some((offset) => offset !== 0)) {
        mismatches.push(code);
      }
    }
    assert.deepEqual(mismatches, []);
  });

  for (const count of [0, 1, 64]) {
    test(`${count} supplementary NFKC expansions preserve the exact credential span`, () => {
      const prefix = '\uFA6C'.repeat(count) + '\n';
      const suffix = '\n' + 'z'.repeat(256);
      const input = `${prefix}DB_PASSWORD=${secret}${suffix}`;
      const expected = `${prefix}DB_PASSWORD=<REDACTED-env.kv>${suffix}`;
      assert.equal(redactFindingSpans(input), expected);
      assert.deepEqual(scan(input).findings.map(({ id, line, col }) => ({ id, line, col })),
        [{ id: 'env.kv', line: 2, col: 13 }]);
      // 随 cso 批次回填：上游另有
      //   expect(redact(input)).toBe(expected);
      //   expect(sanitizeForJson({ output: input })).toEqual({ output: expected });
      // 两条 lib/cso/process 断言。
    });
  }

  test('supplementary source text, entities, and zero-width input retain their original bytes', () => {
    const prefix = '\u{242EE} &amp; \u200b\n';
    const value = `${secret.slice(0, 9)}\u200b${secret.slice(9)}`;
    const input = `${prefix}DB_PASSWORD=${value}\r\nend`;
    const { normalized, map } = normalizeWithMap(input);
    assert.equal(map.length, normalized.length + 1);
    assert.equal(map[normalized.length], input.length);
    assert.equal(redactFindingSpans(input), `${prefix}DB_PASSWORD=<REDACTED-env.kv>\r\nend`);
  });

  for (const suffix of ['', ' after']) {
    test(`both masking APIs preserve exact email boundaries with suffix ${JSON.stringify(suffix)}`, () => {
      const prefix = '\uFA6C contact: ';
      const input = prefix + 'reviewer@audit.invalid' + suffix;
      assert.equal(redactFindingSpans(input), prefix + '<REDACTED-pii.email>' + suffix);
      const result = applyRedactions(input, ['pii.email']);
      assert.equal(result.body, prefix + '<REDACTED-EMAIL>' + suffix);
      assert.deepEqual(result.skipped, []);
    });
  }

  // 回填于 lane C：上游尾部用 Bun.spawnSync 真实运行
  // `bin/gstack-redact --auto-redact pii.email`（spawn 真 bin），验证
  // 补充平面展开后 EOF 处 email 的自动脱敏 —— CLI 属 Lane C
  // (bin/gstack861-redact.mjs + test/redact-cli.test.mjs)。
});
