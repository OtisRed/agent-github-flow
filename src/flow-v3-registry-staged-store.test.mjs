import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckpointKeyring } from './flow-checkpoint-keyring.mjs';
import { reserveV3Project, encodeV3Registry } from './flow-v3-registry.mjs';
import { createV3RegistryAnchor } from './flow-v3-registry-anchor.mjs';
import { verifyV3BootstrapEnrollment } from './flow-v3-bootstrap-enrollment.mjs';
import { createV3GenesisPinStep } from './flow-v3-genesis-pin-step.mjs';
import { createV3RegistryStagedStore, inspectV3RegistryStaging } from './flow-v3-registry-staged-store.mjs';

const oid=c=>c.repeat(40),policy={source:'a'.repeat(32),repository:'owner/project',repositoryId:'repo-id',expectedPrivate:false,
  cutoverAt:'2026-01-01T10:00:00Z',appId:12,updateRulesetId:1,historyRulesetId:2};
const bootstrap={genesisOid:oid('e'),treeOid:oid('f')};
function fixture(){
  const keyring=createCheckpointKeyring({currentKeyId:1,keys:[{id:1,key:Buffer.alloc(32,1)}]});
  const reserved=JSON.parse(reserveV3Project({version:1,revision:1,entries:[]},policy).content);
  const anchor=createV3RegistryAnchor(reserved,keyring).anchor;
  const state={privateHead:oid('a'),anchorHead:oid('b'),content:encodeV3Registry(reserved).content,
    anchor:structuredClone(anchor),stagedAnchor:structuredClone(anchor),privateParent:null,privateWrites:0,anchorWrites:0,fail:null};
  const read=async()=>structuredClone(state);
  const writePrivate=async({expectedHead,content,stagedAnchor})=>{state.privateWrites++;assert.equal(expectedHead,state.privateHead);
    if(state.fail==='private-refused')return {kind:'blocked'};
    state.privateParent=state.privateHead;state.privateHead=oid('c');state.content=content;state.stagedAnchor=stagedAnchor;
    if(state.fail==='anchor-race')state.anchorHead=oid('9');
    if(state.fail==='private-after')throw Error('uncertain');return {kind:'registry-private-advanced',head:state.privateHead};};
  const writeAnchor=async({expectedHead,anchor})=>{state.anchorWrites++;assert.equal(expectedHead,state.anchorHead);
    if(state.fail==='anchor-cas-race'){state.anchorHead=oid('9');return {kind:'blocked'};}
    if(state.fail==='anchor-before')throw Error('uncertain');if(state.fail==='anchor-refused')return {kind:'blocked'};
    state.anchorHead=oid('d');state.anchor=anchor;
    if(state.fail==='anchor-after')throw Error('uncertain');return {kind:'registry-anchor-advanced',head:state.anchorHead};};
  const store=createV3RegistryStagedStore({keyring,read,writePrivate,writeAnchor});
  return {state,keyring,store,read,step:createV3GenesisPinStep({keyring,load:store.load,commit:store.commit})};
}
test('two CAS stages expose a verified pin only after both readbacks match',async()=>{
  const f=fixture(),result=await f.step(policy,bootstrap);assert.equal(result.kind,'v3-genesis-pinned');
  assert.equal(f.state.privateWrites,1);assert.equal(f.state.anchorWrites,1);
  const loaded=await f.store.load(),proof=verifyV3BootstrapEnrollment({...loaded,keyring:f.keyring,policy});
  assert.equal(proof.phase,'initializing');assert.deepEqual(proof.bootstrap,bootstrap);
});
test('a partial staged update blocks readers and is only reported through read-only diagnosis',async()=>{
  for(const mode of ['private-after','anchor-before']){
    const f=fixture(),before=await f.read();f.state.fail=mode;
    assert.equal((await f.step(policy,bootstrap)).kind,'v3-genesis-pin-uncertain');await assert.rejects(f.store.load());
    const current=await f.read(),inspection=inspectV3RegistryStaging({before,current,keyring:f.keyring});
    assert.equal(inspection.kind,'v3-registry-staging-observed');assert.equal(inspection.retryAllowed,false);
    assert.equal((await f.step(policy,bootstrap)).kind,'blocked');assert.equal(f.state.privateWrites,1);
  }
});
test('a lost acknowledgment after both stages stays uncertain even when later reads match',async()=>{
  const f=fixture();f.state.fail='anchor-after';assert.equal((await f.step(policy,bootstrap)).kind,'v3-genesis-pin-uncertain');
  const loaded=await f.store.load();assert.equal(verifyV3BootstrapEnrollment({...loaded,keyring:f.keyring,policy}).phase,'initializing');
  assert.equal(f.state.privateWrites,1);assert.equal(f.state.anchorWrites,1);
});
test('CAS refusals or a concurrent anchor movement stop without further writes',async()=>{
  for(const mode of ['private-refused','anchor-refused','anchor-race','anchor-cas-race']){const f=fixture();f.state.fail=mode;
    assert.equal((await f.step(policy,bootstrap)).kind,'v3-genesis-pin-uncertain');
    assert.equal(f.state.privateWrites,1);assert.equal(f.state.anchorWrites,['anchor-refused','anchor-cas-race'].includes(mode)?1:0);
    assert.equal((await f.step(policy,bootstrap)).kind,'blocked');}
});
