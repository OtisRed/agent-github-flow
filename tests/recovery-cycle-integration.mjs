// Uses the actual pinned v3 cycle with synthetic GitHub/context and a virtual clock.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {readSync,writeSync} from 'node:fs';
import {isDeepStrictEqual as isDeepEqual} from 'node:util';
import {observeStatusRecovery} from '../src/worker-recovery-observe.mjs';
import {createWorkerStatusSigner} from '../src/worker-status-commitment.mjs';
import {runGuardedReservation} from '../src/worker-reservation-guard.mjs';
import {matchesFinalContext} from '../src/worker-final-context.mjs';

const root=process.env.AGF_CONTROLLER_ROOT;
if(!root) throw Error('AGF_CONTROLLER_ROOT required');
const load=name=>import(pathToFileURL(join(root,'src',name)).href);
const {runFirstV3Cycle}=await load('flow-first-v3-cycle.mjs');
const {planInitialV3Handoff}=await load('flow-v3-initial-handoff.mjs');
const {createCheckpointKeyring}=await load('flow-checkpoint-keyring.mjs');
const {FLOW_STATUSES}=await load('flow.mjs');
const {resolveV3ProjectPolicy}=await load('flow-project-policy-resolver.mjs');
const {v3HandoffBinding}=await load('flow-v3-handoff-binding.mjs');
const {createV3PublicationStep}=await load('flow-v3-publication-step.mjs');
const {createV3ProjectStatusStep}=await load('flow-v3-project-status-step.mjs');
const {encodeCheckpointV3,verifyCheckpointV3Continuity}=await load('flow-checkpoint-v3.mjs');
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
  const handoffEvidence={kind:'evidence',handoff}, trustedAuthorIds=['user','other'],expectedProjectId='project';
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
  return {input,project,checkpoint,handoff,graphql,routes,keyring,setChanged:()=>{change=true;},counts:()=>({waited,reads,writes})};
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
if(request.mode==='transition'){
  const {signer,metadata}=statusCommitment(f);
  const transition=signer.transition({metadata,oldOid:f.checkpoint.headOid,newOid:'d'.repeat(40),
    treeOid:'e'.repeat(40),reservedAt:'2026-01-01T10:03:00Z'});
  assert.equal(transition.kind,'worker-ref-transition');
  await new Promise(resolve=>process.stdout.write(JSON.stringify(transition)+'\n',resolve));
  process.exit(0);
}
const prepared=statusCommitment(f);
assert.equal(prepared.signer.verify(prepared.metadata,request.commitment),true);
{
  const g=fixture();g.project.currentStatus='agent-ready';g.project.statusOptionId='ready';
  const before=structuredClone(await g.input.collectContext()),after=structuredClone(before);
  const oldOid=before.observation.checkpoint.headOid,newOid='d'.repeat(40),record=before.observation.checkpoint.selectedRecord;
  after.observation.checkpoint.headOid=newOid;after.observation.checkpoint.selectedRecord.current.phase='committed';
  after.observation.checkpoint.selectedRecord.reservation=null;
  const marker=record.current,receipt={repositoryId:record.repositoryId,issueId:record.issueId,number:record.number,
    phase:'committed',commentId:marker.commentId,commentMac:marker.commentMac,commentKeyId:marker.commentKeyId,
    configMac:marker.configMac,configKeyId:marker.configKeyId,checkpointOid:newOid};
  const input={before,after,receipt,oldOid,newOid,itemId:'item',targetOptionId:'ready',
    encode:encodeCheckpointV3,verifyContinuity:verifyCheckpointV3Continuity};
  assert.equal(matchesFinalContext(input),true);
  for(const change of [v=>v.after.observation.checkpoint.headOid='f'.repeat(40),
    v=>v.after.observation.checkpoint.selectedRecord.current.commentId='999',
    v=>v.after.observation.checkpoint.index.issues=[],v=>v.after.observation.project.itemId='other',
    v=>v.after.observation.handoffEvidence.handoff.authorId='other',v=>v.receipt.commentId='999']){
    const altered={...input,after:structuredClone(after),receipt:structuredClone(receipt)};change(altered);
    assert.equal(matchesFinalContext(altered),false);
  }
  for(const change of [c=>c.observation.project.statusOptionId='foreign',c=>c.observation.project.itemId='foreign',
    c=>c.observation.project.issueState='CLOSED',c=>c.observation.project.issueNodeId='other',
    c=>{c.observation.project.statusOptions.find(x=>x.name==='agent-ready').id='foreign';}]){
    const altered={...input,before:structuredClone(before),after:structuredClone(after)};
    change(altered.before);change(altered.after);assert.equal(matchesFinalContext(altered),false);
  }
  const changing={...input,encode:record=>{const result=encodeCheckpointV3(record);record.number=999;return result;}};
  assert.equal(matchesFinalContext(changing),true);
}
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

