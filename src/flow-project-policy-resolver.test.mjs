import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProjectPolicy, resolveV3ProjectPolicy, ISSUE_IDENTITY_QUERY } from './flow-project-policy-resolver.mjs';
import { CHECKPOINT_BRANCH_REF } from './flow-checkpoint-registration.mjs';
import { isHandoffSubject } from './flow-handoff-binding.mjs';
import { createFlowReadTransports } from './flow-read-transports.mjs';
import { createCheckpointKeyring } from './flow-checkpoint-keyring.mjs';
import { FLOW_STATUSES } from './flow.mjs';

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

test('resolves the issue through the bounded App read transport',async()=>{
  const f=fixture(),calls=[];
  const transports=createFlowReadTransports({projectToken:'synthetic-project-token',issueToken:'synthetic-app-token',
    request:async(url,options)=>{calls.push({url,authorization:options.headers.Authorization});
      return {status:200,text:async()=>JSON.stringify({data:{repository:{id:'repo-id',nameWithOwner:f.registration.repository,
        issue:{id:'issue-node',number:7}}}}),headers:{get:()=>null}};}});
  const result=await resolveProjectPolicy({registration:f.registration,candidate:f.candidate,source:f.registration.source,graphql:transports.issueGraphql});
  assert.equal(result.kind,'project-policy-resolved');assert.equal(calls.length,2);
  assert.ok(calls.every(call=>call.url==='https://api.github.com/graphql'&&call.authorization==='Bearer synthetic-app-token'));
});
test('v3 resolves only the exact HMAC-authenticated registration and still checks issue twice',async()=>{
  const f=fixture();f.registration.version=3;f.registration.expectedPrivate=true;f.registration.dataPolicy='common-v3';
  f.registration.statusOptions=FLOW_STATUSES.map((name,index)=>({name,id:`option-${index}`}));f.registration.checkpoint.checkpointSchemaVersion=3;
  const keyring=createCheckpointKeyring({currentKeyId:1,keys:[{id:1,key:Buffer.alloc(32,1)}]});
  const registrationCommitment={keyId:1,mac:keyring.current().config(f.registration)};
  const input={...f,source:f.registration.source,keyring,registrationCommitment};
  const result=await resolveV3ProjectPolicy(input);assert.equal(result.kind,'project-policy-resolved');assert.equal(f.getCalls(),2);
  assert.equal(result.policy.issueId,'issue-node');assert.equal(result.checkpoint.checkpointSchemaVersion,3);
  const wrong=structuredClone(f.registration);wrong.statusOptions[0].id='changed';
  assert.equal((await resolveV3ProjectPolicy({...input,registration:wrong})).kind,'blocked');assert.equal(f.getCalls(),2);
  assert.equal((await resolveV3ProjectPolicy({...input,registrationCommitment:{keyId:2,mac:registrationCommitment.mac}})).kind,'blocked');
  assert.equal((await resolveProjectPolicy(input)).kind,'blocked');
});
