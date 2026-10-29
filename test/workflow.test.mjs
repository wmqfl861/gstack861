import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TaskStore } from '../src/tasks.mjs';
import { ApprovalStore } from '../src/approvals.mjs';
import { cancelWorkflow } from '../src/workflow.mjs';
import { fixture } from './helpers.mjs';
const cli = fileURLToPath(new URL('../bin/gstack861.mjs', import.meta.url));
const subject = f => ({ host: 'zcode', runId: 'r1', sessionId: 's1', policyHash: f.policy.policyHash, action: { kind: 'publish', artifactHash: 'fixture' } });

/** Fresh task driven to `state`; every cancellable and terminal state is reachable offline. */
const taskIn = (store, s, state) => {
  const id = store.create(s);
  if (state === 'running') store.start(id, s);
  else if (state === 'interrupted') { store.start(id, s); store.interrupt(id, s); } // interrupt is supervisor-side: no token
  else if (state === 'completed') { const a = store.start(id, s); store.complete(id, s, { attemptToken: a.attemptToken }); }
  else if (state === 'failed') { const a = store.start(id, s); store.fail(id, s, { attemptToken: a.attemptToken }); }
  else if (state === 'cancelled') store.cancel(id, s);
  return id;
};

test('cancellation matrix: cancellable states cancel, terminal states refuse, bound approvals reject inside the TTL', t => {
  const f = fixture(t), s = subject(f);
  const tasks = new TaskStore(path.join(f.base, 'tasks')), approvals = new ApprovalStore(path.join(f.base, 'approvals'));
  for (const state of ['planned', 'running', 'interrupted']) {
    const taskId = taskIn(tasks, s, state);
    assert.equal(tasks.cancel(taskId, s).state, 'cancelled', `${state} must be cancellable`);
    // Approval columns are bound to the same subject (hence to the row's task).
    // Issue with the default TTL and decide immediately: every reject cell is within the TTL.
    const pending = approvals.issue(s);
    assert.equal(approvals.reject(pending, s).state, 'rejected', `reject(pending) over a ${state} task`);
    assert.throws(() => approvals.consume(pending, s), /APPROVAL_WRONG_STATE/);
    assert.equal(approvals.verify(pending, s).binding, 'match');
    const approved = approvals.issue(s);
    approvals.approve(approved, s);
    assert.equal(approvals.reject(approved, s).state, 'rejected', `reject(approved) over a ${state} task`);
    assert.throws(() => approvals.consume(approved, s), /APPROVAL_WRONG_STATE/);
    assert.equal(approvals.verify(approved, s).binding, 'match');
  }
  for (const state of ['completed', 'failed', 'cancelled']) {
    const taskId = taskIn(tasks, s, state);
    assert.throws(() => tasks.cancel(taskId, s), /TASK_WRONG_STATE/, `${state} must refuse cancel`);
    assert.equal(tasks.get(taskId).state, state);
  }
});
test('single-use invariant: a consumed approval can no longer be rejected', t => {
  const f = fixture(t), store = new ApprovalStore(path.join(f.base, 'approvals')), s = subject(f);
  const id = store.issue(s);
  store.approve(id, s);
  assert.equal(store.consume(id, s).state, 'consumed');
  assert.throws(() => store.reject(id, s), /APPROVAL_WRONG_STATE/);
  assert.equal(store.get(id).state, 'consumed');
});
test('cancelWorkflow from running+pending rejects the approval and cancels the task, on disk', t => {
  const f = fixture(t), s = subject(f);
  const taskDir = path.join(f.base, 'tasks'), approvalDir = path.join(f.base, 'approvals');
  const tasks = new TaskStore(taskDir), approvals = new ApprovalStore(approvalDir);
  const taskId = taskIn(tasks, s, 'running');
  const approvalId = approvals.issue(s);
  const { approval, task } = cancelWorkflow({ taskStore: tasks, approvalStore: approvals, taskId, approvalId, subject: s });
  assert.equal(approval.state, 'rejected');
  assert.equal(task.state, 'cancelled');
  assert.equal(Object.isFrozen(approval) && Object.isFrozen(task), true);
  // On-disk confirmation through fresh store instances, not the returned views.
  assert.equal(new ApprovalStore(approvalDir).get(approvalId).state, 'rejected');
  assert.equal(new TaskStore(taskDir).get(taskId).state, 'cancelled');
});
test('cancelWorkflow step-1 failures precede any task mutation: expired and already-rejected approvals', t => {
  // (a) Expired approval: APPROVAL_EXPIRED fires before task.cancel runs; the task
  // record is byte-identical (same state, same updatedAt) and the approval stays
  // un-transitioned — an expired approval is unconsumable anyway, so this is safe.
  {
    const f = fixture(t); let time = 1000;
    const approvals = new ApprovalStore(path.join(f.base, 'approvals'), { clock: () => time });
    const tasks = new TaskStore(path.join(f.base, 'tasks')), s = subject(f);
    const taskId = taskIn(tasks, s, 'running');
    const approvalId = approvals.issue(s, { ttlMs: 1 });
    time = 1001; // now >= expiresAt inside the lock
    const before = tasks.get(taskId);
    assert.throws(() => cancelWorkflow({ taskStore: tasks, approvalStore: approvals, taskId, approvalId, subject: s }), /APPROVAL_EXPIRED/);
    assert.deepEqual(tasks.get(taskId), before, 'an expired approval must never touch the task record');
    assert.equal(approvals.get(approvalId).state, 'pending');
  }
  // (b) Already-rejected approval: APPROVAL_WRONG_STATE, task untouched.
  {
    const f = fixture(t), s = subject(f);
    const tasks = new TaskStore(path.join(f.base, 'tasks')), approvals = new ApprovalStore(path.join(f.base, 'approvals'));
    const taskId = taskIn(tasks, s, 'running');
    const approvalId = approvals.issue(s);
    approvals.reject(approvalId, s);
    const before = tasks.get(taskId);
    assert.throws(() => cancelWorkflow({ taskStore: tasks, approvalStore: approvals, taskId, approvalId, subject: s }), /APPROVAL_WRONG_STATE/);
    assert.deepEqual(tasks.get(taskId), before);
  }
});
test('cancelWorkflow on a completed task still rejects the approval first (fail-safe order pin)', t => {
  const f = fixture(t), s = subject(f);
  const tasks = new TaskStore(path.join(f.base, 'tasks')), approvals = new ApprovalStore(path.join(f.base, 'approvals'));
  const taskId = taskIn(tasks, s, 'completed');
  const approvalId = approvals.issue(s);
  assert.throws(() => cancelWorkflow({ taskStore: tasks, approvalStore: approvals, taskId, approvalId, subject: s }), /TASK_WRONG_STATE/);
  // Step 1 already executed: the approval is rejected (unconsumable) even though
  // step 2 refused — the reverse order would have left it consumable.
  assert.equal(approvals.get(approvalId).state, 'rejected');
  assert.equal(tasks.get(taskId).state, 'completed');
});
test('cancelWorkflow refuses mismatched bindings with zero transitions in both stores', t => {
  const f = fixture(t), s = subject(f);
  // A different action file content is a different subject.
  const other = { ...s, action: { kind: 'delete' } };
  const tasks = new TaskStore(path.join(f.base, 'tasks')), approvals = new ApprovalStore(path.join(f.base, 'approvals'));
  const taskId = tasks.create(s);
  const approvalId = approvals.issue(s);
  const taskBefore = tasks.get(taskId), approvalBefore = approvals.get(approvalId);
  assert.throws(() => cancelWorkflow({ taskStore: tasks, approvalStore: approvals, taskId, approvalId, subject: other }), /WORKFLOW_BINDING_MISMATCH/);
  assert.deepEqual(tasks.get(taskId), taskBefore);
  assert.deepEqual(approvals.get(approvalId), approvalBefore);
  // The approval-side binding alone also refuses: task matches, approval does not.
  const foreignId = approvals.issue(other);
  assert.throws(() => cancelWorkflow({ taskStore: tasks, approvalStore: approvals, taskId, approvalId: foreignId, subject: s }), /WORKFLOW_BINDING_MISMATCH/);
  assert.deepEqual(tasks.get(taskId), taskBefore);
  assert.equal(approvals.get(foreignId).state, 'pending');
});
test('approvals reject CLI subprocess rejects a pending record on disk', t => {
  const f = fixture(t), state = path.join(f.base, 'approvals');
  const s = { host: 'dsh', runId: 'r9', sessionId: 's9', policyHash: f.policy.policyHash, action: { tool: 'write_file', input: { path: 'src/a' } } };
  const actionFile = path.join(f.base, 'action.json');
  fs.writeFileSync(actionFile, JSON.stringify(s.action));
  const id = new ApprovalStore(state).issue(s);
  const child = spawnSync(process.execPath, [cli, 'approvals', 'reject', '--state', state, '--id', id,
    '--host', 'dsh', '--session', s.sessionId, '--run', s.runId, '--policy-hash', s.policyHash, '--action-file', actionFile], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).state, 'rejected');
  // On-disk confirmation through a fresh store, not the subprocess stdout.
  assert.equal(new ApprovalStore(state).get(id).state, 'rejected');
});
