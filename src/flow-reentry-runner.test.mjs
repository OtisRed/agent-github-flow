import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runReentryStep } from './flow-reentry-runner.mjs';
import { PROJECT_WRITE, ISSUE_WRITE, writeReentryGitHubStep } from '../test-support/legacy-flow-github-write.mjs';
import { replaceFlowMarker, readFlowMarker } from './flow-marker.mjs';

const body = '[FLOW]\nRola: Smoker\nStan docelowy: smoke\nWykonano: Praca\nNastępny krok: Smoke';
const digest = createHash('sha256').update(body).digest('hex');
const initial = () => {
  const marker = { version: 1, phase: 'committed', commentId: '1', digest, fromStatus: 'review', targetStatus: 'smoke' };
  const epoch = { kind: 'reopened', anchor: 'reopen' };
  return { kind: 'snapshot', projectId: 'project', itemId: 'item', issueNodeId: 'issue', repository: 'owner/repo',
    statusFieldId: 'status-field', checkpointFieldId: 'checkpoint-field', issueState: 'OPEN', issueBody: replaceFlowMarker('Original', null, marker).body,
    complete: true, singleWriterVerified: true, projectSourceVerified: true, singleCardVerified: true,
    currentStatus: 'smoke', statusOptions: [{ id: 'smoke-id', name: 'smoke' }, { id: 'design-id', name: 'needs-design' }],
    epoch, marker, witness: { version: 1, current: marker, previous: null }, previousComment: { id: '1', nodeId: 'node1', body },
    handoff: { kind: 'absent' },
    cutoverAt: '2026-01-01T00:00:00Z',
    nativeReopenEvidence: { kind: 'native-reopen-evidence', issueNodeId: 'issue', epoch, reopenedAt: '2026-01-01T00:00:01Z' },
    checkpointEpochEvidence: { kind: 'checkpoint-epoch-evidence', relation: 'prior', issueNodeId: 'issue', commentId: '1',
      commentNodeId: 'node1', commentDigest: digest, epoch } };
};
function harness() {
  const state = initial(); const mutations = [];
  const graphql = async (query, variables) => {
    mutations.push({ query, variables: structuredClone(variables) });
    if (query === ISSUE_WRITE) { state.issueBody = variables.body; const marker = readFlowMarker(variables.body);
      state.marker = marker.kind === 'found' ? marker.marker : null; return { data: { updateIssue: { issue: { id: 'issue' } } } }; }
    assert.equal(query, PROJECT_WRITE); assert.equal(variables.project, 'project'); assert.equal(variables.item, 'item');
    if (variables.field === 'checkpoint-field') state.witness = JSON.parse(variables.value.text);
    else { assert.equal(variables.field, 'status-field'); assert.equal(variables.value.singleSelectOptionId, 'design-id'); state.currentStatus = 'needs-design'; }
    return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item' } } } };
  };
  return { state, mutations, readSnapshot: async () => structuredClone(state),
    writeStep: (snapshot, plan) => writeReentryGitHubStep({ graphql, snapshot, plan }) };
}

test('reports a conflict if cutover policy changes during a reopen write', async () => {
  const ctx = harness(); ctx.state.cutoverAt = '2026-01-01T00:00:00Z';
  ctx.state.nativeReopenEvidence.reopenedAt = '2026-01-01T00:00:01Z';
  const writeStep = async (snapshot, plan) => { await ctx.writeStep(snapshot, plan); ctx.state.cutoverAt = '2026-01-01T00:00:01Z'; };
  assert.deepEqual(await runReentryStep({ readSnapshot: ctx.readSnapshot, writeStep }), { kind: 'blocked', reason: 'readback-conflict' });
  assert.equal(ctx.mutations.length, 1);
});

test('restarts from native reopen once and preserves issue text', async () => {
  const ctx = harness();
  for (const step of ['start-reentry', 'update-status', 'remove-issue-marker', 'finish-reentry']) {
    assert.deepEqual(await runReentryStep(ctx), { kind: 'step-applied', step });
  }
  assert.deepEqual(await runReentryStep(ctx), { kind: 'already-reentered' });
  assert.equal(ctx.state.issueBody, 'Original\n\n'); assert.equal(ctx.state.currentStatus, 'needs-design');
  ctx.state.currentStatus = 'review';
  assert.deepEqual(await runReentryStep(ctx), { kind: 'already-reentered' });
  assert.equal(ctx.mutations.length, 4);
});

test('rejects stale native evidence, changing snapshots and altered readback', async () => {
  const ctx = harness(); ctx.state.nativeReopenEvidence.epoch = { kind: 'reopened', anchor: 'wrong' };
  assert.deepEqual(await runReentryStep(ctx), { kind: 'blocked', reason: 'unverified-native-reopen' });
  ctx.state.nativeReopenEvidence.epoch = ctx.state.epoch;
  const writeStep = async (snapshot, plan) => { await ctx.writeStep(snapshot, plan); ctx.state.previousComment.body += ' changed'; };
  assert.deepEqual(await runReentryStep({ readSnapshot: ctx.readSnapshot, writeStep }), { kind: 'blocked', reason: 'readback-conflict' });
  assert.equal(ctx.mutations.length, 1);
});

test('reports a conflict if a new handoff appears during the reentry write', async () => {
  const ctx = harness();
  const writeStep = async (snapshot, plan) => {
    await ctx.writeStep(snapshot, plan);
    ctx.state.handoff = { kind: 'handoff', id: '2', nodeId: 'node2', body };
  };
  assert.deepEqual(await runReentryStep({ readSnapshot: ctx.readSnapshot, writeStep }),
    { kind: 'blocked', reason: 'readback-conflict' });
  assert.equal(ctx.mutations.length, 1);
});
