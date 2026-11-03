import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planStatusReservation, planReservedHandoffCommit, planUnchangedHandoffCommit } from './flow-checkpoint-reservation-plan.mjs';
import { inspectV3ReservedHandoff, planV3StatusReservation, planV3HandoffCommit } from './flow-v3-reservation-plan.mjs';
import { createCheckpointKeyring } from './flow-checkpoint-keyring.mjs';
import { FLOW_STATUSES } from './flow.mjs';
import { verifyV3Preparation } from './flow-v3-preparation-guard.mjs';

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

function fixtureV3(){
  const v=fixture();v.checkpoint.schemaVersion=3;v.registration.checkpointSchemaVersion=3;
  v.project.statusFieldName='Status';v.project.statusOptions=FLOW_STATUSES.map((name,index)=>({name,
    id:name==='needs-design'?'design':name==='agent-ready'?'ready':`private-option-${index}`}));
  v.repository={node_id:'repo-id',full_name:'owner/project',private:false,fork:false};
  v.projectRegistration={version:3,source:'a'.repeat(32),repository:'owner/project',repositoryId:'repo-id',expectedPrivate:false,
    dataPolicy:'common-v3',projectOwner:'board-owner',projectNumber:1,projectId:'project',statusFieldId:'status',statusFieldName:'Status',
    statusOptions:structuredClone(v.project.statusOptions),appId:12,updateRulesetId:1,historyRulesetId:2,trustedAuthorIds:['user'],checkpoint:structuredClone(v.registration)};
  v.keyring=createCheckpointKeyring({currentKeyId:1,keys:[{id:1,key:Buffer.alloc(32,1)}]});
  const record=v.checkpoint.selectedRecord;record.version=3;delete record.current.digest;
  record.current.commentKeyId=1;record.current.commentMac=v.keyring.current().comment({repositoryId:'repo-id',issueId:'issue',commentId:'4',body});
  record.current.configKeyId=1;record.current.configMac=v.keyring.current().config(v.projectRegistration);return v;
}

test('v3 reserves and completes a verified handoff without publishing private configuration',()=>{
  const v=fixtureV3(),first=planV3StatusReservation(v);assert.equal(first.kind,'v3-status-reservation-planned');
  assert.deepEqual(first.record.reservation,{reservedAt:v.reservedAt});
  assert.equal(verifyV3Preparation({...v,after:first.record}).kind,'v3-preparation-consistent');
  const forged=structuredClone(first.record);forged.current.configMac='d'.repeat(64);
  assert.equal(verifyV3Preparation({...v,after:forged}).kind,'blocked');
  const noReservation=structuredClone(v.checkpoint.selectedRecord);noReservation.current.phase='committed';
  assert.equal(verifyV3Preparation({...v,after:noReservation}).kind,'blocked');
  const wrongTime=structuredClone(first.record);wrongTime.reservation.reservedAt='not-a-time';
  assert.equal(verifyV3Preparation({...v,after:wrongTime}).kind,'blocked');
  const published=first.commit.additions.map(entry=>Buffer.from(entry.contents,'base64').toString()).join('\n');
  assert.equal(published.includes('private-option-'),false);assert.equal(published.includes(body),false);
  v.checkpoint.selectedRecord=first.record;assert.equal(inspectV3ReservedHandoff(v).kind,'status-update-planned');
  assert.equal(planV3HandoffCommit(v).kind,'blocked');
  v.project.currentStatus='agent-ready';v.project.statusOptionId='ready';
  assert.equal(inspectV3ReservedHandoff(v).kind,'commit-handoff-planned');
  const done=planV3HandoffCommit(v);assert.equal(done.kind,'v3-commit-handoff-planned');
  assert.equal(verifyV3Preparation({...v,after:done.record}).kind,'v3-preparation-consistent');
  assert.equal(done.record.reservation,null);assert.equal(done.record.current.phase,'committed');
});

test('v3 requires fresh matching configuration and checkpoint for retry and completion',()=>{
  let v=fixtureV3();v.checkpoint.selectedRecord.reservation={reservedAt:'2026-01-01T10:01:30Z'};
  assert.equal(planV3StatusReservation(v).kind,'v3-status-reservation-planned');
  v.reservedAt='2026-01-01T10:01:30Z';assert.equal(planV3StatusReservation(v).kind,'blocked');
  v=fixtureV3();v.project.statusOptions[0].id='changed';assert.equal(planV3StatusReservation(v).kind,'blocked');
  v=fixtureV3();v.handoffEvidence.handoff.body+='edited';assert.equal(planV3StatusReservation(v).kind,'blocked');
  v=fixtureV3();v.repository.private=true;assert.equal(planV3StatusReservation(v).kind,'blocked');
  v=fixtureV3();v.checkpoint.repositoryFullName='owner/other';assert.equal(planV3StatusReservation(v).kind,'blocked');
  v=fixtureV3();v.project.currentStatus='agent-ready';v.project.statusOptionId='ready';assert.equal(planV3HandoffCommit(v).kind,'blocked');
  v=fixtureV3();v.keyring={forId:()=>null};assert.equal(planV3StatusReservation(v).kind,'blocked');
});

test('v3 can commit an unchanged status without inventing a reservation',()=>{
  const v=fixtureV3();v.checkpoint.selectedRecord.current.fromStatus='agent-ready';
  v.project.currentStatus='agent-ready';v.project.statusOptionId='ready';
  const done=planV3HandoffCommit(v);assert.equal(done.kind,'v3-commit-handoff-planned');assert.equal(done.record.reservation,null);
  assert.equal(planV3StatusReservation(v).kind,'blocked');
});
