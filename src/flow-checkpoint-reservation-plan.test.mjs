import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planStatusReservation, planReservedHandoffCommit, planUnchangedHandoffCommit } from './flow-checkpoint-reservation-plan.mjs';

const body = '[FLOW]\nRola: Designer\nStan docelowy: agent-ready\nWykonano: Praca\nNastępny krok: Kod';
const digest = createHash('sha256').update(body).digest('hex');
function fixture() {
  const epoch = { kind: 'initial', anchor: 'issue' };
  const record = { version: 2, repositoryId: 'repo-id', number: 1, issueId: 'issue', cutoverAt: '2026-01-01T10:00:00Z',
    epoch, reentry: null, current: { phase: 'pending', commentId: '4', digest, fromStatus: 'needs-design',
      targetStatus: 'agent-ready', createdAt: '2026-01-01T10:01:00Z', epoch }, previous: null, reservation: null };
  return { reservedAt: '2026-01-01T10:02:00Z', registration: { repositoryId: 'repo-id', ref: 'refs/heads/agent-github-flow/checkpoints',
    genesisOid: 'a'.repeat(40), cutoverAt: record.cutoverAt, checkpointSchemaVersion: 2 },
    checkpoint: { kind: 'checkpoint-snapshot-observed', schemaVersion: 2, headOid: 'b'.repeat(40), repositoryId: 'repo-id',
      repositoryFullName: 'owner/project', cutoverAt: record.cutoverAt, selection: { number: 1, issueId: 'issue' },
      index: { version: 1, repositoryId: 'repo-id', issues: [{ number: 1, issueId: 'issue' }] }, selectedRecord: record },
    project: { kind: 'branch-project-observed', issueNodeId: 'issue', repository: 'owner/project', issueState: 'OPEN',
      currentStatus: 'needs-design', projectId: 'project', itemId: 'item', statusFieldId: 'status', statusOptionId: 'design',
      statusOptions: [{ id: 'design', name: 'needs-design' }, { id: 'ready', name: 'agent-ready' }] },
    handoffEvidence: { kind: 'evidence', handoff: { kind: 'handoff', id: '4', nodeId: 'comment', authorId: 'user',
      createdAt: record.current.createdAt, body } }, trustedAuthorIds: ['user'], expectedProjectId: 'project',
    epochProof: { kind: 'handoff-epoch-evidence', issueNodeId: 'issue', commentNodeId: 'comment', commentId: '4',
      commentCreatedAt: record.current.createdAt, commentDigest: digest, epoch } };
}

test('plans reservation of the exact observed source and target options against current HEAD', () => {
  const value = fixture(), result = planStatusReservation(value);
  assert.equal(result.kind, 'status-reservation-planned');
  assert.deepEqual(result.record.reservation, { reservedAt: value.reservedAt, fromOptionId: 'design', targetOptionId: 'ready' });
  assert.equal(result.commit.expectedHeadOid, value.checkpoint.headOid);
  assert.equal(value.checkpoint.selectedRecord.reservation, null);
});

test('blocks changed handoff, issue, status, field options, v1 or untrusted registration', () => {
  for (const change of [
    v => { v.handoffEvidence.handoff.body += '!'; },
    v => { v.project.issueState = 'CLOSED'; },
    v => { v.project.currentStatus = 'agent-ready'; v.project.statusOptionId = 'ready'; },
    v => { v.project.statusOptions[1].id = 'design'; },
    v => { v.checkpoint.schemaVersion = 1; },
    v => { v.registration.repositoryId = 'other'; },
    v => { v.reservedAt = 'not-a-time'; }
  ]) { const v = fixture(); change(v); assert.equal(planStatusReservation(v).kind, 'blocked'); }
});

test('later reservation preserves observed option IDs and must advance its timestamp', () => {
  const value = fixture(); value.checkpoint.selectedRecord.reservation = { reservedAt: '2026-01-01T10:01:30Z', fromOptionId: 'design', targetOptionId: 'ready' };
  assert.equal(planStatusReservation(value).kind, 'status-reservation-planned');
  value.checkpoint.selectedRecord.reservation.targetOptionId = 'old-ready';
  assert.equal(planStatusReservation(value).kind, 'blocked');
  value.checkpoint.selectedRecord.reservation.targetOptionId = 'ready'; value.reservedAt = '2026-01-01T10:01:30Z';
  assert.equal(planStatusReservation(value).kind, 'blocked');
});

test('plans final v2 checkpoint only after the reserved target is observed', () => {
  const v = fixture(); v.checkpoint.selectedRecord.reservation = { reservedAt: v.reservedAt, fromOptionId: 'design', targetOptionId: 'ready' };
  assert.equal(planReservedHandoffCommit(v).kind, 'blocked');
  v.project.currentStatus = 'agent-ready'; v.project.statusOptionId = 'ready';
  const result = planReservedHandoffCommit(v);
  assert.equal(result.kind, 'commit-handoff-v2-planned'); assert.equal(result.record.current.phase, 'committed');
  assert.equal(result.record.reservation, null); assert.equal(result.commit.expectedHeadOid, v.checkpoint.headOid);
  v.project.statusOptions[0].id = 'changed'; assert.equal(planReservedHandoffCommit(v).kind, 'blocked');
});

test('allows a handoff with unchanged status without manufacturing a reservation', () => {
  const v = fixture();v.checkpoint.selectedRecord.current.fromStatus = 'agent-ready';
  v.project.currentStatus = 'agent-ready';v.project.statusOptionId = 'ready';
  const plan = planUnchangedHandoffCommit(v);
  assert.equal(plan.kind, 'commit-handoff-v2-planned');assert.equal(plan.record.reservation, null);
  assert.equal(plan.record.current.phase, 'committed');assert.equal(plan.commit.expectedHeadOid, v.checkpoint.headOid);
  v.project.currentStatus = 'needs-design';v.project.statusOptionId = 'design';assert.equal(planUnchangedHandoffCommit(v).kind, 'blocked');
  v.project.currentStatus = 'agent-ready';v.project.statusOptionId = 'ready';v.handoffEvidence.handoff.body += '!';
  assert.equal(planUnchangedHandoffCommit(v).kind, 'blocked');
});
