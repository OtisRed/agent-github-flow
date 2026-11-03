import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeProjectRegistration, decodeProjectRegistration } from './flow-project-registration.mjs';
import { CHECKPOINT_BRANCH_REF } from './flow-checkpoint-registration.mjs';

function fixture(){return {version:1,source:'a'.repeat(32),repository:'owner/private-project',repositoryId:'repo-id',
  projectOwner:'owner',projectNumber:4,projectId:'project-id',statusFieldId:'field-id',statusFieldName:'Status',
  appId:12,updateRulesetId:1,historyRulesetId:2,trustedAuthorIds:['user'],
  checkpoint:{repositoryId:'repo-id',ref:CHECKPOINT_BRANCH_REF,genesisOid:'b'.repeat(40),cutoverAt:'2026-01-01T10:00:00Z',checkpointSchemaVersion:2}};}

test('round-trips a canonical per-project registration bound to its wakeup route and repo',()=>{
  const value=fixture(),encoded=encodeProjectRegistration(value);assert.equal(encoded.kind,'encoded-registration');
  assert.deepEqual(decodeProjectRegistration(encoded.content,{source:value.source,repository:value.repository}),{kind:'decoded-registration',registration:value});
  assert.equal(decodeProjectRegistration(encoded.content+'\n',{source:value.source,repository:value.repository}).kind,'blocked');
  assert.equal(decodeProjectRegistration(encoded.content,{source:'b'.repeat(32),repository:value.repository}).kind,'blocked');
  assert.equal(decodeProjectRegistration(encoded.content,{source:value.source,repository:'other/repo'}).kind,'blocked');
});

test('blocks missing, ambiguous, wrong-version or mismatched configuration',()=>{
  for(const change of [
    v=>{v.checkpoint.repositoryId='other';},v=>{v.checkpoint.checkpointSchemaVersion=1;},v=>{v.checkpoint.ref='refs/heads/main';},
    v=>{v.historyRulesetId=v.updateRulesetId;},v=>{v.trustedAuthorIds=['user','user'];},v=>{v.source='bad';},
    v=>{v.projectNumber=0;},v=>{v.statusFieldName='';},v=>{v.extra='secret';},v=>{v.checkpoint.extra='secret';}
  ]){const value=fixture();change(value);assert.equal(encodeProjectRegistration(value).kind,'blocked');}
  assert.equal(decodeProjectRegistration('',{source:'a'.repeat(32),repository:'owner/private-project'}).kind,'blocked');
});
