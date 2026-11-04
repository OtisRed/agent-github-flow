import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkerStatusSigner} from './worker-status-commitment.mjs';

const makeWorkerStatusCommitment=input=>{
  try{return createWorkerStatusSigner({key:input.key,keyId:input.keyId}).sign(input.metadata);}catch{return {kind:'blocked'};}
};
const verifyWorkerStatusCommitment=(input,expected)=>{
  try{return createWorkerStatusSigner({key:input.key,keyId:input.keyId}).verify(input.metadata,expected);}catch{return false;}
};

function fixture(){
  const binding={repositoryId:'repo-node',repository:'owner/project',projectId:'project-node',statusFieldId:'field-node',
    issueId:'issue-node',issueNumber:1,appId:12,updateRulesetId:1,historyRulesetId:2,trustedAuthorIds:['user'],
    commentId:'42',commentMac:'a'.repeat(64),commentKeyId:1,configMac:'b'.repeat(64),configKeyId:1,
    phase:'pending',fromStatus:'needs-design',targetStatus:'agent-ready',createdAt:'2026-01-01T10:01:00Z',
    epoch:{kind:'initial',anchor:'issue-node'},reservation:{reservedAt:'2026-01-01T10:02:00Z'},checkpointOid:'c'.repeat(40)};
  return {key:Buffer.alloc(32,7),keyId:1,metadata:{deliveryId:'10000000-0000-4000-8000-000000000000',binding,
    itemId:'item-node',fromOptionId:'design-option',targetOptionId:'ready-option'}};
}
test('commits to canonical private identity without exposing any binding fields',()=>{
  const f=fixture(),result=makeWorkerStatusCommitment(f);
  assert.equal(result.kind,'worker-status-commitment');assert.equal(result.keyId,1);assert.match(result.mac,/^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(result).sort(),['keyId','kind','mac']);
  assert.equal(verifyWorkerStatusCommitment(f,result),true);
  const reversed=fixture();reversed.metadata.binding=Object.fromEntries(Object.entries(reversed.metadata.binding).reverse());
  assert.deepEqual(makeWorkerStatusCommitment(reversed),result);
  assert.equal(verifyWorkerStatusCommitment({...f,key:Buffer.alloc(32,8)},result),false);
  assert.equal(verifyWorkerStatusCommitment({...f,keyId:2},result),false);
  let reads=0;const initial=Buffer.alloc(32,7);
  const signer=createWorkerStatusSigner({get key(){reads++;return initial;},keyId:1});
  initial.fill(9);
  assert.equal(reads,1);assert.deepEqual(signer.sign(f.metadata),result);
});
test('rejects altered issue, handoff, options, reservation, checkpoint and delivery',()=>{
  const original=fixture(),result=makeWorkerStatusCommitment(original);
  const changes=[
    m=>m.deliveryId='20000000-0000-4000-8000-000000000000',m=>m.binding.repositoryId='other',
    m=>m.binding.projectId='other',m=>m.binding.issueNumber=2,m=>m.binding.commentId='43',
    m=>m.binding.commentMac='d'.repeat(64),m=>m.binding.configMac='d'.repeat(64),
    m=>m.binding.commentKeyId=2,m=>m.binding.configKeyId=2,m=>m.binding.trustedAuthorIds=['other'],
    m=>m.binding.fromStatus='spike',m=>m.binding.targetStatus='review',m=>m.binding.createdAt='2026-01-01T10:01:01Z',
    m=>m.binding.reservation.reservedAt='2026-01-01T10:03:00Z',m=>m.binding.checkpointOid='d'.repeat(40),
    m=>m.itemId='other',m=>m.fromOptionId='other',m=>m.targetOptionId='other',
    m=>{m.binding.issueId='other';m.binding.epoch.anchor='other';}];
  for(const change of changes){const f=fixture();change(f.metadata);assert.equal(verifyWorkerStatusCommitment(f,result),false);}
});
test('fails closed for missing historical key and malformed or extra data',()=>{
  const f=fixture(),result=makeWorkerStatusCommitment(f);
  assert.equal(verifyWorkerStatusCommitment({...f,key:null},result),false);
  assert.equal(verifyWorkerStatusCommitment(f,{...result,mac:'not-a-mac'}),false);
  for(const change of [m=>{m.binding.reservation=null;},m=>{m.binding.epoch.anchor='foreign';},
    m=>{m.binding.targetStatus='done';},m=>{m.binding.body='must-not-store';},
    m=>{m.binding.createdAt='2026-99-99T99:99:99Z';},m=>{m.binding.createdAt='2026-01-01T10:01:00.000Z';},
    m=>{m.binding.createdAt='0000-01-01T00:00:00Z';},
    m=>{m.binding.reservation.reservedAt='2026-01-01T10:00:59Z';},
    m=>{m.binding.targetStatus=m.binding.fromStatus;},m=>{m.targetOptionId=m.fromOptionId;}]){
    const value=fixture();change(value.metadata);assert.deepEqual(makeWorkerStatusCommitment(value),{kind:'blocked'});
  }
});
test('binds only the planned reservation transition while preserving original status intent',()=>{
  const f=fixture(),signer=createWorkerStatusSigner({key:f.key,keyId:f.keyId});
  const input={metadata:f.metadata,oldOid:'c'.repeat(40),newOid:'d'.repeat(40),treeOid:'e'.repeat(40),
    reservedAt:'2026-01-01T10:03:00Z'};
  const prior=signer.sign(f.metadata),transition=signer.transition(input);
  assert.equal(transition.kind,'worker-ref-transition');assert.equal(transition.operation,'reservation');assert.equal(transition.oldMac,prior.mac);
  const next=structuredClone(f.metadata);next.binding.checkpointOid=input.newOid;next.binding.reservation.reservedAt=input.reservedAt;
  assert.equal(transition.nextMac,signer.sign(next).mac);
  assert.equal(signer.verifyTransition(input,transition),true);
  for(const change of [p=>p.oldOid='f'.repeat(40),p=>p.newOid='f'.repeat(40),p=>p.treeOid='f'.repeat(40),
    p=>p.reservedAt='2026-01-01T10:04:00Z',p=>p.metadata.binding.commentId='43']){
    const modified=structuredClone(input);change(modified);assert.equal(signer.verifyTransition(modified,transition),false);
  }
  assert.equal(signer.verifyTransition({...input,reservedAt:'2026-01-01T10:02:00Z'},transition),false);
  assert.equal(signer.verifyTransition(input,{...transition,nextMac:'f'.repeat(64)}),false);
  assert.equal(signer.verifyTransition(input,{...transition,operation:'commit'}),false);
  assert.equal(createWorkerStatusSigner({key:Buffer.alloc(32,8),keyId:2}).verifyTransition(input,transition),false);
  let reads=0;const unstable={...input,get newOid(){reads++;return reads===1?'d'.repeat(40):'f'.repeat(40);}};
  const snapshotted=signer.transition(unstable);
  const snapshotNext=structuredClone(f.metadata);snapshotNext.binding.checkpointOid=snapshotted.newOid;
  snapshotNext.binding.reservation.reservedAt=input.reservedAt;
  assert.equal(reads,1);assert.equal(snapshotted.kind,'worker-ref-transition');
  assert.equal(snapshotted.nextMac,signer.sign(snapshotNext).mac);
});
test('binds a final checkpoint plan without disclosing its record',()=>{
  const f=fixture(),signer=createWorkerStatusSigner({key:f.key,keyId:f.keyId});
  const input={metadata:f.metadata,oldOid:'c'.repeat(40),newOid:'d'.repeat(40),treeOid:'e'.repeat(40),
    recordContent:'{"synthetic":"committed-record"}'};
  const result=signer.completion(input);
  assert.equal(result.kind,'worker-final-ref-transition');assert.equal(result.operation,'commit');
  assert.equal(result.oldMac,signer.sign(f.metadata).mac);assert.match(result.recordMac,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('committed-record'),false);
  assert.equal(signer.verifyCompletion(input,result),true);
  for(const change of [x=>x.oldOid='f'.repeat(40),x=>x.newOid='f'.repeat(40),x=>x.treeOid='f'.repeat(40),
    x=>x.recordContent+=' ',x=>x.metadata.binding.commentId='43']){
    const altered=structuredClone(input);change(altered);assert.equal(signer.verifyCompletion(altered,result),false);
  }
  assert.equal(signer.verifyCompletion(input,{...result,recordMac:'f'.repeat(64)}),false);
  assert.equal(signer.verifyCompletion(input,{...result,extra:true}),false);
  assert.equal(createWorkerStatusSigner({key:Buffer.alloc(32,8),keyId:1}).verifyCompletion(input,result),false);
  assert.equal(createWorkerStatusSigner({key:f.key,keyId:2}).verifyCompletion(input,result),false);
  assert.equal(signer.completion({...input,recordContent:'x'.repeat(16385)}).kind,'blocked');
  assert.equal(signer.completion({...input,newOid:input.oldOid}).kind,'blocked');
  let reads=0;const unstable={...input,get newOid(){reads++;return reads===1?'d'.repeat(40):'f'.repeat(40);}};
  assert.equal(signer.verifyCompletion(input,signer.completion(unstable)),true);assert.equal(reads,1);
});
