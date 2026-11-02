import test from 'node:test';
import assert from 'node:assert/strict';
import { FLOW_STATUSES } from './flow.mjs';
import { planActiveStatus } from './flow-transition.mjs';

test('plans every active-to-active transition and leaves duplicates unchanged', () => {
  const active = FLOW_STATUSES.filter(status => status !== 'done');
  for (const currentStatus of active) {
    for (const targetStatus of active) {
      const input = { issueState: 'OPEN', currentStatus, targetStatus };
      assert.deepEqual(planActiveStatus(input), currentStatus === targetStatus
        ? { kind: 'unchanged' }
        : { kind: 'update', targetStatus });
      assert.deepEqual(input, { issueState: 'OPEN', currentStatus, targetStatus });
    }
  }
});

test('never plans a transition to or from done for an open issue', () => {
  assert.deepEqual(planActiveStatus({ issueState: 'OPEN', currentStatus: 'smoke', targetStatus: 'done' }),
    { kind: 'blocked', reason: 'closure-required' });
  assert.deepEqual(planActiveStatus({ issueState: 'OPEN', currentStatus: 'done', targetStatus: 'smoke' }),
    { kind: 'blocked', reason: 'open-issue-in-done' });
  assert.deepEqual(planActiveStatus({ issueState: 'OPEN', currentStatus: 'done', targetStatus: 'done' }),
    { kind: 'blocked', reason: 'open-issue-in-done' });
});

test('leaves closed issues for native state reconciliation', () => {
  assert.deepEqual(planActiveStatus({ issueState: 'CLOSED', currentStatus: 'smoke', targetStatus: 'review' }),
    { kind: 'blocked', reason: 'issue-closed' });
});

test('blocks missing, unknown and incorrectly cased state data', () => {
  for (const input of [undefined, null, [], 42, {}, { issueState: 'open', currentStatus: 'smoke', targetStatus: 'review' }]) {
    assert.deepEqual(planActiveStatus(input), { kind: 'blocked', reason: 'invalid-issue-state' });
  }
  for (const input of [
    { issueState: 'OPEN', targetStatus: 'review' },
    { issueState: 'OPEN', currentStatus: 'smoke' },
    { issueState: 'OPEN', currentStatus: 'Smoke', targetStatus: 'review' },
    { issueState: 'OPEN', currentStatus: 'smoke', targetStatus: 'unknown' },
  ]) assert.deepEqual(planActiveStatus(input), { kind: 'blocked', reason: 'invalid-status' });
});