function guardedFixture({recordFailure=false,publishFailure=false,observeFailure=false,confirmFailure=false,
  mutateAfterRecord=false,mutateRecordPlan=false,journalOverride=null,runStatus=false,statusFailure=false,
  statusFailureAfterWrite=false,statusNoObservation=false,statusMismatch=false}={}){
  const v=fixture(),{signer,metadata,commitment}=statusCommitment(v);
  let recorded=null,records=0,confirms=0,refWrites=0,statusWrites=0,statusTargets=[];
  const verifyProtection=async()=>({kind:'checkpoint-protection-observed',repositoryId:'repo-id',appId:12,updateRulesetId:1,historyRulesetId:2});
  const prepare=async({snapshot})=>({kind:'checkpoint-objects-prepared',expectedHeadOid:snapshot.headOid,
    expectedTreeOid:'e'.repeat(40),commit:{sha:'d'.repeat(40),tree:{sha:'e'.repeat(40)},parents:[{sha:snapshot.headOid}]}});
  const publish=async payload=>{refWrites++;if(publishFailure)throw Error('synthetic failure');
    v.checkpoint.headOid=payload.commit.sha;v.checkpoint.selectedRecord=payload.after;return {kind:'ref-update-acknowledged'};};
  const observe=async()=>observeFailure?{kind:'blocked'}:{kind:'publication-observed'};
  const journal=journalOverride??{record:async(_id,plan)=>{records++;if(recordFailure)return {kind:'blocked'};
      if(mutateRecordPlan)plan.newOid='f'.repeat(40);recorded=structuredClone(plan);
      if(mutateAfterRecord)v.project.itemId='changed-card';return {kind:'recorded'};},
    read:async()=>structuredClone(recorded),
    confirm:async(_id,plan)=>{confirms++;return confirmFailure||!isDeepEqual(plan,recorded)?{kind:'blocked'}:{kind:'confirmed'};},
    matchesStatus:async(_id,value)=>!statusMismatch&&confirms===1&&value.keyId===recorded?.keyId&&value.mac===recorded?.nextMac
      ?{kind:'matched'}:{kind:'blocked'}};
  const publicationInputs={policy:v.input.policy,projectRegistration:v.input.projectRegistration,
    registrationCommitment:v.input.registrationCommitment,keyring:v.keyring,collectContext:v.input.collectContext,
    verifyProtection,prepare,publish,observe};
  const args={state,delivery,routes:v.routes,graphql:v.graphql,keyring:v.keyring,resolvePolicy:resolveV3ProjectPolicy,
    runCycle:runFirstV3Cycle,cycleInput:v.input,signer,commitment,metadata,createPublicationStep:createV3PublicationStep,
    publicationInputs,deriveBinding:v3HandoffBinding,journal};
  if(runStatus){
    const transport={projectId:'project',statusFieldId:'status',setStatus:async values=>{statusWrites++;
      statusTargets.push(structuredClone(values));
      assert.deepEqual(values,{itemId:'item',targetOptionId:'ready'});
      if(statusFailure)throw Error('synthetic status failure');
      if(!statusNoObservation){v.project.currentStatus='agent-ready';v.project.statusOptionId='ready';}
      if(statusFailureAfterWrite)throw Error('synthetic response lost after status change');
      return {kind:'status-write-acknowledged'};}};
    args.createStatusStep=createV3ProjectStatusStep;
    args.statusInputs={collectContext:v.input.collectContext,verifyProtection,transport};
  }
  return {args,project:v.project,checkpoint:v.checkpoint,handoff:v.handoff,statusTargets,
    counts:()=>({records,confirms,refWrites,waited:v.counts().waited,statusWrites:statusWrites+v.counts().writes})};
}
if(request.mode==='guarded-status-ipc'){
  const requestFd=Number(process.env.AGF_TEST_REQUEST_FD),replyFd=Number(process.env.AGF_TEST_REPLY_FD);
  assert.ok(Number.isInteger(requestFd)&&requestFd>=3&&Number.isInteger(replyFd)&&replyFd>=3&&requestFd!==replyFd);
  const call=(operation,id,transition)=>{
    writeSync(requestFd,JSON.stringify({operation,id,transition})+'\n');
    const bytes=[];const one=Buffer.alloc(1);
    while(bytes.length<4096){if(readSync(replyFd,one,0,1,null)!==1)throw Error('journal reply unavailable');
      if(one[0]===10)return JSON.parse(Buffer.from(bytes).toString('utf8'));bytes.push(one[0]);}
    throw Error('journal reply too long');
  };
  const journal={record:async(id,plan)=>call('record',id,plan),read:async id=>call('read',id),
    confirm:async(id,plan)=>call('confirm',id,plan),matchesStatus:async(id,value)=>call('match-status',id,value)};
  const g=guardedFixture({journalOverride:journal,runStatus:true});
  assert.deepEqual(await runGuardedReservation(g.args),{kind:'status-observed-commit-blocked'});
  assert.equal(g.counts().refWrites,1);assert.equal(g.counts().statusWrites,1);assert.equal(g.counts().waited,120000);
  await new Promise(resolve=>process.stdout.write('synthetic guarded status and ledger passed\n',resolve));
  process.exit(0);
}
let guarded=guardedFixture();
assert.deepEqual(await runGuardedReservation(guarded.args),{kind:'reservation-observed-status-blocked'});
assert.deepEqual(guarded.counts(),{records:1,confirms:1,refWrites:1,waited:120000,statusWrites:0});
guarded=guardedFixture({runStatus:true});
assert.deepEqual(await runGuardedReservation(guarded.args),{kind:'status-observed-commit-blocked'});
assert.deepEqual(guarded.counts(),{records:1,confirms:1,refWrites:1,waited:120000,statusWrites:1});
for(const settings of [{statusFailure:true},{statusFailureAfterWrite:true},{statusNoObservation:true},{statusMismatch:true}]){
  guarded=guardedFixture({runStatus:true,...settings});
  assert.deepEqual(await runGuardedReservation(guarded.args),{kind:'blocked'});
  assert.equal(guarded.counts().statusWrites,settings.statusMismatch?0:1);
  assert.equal(guarded.counts().confirms,1);
}
guarded=guardedFixture({runStatus:true});
guarded.args.createStatusStep=()=>async args=>({kind:'status-target-observed',binding:args.expectedBinding});
assert.deepEqual(await runGuardedReservation(guarded.args),{kind:'blocked'});
assert.equal(guarded.counts().statusWrites,0);
for(const change of [g=>{g.checkpoint.headOid='f'.repeat(40);},g=>{g.project.itemId='changed-card';}]){
  guarded=guardedFixture({runStatus:true});let checks=0;const original=guarded.args.journal.matchesStatus;
  guarded.args.journal.matchesStatus=async(...args)=>{const result=await original(...args);
    if(++checks===2)change(guarded);return result;};
  assert.deepEqual(await runGuardedReservation(guarded.args),{kind:'blocked'});
  assert.equal(guarded.counts().statusWrites,0);
}
guarded=guardedFixture({runStatus:true});
let transportChecks=0,foreignWrites=0;const originalMatches=guarded.args.journal.matchesStatus;
guarded.args.journal.matchesStatus=async(...args)=>{const result=await originalMatches(...args);
  if(++transportChecks===2)guarded.args.statusInputs.transport={projectId:'foreign',statusFieldId:'foreign',
    setStatus:async()=>{foreignWrites++;return {kind:'status-write-acknowledged'};}};return result;};
