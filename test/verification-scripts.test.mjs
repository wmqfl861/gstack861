// Batch 17 lane B: three-way consistency — docs/VERIFICATION-SCRIPTS.md table ↔ the
// scripts/ directory ↔ `bin/gstack861.mjs doctor` `verticals` output — plus the runner
// contract for scripts/verify-offline.mjs and the two keyless unit pins that had no pin
// anywhere before this batch (verify-dsh-guard, verify-dsh-vertical).
//
// CROSS-LANE NOTE (plan 审计划必改落实 item 3): the two doctor↔table tests read Lane A's
// `verticals` output, which does not exist on b17b-lane — they are RED in this lane BY
// DESIGN and are 'green only after b17a-lane merge'; the merged-tree review reruns this
// file as the merge gate. Everything else here must be green in-lane.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(repoRoot, 'docs', 'VERIFICATION-SCRIPTS.md');

/**
 * Table rows of docs/VERIFICATION-SCRIPTS.md: lines starting with '| scripts/', split
 * into trimmed cells. Layout pinned (7 columns => split length 9: ['', 脚本, 目的, 密钥,
 * CI 可跑, 运行方式, 状态, 证据, '']). Sample pinned below so a hand-edit that adds a
 * column or a '|' inside a cell turns this red instead of silently misparsing.
 */
function tableRows() {
  const rows = fs.readFileSync(DOC, 'utf8').split(/\r?\n/)
    .filter(line => line.startsWith('| scripts/'))
    .map(line => line.split('|').map(cell => cell.trim()));
  assert.ok(rows.length >= 10, `expected >=10 '| scripts/' rows, parsed ${rows.length}`);
  for (const row of rows) assert.equal(row.length, 9, `row must have exactly 7 columns: ${row[1]}`);
  // Format sample (plan 风险与对策: pin one row's shape): first row is the 8dot3 probe,
  // keyless, manual-only, evidenced against VERIFICATION.md.
  const sample = rows[0];
  assert.equal(sample[1], 'scripts/verify-8dot3.mjs');
  assert.equal(sample[3], '密钥无');
  assert.match(sample[4], /manual/);
  assert.equal(sample[7], 'docs/VERIFICATION.md');
  return rows;
}

/** Bare script names ('verify-dsh-guard') — the doctor verticals key form. */
const bare = row => row[1].slice('scripts/'.length, -'.mjs'.length);

/** One doctor invocation, parsed. Keyless env so a stray exported key cannot matter. */
function doctor() {
  const env = { ...process.env, DEEPSEEK_API_KEY: '' };
  const child = spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'gstack861.mjs'), 'doctor'],
    { encoding: 'utf8', timeout: 60000, env, cwd: repoRoot });
  assert.equal(child.status, 0, `doctor exited ${child.status}: ${child.stderr}`);
  return JSON.parse(child.stdout);
}

test('table↔fs bijection: every table script exists and no scripts/{verify,dsh,zcode}-*.mjs is missing from the table', () => {
  const table = [...new Set(tableRows().map(row => row[1]))].sort();
  const onDisk = fs.readdirSync(path.join(repoRoot, 'scripts'))
    .filter(name => /^(verify|dsh|zcode)-.*\.mjs$/.test(name))
    // scripts/verify-offline.mjs is THIS batch's unified runner — the orchestrator of the
    // family, not a verification target, so it is not a table row and not a doctor vertical.
    .filter(name => name !== 'verify-offline.mjs')
    .map(name => `scripts/${name}`)
    .sort();
  assert.deepEqual(table, onDisk, 'no orphans (table rows without a script) and no ghosts (scripts without a table row)');
  assert.equal(table.length, 12); // batch 25 zcode-acceptance + batch 29 dsh-keyed-consumption
});

test('evidence existence: every table row names a repo-relative evidence file that exists on disk', () => {
  for (const row of tableRows()) {
    assert.match(row[7], /^docs\//, `${row[1]}: evidence cell must be a repo-relative docs/ path`);
    assert.ok(fs.existsSync(path.join(repoRoot, row[7])), `${row[1]} -> ${row[7]}: evidence file missing`);
  }
});

// green only after b17a-lane merge — RED on b17b-lane by design (doctor `verticals` is
// Lane A's output; plan required-change 3 makes the cross-lane merge gate explicit).
test('doctor↔table: doctor verticals keys equal the table script-name set', () => {
  const out = doctor();
  assert.ok(out.verticals, 'doctor must expose a `verticals` object — green only after b17a-lane merge (plan 审计划必改落实 3)');
  assert.deepEqual(Object.keys(out.verticals).sort(), tableRows().map(bare).sort(),
    'the doctor verticals key set and the table script column must match exactly');
});

// green only after b17a-lane merge — RED on b17b-lane by design (same cross-lane reason).
test('keyed consistency: the table 密钥 column equals doctor verticals[name].keyed for every row', () => {
  const out = doctor();
  assert.ok(out.verticals, 'doctor must expose a `verticals` object — green only after b17a-lane merge (plan 审计划必改落实 3)');
  for (const row of tableRows()) {
    const name = bare(row);
    assert.ok(out.verticals[name], `doctor verticals is missing ${name}`);
    assert.equal(row[3].includes('需'), out.verticals[name].keyed,
      `${name}: table 密钥 column (${row[3]}) and doctor keyed boolean disagree`);
  }
});

test('runner contract: scripts/verify-offline.mjs exits 0 with the key stripped (~7s)', () => {
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;
  const child = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'verify-offline.mjs')],
    { encoding: 'utf8', timeout: 120000, env, cwd: repoRoot });
  assert.equal(child.status, 0, `runner exited ${child.status}\n--- stdout ---\n${child.stdout}\n--- stderr ---\n${child.stderr}`);
  assert.match(child.stdout, /RESULT: PASS/);
}, { timeout: 120000 });

test('keyless unit pins: verify-dsh-guard and verify-dsh-vertical exit 2 (BLOCKED) with an explicitly empty key', () => {
  // These two keyed scripts had NO keyless pin anywhere before batch 17 (the batch-13/14/16
  // scripts are pinned in their own test files) — unit pins, not runner re-runs.
  for (const script of ['verify-dsh-guard.mjs', 'verify-dsh-vertical.mjs']) {
    const child = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', script)],
      { encoding: 'utf8', timeout: 60000, env: { ...process.env, DEEPSEEK_API_KEY: '' }, cwd: repoRoot });
    assert.equal(child.status, 2, `${script} must exit 2 without the key`);
    assert.match(child.stdout, /BLOCKED/, `${script} must print a BLOCKED line`);
  }
}, { timeout: 120000 });
