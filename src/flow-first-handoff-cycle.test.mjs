import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runFirstHandoffCycle} from './flow-first-handoff-cycle.mjs';
import {planCheckpointCommit} from './flow-checkpoint-commit-plan.mjs';

function fixture({targetAlready=false}={}){
  const body='[FLOW]\nRola: Designer\nStan docelowy: agent-ready\nWykonano: Praca\nNastępny krok: Kod';
  const epoch={kind:'initial',anchor:'issue'},createdAt='2026-01-01T10:01:00Z';
  const handoff={kind:'handoff',id:'4',nodeId:'comment',authorId:'user',createdAt,body};
  const state={checkpoint:{kind:'checkpoint-snapshot-observed',headOid:'b'.repeat(40),repositoryId:'repo-id',repositoryFullName:'owner/project',
    cutoverAt:'2026-01-01T10:00:00Z',selection:{number:1,issueId:'issue'},index:{version:1,repositoryId:'repo-id',issues:[]},selectedRecord:null},
    project:{kind:'branch-project-observed',issueNodeId:'issue',repository:'owner/project',issueState:'OPEN',currentStatus:'needs-design',
      projectId:'project',itemId:'item',statusFieldId:'status',statusOptionId:'design',
      statusOptions:[{id:'design',name:'needs-design'},{id:'ready',name:'agent-ready'}]},
    handoffEvidence:{kind:'evidence',handoff},trustedAuthorIds:['user'],expectedProjectId:'project',
    epochProof:{kind:'handoff-epoch-evidence',issueNodeId:'issue',commentNodeId:'comment',commentId:'4',commentCreatedAt:createdAt,
      commentDigest:createHash('sha256').update(body).digest('hex'),epoch}};
  if(targetAlready){state.project.currentStatus='agent-ready';state.project.statusOptionId='ready';}
  const policy={repositoryId:'repo-id',repository:'owner/project',projectId:'project',statusFieldId:'status',issueId:'issue',issueNumber:1,
    trustedAuthorIds:['user'],appId:12,updateRulesetId:1,historyRulesetId:2};
  const protection={kind:'checkpoint-protection-observed',repositoryId:'repo-id',appId:12,updateRulesetId:1,historyRulesetId:2};
  const controls={statusResult:'status-write-acknowledged',gitResult:'ref-update-acknowledged',observeResult:'publication-observed',reads:0};
  let staged=null;const writes=[];
  const collect=async()=>{controls.reads++;return structuredClone(state);},verifyProtection=async()=>structuredClone(protection);
  const prepare=async({snapshot,after})=>{const plan=planCheckpointCommit({snapshot,after});assert.equal(plan.kind,'checkpoint-commit-plan');
    const newOid=(snapshot.headOid==='b'.repeat(40)?'c':'e').repeat(40),treeOid='d'.repeat(40);
    staged={newOid,after:structuredClone(after),index:JSON.parse(Buffer.from(plan.additions.find(x=>x.path==='index.json').contents,'base64').toString())};
    return {kind:'checkpoint-objects-prepared',expectedHeadOid:snapshot.headOid,expectedTreeOid:treeOid,
      commit:{sha:newOid,tree:{sha:treeOid},parents:[{sha:snapshot.headOid}]}};};
  const publish=async()=>{writes.push('git');state.checkpoint.headOid=staged.newOid;state.checkpoint.index=staged.index;
    state.checkpoint.selectedRecord=staged.after;return {kind:controls.gitResult};};
  const observe=async()=>({kind:controls.observeResult});
  const transport={projectId:'project',statusFieldId:'status',setStatus:async()=>{writes.push('project');
    if(controls.statusResult==='status-write-acknowledged'){state.project.currentStatus='agent-ready';state.project.statusOptionId='ready';}
    return {kind:controls.statusResult};}};
  const confirmStart=async subject=>({kind:'execution-safe',subject});
  return {state,policy,protection,controls,writes,input:{policy,collect,verifyProtection,prepare,publish,observe,transport,confirmStart}};
}
test('runs the real guarded steps in order with one shared subject and fake transports',async()=>{
  const f=fixture();assert.deepEqual(await runFirstHandoffCycle(f.input),{kind:'first-handoff-observed',retryAllowed:false});
  assert.deepEqual(f.writes,['git','project','git']);assert.equal(f.state.checkpoint.selectedRecord.current.phase,'committed');
});
test('skips the Project write when target status is already present',async()=>{
  const f=fixture({targetAlready:true});assert.equal((await runFirstHandoffCycle(f.input)).kind,'first-handoff-observed');
  assert.deepEqual(f.writes,['git','git']);
});
test('stops after uncertain writes without continuing or retrying',async()=>{
  let f=fixture();f.controls.gitResult='ref-update-uncertain';
  assert.deepEqual(await runFirstHandoffCycle(f.input),{kind:'cycle-stopped',phase:'initial',retryAllowed:false});assert.deepEqual(f.writes,['git']);
  f=fixture();f.controls.statusResult='status-write-uncertain';
  assert.deepEqual(await runFirstHandoffCycle(f.input),{kind:'cycle-stopped',phase:'status',retryAllowed:false});assert.deepEqual(f.writes,['git','project']);
});
test('resumes only a freshly verified pending record after a stopped status step',async()=>{
  const f=fixture();f.controls.statusResult='status-write-uncertain';assert.equal((await runFirstHandoffCycle(f.input)).phase,'status');
  f.controls.statusResult='status-write-acknowledged';f.input.confirmStart=async()=>({kind:'unresolved'});
  assert.equal((await runFirstHandoffCycle(f.input)).phase,'start');assert.deepEqual(f.writes,['git','project']);
  f.input.confirmStart=async subject=>({kind:'execution-safe',subject});
  assert.equal((await runFirstHandoffCycle(f.input)).kind,'first-handoff-observed');
  assert.deepEqual(f.writes,['git','project','project','git']);
});
test('wrong issue or status field stops before any write',async()=>{
  for(const [field,value] of [['issueId','other'],['issueNumber',2],['statusFieldId','other']]){
    const f=fixture();f.policy[field]=value;assert.equal((await runFirstHandoffCycle(f.input)).phase,'initial');assert.deepEqual(f.writes,[]);
  }
});
test('a different subject appearing after pending publication cannot reach status or commit',async()=>{
  const f=fixture();const collect=f.input.collect;
  f.input.collect=async()=>{const snapshot=await collect();if(f.controls.reads===5)snapshot.checkpoint.selection.issueId='other';return snapshot;};
  assert.equal((await runFirstHandoffCycle(f.input)).phase,'pending-read');assert.deepEqual(f.writes,['git']);
});
test('does not start or repeat publication without proof earlier requests have settled',async()=>{
  const f=fixture();delete f.input.confirmStart;
  assert.equal((await runFirstHandoffCycle(f.input)).phase,'configuration');assert.deepEqual(f.writes,[]);
  f.input.confirmStart=async subject=>({kind:'execution-safe',subject:{...subject,issueId:'other'}});
  assert.equal((await runFirstHandoffCycle(f.input)).phase,'start');assert.deepEqual(f.writes,[]);
});
