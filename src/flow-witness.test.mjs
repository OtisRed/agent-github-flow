import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planWitnessRecovery } from './flow-witness.mjs';

const body = '[FLOW]\nRola: Coder\nStan docelowy: review\nWykonano: Zmiana\nNastępny krok: Przegląd';
const digest = createHash('sha256').update(body).digest('hex');
const oldBody = '[FLOW]\nRola: Designer\nStan docelowy: agent-ready\nWykonano: Projekt\nNastępny krok: Implementacja';
const prior = { version: 1, phase: 'committed', commentId: '1', digest: createHash('sha256').update(oldBody).digest('hex'), fromStatus: 'needs-design', targetStatus: 'agent-ready' };
const pending = { version: 1, phase: 'pending', commentId: '2', digest, fromStatus: 'agent-ready', targetStatus: 'review' };
const committed = { ...pending, phase: 'committed' };
const epoch = { kind: 'initial', anchor: 'issue' };
const proof = comment => ({ kind: 'handoff-epoch-evidence', issueNodeId: 'issue', commentId: comment.id, commentNodeId: comment.nodeId,
  commentCreatedAt: comment.createdAt, commentDigest: createHash('sha256').update(comment.body).digest('hex'), epoch: structuredClone(epoch) });
const previousComment = { id: '1', nodeId: 'old', createdAt: '2026-01-01T00:00:01Z', body: oldBody };
const latestComment = { id: '2', nodeId: 'new', createdAt: '2026-01-01T00:00:02Z', body };
const input = () => ({ witness: { version: 1, current: pending, previous: prior }, marker: prior,
  projectSourceVerified: true, complete: true, trusted: true, singleWriterVerified: true, issueNodeId: 'issue', epoch: structuredClone(epoch),
  previousEpochEvidence: proof(previousComment), handoffEpochEvidence: proof(latestComment),
  issueState: 'OPEN', currentStatus: 'agent-ready', previousComment: structuredClone(previousComment), latestComment: structuredClone(latestComment) });

test('plans each interrupted step in the permitted two-copy ordering', () => {
  const value = input();
  let plan = planWitnessRecovery(value);
  assert.equal(plan.kind, 'write-issue-pending'); assert.deepEqual(plan.marker, pending);
  assert.deepEqual(plan.expected.marker, prior); assert.deepEqual(plan.expected.witness, value.witness);
  value.marker = pending;
  plan = planWitnessRecovery(value);
  assert.equal(plan.kind, 'update-status'); assert.equal(plan.expectedStatus, 'agent-ready'); assert.equal(plan.targetStatus, 'review');
  value.currentStatus = 'review';
  plan = planWitnessRecovery(value); assert.equal(plan.kind, 'commit-project-checkpoint'); assert.deepEqual(plan.marker, committed);
  value.witness = { version: 1, current: committed, previous: null };
  plan = planWitnessRecovery(value); assert.equal(plan.kind, 'commit-issue-marker'); assert.deepEqual(plan.marker, committed);
  value.marker = committed;
  assert.deepEqual(planWitnessRecovery(value), { kind: 'unchanged' });
});

test('blocks a rolled-back issue marker after the project checkpoint is committed', () => {
  const value = input(); value.witness = { version: 1, current: committed, previous: null }; value.currentStatus = 'review';
  assert.deepEqual(planWitnessRecovery(value), { kind: 'blocked', reason: 'checkpoint-mismatch' });
});

test('blocks deletion or edits of the checkpointed comment even if older handoff remains', () => {
  for (const comment of [null, { id: '1', body }, { id: '2', body: `${body} zmiana` }]) {
    const value = input(); value.latestComment = comment;
    assert.equal(planWitnessRecovery(value).kind, 'blocked');
  }
});

test('requires the previously accepted comment throughout the pending transition', () => {
  const value = input(); value.previousComment = null;
  assert.deepEqual(planWitnessRecovery(value), { kind: 'blocked', reason: 'missing-previous-comment' });
  value.previousComment = { id: '1', body: `${oldBody} zmieniony` };
  assert.deepEqual(planWitnessRecovery(value), { kind: 'blocked', reason: 'previous-comment-changed' });
});

test('blocks unexpected ordering, inconsistent status, untrusted checkpoint and reopened issue history', () => {
  const cases = [
    [v => { v.projectSourceVerified = false; }, 'unverified-project-checkpoint'],
    [v => { v.marker = null; }, 'invalid-issue-marker'],
    [v => { v.witness.previous = { ...prior, targetStatus: 'smoke' }; }, 'invalid-project-checkpoint'],
    [v => { v.currentStatus = 'review'; }, 'unexpected-status'],
    [v => { v.handoffEpochEvidence.commentId = 'other'; }, 'unverified-reopen-history'],
    [v => { v.previousEpochEvidence.epoch.anchor = 'old'; }, 'unverified-previous-epoch'],
    [v => { v.issueState = 'CLOSED'; }, 'issue-closed'],
  ];
  for (const [mutate, reason] of cases) {
    const value = input(); value.witness = { ...value.witness }; mutate(value);
    assert.deepEqual(planWitnessRecovery(value), { kind: 'blocked', reason });
  }
});

test('retains independent expected snapshots for a fresh pre-write comparison', () => {
  const value = input(); const plan = planWitnessRecovery(value);
  value.marker = { ...prior, targetStatus: 'smoke' };
  value.witness = { ...value.witness, current: { ...pending, targetStatus: 'smoke' } };
  assert.deepEqual(plan.expected.marker, prior);
  assert.deepEqual(plan.expected.witness.current, pending);
  assert.equal(plan.expected.currentStatus, 'agent-ready');
  assert.equal(plan.expected.commentId, '2');
  assert.equal(plan.expected.commentDigest, digest);
});
