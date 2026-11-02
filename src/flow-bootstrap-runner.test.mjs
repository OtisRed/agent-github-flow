import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runBootstrapStep } from './flow-bootstrap-runner.mjs';
import { PROJECT_WRITE, ISSUE_WRITE, writeBootstrapGitHubStep } from './flow-github-write.mjs';
import { readFlowMarker } from './flow-marker.mjs';
import { planBootstrap } from './flow-bootstrap.mjs';

const body = '[FLOW]\nRola: Designer\nStan docelowy: agent-ready\nWykonano: Projekt\nNastępny krok: Praca';
const initial = () => ({ kind: 'snapshot', projectId: 'project', itemId: 'item', issueNodeId: 'issue', repository: 'owner/repo',
  statusFieldId: 'status-field', checkpointFieldId: 'checkpoint-field', issueState: 'OPEN', issueBody: 'Dane użytkownika\n',
  complete: true, singleWriterVerified: true, projectSourceVerified: true, singleCardVerified: true, trusted: true,
  currentStatus: 'needs-design', statusOptions: [{ id: 'design-id', name: 'needs-design' }, { id: 'ready-id', name: 'agent-ready' }],
  epoch: { kind: 'initial', anchor: 'issue' }, cutoverAt: '2026-01-01T00:00:00Z', marker: null, witness: null,
  handoff: { kind: 'handoff', id: '1', nodeId: 'comment', authorId: 'author', createdAt: '2026-01-01T00:00:02Z', body },
  handoffEpochEvidence: { kind: 'handoff-epoch-evidence', issueNodeId: 'issue', commentId: '1', commentNodeId: 'comment',
    commentCreatedAt: '2026-01-01T00:00:02Z', commentDigest: createHash('sha256').update(body).digest('hex'),
    epoch: { kind: 'initial', anchor: 'issue' } } });

function harness() {
  const state = initial(); const mutations = [];
  const graphql = async (query, variables) => {
    mutations.push({ query, variables: structuredClone(variables) });
    if (query === ISSUE_WRITE) {
      assert.equal(variables.issue, 'issue'); state.issueBody = variables.body; state.marker = readFlowMarker(variables.body).marker;
      return { data: { updateIssue: { issue: { id: 'issue' } } } };
    }
    assert.equal(query, PROJECT_WRITE); assert.equal(variables.project, 'project'); assert.equal(variables.item, 'item');
    if (variables.field === 'checkpoint-field') state.witness = JSON.parse(variables.value.text);
    else { assert.equal(variables.field, 'status-field'); assert.equal(variables.value.singleSelectOptionId, 'ready-id'); state.currentStatus = 'agent-ready'; }
    return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item' } } } };
  };
  return { state, mutations, readSnapshot: async options => ({ ...structuredClone(state), ...(options?.readbackCheckpoint ? {
    readbackPreviousComment: structuredClone(state.previousComment),
    readbackPreviousEpochEvidence: structuredClone(state.checkpointEpochEvidence ?? state.previousEpochEvidence),
    readbackNativeReopenEvidence: structuredClone(state.nativeReopenEvidence ?? null),
  } : {}) }),
    writeStep: (snapshot, plan) => writeBootstrapGitHubStep({ graphql, snapshot, plan }) };
}

test('executes and reads back each bootstrap step in order, preserving issue content', async () => {
  const ctx = harness(); const expected = ['write-bootstrap-witness', 'write-issue-pending', 'update-status',
    'commit-project-checkpoint', 'commit-issue-marker', 'normalize-project-checkpoint'];
  for (const step of expected) assert.deepEqual(await runBootstrapStep(ctx), { kind: 'step-applied', step });
  assert.deepEqual(await runBootstrapStep(ctx), { kind: 'bootstrap-complete' });
  assert.equal(ctx.mutations.length, 6); assert.ok(ctx.state.issueBody.startsWith('Dane użytkownika\n'));
  assert.equal(ctx.state.marker.phase, 'committed'); assert.equal(ctx.state.witness.current.phase, 'committed');
});

test('does not write when snapshot changes, and never retries uncertain writes', async () => {
  const ctx = harness(); let count = 0;
  const readSnapshot = async () => { const value = structuredClone(ctx.state); if (++count === 2) value.currentStatus = 'review'; return value; };
  assert.deepEqual(await runBootstrapStep({ readSnapshot, writeStep: ctx.writeStep }), { kind: 'blocked', reason: 'snapshot-changed' });
  assert.equal(ctx.mutations.length, 0);
  let writes = 0;
  assert.deepEqual(await runBootstrapStep({ readSnapshot: ctx.readSnapshot, writeStep: async () => { writes += 1; throw Error('timeout'); } }),
    { kind: 'blocked', reason: 'write-uncertain' });
  assert.equal(writes, 1);
});

test('rejects a successful API response if readback differs or another field changes', async () => {
  const ctx = harness();
  const writeStep = async (snapshot, plan) => { await ctx.writeStep(snapshot, plan); ctx.state.currentStatus = 'review'; };
  assert.deepEqual(await runBootstrapStep({ readSnapshot: ctx.readSnapshot, writeStep }), { kind: 'blocked', reason: 'readback-conflict' });
  assert.equal(ctx.mutations.length, 1);
});

test('readback also protects the old comment and epoch evidence after reopen', async () => {
  const ctx = harness(); const oldBody = '[FLOW]\nRola: Smoker\nStan docelowy: smoke\nWykonano: Praca\nNastępny krok: Smoke';
  const old = { version: 1, phase: 'committed', commentId: '9', digest: createHash('sha256').update(oldBody).digest('hex'),
    fromStatus: 'review', targetStatus: 'smoke' };
  ctx.state.epoch = { kind: 'reopened', anchor: 'reopen' }; ctx.state.handoffEpochEvidence.epoch = structuredClone(ctx.state.epoch);
  ctx.state.witness = { version: 2, kind: 'reentry', phase: 'ready', epoch: structuredClone(ctx.state.epoch), previous: old, fromStatus: 'done' };
  ctx.state.previousComment = { id: '9', nodeId: 'old-node', body: oldBody };
  ctx.state.checkpointEpochEvidence = { kind: 'checkpoint-epoch-evidence', issueNodeId: 'issue', commentId: '9', commentNodeId: 'old-node',
    commentDigest: old.digest, relation: 'prior', epoch: structuredClone(ctx.state.epoch) };
  ctx.state.nativeReopenEvidence = { kind: 'native-reopen-evidence', issueNodeId: 'issue', epoch: structuredClone(ctx.state.epoch) };
  const writeStep = async (snapshot, plan) => { await ctx.writeStep(snapshot, plan); ctx.state.previousComment.body += ' changed'; };
  assert.deepEqual(await runBootstrapStep({ readSnapshot: ctx.readSnapshot, writeStep }), { kind: 'blocked', reason: 'readback-conflict' });
  assert.equal(ctx.mutations.length, 1);
});

test('blocks invalid options and GraphQL mutation errors', async () => {
  const ctx = harness(); const snapshot = structuredClone(ctx.state);
  await assert.rejects(writeBootstrapGitHubStep({ graphql: async () => ({}), snapshot,
    plan: { kind: 'update-status', expectedStatus: 'needs-design', targetStatus: 'unknown' } }), /plan-snapshot-mismatch/);
  await assert.rejects(writeBootstrapGitHubStep({ graphql: async () => ({ errors: [{ message: 'failed' }] }), snapshot,
    plan: planBootstrap(snapshot) }), /unconfirmed-project-write/);
});
