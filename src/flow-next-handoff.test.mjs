import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planNextHandoff } from './flow-next-handoff.mjs';
import { planWitnessRecovery } from './flow-witness.mjs';

const body = status => `[FLOW]\nRola: Coder\nStan docelowy: ${status}\nWykonano: Praca\nNastępny krok: Kontrola`;
const hash = value => createHash('sha256').update(value).digest('hex');
const proof = (comment, epoch) => ({ kind: 'handoff-epoch-evidence', issueNodeId: 'issue', commentId: comment.id,
  commentNodeId: comment.nodeId, commentCreatedAt: comment.createdAt, commentDigest: hash(comment.body), epoch: structuredClone(epoch) });
const input = () => {
  const epoch = { kind: 'initial', anchor: 'issue' };
  const previousComment = { id: '1', nodeId: 'node1', createdAt: '2026-01-01T00:00:01Z', body: body('agent-ready') };
  const handoff = { kind: 'handoff', id: '2', nodeId: 'node2', authorId: 'author', createdAt: '2026-01-01T00:00:02Z', body: body('review') };
  const marker = { version: 1, phase: 'committed', commentId: '1', digest: hash(previousComment.body), fromStatus: 'needs-design', targetStatus: 'agent-ready' };
  return { complete: true, singleWriterVerified: true, projectSourceVerified: true, singleCardVerified: true, trusted: true,
    issueNodeId: 'issue', issueState: 'OPEN', currentStatus: 'agent-ready', epoch, marker,
    witness: { version: 1, current: marker, previous: null }, previousComment, handoff,
    previousEpochEvidence: proof(previousComment, epoch), handoffEpochEvidence: proof(handoff, epoch) };
};

test('starts the next handoff and connects to existing recovery', () => {
  const value = input(); const plan = planNextHandoff(value);
  assert.equal(plan.kind, 'start-handoff'); assert.equal(plan.witness.current.targetStatus, 'review');
  const next = planWitnessRecovery({ ...value, witness: plan.witness, latestComment: value.handoff });
  assert.equal(next.kind, 'write-issue-pending');
});

test('blocks unverified, stale, deleted or out-of-order comments and mismatched checkpoints', () => {
  const cases = [
    [v => { v.handoffEpochEvidence.epoch.anchor = 'old'; }, 'unverified-comments'],
    [v => { v.previousComment = null; }, 'unverified-comments'],
    [v => { v.previousComment.body += ' changed'; }, 'unverified-comments'],
    [v => { v.handoff.createdAt = v.previousComment.createdAt; v.handoffEpochEvidence.commentCreatedAt = v.handoff.createdAt; }, 'ambiguous-or-older-handoff'],
    [v => { v.currentStatus = 'smoke'; }, 'previous-status-mismatch'],
    [v => { v.marker = null; }, 'checkpoint-mismatch'],
    [v => { v.complete = false; }, 'unverified-snapshot'],
    [v => { delete v.issueNodeId; delete v.previousEpochEvidence.issueNodeId; delete v.handoffEpochEvidence.issueNodeId; }, 'unverified-comments'],
  ];
  for (const [mutate, reason] of cases) { const value = input(); mutate(value); assert.deepEqual(planNextHandoff(value), { kind: 'blocked', reason }); }
});

test('supports the next handoff after reopen with both proofs in the new epoch', () => {
  const value = input(); value.epoch = { kind: 'reopened', anchor: 'reopen' };
  value.handoffEpochEvidence = proof(value.handoff, value.epoch); value.previousEpochEvidence = proof(value.previousComment, value.epoch);
  assert.equal(planNextHandoff(value).kind, 'start-handoff');
});
