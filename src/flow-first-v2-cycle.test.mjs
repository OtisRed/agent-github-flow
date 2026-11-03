import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runFirstV2Cycle } from './flow-first-v2-cycle.mjs';
import { planCheckpointV2Commit } from './flow-checkpoint-commit-plan.mjs';

function fixture({targetAlready=false}={}) {
  const body='[FLOW]\nRola: Designer\nStan docelowy: agent-ready\nWykonano: Praca\nNastępny krok: Kod';
  const epoch={kind:'initial',anchor:'issue'},createdAt='2026-01-01T10:01:00Z';
  const handoff={kind:'handoff',id:'4',nodeId:'comment',authorId:'user',createdAt,body};
  const registration={repositoryId:'repo-id',ref:'refs/heads/agent-github-flow/checkpoints',genesisOid:'a'.repeat(40),
    cutoverAt:'2026-01-01T10:00:00Z',checkpointSchemaVersion:2};
  const state={checkpoint:{kind:'checkpoint-snapshot-observed',schemaVersion:2,headOid:'b'.repeat(40),repositoryId:'repo-id',
    repositoryFullName:'owner/project',cutoverAt:registration.cutoverAt,selection:{number:1,issueId:'issue'},
    index:{version:1,repositoryId:'repo-id',issues:[]},selectedRecord:null},
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
  const controls={statusResult:'status-write-acknowledged',moveOnUncertain:false,clock:0,waited:0,waitAdvances:true,changeOnWait:false,gitResults:[]};
  let staged=null;let sequence=0;const writes=[];
  const collect=async()=>structuredClone(state),verifyProtection=async()=>structuredClone(protection);
  const prepare=async({snapshot,after,registration:actual})=>{const plan=planCheckpointV2Commit({snapshot,after,registration:actual});
    assert.equal(plan.kind,'checkpoint-commit-plan');const newOid=['c','e','f','9'][sequence++].repeat(40),treeOid='d'.repeat(40);
    staged={newOid,after:structuredClone(after),index:JSON.parse(Buffer.from(plan.additions.find(x=>x.path==='index.json').contents,'base64').toString())};
    return {kind:'checkpoint-objects-prepared',expectedHeadOid:snapshot.headOid,expectedTreeOid:treeOid,
      commit:{sha:newOid,tree:{sha:treeOid},parents:[{sha:snapshot.headOid}]}};};
  const publish=async()=>{writes.push('git');state.checkpoint.headOid=staged.newOid;state.checkpoint.index=staged.index;
    state.checkpoint.selectedRecord=staged.after;return {kind:controls.gitResults.shift()??'ref-update-acknowledged'};};
  const observe=async()=>({kind:'publication-observed'});
  const transport={projectId:'project',statusFieldId:'status',setStatus:async()=>{writes.push('project');
    if(controls.statusResult==='status-write-acknowledged'||controls.moveOnUncertain){state.project.currentStatus='agent-ready';state.project.statusOptionId='ready';}
    return {kind:controls.statusResult};}};
  const verifyBootstrap=async()=>({kind:'v2-bootstrap-verified',registration:structuredClone(registration)});
  const wait=async ms=>{controls.waited+=ms;if(controls.waitAdvances)controls.clock+=ms;if(controls.changeOnWait)state.project.statusOptionId='different';};
  const monotonic=()=>controls.clock;let timestamps=0;
  const timestamp=()=>['2026-01-01T10:02:00Z','2026-01-01T10:04:00Z','2026-01-01T10:06:00Z'][timestamps++];
  return {state,controls,writes,input:{policy,registration,collect,verifyProtection,prepare,publish,observe,transport,verifyBootstrap,wait,monotonic,timestamp}};
}

test('executes first v2 handoff with a reservation before the only status write',async()=>{
  const f=fixture(),result=await runFirstV2Cycle(f.input);
  assert.equal(result.kind,'first-v2-handoff-observed');assert.deepEqual(f.writes,['git','git','project','git']);
  assert.equal(f.state.checkpoint.selectedRecord.current.phase,'committed');assert.equal(f.controls.waited,0);
});
test('finishes unchanged status without reserving or writing Project',async()=>{
  const f=fixture({targetAlready:true});assert.equal((await runFirstV2Cycle(f.input)).kind,'first-v2-handoff-observed');
  assert.deepEqual(f.writes,['git','git']);
});
test('restarts an uncertain source status only after a full new waiting period',async()=>{
  const f=fixture();f.controls.statusResult='unknown';assert.equal((await runFirstV2Cycle(f.input)).phase,'status');
  assert.deepEqual(f.writes,['git','git','project']);f.controls.statusResult='status-write-acknowledged';
  assert.equal((await runFirstV2Cycle(f.input)).kind,'first-v2-handoff-observed');assert.equal(f.controls.waited,120000);
  assert.deepEqual(f.writes,['git','git','project','git','project','git']);
});
test('when an uncertain write already reached target it commits without retrying Project',async()=>{
  const f=fixture();f.controls.statusResult='unknown';f.controls.moveOnUncertain=true;
  assert.equal((await runFirstV2Cycle(f.input)).phase,'status');assert.equal((await runFirstV2Cycle(f.input)).kind,'first-v2-handoff-observed');
  assert.deepEqual(f.writes,['git','git','project','git']);assert.equal(f.controls.waited,0);
});
test('stops if the waiting period is short, observation changes or bootstrap is unverified',async()=>{
  for(const mode of ['short','changed']){const f=fixture();f.controls.statusResult='unknown';await runFirstV2Cycle(f.input);
    if(mode==='short')f.controls.waitAdvances=false;else f.controls.changeOnWait=true;
    const result=await runFirstV2Cycle(f.input);assert.equal(result.kind,'cycle-stopped');assert.equal(f.writes.length,3);}
  const f=fixture();f.input.verifyBootstrap=async()=>({kind:'unverified'});
  assert.equal((await runFirstV2Cycle(f.input)).phase,'bootstrap');assert.deepEqual(f.writes,[]);
});

test('does not retry or continue after an uncertain Git publication',async()=>{
  let f=fixture();f.controls.gitResults=['unknown'];assert.equal((await runFirstV2Cycle(f.input)).phase,'initial');assert.deepEqual(f.writes,['git']);
  f=fixture();f.controls.gitResults=['ref-update-acknowledged','unknown'];assert.equal((await runFirstV2Cycle(f.input)).phase,'reservation');
  assert.deepEqual(f.writes,['git','git']);
});

test('blocks a changed comment, close or checkpoint while waiting, without another write',async()=>{
  for(const change of [
    f=>{f.state.handoffEvidence.handoff.body+='!';},
    f=>{f.state.project.issueState='CLOSED';},
    f=>{f.state.checkpoint.headOid='8'.repeat(40);}
  ]) {
    const f=fixture();f.controls.statusResult='unknown';assert.equal((await runFirstV2Cycle(f.input)).phase,'status');
    const wait=f.input.wait;f.input.wait=async ms=>{await wait(ms);change(f);};
    assert.equal((await runFirstV2Cycle(f.input)).phase,'wait-read');assert.deepEqual(f.writes,['git','git','project']);
  }
});

test('requires bootstrap evidence bound to the complete registration including version and ref',async()=>{
  for(const change of [r=>{r.checkpointSchemaVersion=1;},r=>{r.ref='refs/heads/other';},r=>{r.genesisOid='8'.repeat(40);}]){
    const f=fixture(),registration=structuredClone(f.input.registration);change(registration);
    f.input.verifyBootstrap=async()=>({kind:'v2-bootstrap-verified',registration});
    assert.equal((await runFirstV2Cycle(f.input)).phase,'bootstrap');assert.deepEqual(f.writes,[]);
  }
});

test('target arriving after reservation stops the status write and next cycle commits',async()=>{
  const f=fixture(),audit=f.input.verifyProtection;let count=0;
  f.input.verifyProtection=async()=>{const result=await audit();if(++count===6){f.state.project.currentStatus='agent-ready';f.state.project.statusOptionId='ready';}return result;};
  assert.equal((await runFirstV2Cycle(f.input)).phase,'status');assert.deepEqual(f.writes,['git','git']);
  assert.equal((await runFirstV2Cycle(f.input)).kind,'first-v2-handoff-observed');assert.deepEqual(f.writes,['git','git','git']);
});