assert.deepEqual(await runGuardedReservation(guarded.args),{kind:'status-observed-commit-blocked'});
assert.equal(foreignWrites,0);assert.equal(guarded.counts().statusWrites,1);
guarded=guardedFixture({runStatus:true});
guarded.args.createStatusStep=options=>async()=>{
  const values={itemId:'item',targetOptionId:'ready'};
  const pending=options.transport.setStatus(values);
  values.itemId='foreign';values.targetOptionId='foreign';
  await pending;return {kind:'blocked'};
};
assert.deepEqual(await runGuardedReservation(guarded.args),{kind:'blocked'});
assert.equal(guarded.counts().statusWrites,1);
assert.deepEqual(guarded.statusTargets,[{itemId:'item',targetOptionId:'ready'}]);
guarded=guardedFixture({recordFailure:true});
assert.deepEqual(await runGuardedReservation(guarded.args),{kind:'blocked'});
assert.deepEqual(guarded.counts(),{records:1,confirms:0,refWrites:0,waited:120000,statusWrites:0});
guarded=guardedFixture({publishFailure:true});
assert.deepEqual(await runGuardedReservation(guarded.args),{kind:'blocked'});
assert.deepEqual(guarded.counts(),{records:1,confirms:0,refWrites:1,waited:120000,statusWrites:0});
guarded=guardedFixture({observeFailure:true});
assert.deepEqual(await runGuardedReservation(guarded.args),{kind:'blocked'});
assert.deepEqual(guarded.counts(),{records:1,confirms:0,refWrites:1,waited:120000,statusWrites:0});
guarded=guardedFixture({confirmFailure:true});
assert.deepEqual(await runGuardedReservation(guarded.args),{kind:'blocked'});
assert.deepEqual(guarded.counts(),{records:1,confirms:1,refWrites:1,waited:120000,statusWrites:0});
guarded=guardedFixture();guarded.project.currentStatus='agent-ready';guarded.project.statusOptionId='ready';
assert.deepEqual(await runGuardedReservation(guarded.args),{kind:'blocked'});
assert.deepEqual(guarded.counts(),{records:0,confirms:0,refWrites:0,waited:0,statusWrites:0});
guarded=guardedFixture();guarded.project.itemId='changed-card';
assert.deepEqual(await runGuardedReservation(guarded.args),{kind:'blocked'});
assert.deepEqual(guarded.counts(),{records:0,confirms:0,refWrites:0,waited:0,statusWrites:0});
guarded=guardedFixture();guarded.args.metadata.fromOptionId='old-option';
guarded.args.commitment=guarded.args.signer.sign(guarded.args.metadata);
assert.deepEqual(await runGuardedReservation(guarded.args),{kind:'blocked'});
assert.deepEqual(guarded.counts(),{records:0,confirms:0,refWrites:0,waited:0,statusWrites:0});
guarded=guardedFixture();
const originalWait=guarded.args.cycleInput.wait;
guarded.args.cycleInput.wait=async ms=>{await originalWait(ms);guarded.project.itemId='changed-card';};
assert.deepEqual(await runGuardedReservation(guarded.args),{kind:'blocked'});
assert.deepEqual(guarded.counts(),{records:0,confirms:0,refWrites:0,waited:120000,statusWrites:0});
guarded=guardedFixture({mutateAfterRecord:true});
assert.deepEqual(await runGuardedReservation(guarded.args),{kind:'blocked'});
assert.deepEqual(guarded.counts(),{records:1,confirms:0,refWrites:0,waited:120000,statusWrites:0});
guarded=guardedFixture({mutateRecordPlan:true});
assert.deepEqual(await runGuardedReservation(guarded.args),{kind:'blocked'});
assert.deepEqual(guarded.counts(),{records:1,confirms:0,refWrites:0,waited:120000,statusWrites:0});
guarded=guardedFixture();
guarded.args.deriveBinding=(policy,record,oid)=>{const result=v3HandoffBinding(policy,record,oid);
  record.reservation.reservedAt='2026-01-01T11:00:00Z';return result;};
