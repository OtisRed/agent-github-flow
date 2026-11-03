import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planInitialBranchHandoff, planInitialV2Handoff } from './flow-checkpoint-initial-handoff.mjs';
import { planPendingBranchHandoff } from './flow-checkpoint-pending-handoff.mjs';
import { planStatusReservation, planReservedHandoffCommit, planUnchangedHandoffCommit } from './flow-checkpoint-reservation-plan.mjs';
import { runInitialPublicationStep, runPendingCommitPublicationStep, runStatusReservationPublicationStep, runReservedCommitPublicationStep, runInitialV2PublicationStep, runUnchangedCommitPublicationStep } from './flow-initial-publication-step.mjs';

function fixture() {
  const body='[FLOW]\nRola: Designer\nStan docelowy: agent-ready\nWykonano: Praca\nNastępny krok: Kod';
  const epoch={kind:'initial',anchor:'issue'}, createdAt='2026-01-01T10:01:00Z';
  const handoff={kind:'handoff',id:'4',nodeId:'comment',authorId:'user',createdAt,body};
  const base={checkpoint:{kind:'checkpoint-snapshot-observed',headOid:'b'.repeat(40),repositoryId:'repo-id',
    repositoryFullName:'owner/project',cutoverAt:'2026-01-01T10:00:00Z',selection:{number:1,issueId:'issue'},
    index:{version:1,repositoryId:'repo-id',issues:[]},selectedRecord:null},
    project:{kind:'branch-project-observed',issueNodeId:'issue',repository:'owner/project',issueState:'OPEN',currentStatus:'needs-design',
      projectId:'project',itemId:'item',statusFieldId:'status',statusOptionId:'design',
      statusOptions:[{id:'design',name:'needs-design'},{id:'ready',name:'agent-ready'}]},
    handoffEvidence:{kind:'evidence',handoff},trustedAuthorIds:['user'],expectedProjectId:'project',
    epochProof:{kind:'handoff-epoch-evidence',issueNodeId:'issue',commentNodeId:'comment',commentId:'4',commentCreatedAt:createdAt,
      commentDigest:createHash('sha256').update(body).digest('hex'),epoch}};
  const policy={repositoryId:'repo-id',repository:'owner/project',projectId:'project',issueId:'issue',issueNumber:1,statusFieldId:'status',trustedAuthorIds:['user'],
    appId:12,updateRulesetId:1,historyRulesetId:2};
  const protection={kind:'checkpoint-protection-observed',repositoryId:'repo-id',appId:12,updateRulesetId:1,historyRulesetId:2};
  const plan=planInitialBranchHandoff(base);assert.equal(plan.kind,'initial-handoff-planned');
  const after=structuredClone(base);after.checkpoint.headOid='c'.repeat(40);after.checkpoint.selectedRecord=structuredClone(plan.record);
  after.checkpoint.index=JSON.parse(Buffer.from(plan.commit.additions.find(x=>x.path==='index.json').contents,'base64').toString());
  const state={base,after,protection,calls:[],published:false,changeAfterPrepare:false,write:'ref-update-acknowledged',seen:'publication-observed'};
  const input={policy,collect:async()=>{state.calls.push('collect');return structuredClone(state.published?state.after:state.base);},
    verifyProtection:async()=>{state.calls.push('audit');return structuredClone(state.protection);},
    prepare:async({snapshot,after:record})=>{state.calls.push('prepare');assert.deepEqual(snapshot,base.checkpoint);assert.deepEqual(record,plan.record);
      if(state.changeAfterPrepare)state.base.project.currentStatus='review';
      return {kind:'checkpoint-objects-prepared',expectedHeadOid:'b'.repeat(40),expectedTreeOid:'d'.repeat(40),
        commit:{sha:'c'.repeat(40),tree:{sha:'d'.repeat(40)},parents:[{sha:'b'.repeat(40)}]}};},
    publish:async()=>{state.calls.push('publish');state.published=true;return {kind:state.write};},
    observe:async()=>{state.calls.push('observe');return {kind:state.seen};}};
  return {state,input};
}
test('publishes one pending checkpoint only after fresh full audits and verifies its readback',async()=>{
  const f=fixture();const result=await runInitialPublicationStep(f.input);assert.equal(result.kind,'initial-pending-observed');
  assert.equal(result.binding.issueId,'issue');assert.equal(result.binding.issueNumber,1);assert.equal(result.binding.checkpointOid,'c'.repeat(40));
  assert.deepEqual(f.state.calls,['collect','audit','collect','prepare','collect','audit','publish','observe','collect','audit']);
});

