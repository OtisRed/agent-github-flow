import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeV3Registry, decodeV3Registry, reserveV3Project, pinV3ProjectGenesis, activateV3Project, retireV3Project } from './flow-v3-registry.mjs';
import { CHECKPOINT_BRANCH_REF } from './flow-checkpoint-registration.mjs';
import { FLOW_STATUSES } from './flow.mjs';
import { createCheckpointKeyring } from './flow-checkpoint-keyring.mjs';
import { createV3RegistryAnchor, verifyV3Registry, sealV3RegistryTransition } from './flow-v3-registry-anchor.mjs';
import { verifyV3BootstrapEnrollment } from './flow-v3-bootstrap-enrollment.mjs';
import { createV3GenesisPinStep } from './flow-v3-genesis-pin-step.mjs';
import { createV3RegistryLifecycleStep } from './flow-v3-registry-lifecycle-step.mjs';

const source='a'.repeat(32),cutoverAt='2026-01-01T10:00:00Z';
const intent={source,repository:'owner/project',repositoryId:'repo-id',expectedPrivate:false,cutoverAt,appId:12,updateRulesetId:1,historyRulesetId:2};
const bootstrap={genesisOid:'b'.repeat(40),treeOid:'c'.repeat(40)};
const registration=()=>({version:3,source,repository:intent.repository,repositoryId:intent.repositoryId,expectedPrivate:false,dataPolicy:'common-v3',
  projectOwner:'owner',projectNumber:1,projectId:'private-project',statusFieldId:'private-field',statusFieldName:'Status',
  statusOptions:FLOW_STATUSES.map((name,index)=>({name,id:`private-option-${index}`})),appId:12,updateRulesetId:1,historyRulesetId:2,
  trustedAuthorIds:['user'],checkpoint:{repositoryId:'repo-id',ref:CHECKPOINT_BRANCH_REF,genesisOid:'b'.repeat(40),cutoverAt,checkpointSchemaVersion:3}});
