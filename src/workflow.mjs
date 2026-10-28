import { subjectDigest } from './approvals.mjs';

const fail = code => { throw new Error(code); };

/**
 * Cancellation is an operator-discipline primitive, not an automatic cascade: the
 * task journal and the approval ledger are independent stores by design, and this
 * helper only sequences the two transitions a human operator must never run in the
 * wrong order. The pair is deliberately NOT atomic — the order is the safety
 * argument: reject the approval first (rejected is terminal and unconsumable, so
 * the dangerous resource stays neutralized even if the process dies between the
 * two steps, and the task can still be cancelled later), then cancel the task.
 * The reverse order would leave a consumable approval sitting over a dead task.
 * A step-1 failure (APPROVAL_EXPIRED, APPROVAL_WRONG_STATE) propagates before any
 * task mutation — accepted, an expired or already-decided approval is
 * unconsumable anyway. A step-2 failure (TASK_WRONG_STATE on a completed, failed
 * or cancelled task) propagates with the approval already rejected: a safe
 * terminal end state the operator is left to observe, not to clean up.
 */
export function cancelWorkflow({ taskStore, approvalStore, taskId, approvalId, subject }) {
  // Zero-transition pre-flight: both records must bind to the caller's subject
  // before either store is allowed to change state.
  if (taskStore.get(taskId).subjectHash !== subjectDigest(subject)
    || approvalStore.verify(approvalId, subject).binding !== 'match') fail('WORKFLOW_BINDING_MISMATCH');
  // Fail-safe order: neutralize the consumable resource first (see header).
  const approval = approvalStore.reject(approvalId, subject);
  const task = taskStore.cancel(taskId, subject);
  return { approval, task };
}
