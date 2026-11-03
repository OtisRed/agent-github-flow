import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCheckpointContinuity } from './flow-checkpoint-continuity.mjs';

const initial = { kind: 'initial', anchor: 'issue' };
const marker = (overrides = {}) => ({ phase: 'committed', commentId: '1', digest: 'a'.repeat(64), fromStatus: 'needs-design',
  targetStatus: 'agent-ready', createdAt: '2026-01-01T10:01:00Z', epoch: { ...initial }, ...overrides });
const record = () => ({ version: 1, repositoryId: 'repo', number: 1, issueId: 'issue', cutoverAt: '2026-01-01T10:00:00Z',
  epoch: { ...initial }, reentry: null, current: marker(), previous: null });
const nextHandoff = before => ({ ...structuredClone(before), current: marker({ phase: 'pending', commentId: '2',
  fromStatus: 'agent-ready', targetStatus: 'review', createdAt: '2026-01-01T10:02:00Z' }), previous: structuredClone(before.current) });
const reopen = before => ({ ...structuredClone(before), epoch: { kind: 'reopened', anchor: 'reopen-1' },
  reentry: { phase: 'pending', reopenedAt: '2026-01-01T10:03:00Z', fromStatus: 'done', previous: structuredClone(before.current) } });

test('accepts only a pending first handoff and preserves identity and cutover', () => {
  const first = record(); first.current.phase = 'pending';
  assert.equal(verifyCheckpointContinuity(null, first).kind, 'continuity-verified');
  assert.equal(verifyCheckpointContinuity(null, record()).reason, 'invalid-initial-record');
  const changed = record(); changed.cutoverAt = '2026-01-01T09:59:00Z';
  assert.equal(verifyCheckpointContinuity(record(), changed).reason, 'record-identity-changed');
});

test('moves committed to pending to committed while preserving the prior marker', () => {
  const before = record(); const pending = nextHandoff(before);
  assert.equal(verifyCheckpointContinuity(before, pending).kind, 'continuity-verified');
  const committed = structuredClone(pending); committed.current.phase = 'committed'; committed.previous = null;
  assert.equal(verifyCheckpointContinuity(pending, committed).kind, 'continuity-verified');
  const wrong = structuredClone(pending); wrong.previous.digest = 'b'.repeat(64);
  assert.equal(verifyCheckpointContinuity(before, wrong).reason, 'invalid-handoff-transition');
  const changed = structuredClone(committed); changed.current.digest = 'c'.repeat(64);
  assert.equal(verifyCheckpointContinuity(pending, changed).reason, 'invalid-handoff-transition');
});

test('allows reentry only after a stable previous epoch and preserves evidence', () => {
  const before = record(); const pending = reopen(before);
  assert.equal(verifyCheckpointContinuity(before, pending).kind, 'continuity-verified');
  const ready = structuredClone(pending); ready.reentry.phase = 'ready';
  assert.equal(verifyCheckpointContinuity(pending, ready).kind, 'continuity-verified');
  const regressed = structuredClone(pending);
  assert.equal(verifyCheckpointContinuity(ready, regressed).reason, 'reentry-regressed');
  const changed = structuredClone(ready); changed.reentry.fromStatus = 'smoke';
  assert.equal(verifyCheckpointContinuity(ready, changed).reason, 'reentry-evidence-changed');
});

test('refuses a second reopen while first reentry or handoff remains pending', () => {
  const before = record(); const firstPending = reopen(before);
  const second = structuredClone(firstPending); second.epoch.anchor = 'reopen-2'; second.reentry.reopenedAt = '2026-01-01T10:04:00Z';
  assert.equal(verifyCheckpointContinuity(firstPending, second).reason, 'invalid-reentry-transition');
  const handoffPending = nextHandoff(before); const reopenedDuringHandoff = reopen(handoffPending);
  // The proposed next record itself is invalid because an uncommitted marker
  // cannot be preserved as a completed prior comment.
  assert.equal(verifyCheckpointContinuity(handoffPending, reopenedDuringHandoff).reason, 'invalid-next-record');
  const ready = structuredClone(firstPending); ready.reentry.phase = 'ready';
  assert.equal(verifyCheckpointContinuity(ready, second).kind, 'continuity-verified');
});

test('preserves the pre-reopen comment through a new handoff and same-comment repair', () => {
  const ready = reopen(record()); ready.reentry.phase = 'ready';
  const pending = structuredClone(ready); pending.previous = structuredClone(ready.current);
  pending.current = marker({ phase: 'pending', commentId: '2', epoch: structuredClone(ready.epoch),
    createdAt: '2026-01-01T10:04:00Z' });
  assert.equal(verifyCheckpointContinuity(ready, pending).kind, 'continuity-verified');
  const committed = structuredClone(pending); committed.current.phase = 'committed'; committed.previous = null;
  assert.equal(verifyCheckpointContinuity(pending, committed).kind, 'continuity-verified');
  assert.equal(committed.reentry.previous.commentId, '1');
  const repair = structuredClone(committed); repair.previous = structuredClone(committed.current);
  repair.current.phase = 'pending'; repair.current.fromStatus = 'smoke';
  assert.equal(verifyCheckpointContinuity(committed, repair).kind, 'continuity-verified');
  assert.equal(repair.reentry.previous.commentId, '1');
});
