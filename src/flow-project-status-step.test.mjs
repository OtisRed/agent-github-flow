import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runPendingProjectStatusStep } from './flow-project-status-step.mjs';
import { createBranchStatusTransport, BRANCH_STATUS_UPDATE } from './flow-project-status-transport.mjs';

const body = '[FLOW]\nRola: Designer\nStan docelowy: agent-ready\nWykonano: Praca\nNastępny krok: Kod';
const digest = createHash('sha256').update(body).digest('hex');
function fixture() {
  const epoch = { kind: 'initial', anchor: 'issue' };
  const record = { version: 1, repositoryId: 'repo-id', number: 1, issueId: 'issue', cutoverAt: '2026-01-01T10:00:00Z',
    epoch, reentry: null, current: { phase: 'pending', commentId: '4', digest, fromStatus: 'needs-design',
      targetStatus: 'agent-ready', createdAt: '2026-01-01T10:01:00Z', epoch }, previous: null };
  const state = { checkpoint: { kind: 'checkpoint-snapshot-observed', headOid: 'b'.repeat(40), repositoryId: 'repo-id',
    repositoryFullName: 'owner/project', cutoverAt: record.cutoverAt, selection: { number: 1, issueId: 'issue' },
    index: { version: 1, repositoryId: 'repo-id', issues: [{ number: 1, issueId: 'issue' }] }, selectedRecord: record },
  project: { kind: 'branch-project-observed', issueNodeId: 'issue', repository: 'owner/project', issueState: 'OPEN',
    currentStatus: 'needs-design', projectId: 'project', itemId: 'item', statusFieldId: 'status', statusOptionId: 'design',
    statusOptions: [{ id: 'design', name: 'needs-design' }, { id: 'ready', name: 'agent-ready' }] },
  handoffEvidence: { kind: 'evidence', handoff: { kind: 'handoff', id: '4', nodeId: 'comment', authorId: 'user',
    createdAt: record.current.createdAt, body } }, trustedAuthorIds: ['user'], expectedProjectId: 'project',
  epochProof: { kind: 'handoff-epoch-evidence', issueNodeId: 'issue', commentNodeId: 'comment', commentId: '4',
    commentCreatedAt: record.current.createdAt, commentDigest: digest, epoch } };
  const writes = [];
  const collect = async () => structuredClone(state);
  const setStatus = async args => { writes.push(args);
    state.project.currentStatus = 'agent-ready'; state.project.statusOptionId = 'ready';
    return { kind: 'status-write-acknowledged' }; };
  const policy = { repositoryId: 'repo-id', repository: 'owner/project', projectId: 'project', statusFieldId: 'status', trustedAuthorIds: ['user'] };
  return { state, writes, collect, transport: { projectId: 'project', statusFieldId: 'status', setStatus }, policy };
}

test('performs exactly one bounded status mutation and checks the resulting state', async () => {
  const f = fixture(); const result = await runPendingProjectStatusStep(f);
  assert.deepEqual(result, { kind: 'status-target-observed', retryAllowed: false });
  assert.deepEqual(f.writes, [{ itemId: 'item', targetOptionId: 'ready' }]);
});

test('blocks changed data between preflight reads without writing', async () => {
  const f = fixture(); let calls = 0; const original = f.collect;
  f.collect = async () => { if (++calls === 2) f.state.handoffEvidence.handoff.id = '5'; return original(); };
  assert.deepEqual(await runPendingProjectStatusStep(f), { kind: 'blocked', reason: 'snapshot-changed' });
  assert.equal(f.writes.length, 0);
});

test('never retries when a mutation throws or has an unconfirmed response', async () => {
  for (const mode of ['throws', 'unconfirmed']) {
    const f = fixture(); let count = 0;
    f.transport.setStatus = async () => { count += 1; if (mode === 'throws') throw Error('private error'); return { kind: 'unknown' }; };
    assert.deepEqual(await runPendingProjectStatusStep(f), { kind: 'status-write-uncertain', retryAllowed: false });
    assert.equal(count, 1);
  }
});

test('does not claim success if the checkpoint, handoff or card changes after the write', async () => {
  for (const change of ['checkpoint', 'handoff', 'status']) {
    const f = fixture(); const original = f.transport.setStatus;
    f.transport.setStatus = async (...args) => { const response = await original(...args);
      if (change === 'checkpoint') f.state.checkpoint.headOid = 'c'.repeat(40);
      if (change === 'handoff') f.state.handoffEvidence.handoff.id = '5';
      if (change === 'status') f.state.project.statusOptionId = 'wrong';
      return response; };
    assert.deepEqual(await runPendingProjectStatusStep(f), { kind: 'status-write-uncertain', retryAllowed: false });
    assert.equal(f.writes.length, 1);
  }
});

test('blocks mismatched Project or status field in transport before any read or write', async () => {
  for (const field of ['projectId', 'statusFieldId']) {
    const f = fixture(); f.transport[field] = 'other'; let reads = 0;
    f.collect = async () => { reads += 1; return f.state; };
    assert.deepEqual(await runPendingProjectStatusStep(f), { kind: 'blocked', reason: 'transport-policy-mismatch' });
    assert.equal(reads, 0); assert.equal(f.writes.length, 0);
  }
});

test('rejects a policy that does not match the independently collected project and author list', async () => {
  for (const change of ['repositoryId', 'repository', 'projectId', 'statusFieldId', 'trustedAuthorIds']) {
    const f = fixture(); f.policy[change] = change === 'trustedAuthorIds' ? ['other'] : 'other';
    const reason = ['projectId', 'statusFieldId'].includes(change) ? 'transport-policy-mismatch' : 'policy-mismatch';
    assert.deepEqual(await runPendingProjectStatusStep(f), { kind: 'blocked', reason });
    assert.equal(f.writes.length, 0);
  }
});

test('blocks already complete or unavailable preflight without mutation', async () => {
  let f = fixture(); f.state.project.currentStatus = 'agent-ready'; f.state.project.statusOptionId = 'ready';
  assert.deepEqual(await runPendingProjectStatusStep(f), { kind: 'blocked', reason: 'status-step-not-applicable' });
  assert.equal(f.writes.length, 0);
  f = fixture(); f.collect = async () => { throw Error('private data'); };
  assert.deepEqual(await runPendingProjectStatusStep(f), { kind: 'blocked', reason: 'preflight-unavailable' });
});

test('composes the status step with the policy-bound PAT transport', async () => {
  const f = fixture(); const requests = [];
  f.transport = createBranchStatusTransport({ projectToken: 'synthetic-token', projectId: f.policy.projectId,
    statusFieldId: f.policy.statusFieldId, request: async (url, options) => {
      requests.push({ url, options }); f.state.project.currentStatus = 'agent-ready'; f.state.project.statusOptionId = 'ready';
      return { status: 200, text: async () => JSON.stringify({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item' } } } }) };
    } });
  assert.deepEqual(await runPendingProjectStatusStep(f), { kind: 'status-target-observed', retryAllowed: false });
  assert.equal(requests.length, 1); assert.equal(requests[0].url, 'https://api.github.com/graphql');
  assert.equal(JSON.parse(requests[0].options.body).query, BRANCH_STATUS_UPDATE);
});
