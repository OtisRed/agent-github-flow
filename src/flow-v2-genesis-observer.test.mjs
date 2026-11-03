import test from 'node:test';
import assert from 'node:assert/strict';
import { observeV2GenesisPublication } from './flow-v2-genesis-observer.mjs';
import { CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';

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
