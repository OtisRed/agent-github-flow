import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProjectPolicy, ISSUE_IDENTITY_QUERY } from './flow-project-policy-resolver.mjs';
import { CHECKPOINT_BRANCH_REF } from './flow-checkpoint-registration.mjs';
import { isHandoffSubject } from './flow-handoff-binding.mjs';

function fixture(){const registration={version:1,source:'a'.repeat(32),repository:'owner/private-project',repositoryId:'repo-id',
  projectOwner:'owner',projectNumber:4,projectId:'project-id',statusFieldId:'field-id',statusFieldName:'Status',appId:12,
  updateRulesetId:1,historyRulesetId:2,trustedAuthorIds:['user'],checkpoint:{repositoryId:'repo-id',ref:CHECKPOINT_BRANCH_REF,
    genesisOid:'b'.repeat(40),cutoverAt:'2026-01-01T10:00:00Z',checkpointSchemaVersion:2}};
  const candidate={kind:'candidate',repository:registration.repository,issueNumber:7};let calls=0;
  const response=()=>({data:{repository:{id:'repo-id',nameWithOwner:registration.repository,issue:{id:'issue-node',number:7}}}});
  const graphql=async(query,variables)=>{calls++;assert.equal(query,ISSUE_IDENTITY_QUERY);assert.deepEqual(variables,{owner:'owner',repo:'private-project',number:7});return response();};
  return {registration,candidate,graphql,getCalls:()=>calls};}
test('binds a trusted project registration to a twice-read issue identity',async()=>{
  const f=fixture(),result=await resolveProjectPolicy({...f,source:f.registration.source});
  assert.equal(result.kind,'project-policy-resolved');assert.equal(result.policy.repositoryId,'repo-id');
  assert.equal(result.policy.issueId,'issue-node');assert.equal(result.policy.issueNumber,7);assert.equal(isHandoffSubject(result.policy),true);assert.equal(f.getCalls(),2);
});
test('blocks mismatched routes and unstable, missing or wrong-repository issue identity',async()=>{
  let f=fixture();assert.equal((await resolveProjectPolicy({...f,source:'b'.repeat(32)})).kind,'blocked');assert.equal(f.getCalls(),0);
  f=fixture();f.candidate.repository='other/repo';assert.equal((await resolveProjectPolicy({...f,source:f.registration.source})).kind,'blocked');
  f=fixture();let count=0;f.graphql=async()=>({data:{repository:{id:'repo-id',nameWithOwner:f.registration.repository,issue:{id:++count===1?'first':'second',number:7}}}});
  assert.equal((await resolveProjectPolicy({...f,source:f.registration.source})).kind,'blocked');
  f=fixture();f.graphql=async()=>({data:{repository:{id:'other',nameWithOwner:f.registration.repository,issue:{id:'issue-node',number:7}}}});
  assert.equal((await resolveProjectPolicy({...f,source:f.registration.source})).kind,'blocked');
});