test('publishes the initial v2 checkpoint only with an explicit registration',async()=>{
  const f=fixture();f.state.base.checkpoint.schemaVersion=2;
  const registration={repositoryId:'repo-id',ref:'refs/heads/agent-github-flow/checkpoints',genesisOid:'a'.repeat(40),
    cutoverAt:f.state.base.checkpoint.cutoverAt,checkpointSchemaVersion:2};
  const plan=planInitialV2Handoff({...f.state.base,registration});assert.equal(plan.kind,'initial-handoff-v2-planned');
  f.state.after=structuredClone(f.state.base);f.state.after.checkpoint.headOid='c'.repeat(40);
  f.state.after.checkpoint.selectedRecord=structuredClone(plan.record);
  f.state.after.checkpoint.index=JSON.parse(Buffer.from(plan.commit.additions.find(x=>x.path==='index.json').contents,'base64').toString());
  f.input.registration=registration;
  f.input.prepare=async({snapshot,after,registration:actual})=>{assert.deepEqual(snapshot,f.state.base.checkpoint);assert.deepEqual(after,plan.record);
    assert.deepEqual(actual,registration);return {kind:'checkpoint-objects-prepared',expectedHeadOid:'b'.repeat(40),expectedTreeOid:'d'.repeat(40),
      commit:{sha:'c'.repeat(40),tree:{sha:'d'.repeat(40)},parents:[{sha:'b'.repeat(40)}]}};};
  const result=await runInitialV2PublicationStep(f.input);
  assert.equal(result.kind,'initial-v2-pending-observed');assert.equal(result.binding.checkpointOid,'c'.repeat(40));
});

