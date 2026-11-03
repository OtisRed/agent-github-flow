import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planInitialBranchHandoff } from './flow-checkpoint-initial-handoff.mjs';

const body = '[FLOW]\nRola: Designer\nStan docelowy: agent-ready\nWykonano: Praca\nNastępny krok: Kod';
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
function fixture() {
  const epoch = { kind: 'initial', anchor: 'issue' };
  const handoff = { kind: 'handoff', id: '4', nodeId: 'comment', authorId: 'user', createdAt: '2026-01-01T10:01:00Z', body };
  return { checkpoint: { kind: 'checkpoint-snapshot-observed', headOid: 'b'.repeat(40), repositoryId: 'repo-id',
    repositoryFullName: 'owner/project', cutoverAt: '2026-01-01T10:00:00Z', selection: { number: 1, issueId: 'issue' },
    index: { version: 1, repositoryId: 'repo-id', issues: [] }, selectedRecord: null },
  project: { kind: 'branch-project-observed', issueNodeId: 'issue', repository: 'owner/project', issueState: 'OPEN',
    currentStatus: 'needs-design', projectId: 'project', itemId: 'item', statusFieldId: 'status', statusOptionId: 'design',
    statusOptions: [{ id: 'design', name: 'needs-design' }, { id: 'ready', name: 'agent-ready' }] },
  handoffEvidence: { kind: 'evidence', handoff }, trustedAuthorIds: ['user'], expectedProjectId: 'project',
  epochProof: { kind: 'handoff-epoch-evidence', issueNodeId: 'issue', commentNodeId: 'comment', commentId: '4',
    commentCreatedAt: handoff.createdAt, commentDigest: digest(body), epoch } };
}

test('plans only a pending record tied to the observed Project and checkpoint HEAD', () => {
  const value = fixture(); const result = planInitialBranchHandoff(value);
  assert.equal(result.kind, 'initial-handoff-planned');
  assert.equal(result.record.current.phase, 'pending'); assert.equal(result.record.current.fromStatus, 'needs-design');
  assert.equal(result.record.current.targetStatus, 'agent-ready'); assert.equal(result.record.current.digest, digest(body));
  assert.equal(result.commit.expectedHeadOid, value.checkpoint.headOid);
  assert.deepEqual(result.commit.additions.map(item => item.path), ['index.json', 'issues/1.json']);
  assert.equal(result.itemId, 'item');
  assert.equal(result.targetOptionId, 'ready');
});

test('rejects foreign card or repository, an existing record, closed issues and done', () => {
  let v = fixture(); v.project.issueNodeId = 'other'; assert.equal(planInitialBranchHandoff(v).reason, 'snapshot-mismatch');
  v = fixture(); v.project.repository = 'owner/other'; assert.equal(planInitialBranchHandoff(v).reason, 'snapshot-mismatch');
  v = fixture(); v.checkpoint.selectedRecord = {}; assert.equal(planInitialBranchHandoff(v).reason, 'snapshot-mismatch');
  v = fixture(); v.project.issueState = 'CLOSED'; assert.equal(planInitialBranchHandoff(v).reason, 'inactive-issue-or-status');
  v = fixture(); v.project.currentStatus = 'done'; assert.equal(planInitialBranchHandoff(v).reason, 'inactive-issue-or-status');
  v = fixture(); v.handoffEvidence.handoff.body = body.replace('agent-ready', 'done'); assert.equal(planInitialBranchHandoff(v).reason, 'invalid-handoff');
});

test('rejects altered comments, foreign epochs and handoff at cutover', () => {
  let v = fixture(); v.handoffEvidence.handoff.body += '!'; assert.equal(planInitialBranchHandoff(v).reason, 'unverified-epoch');
  v = fixture(); v.epochProof.epoch = { kind: 'reopened', anchor: 'event' }; assert.equal(planInitialBranchHandoff(v).reason, 'unverified-epoch');
  v = fixture(); v.handoffEvidence.handoff.createdAt = v.checkpoint.cutoverAt; v.epochProof.commentCreatedAt = v.handoffEvidence.handoff.createdAt;
  assert.equal(planInitialBranchHandoff(v).reason, 'handoff-before-cutover');
  v = fixture(); v.epochProof.commentNodeId = 'other'; assert.equal(planInitialBranchHandoff(v).reason, 'unverified-epoch');
});

test('rejects malformed flow and a contradictory index rather than inventing a bootstrap', () => {
  let v = fixture(); v.handoffEvidence.handoff.body = 'text'; assert.equal(planInitialBranchHandoff(v).reason, 'invalid-handoff');
  v = fixture(); v.checkpoint.index.issues.push({ number: 1, issueId: 'issue' });
  assert.equal(planInitialBranchHandoff(v).reason, 'index-record-mismatch');
});

test('requires an allowed author and the registered target Project', () => {
  let v = fixture(); v.handoffEvidence.handoff.authorId = 'other'; assert.equal(planInitialBranchHandoff(v).reason, 'invalid-handoff');
  v = fixture(); v.expectedProjectId = 'other'; assert.equal(planInitialBranchHandoff(v).reason, 'snapshot-mismatch');
  v = fixture(); delete v.handoffEvidence; assert.equal(planInitialBranchHandoff(v).reason, 'invalid-evidence');
});

test('does not plan an unrepresentable or ambiguous Project status', () => {
  let v = fixture(); v.project.statusOptions.pop(); assert.equal(planInitialBranchHandoff(v).reason, 'status-option-mismatch');
  v = fixture(); v.project.statusOptionId = 'other'; assert.equal(planInitialBranchHandoff(v).reason, 'status-option-mismatch');
  v = fixture(); v.project.statusOptions.push({ id: 'another', name: 'agent-ready' });
  assert.equal(planInitialBranchHandoff(v).reason, 'invalid-status-options');
});
