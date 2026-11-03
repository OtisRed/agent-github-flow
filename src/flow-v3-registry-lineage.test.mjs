import test from 'node:test';
import assert from 'node:assert/strict';
import { observeV3RegistryLineage,createV3RegistryLineageGuard } from './flow-v3-registry-lineage.mjs';
const genesisOid='a'.repeat(40),headOid='b'.repeat(40),repositoryId='repo-id';
const comparison=()=>({status:'ahead',ahead_by:1,behind_by:0,base_commit:{sha:genesisOid},merge_base_commit:{sha:genesisOid},commits:[{sha:headOid}]});
test('binds each registry role to its pinned genesis without claiming rollback protection',()=>{
  for(const role of ['private','anchor']){const result=observeV3RegistryLineage({role,repositoryId,genesisOid,headOid,comparison:comparison()});
    assert.equal(result.kind,'v3-registry-lineage-observed');assert.equal(result.rollbackProtected,false);}
  const same={...comparison(),status:'identical',ahead_by:0,commits:[]};
  assert.equal(observeV3RegistryLineage({role:'private',repositoryId,genesisOid,headOid:genesisOid,comparison:same}).kind,'v3-registry-lineage-observed');
});
test('fresh pinned ancestry is bound to two stable reads of the expected branch',async()=>{
  let reads=0,change=false;const role='private';
  const readBranch=async()=>({kind:'v3-registry-branch-observed',role,repositoryId,head:change&&++reads>1?'c'.repeat(40):headOid});
  const guard=createV3RegistryLineageGuard({role,repositoryId,registryGenesisOid:genesisOid,readBranch,compare:async args=>{
    assert.deepEqual(args,{genesisOid,headOid});return comparison();}});
  assert.equal((await guard({expectedHeadOid:headOid})).kind,'v3-registry-lineage-observed');
  reads=0;change=true;assert.equal((await guard({expectedHeadOid:headOid})).kind,'blocked');
});
test('refuses divergent, incomplete and unbound comparisons',()=>{
  for(const mutate of [x=>x.merge_base_commit.sha='c'.repeat(40),x=>x.base_commit.sha='c'.repeat(40),x=>x.behind_by=1,
    x=>x.commits=[],x=>x.commits[0].sha='c'.repeat(40),x=>x.status='diverged']){
    const value=comparison();mutate(value);assert.equal(observeV3RegistryLineage({role:'private',repositoryId,genesisOid,headOid,comparison:value}).kind,'blocked');}
});