test('initial v2 does not prepare or publish against an unrelated registration',async()=>{
  for (const change of ['repositoryId','cutoverAt']) {
    const f=fixture();f.state.base.checkpoint.schemaVersion=2;
    f.input.registration={repositoryId:'repo-id',ref:'refs/heads/agent-github-flow/checkpoints',genesisOid:'a'.repeat(40),
      cutoverAt:f.state.base.checkpoint.cutoverAt,checkpointSchemaVersion:2};
    f.input.registration[change]=change==='repositoryId'?'other':'2025-01-01T00:00:00Z';
    assert.equal((await runInitialV2PublicationStep(f.input)).reason,'initial-v2-step-not-applicable');
    assert.equal(f.state.calls.includes('prepare'),false);assert.equal(f.state.calls.includes('publish'),false);
  }
});
test('does not publish without protection or when the source changes during preparation',async()=>{
  let f=fixture();f.state.protection.historyRulesetId=9;
  assert.equal((await runInitialPublicationStep(f.input)).reason,'protection-unverified');assert.equal(f.state.calls.includes('publish'),false);
  f=fixture();f.state.changeAfterPrepare=true;
  assert.equal((await runInitialPublicationStep(f.input)).reason,'publication-preflight-changed');assert.equal(f.state.calls.includes('publish'),false);
});
test('never retries an uncertain write and never reports success without readback',async()=>{
  let f=fixture();f.state.write='ref-update-uncertain';
  assert.deepEqual(await runInitialPublicationStep(f.input),{kind:'publication-uncertain',retryAllowed:false});
  assert.equal(f.state.calls.filter(x=>x==='publish').length,1);assert.equal(f.state.calls.at(-1),'observe');
  f=fixture();f.state.seen='publication-not-observed';
  assert.equal((await runInitialPublicationStep(f.input)).kind,'publication-uncertain');assert.equal(f.state.calls.filter(x=>x==='publish').length,1);
  f=fixture();f.state.after.checkpoint.selectedRecord.current.targetStatus='smoke';
  assert.equal((await runInitialPublicationStep(f.input)).kind,'publication-uncertain');
});
test('rejects mismatched routing before object creation',async()=>{
  const f=fixture();f.input.policy.projectId='other';assert.equal((await runInitialPublicationStep(f.input)).reason,'policy-mismatch');
  assert.deepEqual(f.state.calls,['collect']);
  for(const [key,value] of [['issueId','different'],['issueNumber',2]]){
    const other=fixture();other.input.policy[key]=value;
    assert.equal((await runInitialPublicationStep(other.input)).reason,'policy-mismatch');assert.deepEqual(other.state.calls,['collect']);
  }
});
test('does not publish if protection changes during final snapshot read',async()=>{
  const f=fixture();const original=f.input.collect;let count=0;
  f.input.collect=async()=>{const result=await original();if(++count===3)f.state.protection.historyRulesetId=9;return result;};
  assert.equal((await runInitialPublicationStep(f.input)).reason,'publication-preflight-changed');
  assert.equal(f.state.calls.includes('publish'),false);
});
test('commits an existing pending checkpoint only after observing the target status',async()=>{
  const f=fixture();const pending=structuredClone(f.state.after);
  pending.project.currentStatus='agent-ready';pending.project.statusOptionId='ready';
  const plan=planPendingBranchHandoff(pending);assert.equal(plan.kind,'commit-handoff-planned');
  const committed=structuredClone(pending);committed.checkpoint.headOid='e'.repeat(40);committed.checkpoint.selectedRecord=structuredClone(plan.record);
  f.state.base=pending;f.state.after=committed;
  f.input.expectedBinding={repositoryId:'repo-id',repository:'owner/project',projectId:'project',statusFieldId:'status',issueId:'issue',issueNumber:1,
    appId:12,updateRulesetId:1,historyRulesetId:2,trustedAuthorIds:['user'],
    commentId:plan.record.current.commentId,commentDigest:plan.record.current.digest,checkpointOid:'c'.repeat(40)};
  f.input.prepare=async({snapshot,after})=>{f.state.calls.push('prepare');assert.deepEqual(snapshot,pending.checkpoint);assert.deepEqual(after,plan.record);
    return {kind:'checkpoint-objects-prepared',expectedHeadOid:'c'.repeat(40),expectedTreeOid:'d'.repeat(40),
      commit:{sha:'e'.repeat(40),tree:{sha:'d'.repeat(40)},parents:[{sha:'c'.repeat(40)}]}};};
  const result=await runPendingCommitPublicationStep(f.input);assert.equal(result.kind,'pending-commit-observed');
  assert.equal(result.binding.issueId,'issue');assert.equal(result.binding.checkpointOid,'c'.repeat(40));
  const another=fixture();another.state.base=structuredClone(pending);another.state.base.project.currentStatus='needs-design';another.state.base.project.statusOptionId='design';
  assert.equal((await runPendingCommitPublicationStep(another.input)).reason,'pending-commit-not-applicable');
  assert.equal(another.state.calls.includes('publish'),false);
});
test('does not commit pending if the expected checkpoint belongs to another handoff',async()=>{
  const f=fixture();const pending=structuredClone(f.state.after);pending.project.currentStatus='agent-ready';pending.project.statusOptionId='ready';
  f.state.base=pending;const plan=planPendingBranchHandoff(pending);
  f.input.expectedBinding={repositoryId:'repo-id',repository:'owner/project',projectId:'project',statusFieldId:'status',issueId:'issue',issueNumber:1,
    appId:12,updateRulesetId:1,historyRulesetId:2,trustedAuthorIds:['user'],
    commentId:'other',commentDigest:plan.record.current.digest,checkpointOid:'c'.repeat(40)};
  assert.equal((await runPendingCommitPublicationStep(f.input)).reason,'handoff-binding-mismatch');
  assert.equal(f.state.calls.includes('prepare'),false);assert.equal(f.state.calls.includes('publish'),false);
});
test('retains the initial-step refusal reason for an existing checkpoint',async()=>{
  const f=fixture();f.state.base=structuredClone(f.state.after);
  assert.equal((await runInitialPublicationStep(f.input)).reason,'initial-step-not-applicable');
  assert.equal(f.state.calls.includes('publish'),false);
});

