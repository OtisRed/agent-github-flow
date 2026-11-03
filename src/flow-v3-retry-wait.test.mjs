import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { v3HandoffBinding } from './flow-v3-handoff-binding.mjs';
import { waitForV3Retry } from './flow-v3-retry-wait.mjs';

function fixture(){
  const policy={repositoryId:'repo',repository:'owner/project',projectId:'project',statusFieldId:'field',issueId:'issue',issueNumber:1,
    appId:1,updateRulesetId:2,historyRulesetId:3,trustedAuthorIds:['user']};
  const epoch={kind:'initial',anchor:'issue'},head='c'.repeat(40);
  const record={version:3,repositoryId:'repo',number:1,issueId:'issue',cutoverAt:'2026-01-01T10:00:00Z',epoch,reentry:null,
    current:{phase:'pending',commentId:'4',commentMac:'a'.repeat(64),commentKeyId:1,configMac:'b'.repeat(64),configKeyId:2,
      fromStatus:'needs-design',targetStatus:'agent-ready',createdAt:'2026-01-01T10:01:00Z',epoch},previous:null,
    reservation:{reservedAt:'2026-01-01T10:02:00Z'}};
  const body='[FLOW] test',createdAt='2026-01-01T10:01:00Z';
  const observation={checkpoint:{kind:'checkpoint-snapshot-observed',schemaVersion:3,headOid:head,repositoryId:'repo',repositoryFullName:'owner/project',
    selection:{number:1,issueId:'issue'},selectedRecord:record},
    project:{kind:'branch-project-observed',repository:'owner/project',projectId:'project',issueNodeId:'issue',statusFieldId:'field',issueState:'OPEN',currentStatus:'needs-design'},
    handoffEvidence:{kind:'evidence',handoff:{kind:'handoff',id:'4',nodeId:'comment',authorId:'user',createdAt,body}},
    epochProof:{kind:'handoff-epoch-evidence',issueNodeId:'issue',commentNodeId:'comment',commentId:'4',commentCreatedAt:createdAt,
      commentDigest:createHash('sha256').update(body).digest('hex'),epoch},expectedProjectId:'project',trustedAuthorIds:['user']};
  const state={observation,reads:0,time:0,waited:0,mutate:null};
  const input={policy,expectedBinding:v3HandoffBinding(policy,record,head),collect:async()=>{
    if(++state.reads===2&&state.mutate)state.mutate(state.observation);return state.observation;},
    monotonic:()=>state.time,wait:async ms=>{state.waited=ms;state.time+=ms;}};
  return {input,state};
}
test('waits in one runner and accepts only the same fresh reserved observation',async()=>{
  const f=fixture(),result=await waitForV3Retry(f.input);assert.equal(result.kind,'retry-wait-observed');
  assert.equal(f.state.waited,120000);assert.equal(f.state.reads,2);assert.deepEqual(result.binding,f.input.expectedBinding);
});
test('stops when the wait is short, clock is invalid, or collection fails',async()=>{
  let f=fixture();f.input.wait=async()=>{};assert.equal((await waitForV3Retry(f.input)).reason,'clock');
  f=fixture();f.input.monotonic=()=>NaN;assert.equal((await waitForV3Retry(f.input)).reason,'clock');
  f=fixture();f.input.collect=async()=>{throw Error('no');};assert.equal((await waitForV3Retry(f.input)).kind,'retry-wait-stopped');
});
test('stops for changed status, handoff, checkpoint, configuration or unrelated observation after waiting',async()=>{
  for(const mutate of [o=>o.project.currentStatus='agent-ready',o=>o.handoffEvidence.handoff.id='5',
    o=>o.checkpoint.headOid='d'.repeat(40),o=>o.checkpoint.selectedRecord.current.configMac='d'.repeat(64),
    o=>o.project.extra='changed']){
    const f=fixture();f.state.mutate=mutate;assert.equal((await waitForV3Retry(f.input)).reason,'observation-changed');
  }
});
test('does not wait without a reservation, matching binding, old status or latest handoff',async()=>{
  for(const mutate of [o=>o.checkpoint.selectedRecord.reservation=null,o=>o.project.currentStatus='agent-ready',
    o=>o.handoffEvidence.handoff.id='5',o=>o.project.issueState='CLOSED',o=>delete o.checkpoint.kind,
    o=>delete o.project.kind,o=>delete o.expectedProjectId,o=>delete o.epochProof]){
    const f=fixture();mutate(f.state.observation);assert.equal((await waitForV3Retry(f.input)).reason,'initial-observation');assert.equal(f.state.waited,0);
  }
  const f=fixture();f.input.expectedBinding=null;f.state.observation.checkpoint.selectedRecord.current.commentMac='invalid';
  assert.equal((await waitForV3Retry(f.input)).reason,'initial-observation');assert.equal(f.state.waited,0);
});
