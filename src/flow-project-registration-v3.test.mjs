import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeProjectRegistrationV3, decodeProjectRegistrationV3 } from './flow-project-registration-v3.mjs';
import { CHECKPOINT_BRANCH_REF } from './flow-checkpoint-registration.mjs';
import { FLOW_STATUSES } from './flow.mjs';

function fixture(){return {version:3,source:'a'.repeat(32),repository:'owner/project',repositoryId:'repo-id',expectedPrivate:false,
  dataPolicy:'common-v3',projectOwner:'owner',projectNumber:1,projectId:'private-project',statusFieldId:'private-field',statusFieldName:'Status',
  statusOptions:FLOW_STATUSES.map((name,index)=>({name,id:`private-option-${index}`})),appId:12,updateRulesetId:1,historyRulesetId:2,
  trustedAuthorIds:['user'],checkpoint:{repositoryId:'repo-id',ref:CHECKPOINT_BRANCH_REF,genesisOid:'b'.repeat(40),
    cutoverAt:'2026-01-01T10:00:00Z',checkpointSchemaVersion:3}};}

test('round-trips the canonical private v3 registration for public and private repositories',()=>{
  for(const expectedPrivate of [false,true]){const value=fixture();value.expectedPrivate=expectedPrivate;
    const encoded=encodeProjectRegistrationV3(value);assert.equal(encoded.kind,'encoded-registration');
    assert.deepEqual(decodeProjectRegistrationV3(encoded.content,{source:value.source,repository:value.repository}),{kind:'decoded-registration',registration:value});}
});

test('requires explicit visibility, one common data policy, v3 and every unique ordered status option',()=>{
  for(const change of [v=>{delete v.expectedPrivate;},v=>{v.expectedPrivate='false';},v=>{v.dataPolicy='private-v3';},
    v=>{v.checkpoint.checkpointSchemaVersion=2;},v=>{v.version=1;},v=>{v.statusOptions.pop();},
    v=>{v.statusOptions[1].id=v.statusOptions[0].id;},v=>{v.statusOptions.reverse();},v=>{v.extra='private';}]){
    const value=fixture();change(value);assert.equal(encodeProjectRegistrationV3(value).kind,'blocked');}
});