function reservationFixture(){
  const f=fixture(); const pending=structuredClone(f.state.after); pending.checkpoint.schemaVersion=2;
  pending.checkpoint.selectedRecord.version=2;pending.checkpoint.selectedRecord.reservation=null;
  const registration={repositoryId:'repo-id',ref:'refs/heads/agent-github-flow/checkpoints',genesisOid:'a'.repeat(40),
    cutoverAt:pending.checkpoint.cutoverAt,checkpointSchemaVersion:2};
  const reservedAt='2026-01-01T10:02:00Z';const plan=planStatusReservation({...pending,registration,reservedAt});
  assert.equal(plan.kind,'status-reservation-planned');
  const after=structuredClone(pending);after.checkpoint.headOid='e'.repeat(40);after.checkpoint.selectedRecord=structuredClone(plan.record);
  f.state.base=pending;f.state.after=after;f.input.registration=registration;f.input.reservedAt=reservedAt;
  f.input.expectedBinding={...f.input.policy,commentId:'4',commentDigest:pending.checkpoint.selectedRecord.current.digest,checkpointOid:'c'.repeat(40)};
  f.input.prepare=async({snapshot,after:record,registration:actual})=>{f.state.calls.push('prepare');assert.deepEqual(snapshot,pending.checkpoint);
    assert.deepEqual(record,plan.record);assert.deepEqual(actual,registration);return {kind:'checkpoint-objects-prepared',expectedHeadOid:'c'.repeat(40),
      expectedTreeOid:'d'.repeat(40),commit:{sha:'e'.repeat(40),tree:{sha:'d'.repeat(40)},parents:[{sha:'c'.repeat(40)}]}};};
  return f;
}
test('publishes a v2 reservation exactly once and returns binding to the new HEAD',async()=>{
  const f=reservationFixture();const result=await runStatusReservationPublicationStep(f.input);
  assert.equal(result.kind,'status-reservation-observed');assert.equal(result.binding.checkpointOid,'e'.repeat(40));
  assert.equal(f.state.calls.filter(x=>x==='publish').length,1);
});

test('reservation refuses changed binding, protection and observations before publishing',async()=>{
  let f=reservationFixture();f.input.expectedBinding.commentId='other';
  assert.equal((await runStatusReservationPublicationStep(f.input)).reason,'handoff-binding-mismatch');
  assert.equal(f.state.calls.includes('prepare'),false);
  f=reservationFixture();f.state.protection.historyRulesetId=9;
  assert.equal((await runStatusReservationPublicationStep(f.input)).reason,'protection-unverified');
  assert.equal(f.state.calls.includes('publish'),false);
  f=reservationFixture();const collect=f.input.collect;let count=0;
  f.input.collect=async()=>{const result=await collect();if(++count===3)result.project.statusOptionId='changed';return result;};
  assert.equal((await runStatusReservationPublicationStep(f.input)).reason,'publication-preflight-changed');
  assert.equal(f.state.calls.includes('publish'),false);
});

test('an uncertain reservation publication is not retried or accepted as observed',async()=>{
  const f=reservationFixture();f.state.write='ref-update-uncertain';
  assert.deepEqual(await runStatusReservationPublicationStep(f.input),{kind:'publication-uncertain',retryAllowed:false});
  assert.equal(f.state.calls.filter(x=>x==='publish').length,1);
});

