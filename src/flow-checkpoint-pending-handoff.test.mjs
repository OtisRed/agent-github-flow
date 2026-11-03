import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planPendingBranchHandoff } from './flow-checkpoint-pending-handoff.mjs';

const body = '[FLOW]\nRola: Designer\nStan docelowy: agent-ready\nWykonano: Praca\nNastępny krok: Kod';
const digest = createHash('sha256').update(body).digest('hex');
function fixture() {
  const epoch = { kind: 'initial', anchor: 'issue' };
  const record = { version: 1, repositoryId: 'repo-id', number: 1, issueId: 'issue', cutoverAt: '2026-01-01T10:00:00Z',
    epoch, reentry: null, current: { phase: 'pending', commentId: '4', digest, fromStatus: 'needs-design',
      targetStatus: 'agent-ready', createdAt: '2026-01-01T10:01:00Z', epoch }, previous: null };
  return { checkpoint: { kind: 'checkpoint-snapshot-observed', headOid: 'b'.repeat(40), repositoryId: 'repo-id',
    repositoryFullName: 'owner/project', cutoverAt: record.cutoverAt, selection: { number: 1, issueId: 'issue' },
    index: { version: 1, repositoryId: 'repo-id', issues: [{ number: 1, issueId: 'issue' }] }, selectedRecord: record },
  project: { kind: 'branch-project-observed', issueNodeId: 'issue', repository: 'owner/project', issueState: 'OPEN',
    currentStatus: 'needs-design', projectId: 'project', itemId: 'item', statusFieldId: 'status', statusOptionId: 'design',
    statusOptions: [{ id: 'design', name: 'needs-design' }, { id: 'ready', name: 'agent-ready' }, { id: 'smoke', name: 'smoke' }] },
  handoffEvidence: { kind: 'evidence', handoff: { kind: 'handoff', id: '4', nodeId: 'comment', authorId: 'user',
    createdAt: record.current.createdAt, body } }, trustedAuthorIds: ['user'], expectedProjectId: 'project',
  epochProof: { kind: 'handoff-epoch-evidence', issueNodeId: 'issue', commentNodeId: 'comment', commentId: '4',
    commentCreatedAt: record.current.createdAt, commentDigest: digest, epoch } };
}

test('plans the exact status option after pending and no checkpoint write', () => {
  const result = planPendingBranchHandoff(fixture());
  assert.deepEqual(result, { kind: 'status-update-planned', projectId: 'project', itemId: 'item',
    statusFieldId: 'status', fromOptionId: 'design', targetOptionId: 'ready', expectedCheckpointOid: 'b'.repeat(40),
    issueNodeId: 'issue', commentId: '4', commentDigest: digest });
});

test('after observed target plans only committed record and does not mutate input', () => {
  const v = fixture(); v.project.currentStatus = 'agent-ready'; v.project.statusOptionId = 'ready';
  const result = planPendingBranchHandoff(v);
  assert.equal(result.kind, 'commit-handoff-planned'); assert.equal(result.record.current.phase, 'committed');
  assert.equal(result.commit.expectedHeadOid, v.checkpoint.headOid); assert.equal(v.checkpoint.selectedRecord.current.phase, 'pending');
});

test('when source equals target commits without an unnecessary Project update', () => {
  const v = fixture(); v.checkpoint.selectedRecord.current.fromStatus = 'agent-ready';
  v.project.currentStatus = 'agent-ready'; v.project.statusOptionId = 'ready';
  assert.equal(planPendingBranchHandoff(v).kind, 'commit-handoff-planned');
});

test('blocks unexpected status, missing option, mismatched issue and closed issue', () => {
  let v = fixture(); v.project.currentStatus = 'smoke'; v.project.statusOptionId = 'smoke';
  assert.equal(planPendingBranchHandoff(v).reason, 'unexpected-status');
  v = fixture(); v.project.statusOptions = v.project.statusOptions.filter(x => x.id !== 'ready');
  assert.equal(planPendingBranchHandoff(v).reason, 'status-option-mismatch');
  v = fixture(); v.project.issueNodeId = 'other'; assert.equal(planPendingBranchHandoff(v).reason, 'snapshot-mismatch');
  v = fixture(); v.project.issueState = 'CLOSED'; assert.equal(planPendingBranchHandoff(v).reason, 'issue-not-open');
  v = fixture(); v.checkpoint.index.issues = []; assert.equal(planPendingBranchHandoff(v).reason, 'snapshot-mismatch');
  v = fixture(); v.checkpoint.headOid = 'bad'; assert.equal(planPendingBranchHandoff(v).reason, 'snapshot-mismatch');
});

test('blocks changed or newer handoff, different epoch and unsupported reopen', () => {
  let v = fixture(); v.handoffEvidence.handoff.body += '!'; assert.equal(planPendingBranchHandoff(v).reason, 'handoff-mismatch');
  v = fixture(); v.handoffEvidence.handoff.id = '5'; assert.equal(planPendingBranchHandoff(v).reason, 'handoff-mismatch');
  v = fixture(); v.epochProof.epoch = { kind: 'reopened', anchor: 'event' };
  assert.equal(planPendingBranchHandoff(v).reason, 'handoff-mismatch');
  v = fixture(); v.checkpoint.selectedRecord.current.phase = 'committed';
  assert.equal(planPendingBranchHandoff(v).reason, 'unsupported-checkpoint');
});

test('blocks a newer selected handoff, untrusted author and a different configured Project', () => {
  let v = fixture(); v.handoffEvidence.handoff = { ...v.handoffEvidence.handoff, id: '5', nodeId: 'newer',
    createdAt: '2026-01-01T10:02:00Z' };
  assert.equal(planPendingBranchHandoff(v).reason, 'handoff-mismatch');
  v = fixture(); v.handoffEvidence.handoff.authorId = 'other'; assert.equal(planPendingBranchHandoff(v).reason, 'handoff-mismatch');
  v = fixture(); v.expectedProjectId = 'other'; assert.equal(planPendingBranchHandoff(v).reason, 'snapshot-mismatch');
  v = fixture(); delete v.handoffEvidence; assert.equal(planPendingBranchHandoff(v).reason, 'invalid-evidence');
});
