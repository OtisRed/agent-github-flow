import { FLOW_STATUSES } from './flow.mjs';

// Plans only the status change. The caller must separately establish that its
// inputs are complete, current, trusted and consistent with the checkpoint.
// This function does not read or write GitHub and cannot prevent races.
export function planActiveStatus(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { kind: 'blocked', reason: 'invalid-issue-state' };
  }
  const { issueState, currentStatus, targetStatus } = input;
  if (issueState !== 'OPEN' && issueState !== 'CLOSED') {
    return { kind: 'blocked', reason: 'invalid-issue-state' };
  }
  if (!FLOW_STATUSES.includes(currentStatus) || !FLOW_STATUSES.includes(targetStatus)) {
    return { kind: 'blocked', reason: 'invalid-status' };
  }
  if (issueState === 'CLOSED') return { kind: 'blocked', reason: 'issue-closed' };
  if (currentStatus === 'done') return { kind: 'blocked', reason: 'open-issue-in-done' };
  if (targetStatus === 'done') return { kind: 'blocked', reason: 'closure-required' };
  if (currentStatus === targetStatus) return { kind: 'unchanged' };
  return { kind: 'update', targetStatus };
}
