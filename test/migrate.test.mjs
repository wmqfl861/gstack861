import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { migrateStateFiles } from '../src/migrate.mjs';
import { TaskStore } from '../src/tasks.mjs';
import { ApprovalStore } from '../src/approvals.mjs';
import { fixture } from './helpers.mjs';
const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/gstack861.mjs', import.meta.url));
const uuid = n => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const state = (f, name = 'state') => { const dir = path.join(f.base, name); fs.mkdirSync(dir, { mode: 0o700 }); return dir; };
const put = (dir, name, bytes) => { const file = path.join(dir, name); fs.writeFileSync(file, bytes, { mode: 0o600 }); return file; };
const dirSnapshot = dir => fs.readdirSync(dir).sort().map(name => ({ name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs }));
// 0.3.0 shapes, hand-written byte-exact (field order and trailing newline included).
const TASK_ID = '11111111-2222-4333-8444-555555555555';
const APPROVAL_ID = '66666666-7777-4888-9aaa-bbbbbbbbbbbb';
const TASK_BYTES = JSON.stringify({ schemaVersion: 1, id: TASK_ID, subjectHash: 'ab'.repeat(32), state: 'completed', attempts: 1, createdAt: 5, updatedAt: 6 }) + '\n';
const APPROVAL_BYTES = JSON.stringify({ schemaVersion: 1, id: APPROVAL_ID, subjectHash: 'ab'.repeat(32), state: 'consumed', issuedAt: 5, expiresAt: 6 }) + '\n';
const taskRecord = (id, over = {}) => JSON.stringify({ schemaVersion: 1, id, subjectHash: 'ab'.repeat(32), state: 'planned', attempts: 1, createdAt: 5, updatedAt: 6, ...over }) + '\n';
const approvalRecord = id => JSON.stringify({ schemaVersion: 1, id, subjectHash: 'ab'.repeat(32), state: 'consumed', issuedAt: 5, expiresAt: 6 }) + '\n';

