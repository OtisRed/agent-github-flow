import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyV3Commitments } from './flow-v3-commitment-verifier.mjs';
import { createCheckpointKeyring } from './flow-checkpoint-keyring.mjs';
import { CHECKPOINT_BRANCH_REF } from './flow-checkpoint-registration.mjs';
import { FLOW_STATUSES } from './flow.mjs';

function fixture(){
  const options=FLOW_STATUSES.map((name,index)=>({name,id:`private-option-${index}`}));
  const registration={version:3,source:'a'.repeat(32),repository:'owner/project',repositoryId:'repo-id',expectedPrivate:false,dataPolicy:'common-v3',
    projectOwner:'owner',projectNumber:1,projectId:'private-project',statusFieldId:'private-field',statusFieldName:'Status',statusOptions:options,
    appId:12,updateRulesetId:1,historyRulesetId:2,trustedAuthorIds:['user'],checkpoint:{repositoryId:'repo-id',ref:CHECKPOINT_BRANCH_REF,
      genesisOid:'b'.repeat(40),cutoverAt:'2026-01-01T10:00:00Z',checkpointSchemaVersion:3}};
  const keyring=createCheckpointKeyring({currentKeyId:2,keys:[{id:1,key:Buffer.alloc(32,1)},{id:2,key:Buffer.alloc(32,2)}]});
  const body='[FLOW]\nRola: Designer\nStan docelowy: agent-ready\nWykonano: Praca\nNastępny krok: Kod';
  const comment={id:'4',authorId:'user',createdAt:'2026-01-01T10:01:00Z',body},epoch={kind:'initial',anchor:'issue-id'};
  const record={version:3,repositoryId:'repo-id',number:1,issueId:'issue-id',cutoverAt:registration.checkpoint.cutoverAt,epoch,reentry:null,
    current:{phase:'pending',commentId:'4',commentMac:keyring.forId(1).comment({repositoryId:'repo-id',issueId:'issue-id',commentId:'4',body}),
      commentKeyId:1,configMac:keyring.forId(1).config(registration),configKeyId:1,fromStatus:'needs-design',targetStatus:'agent-ready',
      createdAt:comment.createdAt,epoch},previous:null,reservation:null};
  return {registration,record,keyring,comments:[comment],repository:{node_id:'repo-id',full_name:'owner/project',private:false,fork:false},
    project:{kind:'branch-project-observed',projectId:'private-project',statusFieldId:'private-field',statusFieldName:'Status',statusOptions:structuredClone(options),issueNodeId:'issue-id',repository:'owner/project'}};
}

test('verifies historical key commitments and privately matches every live Project option',()=>{
  const result=verifyV3Commitments(fixture());assert.equal(result.kind,'v3-commitments-verified');
  assert.ok(!JSON.stringify(result).includes('private-option'));assert.ok(!JSON.stringify(result).includes('Praca'));
});
test('fails closed on changed or deleted comments, wrong author, missing old key and config change',()=>{
  for(const change of [v=>{v.comments=[];},v=>{v.comments[0].body+='!';},v=>{v.comments[0].authorId='other';},
    v=>{v.comments[0].body=v.comments[0].body.replace('Wykonano: Praca','Wykonano: Inna praca');},
    v=>{v.record.current.commentKeyId=99;},v=>{v.registration.projectId='other';},v=>{v.record.current.configKeyId=99;}]){
    const v=fixture();change(v);assert.equal(verifyV3Commitments(v).kind,'blocked');}
});
test('blocks changed visibility, repo, Project, field, option IDs or ambiguous option sets',()=>{
  for(const change of [v=>{v.repository.private=true;},v=>{v.repository.node_id='other';},v=>{v.project.projectId='other';},
    v=>{v.project.statusFieldId='other';},v=>{v.project.statusOptions[0].id='changed';},v=>{v.project.statusOptions.push(v.project.statusOptions[0]);}]){
    const v=fixture();change(v);assert.equal(verifyV3Commitments(v).kind,'blocked');}
});

test('blocks a changed status field name even when its ID remains the same',()=>{
  const value=fixture();value.project.statusFieldName='Renamed';assert.equal(verifyV3Commitments(value).kind,'blocked');
});
