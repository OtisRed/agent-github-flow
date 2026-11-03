import test from 'node:test';
import assert from 'node:assert/strict';
import { createV3RegistryWriteGuard } from './flow-v3-registry-write-guard.mjs';
import { V3_REGISTRY_REF,V3_REGISTRY_ANCHOR_REF } from './flow-v3-registry-git-plan.mjs';

function fixture(role){
  const ref=role==='private'?V3_REGISTRY_REF:V3_REGISTRY_ANCHOR_REF,head='a'.repeat(40),state={reads:0,changed:false,wrong:false};
  const readBranch=async()=>({kind:'v3-registry-branch-observed',role,head:state.changed&&++state.reads>1?'b'.repeat(40):head});
  const readProtection=async()=>({kind:'v3-registry-protection-audit-observed',role,ref,repositoryId:'repo-id',appId:state.wrong?13:12,
    updateRulesetId:1,historyRulesetId:2});
  const guard=createV3RegistryWriteGuard({role,repositoryId:'repo-id',appId:12,updateRulesetId:1,historyRulesetId:2,readBranch,readProtection});
  return {guard,state,candidate:{role,repositoryId:'repo-id',ref,appId:12,expectedHeadOid:head}};
}
test('binds a current scoped branch to its separately audited registry protection',async()=>{
  for(const role of ['private','anchor']){const f=fixture(role),proof=await f.guard(f.candidate);
    assert.equal(proof.kind,'v3-registry-protection-observed');assert.equal(proof.expectedHeadOid,f.candidate.expectedHeadOid);}
});
test('rejects changed branch, wrong App or target before providing a guard receipt',async()=>{
  let f=fixture('private');f.state.changed=true;assert.equal((await f.guard(f.candidate)).kind,'blocked');
  f=fixture('private');f.state.wrong=true;assert.equal((await f.guard(f.candidate)).kind,'blocked');
  f=fixture('private');assert.equal((await f.guard({...f.candidate,ref:V3_REGISTRY_ANCHOR_REF})).kind,'blocked');
});