assert.deepEqual(await runGuardedReservation(guarded.args),{kind:'reservation-observed-status-blocked'});
assert.deepEqual(guarded.counts(),{records:1,confirms:1,refWrites:1,waited:120000,statusWrites:0});
guarded=guardedFixture();
guarded.args.deriveBinding=(policy,record,oid)=>{const result=v3HandoffBinding(policy,record,oid);
  guarded.checkpoint.headOid='f'.repeat(40);return result;};
assert.deepEqual(await runGuardedReservation(guarded.args),{kind:'blocked'});
assert.deepEqual(guarded.counts(),{records:0,confirms:0,refWrites:0,waited:120000,statusWrites:0});
guarded=guardedFixture();
let journalReads=0;const originalRead=guarded.args.journal.read;
guarded.args.journal.read=async id=>{const saved=await originalRead(id);
  if(++journalReads===2)guarded.checkpoint.headOid='f'.repeat(40);return saved;};
assert.deepEqual(await runGuardedReservation(guarded.args),{kind:'blocked'});
assert.deepEqual(guarded.counts(),{records:1,confirms:0,refWrites:1,waited:120000,statusWrites:0});
for(const change of [g=>{g.checkpoint.headOid='f'.repeat(40);},
  g=>{g.checkpoint.selectedRecord.reservation.reservedAt='2026-01-01T10:04:00Z';},
  g=>{g.handoff.body+=' changed';},g=>{g.handoff.id='999';},g=>{g.handoff.authorId='other';},
  g=>{g.project.itemId='changed-card';}]){
  guarded=guardedFixture();const original=guarded.args.createPublicationStep;
  guarded.args.createPublicationStep=options=>{const step=original(options);return async args=>{
    const result=await step(args);change(guarded);return result;};};
  assert.deepEqual(await runGuardedReservation(guarded.args),{kind:'blocked'});
  assert.deepEqual(guarded.counts(),{records:1,confirms:0,refWrites:1,waited:120000,statusWrites:0});
}
process.stdout.write('synthetic real-v3 recovery observation passed\n');