test('0.3.0 unprefixed records dry-run as would-migrate, then rename byte-exact into readable stores', t => {
  const f = fixture(t), dir = state(f);
  put(dir, `${TASK_ID}.json`, TASK_BYTES);
  put(dir, `${APPROVAL_ID}.json`, APPROVAL_BYTES);
  const before = dirSnapshot(dir), lines = [];
  // Dry run: every check runs, zero writes.
  const planned = migrateStateFiles({ stateDir: dir, dryRun: true, log: line => lines.push(line) });
  assert.deepEqual(planned, { migrated: [{ file: `${TASK_ID}.json`, kind: 'task' }, { file: `${APPROVAL_ID}.json`, kind: 'approval' }], refused: [], pendingCount: 2 });
  assert.deepEqual(dirSnapshot(dir), before, 'dry run leaves names and mtimes untouched');
  assert.equal(lines.length, 2, 'the operator log reports each candidate once');
  // Real run: rename-only — bytes and mode preserved.
  const done = migrateStateFiles({ stateDir: dir });
  assert.deepEqual(done, { migrated: [{ file: `${TASK_ID}.json`, kind: 'task' }, { file: `${APPROVAL_ID}.json`, kind: 'approval' }], refused: [], pendingCount: 0 });
  assert.equal(fs.existsSync(path.join(dir, `${TASK_ID}.json`)), false);
  assert.equal(fs.existsSync(path.join(dir, `${APPROVAL_ID}.json`)), false);
  assert.deepEqual(fs.readFileSync(path.join(dir, `task-${TASK_ID}.json`)), Buffer.from(TASK_BYTES));
  assert.deepEqual(fs.readFileSync(path.join(dir, `approval-${APPROVAL_ID}.json`)), Buffer.from(APPROVAL_BYTES));
  // End-to-end proof the documented equivalent-loss is closed: current stores read the records.
  assert.deepEqual(new TaskStore(dir).get(TASK_ID), JSON.parse(TASK_BYTES));
  assert.deepEqual(new ApprovalStore(dir).get(APPROVAL_ID), JSON.parse(APPROVAL_BYTES));
});
test('refusal matrix: unsafe and ambiguous records are refused untouched while others migrate', t => {
  const f = fixture(t), dir = state(f);
  const both = uuid(1), neither = uuid(2), broken = uuid(3), foreign = uuid(4), collision = uuid(5), huge = uuid(6), good = uuid(7);
  const files = {
    [`${both}.json`]: taskRecord(both, { expiresAt: 6 }), // both keys present: never guess
    [`${neither}.json`]: JSON.stringify({ schemaVersion: 1, id: neither, subjectHash: 'ab'.repeat(32), state: 'planned', createdAt: 5, updatedAt: 6 }) + '\n',
    [`${broken}.json`]: '{"schemaVersion":1,"id":',
    [`${foreign}.json`]: taskRecord('99999999-9999-4999-8999-999999999999'),
    [`${collision}.json`]: taskRecord(collision),
    [`${huge}.json`]: taskRecord(huge, { padding: 'x'.repeat(5 * 1024) }),
    [`${good}.json`]: taskRecord(good),
  };
  for (const [name, bytes] of Object.entries(files)) put(dir, name, bytes);
  put(dir, `task-${collision}.json`, taskRecord(collision)); // destination already taken
  const report = migrateStateFiles({ stateDir: dir });
  assert.deepEqual(report.migrated, [{ file: `${good}.json`, kind: 'task' }]);
  assert.deepEqual(new Map(report.refused.map(r => [r.file, r.reason])), new Map([
    [`${both}.json`, 'AMBIGUOUS_RECORD'],
    [`${neither}.json`, 'AMBIGUOUS_RECORD'],
    [`${broken}.json`, 'MALFORMED_RECORD'],
    [`${foreign}.json`, 'ID_MISMATCH'],
    [`${collision}.json`, 'DESTINATION_EXISTS'],
    [`${huge}.json`, 'UNSAFE_RECORD_FILE'],
  ]));
  assert.equal(report.pendingCount, 6, 'a real run counts the refused remainder');
  for (const [name, bytes] of Object.entries(files)) {
    if (name === `${good}.json`) continue;
    assert.deepEqual(fs.readFileSync(path.join(dir, name)), Buffer.from(bytes), `${name} must stay untouched`);
  }
  assert.equal(fs.existsSync(path.join(dir, `task-${good}.json`)), true);
});
test('a symlinked record is refused as UNSAFE_RECORD_FILE', t => {
  if (process.platform === 'win32') return t.skip('POSIX only (symlink creation is not portable)');
  const f = fixture(t), dir = state(f), id = uuid(8);
  const target = put(f.base, 'symlink-target.json', taskRecord(id));
  fs.symlinkSync(target, path.join(dir, `${id}.json`));
  const alias = path.join(f.base, 'alias-state');
  fs.symlinkSync(dir, alias);
  assert.deepEqual(migrateStateFiles({ stateDir: dir }), { migrated: [], refused: [{ file: `${id}.json`, reason: 'UNSAFE_RECORD_FILE' }], pendingCount: 1 });
  assert.throws(() => migrateStateFiles({ stateDir: alias }), /UNSAFE_STATE_DIRECTORY/);
  assert.equal(fs.existsSync(path.join(dir, `${id}.json`)), true, 'the link itself is untouched');
});
test('mixed directory: only unprefixed <uuid>.json are candidates; prefixed and foreign names untouched', t => {
  const f = fixture(t), dir = state(f), mover = uuid(9), parkedTask = uuid(10), parkedApproval = uuid(11);
  const taskOwned = put(dir, `task-${parkedTask}.json`, taskRecord(parkedTask));
  const approvalOwned = put(dir, `approval-${parkedApproval}.json`, approvalRecord(parkedApproval));
  const foreignFile = put(dir, 'foreign.txt', 'not a record');
  const garbage = put(dir, 'garbage.json', '{}');
  const markdown = put(dir, `${uuid(12)}.md`, taskRecord(uuid(12)));
  put(dir, `${mover}.json`, taskRecord(mover));
  assert.deepEqual(migrateStateFiles({ stateDir: dir }), { migrated: [{ file: `${mover}.json`, kind: 'task' }], refused: [], pendingCount: 0 });
  assert.equal(fs.readFileSync(taskOwned, 'utf8'), taskRecord(parkedTask));
  assert.equal(fs.readFileSync(approvalOwned, 'utf8'), approvalRecord(parkedApproval));
  assert.equal(fs.readFileSync(foreignFile, 'utf8'), 'not a record');
  assert.equal(fs.readFileSync(garbage, 'utf8'), '{}');
  assert.equal(fs.readFileSync(markdown, 'utf8'), taskRecord(uuid(12)));
});
test('pendingCount is the would-migrate count when dry-running and the refused remainder when migrating', t => {
  const f = fixture(t), dir = state(f);
  put(dir, `${uuid(13)}.json`, taskRecord(uuid(13)));
  put(dir, `${uuid(14)}.json`, taskRecord(uuid(14)));
  put(dir, `${uuid(15)}.json`, taskRecord(uuid(15), { expiresAt: 6 }));
  const planned = migrateStateFiles({ stateDir: dir, dryRun: true });
  assert.equal(planned.migrated.length, 2);
  assert.equal(planned.refused.length, 1);
  assert.equal(planned.pendingCount, 2, 'dry run reports what WOULD migrate');
  assert.equal(migrateStateFiles({ stateDir: dir }).pendingCount, 1, 'real run reports what still needs an operator');
});
test('stateDir must be an absolute, existing directory and is never created by the tool', t => {
  const f = fixture(t);
  assert.throws(() => migrateStateFiles({ stateDir: 'relative-state' }), /ABSOLUTE_STATE_PATH_REQUIRED/);
  const missing = path.join(f.base, 'never-created');
  assert.throws(() => migrateStateFiles({ stateDir: missing }), /UNSAFE_STATE_DIRECTORY/);
  assert.equal(fs.existsSync(missing), false, 'a typo must not be papered over by mkdir');
});
test('CLI: a relative --state exits nonzero without creating any directory', async t => {
  const f = fixture(t);
  await assert.rejects(execute(process.execPath, [cli, 'migrate-state', '--state', 'relative-state'], { cwd: f.base }),
    error => error.code === 1 && /ABSOLUTE_PATH_REQUIRED/.test(error.stderr));
  assert.equal(fs.existsSync(path.join(f.base, 'relative-state')), false);
});
test('CLI: dry run writes nothing, a real run migrates, and a clean rerun is a no-op', async t => {
  const f = fixture(t), dir = state(f);
  put(dir, `${TASK_ID}.json`, TASK_BYTES);
  put(dir, `${APPROVAL_ID}.json`, APPROVAL_BYTES);
  const before = dirSnapshot(dir);
  const planned = JSON.parse((await execute(process.execPath, [cli, 'migrate-state', '--state', dir, '--dry-run'])).stdout);
  assert.deepEqual(planned, { migrated: [{ file: `${TASK_ID}.json`, kind: 'task' }, { file: `${APPROVAL_ID}.json`, kind: 'approval' }], refused: [], pendingCount: 2 });
  assert.deepEqual(dirSnapshot(dir), before, 'dry run leaves listing and mtimes untouched');
  const done = JSON.parse((await execute(process.execPath, [cli, 'migrate-state', '--state', dir])).stdout);
  assert.equal(done.pendingCount, 0);
  assert.equal(fs.existsSync(path.join(dir, `task-${TASK_ID}.json`)), true);
  assert.equal(fs.existsSync(path.join(dir, `approval-${APPROVAL_ID}.json`)), true);
  const idle = JSON.parse((await execute(process.execPath, [cli, 'migrate-state', '--state', dir])).stdout);
  assert.deepEqual(idle, { migrated: [], refused: [], pendingCount: 0 });
});
test('CLI: refused records flip the exit code to 1 while still printing the JSON report', async t => {
  const f = fixture(t), dir = state(f), id = uuid(16);
  put(dir, `${id}.json`, taskRecord(id, { expiresAt: 6 }));
  await assert.rejects(execute(process.execPath, [cli, 'migrate-state', '--state', dir]),
    error => error.code === 1 && JSON.parse(error.stdout).refused[0].reason === 'AMBIGUOUS_RECORD');
  assert.equal(fs.existsSync(path.join(dir, `${id}.json`)), true, 'the refused record stays in place');
});
test('CLI: an empty directory is exit 0 with nothing to do', async t => {
  const f = fixture(t), dir = state(f);
  const report = JSON.parse((await execute(process.execPath, [cli, 'migrate-state', '--state', dir])).stdout);
  assert.deepEqual(report, { migrated: [], refused: [], pendingCount: 0 });
});
