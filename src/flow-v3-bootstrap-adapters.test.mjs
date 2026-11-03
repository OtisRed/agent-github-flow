import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createV3BootstrapAdapters } from './flow-v3-bootstrap-adapters.mjs';
import { runV3BootstrapCycle } from './flow-v3-bootstrap-cycle.mjs';
import { planV3Genesis } from './flow-v3-genesis-plan.mjs';
import { CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';

const oid=c=>c.repeat(40);
function fixture(expectedPrivate=false){
  const policy={repository:'owner/project',repositoryId:'repo-id',expectedPrivate,cutoverAt:'2026-01-01T10:00:00Z',
    appId:12,updateRulesetId:1,historyRulesetId:2};
  const setupIntent={repository:policy.repository,repositoryId:policy.repositoryId,expectedPrivate,cutoverAt:policy.cutoverAt};
  const plan=planV3Genesis({repositoryId:policy.repositoryId,cutoverAt:policy.cutoverAt});
  const blobs=plan.files.map(file=>{const bytes=Buffer.from(file.contents,'base64');return {file,bytes,
    sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')};});
  const tree={sha:oid('a'),truncated:false,tree:blobs.map(b=>({path:b.file.path,type:'blob',mode:'100644',sha:b.sha,size:b.bytes.length}))};
  const state={created:false,mutations:0,calls:[],throwAfterSet:false};
  const reply=(value,status=200)=>({status,text:async()=>JSON.stringify(value),headers:{get:()=>null}});
  const request=async(url,options)=>{state.calls.push({url,method:options.method,body:options.body});assert.equal(options.headers.Authorization,'Bearer synthetic-app');
    const path=new URL(url).pathname;
    if(path==='/installation/repositories')return reply({total_count:1,repositories:[{node_id:'repo-id',full_name:'owner/project',private:expectedPrivate,fork:false}]});
    if(path==='/repos/owner/project')return reply({node_id:'repo-id',full_name:'owner/project',private:expectedPrivate,fork:false,default_branch:'main'});
    if(path.includes('/git/ref/heads/agent-github-flow/')){
      if(!state.created)return reply({},404);const ref=path.endsWith('/checkpoints')?CHECKPOINT_BRANCH_REF:CHECKPOINT_ANCHOR_REF;
      return reply({ref,object:{type:'commit',sha:oid('b')}});}
    if(path==='/repos/owner/project/git/trees'&&options.method==='POST')return reply({sha:oid('a')},201);
    if(path===`/repos/owner/project/git/trees/${oid('a')}`)return reply(tree);
    if(path==='/repos/owner/project/git/commits'&&options.method==='POST')return reply({sha:oid('b')},201);
    if(path===`/repos/owner/project/git/commits/${oid('b')}`)return reply({sha:oid('b'),tree:{sha:oid('a')},parents:[]});
    if(path===`/repos/owner/project/compare/${oid('b')}...${oid('b')}`)return reply({status:'identical',ahead_by:0,behind_by:0,
      base_commit:{sha:oid('b')},merge_base_commit:{sha:oid('b')},commits:[]});
    const blob=blobs.find(b=>path===`/repos/owner/project/git/blobs/${b.sha}`);
    if(blob)return reply({sha:blob.sha,size:blob.bytes.length,encoding:'base64',content:blob.file.contents});
    if(path==='/graphql'){state.mutations++;state.created=true;if(state.throwAfterSet)throw Error('uncertain');
      return reply({data:{updateRefs:{__typename:'UpdateRefsPayload'}}});}
    throw Error('unexpected');};
  const adapters=createV3BootstrapAdapters({setupIntent,appToken:'synthetic-app',request});
  const input={policy,...adapters,verifyEnrollment:async p=>({kind:'bootstrap-permitted',policy:p}),
    verifyApp:async()=>({kind:'app-identity-verified',repositoryId:'repo-id',appId:12}),
    verifyProtection:async()=>({kind:'checkpoint-protection-observed',repositoryId:'repo-id',appId:12,updateRulesetId:1,historyRulesetId:2})};
  return {policy,setupIntent,state,adapters,input};
}
test('v3 bootstrap composes real bounded adapters and reads genesis back on modeled GitHub',async()=>{
  for(const expectedPrivate of [false,true]){const f=fixture(expectedPrivate),result=await runV3BootstrapCycle(f.input);
    assert.equal(result.kind,'v3-registration-candidate');assert.equal(result.registration.genesisOid,oid('b'));assert.equal(f.state.mutations,1);
    const mutation=f.state.calls.find(call=>call.url.endsWith('/graphql'));
    assert.deepEqual(JSON.parse(mutation.body).variables.input.refUpdates,[CHECKPOINT_BRANCH_REF,CHECKPOINT_ANCHOR_REF]
      .map(name=>({name,beforeOid:'0'.repeat(40),afterOid:oid('b'),force:false})));}
});
test('v3 bootstrap confirms an uncertain create only by readback and never repeats it',async()=>{
  const f=fixture();f.state.throwAfterSet=true;const result=await runV3BootstrapCycle(f.input);
  assert.equal(result.kind,'v3-registration-candidate');assert.equal(f.state.mutations,1);
  assert.equal((await f.adapters.publish({setupIntent:f.setupIntent,genesisOid:oid('b'),expectedTreeOid:oid('a')})).kind,'blocked');
  assert.equal(f.state.mutations,1);
});
test('bootstrap adapters do not prepare a different setup or publish unprepared genesis',async()=>{
  const f=fixture();assert.equal((await f.adapters.prepare({...f.setupIntent,repository:'owner/other'})).kind,'blocked');
  assert.equal((await f.adapters.publish({setupIntent:f.setupIntent,genesisOid:oid('b'),expectedTreeOid:oid('a')})).kind,'blocked');
  assert.equal(f.state.calls.length,0);
});
