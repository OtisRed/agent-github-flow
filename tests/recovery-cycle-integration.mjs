// Uses the actual pinned v3 cycle with synthetic GitHub/context and a virtual clock.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {observeStatusRecovery} from '../src/worker-recovery-observe.mjs';
import {createWorkerStatusSigner} from '../src/worker-status-commitment.mjs';

const root=process.env.AGF_CONTROLLER_ROOT;
if(!root) throw Error('AGF_CONTROLLER_ROOT required');
const load=name=>import(pathToFileURL(join(root,'src',name)).href);
const {runFirstV3Cycle}=await load('flow-first-v3-cycle.mjs');
const {planInitialV3Handoff}=await load('flow-v3-initial-handoff.mjs');
const {createCheckpointKeyring}=await load('flow-checkpoint-keyring.mjs');
const {FLOW_STATUSES}=await load('flow.mjs');
const {resolveV3ProjectPolicy}=await load('flow-project-policy-resolver.mjs');
const {v3HandoffBinding}=await load('flow-v3-handoff-binding.mjs');
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));
const {state,delivery}=request;

function fixture(){
  const body='[FLOW]\nRola: Designer\nStan docelowy: agent-ready\nWykonano: Praca\nNastępny krok: Kod';
  const epoch={kind:'initial',anchor:'issue'};
  const handoff={kind:'handoff',id:'4',nodeId:'comment',authorId:'user',createdAt:'2026-01-01T10:01:00Z',body};
  const checkpoint={kind:'checkpoint-snapshot-observed',schemaVersion:3,headOid:'b'.repeat(40),repositoryId:'repo-id',
    repositoryFullName:'owner/project',cutoverAt:'2026-01-01T10:00:00Z',selection:{number:1,issueId:'issue'},
    index:{version:1,repositoryId:'repo-id',issues:[]},selectedRecord:null};
  const options=FLOW_STATUSES.map((name,index)=>({name,id:name==='needs-design'?'design':name==='agent-ready'?'ready':`option-${index}`}));
  const project={kind:'branch-project-observed',issueNodeId:'issue',repository:'owner/project',issueState:'OPEN',
    currentStatus:'needs-design',projectId:'project',itemId:'item',statusFieldId:'status',statusOptionId:'design',
    statusFieldName:'Status',statusOptions:options};
  const handoffEvidence={kind:'evidence',handoff}, trustedAuthorIds=['user'],expectedProjectId='project';
  const epochProof={kind:'handoff-epoch-evidence',issueNodeId:'issue',commentNodeId:'comment',commentId:'4',
    commentCreatedAt:handoff.createdAt,commentDigest:createHash('sha256').update(body).digest('hex'),epoch};
  const registration={repositoryId:'repo-id',ref:'refs/heads/agent-github-flow/checkpoints',genesisOid:'a'.repeat(40),
    cutoverAt:checkpoint.cutoverAt,checkpointSchemaVersion:3};
  const repository={node_id:'repo-id',full_name:'owner/project',private:false,fork:false};
  const projectRegistration={version:3,source:'a'.repeat(32),repository:'owner/project',repositoryId:'repo-id',expectedPrivate:false,
    dataPolicy:'common-v3',projectOwner:'board-owner',projectNumber:1,projectId:'project',statusFieldId:'status',statusFieldName:'Status',
    statusOptions:structuredClone(options),appId:12,updateRulesetId:1,historyRulesetId:2,trustedAuthorIds,checkpoint:registration};
  const keyring=createCheckpointKeyring({currentKeyId:1,keys:[{id:1,key:Buffer.alloc(32,1)}]});
  const policy={repositoryId:'repo-id',repository:'owner/project',projectId:'project',statusFieldId:'status',issueId:'issue',issueNumber:1,
    appId:12,updateRulesetId:1,historyRulesetId:2,trustedAuthorIds};
  const data={checkpoint,project,handoffEvidence,trustedAuthorIds,expectedProjectId,epochProof,registration,repository,projectRegistration,keyring};
  const initial=planInitialV3Handoff(data);assert.equal(initial.kind,'initial-handoff-v3-planned');
  checkpoint.selectedRecord=initial.record;checkpoint.selectedRecord.reservation={reservedAt:'2026-01-01T10:02:00Z'};
  checkpoint.index.issues.push({number:1,issueId:'issue'});
  let clock=0,waited=0,reads=0,writes=0,change=false;
  const input={policy,projectRegistration,registrationCommitment:{keyId:1,mac:keyring.current().config(projectRegistration)},keyring,
    collectContext:async()=>{reads++;return {repository,observation:{checkpoint,project,handoffEvidence,epochProof,trustedAuthorIds,expectedProjectId}};},
    verifyBootstrap:async r=>({kind:'v3-bootstrap-verified',registration:r}),
    makePublicationStep:()=>async()=>{writes++;throw Error('write forbidden');},
    makeStatusStep:()=>async()=>{writes++;throw Error('write forbidden');},
    wait:async ms=>{waited+=ms;clock+=ms;if(change)project.currentStatus='review';},monotonic:()=>clock,
    timestamp:()=> '2026-01-01T10:03:00Z'};
  const graphql=async(_query,vars)=>({data:{repository:{id:'repo-id',nameWithOwner:'owner/project',
    issue:{id:vars.number===1?'issue':'other-issue',number:vars.number}}}});
  const routes=[{installationId:'101',repositoryId:'201',registration:projectRegistration,
    registrationCommitment:input.registrationCommitment}];
  return {input,project,checkpoint,graphql,routes,keyring,setChanged:()=>{change=true;},counts:()=>({waited,reads,writes})};
}

