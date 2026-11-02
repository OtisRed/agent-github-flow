import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planBootstrap } from './flow-bootstrap.mjs';
import { planReentry } from './flow-reentry.mjs';

const body = status => `[FLOW]\nRola: Designer\nStan docelowy: ${status}\nWykonano: Projekt\nNastępny krok: Praca`;
const handoff = status => ({ kind: 'handoff', id: '12', nodeId: 'comment-node', authorId: 'author-node',
  createdAt: '2026-01-01T10:00:02Z', body: body(status) });
const bindHandoff = value => { value.handoffEpochEvidence = { kind: 'handoff-epoch-evidence', issueNodeId: value.issueNodeId,
  commentNodeId: value.handoff.nodeId, commentId: value.handoff.id, commentCreatedAt: value.handoff.createdAt, commentDigest: createHash('sha256').update(value.handoff.body).digest('hex'),
  epoch: structuredClone(value.epoch) }; };
const bindReopen = value => { value.nativeReopenEvidence = { kind: 'native-reopen-evidence', issueNodeId: value.issueNodeId, epoch: structuredClone(value.epoch) }; };
const input = () => ({ complete: true, singleWriterVerified: true, projectSourceVerified: true, singleCardVerified: true,
  trusted: true, issueNodeId: 'issue-node', issueState: 'OPEN', currentStatus: 'needs-design',
  epoch: { kind: 'initial', anchor: 'issue-node' }, cutoverAt: '2026-01-01T10:00:00Z',
  marker: null, witness: null, handoff: handoff('agent-ready'), handoffEpochEvidence: { kind: 'handoff-epoch-evidence',
    issueNodeId: 'issue-node', commentNodeId: 'comment-node', commentId: '12', commentCreatedAt: '2026-01-01T10:00:02Z',
    commentDigest: createHash('sha256').update(body('agent-ready')).digest('hex'), epoch: { kind: 'initial', anchor: 'issue-node' } } });

test('first handoff and a missed event use the same resumable bootstrap sequence', () => {
  const value = input();
  let plan = planBootstrap(value);
  assert.equal(plan.kind, 'write-bootstrap-witness');
  assert.deepEqual(planBootstrap(value), plan);
  value.witness = plan.witness;
  plan = planBootstrap(value); assert.equal(plan.kind, 'write-issue-pending');
  value.marker = plan.marker;
  plan = planBootstrap(value); assert.equal(plan.kind, 'update-status'); assert.equal(plan.targetStatus, 'agent-ready');
  value.currentStatus = 'agent-ready';
  plan = planBootstrap(value); assert.equal(plan.kind, 'commit-project-checkpoint');
  value.witness = plan.witness;
  plan = planBootstrap(value); assert.equal(plan.kind, 'commit-issue-marker');
  value.marker = plan.marker;
  plan = planBootstrap(value); assert.equal(plan.kind, 'normalize-project-checkpoint');
  value.witness = plan.witness;
  assert.deepEqual(planBootstrap(value), { kind: 'bootstrap-complete' });
});

test('a same-status handoff records checkpoints without a status update', () => {
  const value = input(); value.handoff = handoff('needs-design'); bindHandoff(value);
  let plan = planBootstrap(value); value.witness = plan.witness;
  plan = planBootstrap(value); value.marker = plan.marker;
  plan = planBootstrap(value); assert.equal(plan.kind, 'commit-project-checkpoint');
});

test('empty and pre-cutover histories do not produce a mutation', () => {
  const value = input(); value.handoff = { kind: 'absent' };
  assert.deepEqual(planBootstrap(value), { kind: 'awaiting-handoff' });
  value.handoff = handoff('review'); value.handoff.createdAt = value.cutoverAt;
  assert.deepEqual(planBootstrap(value), { kind: 'awaiting-fresh-handoff' });
  value.handoff.createdAt = '2025-12-31T23:59:59Z';
  assert.deepEqual(planBootstrap(value), { kind: 'awaiting-fresh-handoff' });
});

test('reopen requires verified current native epoch and rejects stale handoffs', () => {
  const value = input(); value.epoch = { kind: 'reopened', anchor: 'reopen-event' };
  value.handoffEpochEvidence = null;
  assert.deepEqual(planBootstrap(value), { kind: 'blocked', reason: 'unverified-handoff' });
  bindHandoff(value);
  const plan = planBootstrap(value); assert.equal(plan.kind, 'write-bootstrap-witness');
  value.witness = plan.witness; value.epoch = { kind: 'reopened', anchor: 'another-reopen' }; bindHandoff(value);
  assert.deepEqual(planBootstrap(value), { kind: 'blocked', reason: 'epoch-changed' });
});

test('rejects epoch evidence for a different issue, comment, content or epoch', () => {
  for (const change of [
    p => { p.issueNodeId = 'another-issue'; }, p => { p.commentNodeId = 'another-node'; },
    p => { p.commentId = '13'; }, p => { p.commentDigest = '0'.repeat(64); },
    p => { p.commentCreatedAt = '2025-01-01T00:00:00Z'; },
    p => { p.epoch.anchor = 'another-epoch'; },
  ]) {
    const value = input(); change(value.handoffEpochEvidence);
    assert.deepEqual(planBootstrap(value), { kind: 'blocked', reason: 'unverified-handoff' });
  }
});