function reservedCommitFixture(){
  const f=reservationFixture(),pending=f.state.base;pending.checkpoint.selectedRecord.reservation={reservedAt:f.input.reservedAt,fromOptionId:'design',targetOptionId:'ready'};
  pending.project.currentStatus='agent-ready';pending.project.statusOptionId='ready';
  const plan=planReservedHandoffCommit({...pending,registration:f.input.registration});assert.equal(plan.kind,'commit-handoff-v2-planned');
  f.state.after=structuredClone(pending);f.state.after.checkpoint.headOid='e'.repeat(40);f.state.after.checkpoint.selectedRecord=structuredClone(plan.record);
  f.input.prepare=async({snapshot,after,registration})=>{f.state.calls.push('prepare');assert.deepEqual(snapshot,pending.checkpoint);
    assert.deepEqual(after,plan.record);assert.deepEqual(registration,f.input.registration);
    return {kind:'checkpoint-objects-prepared',expectedHeadOid:'c'.repeat(40),expectedTreeOid:'d'.repeat(40),
      commit:{sha:'e'.repeat(40),tree:{sha:'d'.repeat(40)},parents:[{sha:'c'.repeat(40)}]}};};
  return f;
}

test('publishes committed v2 after observing the reserved target status',async()=>{
  const f=reservedCommitFixture(),result=await runReservedCommitPublicationStep(f.input);
  assert.equal(result.kind,'reserved-commit-observed');assert.equal(result.binding.checkpointOid,'c'.repeat(40));
  assert.equal(f.state.calls.filter(x=>x==='publish').length,1);
});

test('blocks final v2 commit before target or on wrong binding, and does not retry uncertainty',async()=>{
  let f=reservedCommitFixture();f.state.base.project.currentStatus='needs-design';f.state.base.project.statusOptionId='design';
  assert.equal((await runReservedCommitPublicationStep(f.input)).reason,'reserved-commit-not-applicable');assert.equal(f.state.calls.includes('publish'),false);
  f=reservedCommitFixture();f.input.expectedBinding.checkpointOid='b'.repeat(40);
  assert.equal((await runReservedCommitPublicationStep(f.input)).reason,'handoff-binding-mismatch');assert.equal(f.state.calls.includes('prepare'),false);
  f=reservedCommitFixture();f.state.write='ref-update-uncertain';
  assert.deepEqual(await runReservedCommitPublicationStep(f.input),{kind:'publication-uncertain',retryAllowed:false});
  assert.equal(f.state.calls.filter(x=>x==='publish').length,1);
});

test('commits an unchanged status without a Project mutation or reservation',async()=>{
  const f=reservationFixture(),pending=f.state.base;pending.checkpoint.selectedRecord.current.fromStatus='agent-ready';
  pending.project.currentStatus='agent-ready';pending.project.statusOptionId='ready';
  const plan=planUnchangedHandoffCommit({...pending,registration:f.input.registration});assert.equal(plan.kind,'commit-handoff-v2-planned');
  f.state.after=structuredClone(pending);f.state.after.checkpoint.headOid='e'.repeat(40);f.state.after.checkpoint.selectedRecord=structuredClone(plan.record);
  f.input.prepare=async({snapshot,after})=>{assert.deepEqual(snapshot,pending.checkpoint);assert.deepEqual(after,plan.record);
    return {kind:'checkpoint-objects-prepared',expectedHeadOid:'c'.repeat(40),expectedTreeOid:'d'.repeat(40),
      commit:{sha:'e'.repeat(40),tree:{sha:'d'.repeat(40)},parents:[{sha:'c'.repeat(40)}]}};};
  const result=await runUnchangedCommitPublicationStep(f.input);
  assert.equal(result.kind,'unchanged-commit-observed');assert.equal(result.binding.checkpointOid,'c'.repeat(40));
});

test('unchanged status cannot commit a different handoff binding',async()=>{
  const f=reservationFixture(),pending=f.state.base;pending.checkpoint.selectedRecord.current.fromStatus='agent-ready';
  pending.project.currentStatus='agent-ready';pending.project.statusOptionId='ready';f.input.expectedBinding.commentId='other';
  assert.equal((await runUnchangedCommitPublicationStep(f.input)).reason,'handoff-binding-mismatch');
  assert.equal(f.state.calls.includes('prepare'),false);assert.equal(f.state.calls.includes('publish'),false);
});