function statusCommitment(v){
  const binding=v3HandoffBinding(v.input.policy,v.checkpoint.selectedRecord,v.checkpoint.headOid);
  assert.ok(binding);
  const signer=createWorkerStatusSigner({key:Buffer.alloc(32,1),keyId:1});
  const metadata={deliveryId:delivery.deliveryId,binding,itemId:'item',fromOptionId:'design',targetOptionId:'ready'};
  return {signer,metadata,commitment:signer.sign(metadata)};
}
let f=fixture();
if(request.mode==='commitment'){
  const {signer,metadata}=statusCommitment(f);
  if(request.targetOptionId)metadata.targetOptionId=request.targetOptionId;
  const commitment=signer.sign(metadata);
  assert.equal(commitment.kind,'worker-status-commitment');
  await new Promise(resolve=>process.stdout.write(JSON.stringify(commitment)+'\n',resolve));
  process.exit(0);
}
const prepared=statusCommitment(f);
assert.equal(prepared.signer.verify(prepared.metadata,request.commitment),true);
const observe=(v,overrides={})=>observeStatusRecovery({state,delivery,routes:v.routes,graphql:v.graphql,keyring:v.keyring,
  resolvePolicy:resolveV3ProjectPolicy,runCycle:runFirstV3Cycle,cycleInput:v.input,...overrides});
assert.deepEqual(await observe(f),{kind:'retry-path-observation'});
assert.equal(f.counts().waited,120000);assert.ok(f.counts().reads>=3);assert.equal(f.counts().writes,0);
f=fixture();f.project.currentStatus='agent-ready';f.project.statusOptionId='ready';
assert.deepEqual(await observe(f),{kind:'target-path-observation'});
assert.equal(f.counts().waited,0);assert.equal(f.counts().writes,0);
f=fixture();f.setChanged();
assert.deepEqual(await observe(f),{kind:'blocked'});
assert.equal(f.counts().waited,120000);assert.equal(f.counts().writes,0);
f=fixture();
assert.deepEqual(await observe(f,{delivery:{...delivery,issueNumber:'2'}}),{kind:'blocked'});
assert.equal(f.counts().waited,0);assert.equal(f.counts().writes,0);
const changed=structuredClone(prepared.metadata);changed.binding.reservation.reservedAt='2026-01-01T10:04:00Z';
assert.equal(prepared.signer.verify(changed,request.commitment),false);
process.stdout.write('synthetic real-v3 recovery observation passed\n');
