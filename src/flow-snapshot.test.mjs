import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { collectFlowSnapshot, createFlowSnapshotReader } from './flow-snapshot.mjs';
import { planBootstrap } from './flow-bootstrap.mjs';
import { planTransitionSnapshot } from './flow-transition-runner.mjs';
import { makeReadbackCheckpoint } from './flow-readback-evidence.mjs';

const body = status => `[FLOW]\nRola: Designer\nStan docelowy: ${status}\nWykonano: Praca\nNastępny krok: Dalej`;
const digest = value => createHash('sha256').update(value).digest('hex');
const epoch = { kind: 'initial', anchor: 'issue' };
const old = { id: '1', nodeId: 'node1', authorId: 'author', body: body('needs-design'), createdAt: '2026-01-01T00:00:01Z' };
const handoff = { kind: 'handoff', id: '2', nodeId: 'node2', authorId: 'author', body: body('agent-ready'), createdAt: '2026-01-01T00:00:02Z' };
const marker = { version: 1, phase: 'committed', commentId: old.id, digest: digest(old.body), fromStatus: 'needs-design', targetStatus: 'needs-design' };
const proof = (comment, e = epoch) => ({ kind: 'handoff-epoch-evidence', issueNodeId: 'issue', commentId: comment.id,
  commentNodeId: comment.nodeId, commentCreatedAt: comment.createdAt, commentDigest: digest(comment.body), epoch: structuredClone(e) });
const input = () => ({ graphql: async () => ({}), mode: 'handoff', owner: 'owner', repo: 'repo', repository: 'owner/repo',
  number: 1, issueId: 'issue', projectId: 'project', itemId: 'item', statusFieldId: 'status-field', statusFieldName: 'Status',
  checkpointFieldId: 'checkpoint-field', checkpointFieldName: 'FLOW checkpoint',
  trustedAuthorIds: ['author'], observedAt: '2026-01-01T01:00:00Z', cutoverAt: '2026-01-01T00:00:00Z' });
const project = () => ({ kind: 'snapshot', issueNodeId: 'issue', repository: 'owner/repo', issueState: 'OPEN', currentStatus: 'needs-design',
  issueBody: 'body', marker: null, witness: null });
const readers = () => ({ project: async () => project(), handoff: async () => ({ kind: 'evidence', handoff }),
  epoch: async ({ commentNodeId }) => proof(commentNodeId === old.nodeId ? old : handoff) });

test('combines initial evidence but never grants production trust or writer ownership', async () => {
  const result = await collectFlowSnapshot(input(), readers());
  assert.equal(result.kind, 'snapshot'); assert.equal(result.handoff.id, '2'); assert.deepEqual(result.epoch, epoch);
  assert.equal(result.singleWriterVerified, false); assert.equal(result.projectSourceVerified, false); assert.equal(result.trusted, false);
  assert.deepEqual(planBootstrap(result), { kind: 'blocked', reason: 'unverified-snapshot' });
});

test('binds both checkpoint and latest comment and detects a changed Project snapshot', async () => {
  const r = readers(); let reads = 0; const current = project(); current.marker = marker;
  current.witness = { version: 1, current: marker, previous: null };
  r.project = async () => { reads += 1; return structuredClone(current); };
  r.handoff = async args => { assert.equal(args.checkpointCommentId, '1'); return { kind: 'evidence', handoff, previousComment: old }; };
  const result = await collectFlowSnapshot(input(), r);
  assert.equal(result.kind, 'snapshot'); assert.equal(result.previousEpochEvidence.commentId, '1'); assert.equal(reads, 2);
  r.project = async () => { const value = structuredClone(current); if (++reads > 3) value.currentStatus = 'review'; return value; };
  assert.deepEqual(await collectFlowSnapshot(input(), r), { kind: 'blocked', reason: 'project-snapshot-changed' });
});

test('normalized committed checkpoint returns matching evidence for an unchanged handoff', async () => {
  const r = readers(); const current = project(); current.marker = marker; current.witness = { version: 1, current: marker, previous: null };
  r.project = async () => structuredClone(current);
  r.handoff = async () => ({ kind: 'evidence', handoff: { ...old, kind: 'handoff' }, previousComment: old });
  r.epoch = async () => proof(old);
  const result = await collectFlowSnapshot(input(), r);
  assert.deepEqual(result.handoffEpochEvidence, result.previousEpochEvidence);
  const verifiedFixture = { ...result, trusted: true, singleWriterVerified: true, projectSourceVerified: true, singleCardVerified: true };
  assert.deepEqual(planTransitionSnapshot(verifiedFixture), { kind: 'unchanged' });
});

