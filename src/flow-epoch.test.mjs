import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyHandoffEpoch, verifyHandoffEpochAndAnchor, classifyCheckpointEpoch, verifyNativeReopen } from './flow-epoch.mjs';

const input = () => ({ complete: true, issueState: 'OPEN', issueCreatedAt: '2026-01-01T10:00:00Z', handoffCreatedAt: '2026-01-01T10:00:01Z', observedAt: '2026-01-01T10:10:00Z', events: [] });
const close = { id: 'close-1', type: 'CLOSED', at: '2026-01-01T10:01:00Z' };
const reopen = { id: 'reopen-1', type: 'REOPENED', at: '2026-01-01T10:02:00Z' };

test('binds native reopen evidence to the issue and latest complete event history', () => {
  const value = { ...input(), issueNodeId: 'issue', events: [close, reopen] };
  assert.deepEqual(verifyNativeReopen(value), { kind: 'native-reopen-evidence', issueNodeId: 'issue',
    epoch: { kind: 'reopened', anchor: 'reopen-1' } });
  value.observedAt = reopen.at;
  assert.deepEqual(verifyNativeReopen(value), { kind: 'blocked', reason: 'handoff-before-or-at-reopen' });
  value.events = []; value.observedAt = '2026-01-01T10:10:00Z';
  assert.deepEqual(verifyNativeReopen(value), { kind: 'blocked', reason: 'no-reopen-event' });
});

test('verifies a current handoff on a never-closed issue or after reopen', () => {
  assert.deepEqual(verifyHandoffEpoch(input()), { kind: 'verified' });
  const after = input(); after.events = [close, reopen]; after.handoffCreatedAt = '2026-01-01T10:03:00Z';
  assert.deepEqual(verifyHandoffEpoch(after), { kind: 'verified' });
});

test('blocks old handoffs and same-second ordering ambiguity after reopen', () => {
  for (const time of ['2026-01-01T10:00:01Z', '2026-01-01T10:02:00Z']) {
    const snapshot = input(); snapshot.events = [close, reopen]; snapshot.handoffCreatedAt = time;
    assert.deepEqual(verifyHandoffEpoch(snapshot), { kind: 'blocked', reason: 'handoff-before-or-at-reopen' });
  }
});

test('blocks incomplete, duplicate, unordered and inconsistent timelines', () => {
  const cases = [
    [i => { i.complete = false; }, 'incomplete-timeline'],
    [i => { i.events = [reopen]; }, 'inconsistent-timeline'],
    [i => { i.events = [close]; }, 'inconsistent-timeline'],
    [i => { i.events = [close, close]; }, 'invalid-timeline'],
    [i => { i.events = [close, { ...reopen, at: close.at }]; }, 'invalid-timeline'],
    [i => { i.events = [reopen, close]; }, 'inconsistent-timeline'],
    [i => { i.issueState = 'CLOSED'; i.events = [close]; }, 'issue-closed'],
  ];
  for (const [mutate, reason] of cases) {
    const value = input(); mutate(value);
    assert.deepEqual(verifyHandoffEpoch(value), { kind: 'blocked', reason });
  }
});

test('blocks malformed, impossible and future timestamps', () => {
  for (const time of ['2026-02-30T10:00:00Z', '2026-01-01T10:00:01.000Z', 'tomorrow', '2025-01-01T10:00:00Z', '2027-01-01T10:00:00Z']) {
    const value = input(); value.handoffCreatedAt = time;
    assert.deepEqual(verifyHandoffEpoch(value), { kind: 'blocked', reason: 'invalid-timestamp' });
  }
  assert.deepEqual(verifyHandoffEpoch(null), { kind: 'blocked', reason: 'invalid-input' });
});

test('anchors the epoch to the existing issue or last native reopen event', () => {
  const value = { ...input(), issueNodeId: 'issue-node' };
  assert.deepEqual(verifyHandoffEpochAndAnchor(value), { kind: 'verified', epoch: { kind: 'initial', anchor: 'issue-node' } });
  value.events = [close, reopen]; value.handoffCreatedAt = '2026-01-01T10:03:00Z';
  assert.deepEqual(verifyHandoffEpochAndAnchor(value), { kind: 'verified', epoch: { kind: 'reopened', anchor: 'reopen-1' } });
  value.handoffCreatedAt = '2026-01-01T10:02:00Z';
  assert.deepEqual(verifyHandoffEpochAndAnchor(value), { kind: 'blocked', reason: 'handoff-before-or-at-reopen' });
  assert.deepEqual(verifyHandoffEpochAndAnchor({ ...input(), issueNodeId: '' }), { kind: 'blocked', reason: 'invalid-issue-id' });
});

test('classifies a specific checkpointed comment relative to the latest reopen', () => {
  const value = { ...input(), issueNodeId: 'issue-node', commentNodeId: 'comment-node', commentId: '123', commentDigest: 'a'.repeat(64), events: [close, reopen] };
  assert.deepEqual(classifyCheckpointEpoch(value), { kind: 'checkpoint-epoch-evidence', relation: 'prior', issueNodeId: 'issue-node',
    commentNodeId: 'comment-node', commentId: '123', commentDigest: 'a'.repeat(64), epoch: { kind: 'reopened', anchor: 'reopen-1' } });
  value.handoffCreatedAt = '2026-01-01T10:03:00Z';
  assert.equal(classifyCheckpointEpoch(value).relation, 'current');
  value.handoffCreatedAt = '2026-01-01T10:02:00Z';
  assert.deepEqual(classifyCheckpointEpoch(value), { kind: 'blocked', reason: 'ambiguous-reopen-order' });
  delete value.commentNodeId;
  assert.deepEqual(classifyCheckpointEpoch(value), { kind: 'blocked', reason: 'invalid-identity' });
});
