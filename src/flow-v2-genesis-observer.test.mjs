import test from 'node:test';
import assert from 'node:assert/strict';
import { observeV2GenesisPublication } from './flow-v2-genesis-observer.mjs';
import { CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';
import { observeV3GenesisPublication } from './flow-v3-genesis-observer.mjs';
import { createV3SetupGitReader } from './flow-v3-git-reader.mjs';

const oid=c=>c.repeat(40);
function fixture(){const state={pair:[oid('a'),oid('a')],parents:[],reads:0};
  const input={repositoryId:'repo-id',repositoryFullName:'owner/project',genesisOid:oid('a'),expectedTreeOid:oid('b'),
    readRepository:async()=>({node_id:'repo-id',full_name:'owner/project',private:true,default_branch:'main'}),
    readRef:async name=>{const i=[CHECKPOINT_BRANCH_REF,CHECKPOINT_ANCHOR_REF].indexOf(name);const value=state.pair[i];state.reads++;
      return value===null?null:{ref:name,object:{type:'commit',sha:value}};},
    readCommit:async()=>({sha:oid('a'),tree:{sha:oid('b')},parents:state.parents})};return{state,input};}
test('observes both newly created refs and the exact root commit',async()=>{
  const f=fixture();assert.deepEqual(await observeV2GenesisPublication(f.input),{kind:'genesis-publication-observed',retryAllowed:false});
  assert.equal(f.state.reads,4);
});
test('observes v3 refs for matching public and private setup intents',async()=>{
  for(const expectedPrivate of [false,true]){const f=fixture();f.input.readRepository=async()=>({node_id:'repo-id',full_name:'owner/project',
    private:expectedPrivate,fork:false,default_branch:'main'});
    const input={...f.input,setupIntent:{repository:'owner/project',repositoryId:'repo-id',expectedPrivate,cutoverAt:'2026-01-01T10:00:00Z'}};
    assert.equal((await observeV3GenesisPublication(input)).kind,'genesis-publication-observed');
    f.state.pair=[null,null];assert.equal((await observeV3GenesisPublication(input)).kind,'genesis-publication-not-observed');
    f.input.readRepository=async()=>({node_id:'repo-id',full_name:'owner/project',private:expectedPrivate,fork:true,default_branch:'main'});
    input.readRepository=f.input.readRepository;assert.equal((await observeV3GenesisPublication(input)).kind,'blocked');
  }
});
test('v3 setup reader treats only exact ref 404s as absence after verifying App scope',async()=>{
  const setupIntent={repository:'owner/project',repositoryId:'repo-id',expectedPrivate:false,cutoverAt:'2026-01-01T10:00:00Z'};
  const state={private:false,calls:[]};
  const request=async(url,options)=>{state.calls.push({url,method:options.method});assert.equal(options.headers.Authorization,'Bearer synthetic-app');
    if(url.endsWith('/installation/repositories'))return {status:200,text:async()=>JSON.stringify({total_count:1,
      repositories:[{node_id:'repo-id',full_name:'owner/project',private:state.private,fork:false}]}),headers:{get:()=>null}};
    if(url.endsWith('/repos/owner/project'))return {status:200,text:async()=>JSON.stringify({node_id:'repo-id',full_name:'owner/project',
      private:false,fork:false,default_branch:'main'}),headers:{get:()=>null}};
    if(url.includes('/git/ref/')||url.includes('/git/commits/'))return {status:404};throw Error('unexpected');};
  const reader=createV3SetupGitReader({setupIntent,appToken:'synthetic-app',request});
  assert.deepEqual(await observeV3GenesisPublication({setupIntent,genesisOid:oid('a'),expectedTreeOid:oid('b'),
    readRepository:reader.readRepository,readRef:reader.readRef,readCommit:reader.readCommit}),
    {kind:'genesis-publication-not-observed',retryAllowed:false});
  assert.ok(state.calls.every(call=>call.method==='GET'));assert.throws(()=>reader.readRef('refs/heads/main'));
  await assert.rejects(reader.readCommit(oid('a')));
  state.private=true;await assert.rejects(reader.readRef(CHECKPOINT_BRANCH_REF));
});
test('absent, mixed or changed refs never authorize retry or report success',async()=>{
  let f=fixture();f.state.pair=[null,null];assert.deepEqual(await observeV2GenesisPublication(f.input),{kind:'genesis-publication-not-observed',retryAllowed:false});
  f=fixture();f.state.pair=[oid('a'),null];assert.equal((await observeV2GenesisPublication(f.input)).kind,'blocked');
  f=fixture();f.state.parents=[{sha:oid('c')}];assert.equal((await observeV2GenesisPublication(f.input)).kind,'blocked');
  f=fixture();f.input.readRepository=async()=>({node_id:'repo-id',full_name:'owner/project',private:false,default_branch:'main'});
  assert.equal((await observeV2GenesisPublication(f.input)).kind,'blocked');
  f=fixture();let reads=0;f.input.readRepository=async()=>({node_id:'repo-id',full_name:++reads===1?'owner/project':'owner/renamed',private:true,default_branch:'main'});
  assert.equal((await observeV2GenesisPublication(f.input)).kind,'blocked');
  assert.equal((await observeV2GenesisPublication(null)).kind,'blocked');
  f=fixture();const read=f.input.readRef;f.input.readRef=async name=>{const result=await read(name);if(f.state.reads===2)f.state.pair[0]=oid('c');return result;};
  assert.equal((await observeV2GenesisPublication(f.input)).kind,'blocked');
});
