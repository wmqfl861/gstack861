import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, digest } from '../src/json.mjs';
test('canonical digest ignores object key ordering but preserves values and array order', () => {
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
  assert.notEqual(digest([1, 2]), digest([2, 1]));
});
test('non-JSON values, cycles, holes and excessive depth are rejected', () => {
  const cycle = {}; cycle.self = cycle;
  let deep = {}; for (let i = 0; i < 70; i++) deep = { deep };
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), () => {}, cycle, new Array(2), deep]) assert.throws(() => canonical(value));
});
