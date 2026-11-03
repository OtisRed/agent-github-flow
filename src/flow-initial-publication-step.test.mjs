import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planInitialBranchHandoff } from './flow-checkpoint-initial-handoff.mjs';
import { planPendingBranchHandoff } from './flow-checkpoint-pending-handoff.mjs';
import { runInitialPublicationStep, runPendingCommitPublicationStep } from './flow-initial-publication-step.mjs';

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
  const policy={repositoryId:'repo-id',repository:'owner/project',projectId:'project',statusFieldId:'status',trustedAuthorIds:['user'],
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
  const f=fixture();assert.deepEqual(await runInitialPublicationStep(f.input),{kind:'initial-pending-observed',retryAllowed:false});
  assert.deepEqual(f.state.calls,['collect','audit','collect','prepare','collect','audit','publish','observe','collect','audit']);
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
  f.input.prepare=async({snapshot,after})=>{f.state.calls.push('prepare');assert.deepEqual(snapshot,pending.checkpoint);assert.deepEqual(after,plan.record);
    return {kind:'checkpoint-objects-prepared',expectedHeadOid:'c'.repeat(40),expectedTreeOid:'d'.repeat(40),
      commit:{sha:'e'.repeat(40),tree:{sha:'d'.repeat(40)},parents:[{sha:'c'.repeat(40)}]}};};
  assert.deepEqual(await runPendingCommitPublicationStep(f.input),{kind:'pending-commit-observed',retryAllowed:false});
  const another=fixture();another.state.base=structuredClone(pending);another.state.base.project.currentStatus='needs-design';another.state.base.project.statusOptionId='design';
  assert.equal((await runPendingCommitPublicationStep(another.input)).reason,'pending-commit-not-applicable');
  assert.equal(another.state.calls.includes('publish'),false);
});
test('retains the initial-step refusal reason for an existing checkpoint',async()=>{
  const f=fixture();f.state.base=structuredClone(f.state.after);
  assert.equal((await runInitialPublicationStep(f.input)).reason,'initial-step-not-applicable');
  assert.equal(f.state.calls.includes('publish'),false);
});
