import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runTransitionStep, planTransitionSnapshot } from './flow-transition-runner.mjs';
import { PROJECT_WRITE, ISSUE_WRITE, writeTransitionGitHubStep } from './flow-github-write.mjs';
import { replaceFlowMarker, readFlowMarker } from './flow-marker.mjs';

const text = status => `[FLOW]\nRola: Coder\nStan docelowy: ${status}\nWykonano: Zmiana\nNastępny krok: Przegląd`;
const hash = body => createHash('sha256').update(body).digest('hex');
const epoch = { kind: 'initial', anchor: 'issue' };
const proof = comment => ({ kind: 'handoff-epoch-evidence', issueNodeId: 'issue', commentId: comment.id, commentNodeId: comment.nodeId,
  commentCreatedAt: comment.createdAt, commentDigest: hash(comment.body), epoch: structuredClone(epoch) });
const initial = () => {
  const previousComment = { id: '1', nodeId: 'node1', authorId: 'author', createdAt: '2026-01-01T00:00:01Z', body: text('agent-ready') };
  const handoff = { kind: 'handoff', id: '2', nodeId: 'node2', authorId: 'author', createdAt: '2026-01-01T00:00:02Z', body: text('review') };
  const marker = { version: 1, phase: 'committed', commentId: '1', digest: hash(previousComment.body), fromStatus: 'needs-design', targetStatus: 'agent-ready' };
  return { kind: 'snapshot', projectId: 'project', itemId: 'item', issueNodeId: 'issue', repository: 'owner/repo',
    statusFieldId: 'status-field', checkpointFieldId: 'checkpoint-field', issueState: 'OPEN', issueBody: replaceFlowMarker('Original', null, marker).body,
    complete: true, singleWriterVerified: true, projectSourceVerified: true, singleCardVerified: true, trusted: true,
    currentStatus: 'agent-ready', statusOptions: [{ id: 'ready-id', name: 'agent-ready' }, { id: 'review-id', name: 'review' }],
    epoch: structuredClone(epoch), marker, witness: { version: 1, current: marker, previous: null }, previousComment, handoff,
    previousEpochEvidence: proof(previousComment), handoffEpochEvidence: proof(handoff) };
};
function harness() {
  const state = initial(); const mutations = [];
  const graphql = async (query, variables) => {
    mutations.push({ query, variables: structuredClone(variables) });
    if (query === ISSUE_WRITE) { state.issueBody = variables.body; state.marker = readFlowMarker(variables.body).marker;
      return { data: { updateIssue: { issue: { id: 'issue' } } } }; }
    assert.equal(query, PROJECT_WRITE); assert.equal(variables.project, 'project'); assert.equal(variables.item, 'item');
    if (variables.field === 'checkpoint-field') state.witness = JSON.parse(variables.value.text);
    else { assert.equal(variables.field, 'status-field'); assert.equal(variables.value.singleSelectOptionId, 'review-id'); state.currentStatus = 'review'; }
    return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item' } } } };
  };
  return { state, mutations, readSnapshot: async () => structuredClone(state),
    writeStep: (snapshot, plan) => writeTransitionGitHubStep({ graphql, snapshot, plan }) };
}

test('moves from a committed checkpoint through the next handoff and stops unchanged', async () => {
  const ctx = harness();
  for (const step of ['start-handoff', 'write-issue-pending', 'update-status', 'commit-project-checkpoint', 'commit-issue-marker']) {
    assert.deepEqual(await runTransitionStep(ctx), { kind: 'step-applied', step });
  }
  assert.deepEqual(await runTransitionStep(ctx), { kind: 'unchanged' });
  assert.equal(ctx.mutations.length, 5); assert.ok(ctx.state.issueBody.startsWith('Original'));
  assert.equal(ctx.state.marker.commentId, '2'); assert.equal(ctx.state.witness.current.commentId, '2');
});

test('fails closed on changed state, missing old comment, foreign evidence and unconfirmed writes', async () => {
  const ctx = harness(); ctx.state.previousComment = null;
  assert.equal(planTransitionSnapshot(ctx.state).kind, 'blocked');
  ctx.state.previousComment = initial().previousComment; ctx.state.previousEpochEvidence.epoch.anchor = 'old';
  assert.equal(planTransitionSnapshot(ctx.state).kind, 'blocked');
  ctx.state.previousEpochEvidence = initial().previousEpochEvidence;
  let reads = 0;
  assert.deepEqual(await runTransitionStep({ readSnapshot: async () => { const value = structuredClone(ctx.state);
    if (++reads === 2) value.issueBody += ' changed'; return value; }, writeStep: ctx.writeStep }), { kind: 'blocked', reason: 'snapshot-changed' });
  assert.equal(ctx.mutations.length, 0);
  const plan = planTransitionSnapshot(ctx.state); plan.witness.current.targetStatus = 'smoke';
  await assert.rejects(writeTransitionGitHubStep({ graphql: async () => ({}), snapshot: ctx.state, plan }), /plan-snapshot-mismatch/);
});

test('detects a change to the previous comment during the readback', async () => {
  const ctx = harness();
  const writeStep = async (snapshot, plan) => { await ctx.writeStep(snapshot, plan); ctx.state.previousComment.body += ' changed'; };
  assert.deepEqual(await runTransitionStep({ readSnapshot: ctx.readSnapshot, writeStep }), { kind: 'blocked', reason: 'readback-conflict' });
  assert.equal(ctx.mutations.length, 1);
});