test('blocks missing data, dirty checkpoints, closed issues and target done', () => {
  const cases = [
    [v => { v.complete = false; }, 'unverified-snapshot'],
    [v => { v.singleCardVerified = false; }, 'unverified-snapshot'],
    [v => { v.singleWriterVerified = false; }, 'unverified-snapshot'],
    [v => { v.issueState = 'CLOSED'; }, 'issue-not-open'],
    [v => { v.currentStatus = 'done'; }, 'open-issue-in-done'],
    [v => { v.handoff = handoff('done'); bindHandoff(v); }, 'closure-required'],
    [v => { v.handoff = { kind: 'blocked' }; }, 'unverified-handoff'],
    [v => { v.marker = {}; }, 'checkpoint-mismatch'],
    [v => { delete v.marker; }, 'missing-checkpoint-state'],
    [v => { v.cutoverAt = 'tomorrow'; }, 'invalid-policy'],
  ];
  for (const [mutate, reason] of cases) {
    const value = input(); mutate(value);
    assert.deepEqual(planBootstrap(value), { kind: 'blocked', reason });
  }
});

test('recovery blocks changed handoff, policy, epoch or unexpected status', () => {
  const cases = [
    [v => { v.handoff.body = body('review'); }, 'handoff-changed'],
    [v => { v.epoch.anchor = 'different'; }, 'epoch-changed'],
    [v => { v.cutoverAt = '2025-12-31T23:59:59Z'; }, 'cutover-changed'],
    [v => { v.currentStatus = 'smoke'; }, 'unexpected-status'],
  ];
  for (const [mutate, reason] of cases) {
    const value = input(); value.witness = planBootstrap(value).witness; mutate(value); bindHandoff(value);
    assert.deepEqual(planBootstrap(value), { kind: 'blocked', reason });
  }
});

test('reentry, missed handoff and repeated reentry converge without resetting progress', () => {
  const value = input();
  const oldBody = body('smoke');
  const old = { version: 1, phase: 'committed', commentId: '1', digest: createHash('sha256').update(oldBody).digest('hex'),
    fromStatus: 'review', targetStatus: 'smoke' };
  value.epoch = { kind: 'reopened', anchor: 'reopen-node' }; value.marker = old;
  value.witness = { version: 1, current: old, previous: null }; value.currentStatus = 'done';
  value.issueNodeId = 'issue-node'; value.previousComment = { id: '1', nodeId: 'old-node', body: oldBody }; bindReopen(value); bindHandoff(value);
  value.checkpointEpochEvidence = { kind: 'checkpoint-epoch-evidence', relation: 'prior', issueNodeId: 'issue-node',
    commentId: '1', commentNodeId: 'old-node', commentDigest: old.digest, epoch: value.epoch };
  let plan = planReentry(value); value.witness = plan.witness;
  plan = planReentry(value); assert.equal(plan.kind, 'update-status'); value.currentStatus = plan.targetStatus;
  plan = planReentry(value); assert.equal(plan.kind, 'remove-issue-marker'); value.marker = null;
  plan = planReentry(value); assert.equal(plan.kind, 'finish-reentry'); value.witness = plan.witness;
  value.handoff = { kind: 'absent' }; assert.deepEqual(planBootstrap(value), { kind: 'awaiting-handoff' });
  value.handoff = handoff('agent-ready');
  plan = planBootstrap(value); assert.equal(plan.kind, 'write-bootstrap-witness'); value.witness = plan.witness;
  assert.deepEqual(planReentry(value), { kind: 'already-reentered' });
  plan = planBootstrap(value); value.marker = plan.marker;
  plan = planBootstrap(value); assert.equal(plan.kind, 'update-status'); value.currentStatus = plan.targetStatus;
  plan = planBootstrap(value); value.witness = plan.witness;
  plan = planBootstrap(value); value.marker = plan.marker;
  plan = planBootstrap(value); value.witness = plan.witness;
  assert.deepEqual(planBootstrap(value), { kind: 'bootstrap-complete' });
  value.previousComment = { id: value.handoff.id, nodeId: value.handoff.nodeId, body: value.handoff.body };
  value.checkpointEpochEvidence = { kind: 'checkpoint-epoch-evidence', relation: 'current', issueNodeId: 'issue-node',
    commentId: value.handoff.id, commentNodeId: value.handoff.nodeId, commentDigest: value.witness.current.digest, epoch: value.epoch };
  assert.deepEqual(planReentry(value), { kind: 'already-reentered' });
  assert.equal(value.currentStatus, 'agent-ready');
});

test('retains the previous comment evidence until a post-reopen bootstrap is committed', () => {
  const value = input();
  const oldBody = body('smoke');
  const old = { version: 1, phase: 'committed', commentId: '1', digest: createHash('sha256').update(oldBody).digest('hex'),
    fromStatus: 'review', targetStatus: 'smoke' };
  value.epoch = { kind: 'reopened', anchor: 'reopen-node' };
  bindHandoff(value);
  value.witness = { version: 2, kind: 'reentry', phase: 'ready', epoch: value.epoch, previous: old, fromStatus: 'done' };
  value.previousComment = { id: '1', nodeId: 'old-node', body: oldBody };
  value.checkpointEpochEvidence = { kind: 'checkpoint-epoch-evidence', relation: 'prior', issueNodeId: value.issueNodeId,
    commentId: '1', commentNodeId: 'old-node', commentDigest: old.digest, epoch: structuredClone(value.epoch) };
  value.checkpointEpochEvidence.relation = 'current';
  assert.deepEqual(planBootstrap(value), { kind: 'blocked', reason: 'unverified-checkpoint-epoch' });
  value.checkpointEpochEvidence.relation = 'prior';
  const plan = planBootstrap(value); assert.equal(plan.kind, 'write-bootstrap-witness'); value.witness = plan.witness;
  value.previousComment = null;
  assert.deepEqual(planBootstrap(value), { kind: 'blocked', reason: 'previous-comment-missing-or-changed' });
});