test('after normalization reads previous A separately while current checkpoint remains B', async () => {
  const r = readers(); const current = project();
  const nextMarker = { version: 1, phase: 'committed', commentId: handoff.id, digest: digest(handoff.body),
    fromStatus: 'needs-design', targetStatus: 'agent-ready' };
  current.currentStatus = 'agent-ready'; current.marker = nextMarker; current.witness = { version: 1, current: nextMarker, previous: null };
  r.project = async () => structuredClone(current);
  r.handoff = async ({ checkpointCommentId }) => ({ kind: 'evidence', handoff,
    previousComment: checkpointCommentId === '1' ? old : { ...handoff, kind: undefined } });
  const fresh = { issueNodeId: 'issue', epoch, witness: { version: 1, current: { ...nextMarker, phase: 'pending' }, previous: marker },
    previousComment: old, previousEpochEvidence: proof(old) };
  const request = makeReadbackCheckpoint(fresh);
  const result = await collectFlowSnapshot(input(), r, { readbackCheckpoint: request });
  assert.equal(result.kind, 'snapshot'); assert.equal(result.previousComment.id, '2');
  assert.equal(result.readbackPreviousComment.id, '1'); assert.deepEqual(result.readbackPreviousEpochEvidence, proof(old));
  const wrong = { ...request, commentNodeId: 'different' };
  assert.deepEqual(await collectFlowSnapshot(input(), r, { readbackCheckpoint: wrong }), { kind: 'blocked', reason: 'readback-comment-failed' });
  const reader = createFlowSnapshotReader(input(), r, () => new Date('2026-01-01T01:00:00.000Z'));
  const viaRunner = await reader({ readbackCheckpoint: request });
  assert.equal(viaRunner.readbackPreviousComment.id, '1'); assert.equal(viaRunner.previousComment.id, '2');
});

test('blocks foreign or altered checkpoint evidence and a missing checkpointed comment', async () => {
  const r = readers(); const current = project(); current.marker = marker; current.witness = { version: 1, current: marker, previous: null };
  r.project = async () => current;
  r.handoff = async () => ({ kind: 'evidence', handoff, previousComment: { ...old, body: `${old.body} changed` } });
  assert.deepEqual(await collectFlowSnapshot(input(), r), { kind: 'blocked', reason: 'previous-comment-mismatch' });
  r.handoff = async () => ({ kind: 'evidence', handoff, previousComment: old });
  r.epoch = async () => ({ ...proof(handoff), issueNodeId: 'foreign' });
  assert.deepEqual(await collectFlowSnapshot(input(), r), { kind: 'blocked', reason: 'handoff-epoch-read-failed' });
});

test('supports native reopen without any comment and requires old-comment proof when present', async () => {
  const r = readers(); const value = input(); value.mode = 'reentry';
  const reopened = { kind: 'reopened', anchor: 'event' };
  r.handoff = async () => ({ kind: 'evidence', handoff: { kind: 'absent' } });
  r.native = async () => ({ kind: 'native-reopen-evidence', issueNodeId: 'issue', epoch: reopened });
  let result = await collectFlowSnapshot(value, r); assert.equal(result.kind, 'snapshot'); assert.deepEqual(result.epoch, reopened);
  const current = project(); current.marker = marker; current.witness = { version: 1, current: marker, previous: null };
  r.project = async () => current; r.handoff = async () => ({ kind: 'evidence', handoff, previousComment: old });
  r.checkpoint = async () => ({ kind: 'checkpoint-epoch-evidence', issueNodeId: 'issue', commentId: '1', commentNodeId: 'node1',
    commentDigest: marker.digest, relation: 'prior', epoch: reopened });
  result = await collectFlowSnapshot(value, r); assert.equal(result.checkpointEpochEvidence.relation, 'prior');
  r.checkpoint = async () => ({ kind: 'checkpoint-epoch-evidence', issueNodeId: 'issue', commentId: '1', commentNodeId: 'node1',
    commentDigest: marker.digest, relation: 'prior', epoch: { kind: 'reopened', anchor: 'old-event' } });
  assert.deepEqual(await collectFlowSnapshot(value, r), { kind: 'blocked', reason: 'checkpoint-epoch-read-failed' });
});

test('distinguishes a new issue without handoffs from a missing checkpointed handoff', async () => {
  const r = readers(); r.handoff = async () => ({ kind: 'evidence', handoff: { kind: 'absent' } });
  assert.deepEqual(await collectFlowSnapshot(input(), r), { kind: 'awaiting-handoff' });
  const current = project(); current.marker = marker; current.witness = { version: 1, current: marker, previous: null };
  r.project = async () => current; r.handoff = async () => ({ kind: 'evidence', handoff: { kind: 'absent' }, previousComment: old });
  assert.deepEqual(await collectFlowSnapshot(input(), r), { kind: 'blocked', reason: 'missing-checkpointed-handoff' });
});
