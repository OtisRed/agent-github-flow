import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runPendingProjectStatusStep, runReservedProjectStatusStep } from './flow-project-status-step.mjs';
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
  const policy = { repositoryId: 'repo-id', repository: 'owner/project', projectId: 'project', issueId:'issue', issueNumber:1,
    statusFieldId: 'status', trustedAuthorIds: ['user'],appId:12,updateRulesetId:1,historyRulesetId:2 };
  const expectedBinding={repositoryId:'repo-id',repository:'owner/project',projectId:'project',statusFieldId:'status',issueId:'issue',issueNumber:1,
    appId:12,updateRulesetId:1,historyRulesetId:2,trustedAuthorIds:['user'],
    commentId:'4',commentDigest:digest,checkpointOid:'b'.repeat(40)};
  const verifyProtection=async()=>({kind:'checkpoint-protection-observed',repositoryId:'repo-id',appId:12,updateRulesetId:1,historyRulesetId:2});
  return { state, writes, collect, transport: { projectId: 'project', statusFieldId: 'status', setStatus }, policy, expectedBinding, verifyProtection };
}

test('performs exactly one bounded status mutation and checks the resulting state', async () => {
  const f = fixture(); const result = await runPendingProjectStatusStep(f);
  assert.deepEqual(result, { kind: 'status-target-observed', binding:f.expectedBinding, retryAllowed: false });
  assert.deepEqual(f.writes, [{ itemId: 'item', targetOptionId: 'ready' }]);
});

const reservedFixture = () => { const f = fixture(); f.state.checkpoint.schemaVersion = 2;
  const record = f.state.checkpoint.selectedRecord; record.version = 2;
  record.reservation = { reservedAt: '2026-01-01T10:02:00Z', fromOptionId: 'design', targetOptionId: 'ready' };
  return f; };

test('performs the v2 status mutation only against the expected reserved checkpoint', async () => {
  const f = reservedFixture(); const result = await runReservedProjectStatusStep(f);
  assert.deepEqual(result, { kind: 'status-target-observed', binding: f.expectedBinding, retryAllowed: false });
  assert.deepEqual(f.writes, [{ itemId: 'item', targetOptionId: 'ready' }]);
});

test('blocks missing or changed reservation, stale HEAD and altered status options before writing', async () => {
  for (const change of [
    f => { f.state.checkpoint.selectedRecord.reservation = null; },
    f => { f.state.checkpoint.selectedRecord.reservation.targetOptionId = 'old'; },
    f => { f.state.checkpoint.headOid = 'c'.repeat(40); },
    f => { f.state.project.statusOptions[0].id = 'other'; },
    f => { f.state.checkpoint.schemaVersion = 1; }
  ]) { const f = reservedFixture(); change(f); assert.equal((await runReservedProjectStatusStep(f)).kind, 'blocked'); assert.equal(f.writes.length, 0); }
});

test('uncertain v2 status mutation is attempted only once', async () => {
  const f = reservedFixture(); let attempts = 0;
  f.transport.setStatus = async () => { attempts += 1; throw Error('connection lost'); };
  assert.deepEqual(await runReservedProjectStatusStep(f), { kind: 'status-write-uncertain', retryAllowed: false });
  assert.equal(attempts, 1);
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
  for (const change of ['repositoryId', 'repository', 'projectId', 'statusFieldId', 'trustedAuthorIds', 'issueId', 'issueNumber']) {
    const f = fixture(); f.policy[change] = change === 'trustedAuthorIds' ? ['other'] : change==='issueNumber' ? 2 : 'other';
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
test('rejects a binding from a different handoff before writing',async()=>{
  for(const [key,value] of [['commentId','other'],['statusFieldId','other'],['appId',13],['issueNumber',2]]){
    const f=fixture();f.expectedBinding[key]=value;
    assert.deepEqual(await runPendingProjectStatusStep(f),{kind:'blocked',reason:'handoff-binding-mismatch'});assert.equal(f.writes.length,0);
  }
});
test('does not write a status if checkpoint protection is no longer verified',async()=>{
  const f=fixture();f.verifyProtection=async()=>({kind:'blocked'});
  assert.deepEqual(await runPendingProjectStatusStep(f),{kind:'blocked',reason:'protection-unverified'});assert.equal(f.writes.length,0);
});
test('does not claim a confirmed status if protection changes after mutation',async()=>{
  const f=fixture();let count=0;f.verifyProtection=async()=>++count===1
    ?{kind:'checkpoint-protection-observed',repositoryId:'repo-id',appId:12,updateRulesetId:1,historyRulesetId:2}:{kind:'blocked'};
  assert.deepEqual(await runPendingProjectStatusStep(f),{kind:'status-write-uncertain',retryAllowed:false});assert.equal(f.writes.length,1);
});

test('composes the status step with the policy-bound PAT transport', async () => {
  const f = fixture(); const requests = [];
  f.transport = createBranchStatusTransport({ projectToken: 'synthetic-token', projectId: f.policy.projectId,
    statusFieldId: f.policy.statusFieldId, request: async (url, options) => {
      requests.push({ url, options }); f.state.project.currentStatus = 'agent-ready'; f.state.project.statusOptionId = 'ready';
      return { status: 200, text: async () => JSON.stringify({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item' } } } }) };
    } });
  assert.equal((await runPendingProjectStatusStep(f)).kind, 'status-target-observed');
  assert.equal(requests.length, 1); assert.equal(requests[0].url, 'https://api.github.com/graphql');
  assert.equal(JSON.parse(requests[0].options.body).query, BRANCH_STATUS_UPDATE);
});
