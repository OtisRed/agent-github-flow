import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planReentry } from './flow-reentry.mjs';

const oldBody = '[FLOW]\nRola: Smoker\nStan docelowy: smoke\nWykonano: Praca\nNastępny krok: Smoke';
const old = { version: 1, phase: 'committed', commentId: '1', digest: createHash('sha256').update(oldBody).digest('hex'), fromStatus: 'review', targetStatus: 'smoke' };
const input = () => ({ complete: true, singleWriterVerified: true, projectSourceVerified: true, singleCardVerified: true,
  nativeReopenEvidence: { kind: 'native-reopen-evidence', issueNodeId: 'issue-node', epoch: { kind: 'reopened', anchor: 'reopen-node' } },
  issueNodeId: 'issue-node', issueState: 'OPEN', currentStatus: 'done',
  epoch: { kind: 'reopened', anchor: 'reopen-node' }, marker: old,
  witness: { version: 1, current: old, previous: null }, previousComment: { id: '1', nodeId: 'old-comment-node', body: oldBody },
  checkpointEpochEvidence: { kind: 'checkpoint-epoch-evidence', relation: 'prior', issueNodeId: 'issue-node',
    commentId: '1', commentNodeId: 'old-comment-node', commentDigest: old.digest, epoch: { kind: 'reopened', anchor: 'reopen-node' } } });

test('reentry recovers every step and never resets progress after ready', () => {
  const value = input();
  let plan = planReentry(value); assert.equal(plan.kind, 'start-reentry');
  assert.deepEqual(planReentry(value), plan);
  value.witness = plan.witness;
  plan = planReentry(value); assert.equal(plan.kind, 'update-status'); assert.equal(plan.targetStatus, 'needs-design');
  value.currentStatus = 'needs-design';
  plan = planReentry(value); assert.equal(plan.kind, 'remove-issue-marker'); assert.deepEqual(plan.marker, old);
  value.marker = null;
  plan = planReentry(value); assert.equal(plan.kind, 'finish-reentry');
  value.witness = plan.witness;
  assert.deepEqual(planReentry(value), { kind: 'already-reentered' });
  value.currentStatus = 'review';
  assert.deepEqual(planReentry(value), { kind: 'already-reentered' });
});

test('reentry can start from no previous checkpoints or an active status', () => {
  const value = input(); value.witness = null; value.marker = null; value.currentStatus = 'smoke';
  let plan = planReentry(value); assert.equal(plan.kind, 'start-reentry'); assert.equal(plan.witness.previous, null);
  value.witness = plan.witness; plan = planReentry(value); assert.equal(plan.kind, 'update-status');
  value.currentStatus = 'needs-design'; plan = planReentry(value); assert.equal(plan.kind, 'finish-reentry');
});

test('does not reset a checkpoint already verified in the current epoch', () => {
  const value = input(); value.currentStatus = 'review'; value.checkpointEpochEvidence.relation = 'current';
  assert.deepEqual(planReentry(value), { kind: 'already-reentered' });
  value.currentStatus = 'done';
  assert.deepEqual(planReentry(value), { kind: 'blocked', reason: 'open-issue-in-done' });
});

test('does not let an older reopen sentinel reset a later epoch or accept unknown bootstrap', () => {
  const value = input(); value.witness = planReentry(value).witness;
  value.epoch = { kind: 'reopened', anchor: 'later-event' };
  value.nativeReopenEvidence.epoch = value.epoch;
  assert.deepEqual(planReentry(value), { kind: 'blocked', reason: 'epoch-changed' });
  const newBody = '[FLOW]\nRola: Designer\nStan docelowy: review\nWykonano: Projekt\nNastępny krok: Review';
  value.currentStatus = 'needs-design'; value.marker = null; value.trusted = true; value.currentEpochVerified = true;
  value.cutoverAt = '2026-01-01T10:00:00Z';
  value.handoff = { kind: 'handoff', id: '2', nodeId: 'new-node', createdAt: '2026-01-01T10:00:02Z', body: newBody };
  value.handoffEpochEvidence = { kind: 'handoff-epoch-evidence', issueNodeId: value.issueNodeId, commentNodeId: 'new-node',
    commentId: '2', commentCreatedAt: value.handoff.createdAt, commentDigest: createHash('sha256').update(newBody).digest('hex'), epoch: value.epoch };
  value.witness = { version: 2, kind: 'bootstrap', epoch: value.epoch, cutoverAt: value.cutoverAt,
    current: { version: 1, phase: 'pending', commentId: '2', digest: createHash('sha256').update(newBody).digest('hex'),
      fromStatus: 'needs-design', targetStatus: 'review' }, previous: old };
  value.previousComment = null;
  assert.deepEqual(planReentry(value), { kind: 'blocked', reason: 'unverified-bootstrap' });
  value.previousComment = { id: '1', nodeId: 'old-comment-node', body: oldBody };
  assert.deepEqual(planReentry(value), { kind: 'already-reentered' });
});

test('supersedes a finished older reopen after a second verified reopen', () => {
  const value = input(); value.marker = null; value.currentStatus = 'needs-design';
  value.witness = { version: 2, kind: 'reentry', phase: 'ready', epoch: structuredClone(value.epoch), previous: old, fromStatus: 'done' };
  value.epoch = { kind: 'reopened', anchor: 'reopen-2' };
  value.nativeReopenEvidence.epoch = structuredClone(value.epoch);
  let plan = planReentry(value); assert.equal(plan.kind, 'start-reentry'); assert.equal(plan.witness.epoch.anchor, 'reopen-2');
  value.witness = plan.witness; plan = planReentry(value); assert.equal(plan.kind, 'finish-reentry');
  value.witness = plan.witness; assert.deepEqual(planReentry(value), { kind: 'already-reentered' });
});

test('blocks unverified, closed, conflicting, modified or missing data', () => {
  const cases = [
    [v => { v.nativeReopenEvidence = null; }, 'unverified-native-reopen'],
    [v => { v.nativeReopenEvidence.epoch.anchor = 'other'; }, 'unverified-native-reopen'],
    [v => { v.singleWriterVerified = false; }, 'unverified-snapshot'],
    [v => { v.issueState = 'CLOSED'; }, 'issue-not-open'],
    [v => { v.epoch.kind = 'initial'; }, 'invalid-state'],
    [v => { v.marker = null; }, 'checkpoint-mismatch'],
    [v => { v.previousComment = null; }, 'previous-comment-missing-or-changed'],
    [v => { v.previousComment = { id: '1', nodeId: 'old-comment-node', body: `${oldBody} changed` }; }, 'previous-comment-missing-or-changed'],
    [v => { v.checkpointEpochEvidence.commentId = '2'; }, 'unverified-checkpoint-epoch'],
    [v => { v.checkpointEpochEvidence.commentNodeId = 'different'; }, 'unverified-checkpoint-epoch'],
    [v => { v.checkpointEpochEvidence.epoch.anchor = 'older-event'; }, 'unverified-checkpoint-epoch'],
  ];
  for (const [mutate, reason] of cases) {
    const value = input(); mutate(value);
    assert.deepEqual(planReentry(value), { kind: 'blocked', reason });
  }
});
