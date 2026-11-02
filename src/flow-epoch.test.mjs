import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyHandoffEpoch } from './flow-epoch.mjs';

const input = () => ({ complete: true, issueState: 'OPEN', issueCreatedAt: '2026-01-01T10:00:00Z', handoffCreatedAt: '2026-01-01T10:00:01Z', observedAt: '2026-01-01T10:10:00Z', events: [] });
const close = { id: 'close-1', type: 'CLOSED', at: '2026-01-01T10:01:00Z' };
const reopen = { id: 'reopen-1', type: 'REOPENED', at: '2026-01-01T10:02:00Z' };

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