const parsed=plan=>JSON.parse(plan.content);
test('reserves, activates and retires without forgetting a previously enrolled repository',()=>{
  const initial={version:1,revision:1,entries:[]},reserved=parsed(reserveV3Project(initial,intent));
  assert.equal(reserved.revision,2);assert.equal(reserved.entries[0].state,'reserved');assert.equal(reserved.entries[0].registration,null);
  const initializing=parsed(pinV3ProjectGenesis(reserved,source,bootstrap));assert.equal(initializing.revision,3);
  assert.deepEqual(initializing.entries[0].bootstrap,bootstrap);assert.equal(initializing.entries[0].state,'initializing');
  const active=parsed(activateV3Project(initializing,source,registration()));assert.equal(active.revision,4);assert.equal(active.entries[0].state,'active');
  const retired=parsed(retireV3Project(active,source));assert.equal(retired.revision,5);assert.equal(retired.entries[0].state,'retired');
  assert.equal(retired.entries[0].registration.checkpoint.genesisOid,'b'.repeat(40));
  assert.equal(reserveV3Project(retired,{...intent,source:'c'.repeat(32)}).kind,'blocked');
  assert.equal(activateV3Project(retired,source,registration()).kind,'blocked');
});
test('requires exact identity and explicit reservation before activation',()=>{
  const empty={version:1,revision:1,entries:[]},reserved=parsed(reserveV3Project(empty,intent));
  assert.equal(activateV3Project(empty,source,registration()).kind,'blocked');
  assert.equal(activateV3Project(reserved,source,registration()).kind,'blocked');
  const initializing=parsed(pinV3ProjectGenesis(reserved,source,bootstrap));
  assert.equal(pinV3ProjectGenesis(initializing,source,bootstrap).kind,'blocked');
  const wrong=registration();wrong.expectedPrivate=true;assert.equal(activateV3Project(initializing,source,wrong).kind,'blocked');
  const wrongGenesis=registration();wrongGenesis.checkpoint.genesisOid='d'.repeat(40);
  assert.equal(activateV3Project(initializing,source,wrongGenesis).kind,'blocked');
  const wrongApp=registration();wrongApp.appId=13;assert.equal(activateV3Project(initializing,source,wrongApp).kind,'blocked');
  assert.equal(reserveV3Project(reserved,{...intent,source:'c'.repeat(32),repositoryId:'other'}).kind,'blocked');
  assert.equal(reserveV3Project(reserved,{...intent,source:'c'.repeat(32),repository:'owner/other'}).kind,'blocked');
});
test('uses canonical source ordering and rejects malformed, oversized or noncanonical input',()=>{
  const initial={version:1,revision:1,entries:[]};
  const first=parsed(reserveV3Project(initial,{...intent,source:'f'.repeat(32)}));
  const second=reserveV3Project(first,{...intent,source:'1'.repeat(32),repository:'owner/other',repositoryId:'other'});
  const decoded=decodeV3Registry(second.content);assert.equal(decoded.kind,'decoded-v3-registry');
  assert.deepEqual(decoded.registry.entries.map(entry=>entry.source),['1'.repeat(32),'f'.repeat(32)]);
  assert.equal(decodeV3Registry(second.content+' ').kind,'blocked');
  assert.equal(encodeV3Registry({...initial,revision:0}).kind,'blocked');
  assert.equal(decodeV3Registry('x'.repeat(46*1024)).kind,'blocked');
});
test('requires an independent matching keyed anchor and preserves historical key verification',()=>{
  const initial={version:1,revision:1,entries:[]},content=encodeV3Registry(initial).content;
  const old=createCheckpointKeyring({currentKeyId:1,keys:[{id:1,key:Buffer.alloc(32,1)}]});
  const anchor=createV3RegistryAnchor(initial,old).anchor;
  const rotating=createCheckpointKeyring({currentKeyId:2,keys:[{id:1,key:Buffer.alloc(32,1)},{id:2,key:Buffer.alloc(32,2)}]});
  assert.equal(verifyV3Registry(content,anchor,rotating).kind,'v3-registry-verified');
  assert.equal(verifyV3Registry(content,{...anchor,revision:2},rotating).kind,'blocked');
  assert.equal(verifyV3Registry(content,{...anchor,mac:'0'.repeat(64)},rotating).kind,'blocked');
  assert.equal(verifyV3Registry(content,{...anchor,keyId:3},rotating).kind,'blocked');
  assert.equal(verifyV3Registry(content,undefined,rotating).kind,'blocked');
});
test('seals only a single valid lifecycle transition from an authenticated predecessor',()=>{
  const initial={version:1,revision:1,entries:[]},content=encodeV3Registry(initial).content;
  const keyring=createCheckpointKeyring({currentKeyId:1,keys:[{id:1,key:Buffer.alloc(32,1)}]}),anchor=createV3RegistryAnchor(initial,keyring).anchor;
  const reserved=reserveV3Project(initial,intent),first=sealV3RegistryTransition({content,anchor,afterContent:reserved.content,keyring});
  assert.equal(first.kind,'v3-registry-update-planned');assert.equal(first.anchor.revision,2);
  const reservedRegistry=JSON.parse(reserved.content),pinned=pinV3ProjectGenesis(reservedRegistry,source,bootstrap);
  const second=sealV3RegistryTransition({content:first.content,anchor:first.anchor,afterContent:pinned.content,keyring});
  assert.equal(second.kind,'v3-registry-update-planned');assert.equal(second.anchor.revision,3);
  const active=activateV3Project(JSON.parse(pinned.content),source,registration());
  const third=sealV3RegistryTransition({content:second.content,anchor:second.anchor,afterContent:active.content,keyring});
  assert.equal(third.kind,'v3-registry-update-planned');assert.equal(third.anchor.revision,4);
  const truncated=JSON.stringify({version:1,revision:5,entries:[]});
  assert.equal(sealV3RegistryTransition({content:third.content,anchor:third.anchor,afterContent:truncated,keyring}).kind,'blocked');
  assert.equal(sealV3RegistryTransition({content:first.content,anchor:{...first.anchor,mac:'0'.repeat(64)},afterContent:pinned.content,keyring}).kind,'blocked');
});
test('enrollment requires a verified reservation or pinned initialization and never infers one from absence',()=>{
  const keyring=createCheckpointKeyring({currentKeyId:1,keys:[{id:1,key:Buffer.alloc(32,1)}]});
  const empty={version:1,revision:1,entries:[]},emptyContent=encodeV3Registry(empty).content,emptyAnchor=createV3RegistryAnchor(empty,keyring).anchor;
  assert.equal(verifyV3BootstrapEnrollment({content:emptyContent,anchor:emptyAnchor,keyring,policy:intent}).kind,'blocked');
  const reserved=parsed(reserveV3Project(empty,intent)),reservedContent=encodeV3Registry(reserved).content,reservedAnchor=createV3RegistryAnchor(reserved,keyring).anchor;
  assert.equal(verifyV3BootstrapEnrollment({content:reservedContent,anchor:reservedAnchor,keyring,policy:intent}).phase,'reserved');
  assert.equal(verifyV3BootstrapEnrollment({content:reservedContent,anchor:reservedAnchor,keyring,policy:{...intent,appId:13}}).kind,'blocked');
  assert.equal(verifyV3BootstrapEnrollment({content:reservedContent,anchor:undefined,keyring,policy:intent}).kind,'blocked');
  const pinned=parsed(pinV3ProjectGenesis(reserved,source,bootstrap)),pinContent=encodeV3Registry(pinned).content,pinAnchor=createV3RegistryAnchor(pinned,keyring).anchor;
  const proof=verifyV3BootstrapEnrollment({content:pinContent,anchor:pinAnchor,keyring,policy:intent});
  assert.equal(proof.phase,'initializing');assert.deepEqual(proof.bootstrap,bootstrap);
  const active=parsed(activateV3Project(pinned,source,registration())),activeContent=encodeV3Registry(active).content,activeAnchor=createV3RegistryAnchor(active,keyring).anchor;
  assert.equal(verifyV3BootstrapEnrollment({content:activeContent,anchor:activeAnchor,keyring,policy:intent}).kind,'blocked');
});
function pinFixture(){
  const keyring=createCheckpointKeyring({currentKeyId:1,keys:[{id:1,key:Buffer.alloc(32,1)}]});
  const reserved=parsed(reserveV3Project({version:1,revision:1,entries:[]},intent));
  const state={content:encodeV3Registry(reserved).content,anchor:createV3RegistryAnchor(reserved,keyring).anchor,version:'v1',writes:0,mode:'ok'};
  const load=async()=>({content:state.content,anchor:state.anchor,version:state.version});
  const commit=async update=>{state.writes++;assert.equal(update.expectedVersion,state.version);
    state.content=update.content;state.anchor=update.anchor;state.version='v2';if(state.mode==='throw')throw Error('uncertain');
    if(state.mode==='corrupt')state.version='v1';return {kind:'registry-update-acknowledged'};};
  return {state,keyring,step:createV3GenesisPinStep({keyring,load,commit})};
}
test('pins genesis only after authenticated reservation and verified atomic-store readback',async()=>{
  const f=pinFixture(),result=await f.step(intent,bootstrap);assert.equal(result.kind,'v3-genesis-pinned');assert.equal(f.state.writes,1);
  assert.deepEqual(verifyV3BootstrapEnrollment({content:f.state.content,anchor:f.state.anchor,keyring:f.keyring,policy:intent}).bootstrap,bootstrap);
  assert.equal((await f.step(intent,bootstrap)).kind,'blocked');assert.equal(f.state.writes,1);
});
test('uncertain pin is never retried and invalid reservations never write',async()=>{
  for(const mode of ['throw','corrupt']){const f=pinFixture();f.state.mode=mode;
    assert.equal((await f.step(intent,bootstrap)).kind,'v3-genesis-pin-uncertain');assert.equal(f.state.writes,1);
    assert.equal((await f.step(intent,bootstrap)).kind,'blocked');assert.equal(f.state.writes,1);}
  const f=pinFixture();assert.equal((await f.step({...intent,appId:13},bootstrap)).kind,'blocked');assert.equal(f.state.writes,0);
});
function lifecycleFixture(initial){
  const keyring=createCheckpointKeyring({currentKeyId:1,keys:[{id:1,key:Buffer.alloc(32,1)}]});
  const state={content:encodeV3Registry(initial).content,anchor:createV3RegistryAnchor(initial,keyring).anchor,version:'v1',writes:0,mode:'ok'};
  const load=async()=>({content:state.content,anchor:state.anchor,version:state.version});
  const commit=async update=>{state.writes++;assert.equal(update.expectedVersion,state.version);state.content=update.content;
    state.anchor=update.anchor;state.version='v2';if(state.mode==='throw')throw Error('uncertain');return {kind:'registry-update-acknowledged'};};
  const verifyAuthorization=async({operation,policy,registration})=>state.mode==='unauthorized'||(state.mode==='after-auth'&&state.writes>0)?{kind:'blocked'}:
    {kind:'registry-lifecycle-authorized',operation,policy,registration:state.mode==='wrong-registration'?{...registration,projectId:'other'}:registration};
  const verifyGenesis=async({registration,expectedTreeOid})=>({kind:'v3-bootstrap-verified',registration,
    treeOid:state.mode==='wrong-tree'||(state.mode==='after-tree'&&state.writes>0)?'d'.repeat(40):expectedTreeOid});
  return {state,step:createV3RegistryLifecycleStep({keyring,load,commit,verifyAuthorization,verifyGenesis})};
}
test('reserves and activates only the registered and verified genesis',async()=>{
  const initial={version:1,revision:1,entries:[]},f=lifecycleFixture(initial);
  assert.equal((await f.step({operation:'reserve',policy:intent})).kind,'v3-registry-lifecycle-observed');
  assert.equal(JSON.parse(f.state.content).entries[0].state,'reserved');
  const initializing=parsed(pinV3ProjectGenesis(parsed(reserveV3Project(initial,intent)),source,bootstrap));
  const g=lifecycleFixture(initializing);
  assert.equal((await g.step({operation:'activate',policy:intent,registration:registration()})).kind,'v3-registry-lifecycle-observed');
  assert.equal(JSON.parse(g.state.content).entries[0].state,'active');assert.equal(g.state.writes,1);
});
test('reports uncertainty if authorization or genesis verification changes after the write',async()=>{
  const initial={version:1,revision:1,entries:[]},initializing=parsed(pinV3ProjectGenesis(parsed(reserveV3Project(initial,intent)),source,bootstrap));
  for(const mode of ['after-auth','after-tree']){const f=lifecycleFixture(initializing);f.state.mode=mode;
    assert.equal((await f.step({operation:'activate',policy:intent,registration:registration()})).kind,'v3-registry-lifecycle-uncertain');
    assert.equal(f.state.writes,1);assert.equal((await f.step({operation:'activate',policy:intent,registration:registration()})).kind,'blocked');}
});
test('refuses unauthorized enrollment or a different genesis tree and never retries an uncertain write',async()=>{
  const initial={version:1,revision:1,entries:[]},initializing=parsed(pinV3ProjectGenesis(parsed(reserveV3Project(initial,intent)),source,bootstrap));
  let f=lifecycleFixture(initial);f.state.mode='unauthorized';assert.equal((await f.step({operation:'reserve',policy:intent})).kind,'blocked');assert.equal(f.state.writes,0);
  f=lifecycleFixture(initializing);f.state.mode='wrong-tree';assert.equal((await f.step({operation:'activate',policy:intent,registration:registration()})).kind,'blocked');assert.equal(f.state.writes,0);
  f=lifecycleFixture(initializing);f.state.mode='wrong-registration';assert.equal((await f.step({operation:'activate',policy:intent,registration:registration()})).kind,'blocked');assert.equal(f.state.writes,0);
  f=lifecycleFixture(initial);f.state.mode='throw';assert.equal((await f.step({operation:'reserve',policy:intent})).kind,'v3-registry-lifecycle-uncertain');
  assert.equal((await f.step({operation:'reserve',policy:intent})).kind,'blocked');assert.equal(f.state.writes,1);
});
