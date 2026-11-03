import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckpointMac } from './flow-checkpoint-mac.mjs';
import { FLOW_STATUSES } from './flow.mjs';
import { CHECKPOINT_BRANCH_REF } from './flow-checkpoint-registration.mjs';

function registration(){return {version:3,source:'a'.repeat(32),repository:'owner/project',repositoryId:'repo-id',expectedPrivate:false,dataPolicy:'common-v3',projectOwner:'owner',
  projectNumber:1,projectId:'private-project',statusFieldId:'private-field',statusFieldName:'Status',statusOptions:options(),appId:12,updateRulesetId:1,historyRulesetId:2,
  trustedAuthorIds:['user'],checkpoint:{repositoryId:'repo-id',ref:CHECKPOINT_BRANCH_REF,genesisOid:'b'.repeat(40),
    cutoverAt:'2026-01-01T10:00:00Z',checkpointSchemaVersion:3}};}
const options=()=>FLOW_STATUSES.map((name,index)=>({name,id:`private-option-${index}`}));
const comment=()=>({repositoryId:'repo-id',issueId:'issue-id',commentId:'123',body:'[FLOW]\nprivate test content'});

test('binds the exact comment, issue and key version without exposing its text',()=>{
  const mac=createCheckpointMac({key:Buffer.alloc(32,1),keyId:1}),value=comment(),commitment=mac.comment(value);
  assert.match(commitment,/^[a-f0-9]{64}$/);assert.equal(mac.verifyComment(value,commitment),true);
  for(const key of ['repositoryId','issueId','commentId','body']){const changed={...value,[key]:key==='commentId'?'124':`${value[key]}-changed`};
    assert.equal(mac.verifyComment(changed,commitment),false);}
  assert.equal(createCheckpointMac({key:Buffer.alloc(32,2),keyId:1}).verifyComment(value,commitment),false);
  assert.equal(createCheckpointMac({key:Buffer.alloc(32,1),keyId:2}).verifyComment(value,commitment),false);
  assert.equal(mac.verifyComment(value,'bad'),false);assert.ok(!JSON.stringify(mac).includes(value.body));
});

test('binds private project registration and every stable status option',()=>{
  const mac=createCheckpointMac({key:Buffer.alloc(32,3),keyId:1}),reg=registration(),commitment=mac.config(reg);
  assert.equal(mac.keyId,1);assert.equal(mac.verifyConfig(reg,commitment),true);
  const changed=structuredClone(reg);changed.statusOptions[0].id='recreated';assert.equal(mac.verifyConfig(changed,commitment),false);
  const different=registration();different.projectId='other-private-project';assert.equal(mac.verifyConfig(different,commitment),false);
  const visibility=registration();visibility.expectedPrivate=true;assert.equal(mac.verifyConfig(visibility,commitment),false);
  for(const change of [v=>{v.dataPolicy='other';},v=>{v.statusFieldId='other-field';},v=>{v.source='c'.repeat(32);},
    v=>{v.trustedAuthorIds=['other-user'];},v=>{v.appId=13;},v=>{v.updateRulesetId=3;},v=>{v.historyRulesetId=4;}]){
    const altered=registration();change(altered);assert.equal(mac.verifyConfig(altered,commitment),false);}
  const missing=registration();missing.statusOptions.pop();assert.throws(()=>mac.config(missing),/invalid-checkpoint-input/);
  const duplicate=registration();duplicate.statusOptions[1].id=duplicate.statusOptions[0].id;assert.throws(()=>mac.config(duplicate),/invalid-checkpoint-input/);
});

test('requires a 256-bit key, copies it, and never accepts malformed MACs',()=>{
  assert.throws(()=>createCheckpointMac({key:Buffer.alloc(31),keyId:1}),/invalid-checkpoint-key/);
  assert.throws(()=>createCheckpointMac({key:Buffer.alloc(32),keyId:0}),/invalid-checkpoint-key/);
  const key=Buffer.alloc(32,4),mac=createCheckpointMac({key,keyId:1}),value=comment(),before=mac.comment(value);key.fill(0);
  assert.equal(mac.comment(value),before);assert.equal(mac.verifyComment(value,'0'.repeat(63)+'z'),false);
});
