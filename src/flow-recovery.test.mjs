import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planRecovery } from './flow-recovery.mjs';

const body = '[FLOW]\nRola: Coder\nStan docelowy: review\nWykonano: Zmiana\nNastępny krok: Przegląd';
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const snapshot = () => ({
  marker: { version: 1, phase: 'pending', commentId: '123', digest: digest(body), fromStatus: 'agent-ready', targetStatus: 'review' },
  latestComment: { id: '123', body }, complete: true, trusted: true, currentEpochVerified: true, singleWriterVerified: true,
  issueState: 'OPEN', currentStatus: 'agent-ready',
});

test('recovers both interruption points of a pending transition', () => {
  const input = snapshot();
  assert.deepEqual(planRecovery(input), { kind: 'update-status', expectedStatus: 'agent-ready', targetStatus: 'review' });
  input.currentStatus = 'review';
  assert.deepEqual(planRecovery(input), { kind: 'commit-marker' });
  input.currentStatus = 'smoke';
  assert.deepEqual(planRecovery(input), { kind: 'blocked', reason: 'unexpected-status' });
});

test('committed marker is idempotent and permits a verified mismatch plan', () => {
  const input = snapshot(); input.marker.phase = 'committed';
  assert.deepEqual(planRecovery(input), { kind: 'update-status', expectedStatus: 'agent-ready', targetStatus: 'review' });
  input.currentStatus = 'review';
  assert.deepEqual(planRecovery(input), { kind: 'unchanged' });
});

test('blocks a deleted, superseded, modified, malformed or untrusted comment', () => {
  const cases = [
    [i => { i.latestComment = null; }, 'missing-comment'],
    [i => { i.latestComment.id = '124'; }, 'comment-mismatch'],
    [i => { i.latestComment.body += ' zmiana'; }, 'comment-changed'],
    [i => { i.latestComment.body = 'invalid'; i.marker.digest = digest('invalid'); }, 'invalid-comment'],
    [i => { i.marker.targetStatus = 'smoke'; }, 'invalid-comment'],
    [i => { i.trusted = false; }, 'untrusted-comment'],
    [i => { i.complete = false; }, 'incomplete-snapshot'],
    [i => { i.currentEpochVerified = false; }, 'unverified-reopen-history'],
    [i => { i.singleWriterVerified = false; }, 'unverified-writer'],
  ];
  for (const [mutate, reason] of cases) {
    const input = snapshot(); mutate(input);
    assert.deepEqual(planRecovery(input), { kind: 'blocked', reason });
  }
});

test('does not replay a committed handoff from before native reopen', () => {
  const input = snapshot(); input.marker.phase = 'committed';
  input.currentStatus = 'needs-design'; input.currentEpochVerified = false;
  assert.deepEqual(planRecovery(input), { kind: 'blocked', reason: 'unverified-reopen-history' });
});

test('blocks invalid markers and never decides native closure', () => {
  for (const mutate of [
    i => { i.marker = null; }, i => { i.marker.version = 2; }, i => { i.marker.phase = 'unknown'; },
    i => { i.marker.commentId = '0'; }, i => { i.marker.digest = 'bad'; },
    i => { i.marker.fromStatus = 'done'; }, i => { i.marker.targetStatus = 'done'; },
  ]) {
    const input = snapshot(); mutate(input);
    assert.deepEqual(planRecovery(input), { kind: 'blocked', reason: 'invalid-marker' });
  }
  const closed = snapshot(); closed.issueState = 'CLOSED';
  assert.deepEqual(planRecovery(closed), { kind: 'blocked', reason: 'issue-closed' });
  const wrongCard = snapshot(); wrongCard.currentStatus = 'done';
  assert.deepEqual(planRecovery(wrongCard), { kind: 'blocked', reason: 'open-issue-in-done' });
  assert.deepEqual(planRecovery(null), { kind: 'blocked', reason: 'invalid-input' });
});
