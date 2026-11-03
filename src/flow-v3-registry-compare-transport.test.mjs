import test from 'node:test';
import assert from 'node:assert/strict';
import { createV3RegistryCompareTransport } from './flow-v3-registry-compare-transport.mjs';
import { createV3RegistryLineageGuard } from './flow-v3-registry-lineage.mjs';
import { createV3RegistryWriteGuard } from './flow-v3-registry-write-guard.mjs';
import { V3_REGISTRY_REF } from './flow-v3-registry-git-plan.mjs';
const genesisOid='a'.repeat(40),headOid='b'.repeat(40),repository='owner/repo',repositoryId='repo-id';
function fixture(){const state={calls:[],wrong:false,link:false};
  const request=async(url,options)=>{state.calls.push({url,options});const target={node_id:state.wrong?'other':repositoryId,full_name:repository,private:true,fork:false};
    const value=url.endsWith('/installation/repositories')?{total_count:1,repositories:[target]}:url.endsWith('/owner/repo')?target:{status:'ahead'};
    return {status:200,headers:{get:()=>state.link?'next':null},text:async()=>JSON.stringify(value)};};
  return {state,compare:createV3RegistryCompareTransport({role:'private',repository,repositoryId,appToken:'synthetic-token',request})};}
test('compares only pinned SHAs within one independently verified App repository',async()=>{
  const f=fixture();assert.equal((await f.compare({genesisOid,headOid})).status,'ahead');assert.equal(f.state.calls.length,5);
  assert.ok(f.state.calls.every(({options})=>options.method==='GET'&&options.redirect==='error'));
  assert.equal(f.state.calls[2].url,`https://api.github.com/repos/${repository}/compare/${genesisOid}...${headOid}`);
});
test('registry protection uses its own trusted genesis, never the enrolled project genesis',async()=>{
  const registryGenesisOid=genesisOid,projectGenesisOid='c'.repeat(40),urls=[];
  const request=async url=>{urls.push(url);const target={node_id:repositoryId,full_name:repository,private:true,fork:false};
    const value=url.endsWith('/installation/repositories')?{total_count:1,repositories:[target]}:url.endsWith('/owner/repo')?target:
      {status:'ahead',ahead_by:1,behind_by:0,base_commit:{sha:registryGenesisOid},merge_base_commit:{sha:registryGenesisOid},commits:[{sha:headOid}]};
    return {status:200,headers:{get:()=>null},text:async()=>JSON.stringify(value)};};
  const role='private',readBranch=async()=>({kind:'v3-registry-branch-observed',role,repositoryId,head:headOid});
  const compare=createV3RegistryCompareTransport({role,repository,repositoryId,appToken:'synthetic-token',request});
  const verifyLineage=createV3RegistryLineageGuard({role,repositoryId,registryGenesisOid,readBranch,compare});
  const readProtection=async()=>({kind:'v3-registry-protection-audit-observed',role,ref:V3_REGISTRY_REF,repositoryId,appId:12,updateRulesetId:1,historyRulesetId:2});
  const guard=createV3RegistryWriteGuard({role,repositoryId,appId:12,registryGenesisOid,updateRulesetId:1,historyRulesetId:2,readBranch,readProtection,verifyLineage});
  assert.equal((await guard({role,repositoryId,ref:V3_REGISTRY_REF,appId:12,expectedHeadOid:headOid})).kind,'v3-registry-protection-observed');
  assert.ok(urls.some(url=>url.includes(`/compare/${registryGenesisOid}...${headOid}`)));
  assert.ok(urls.every(url=>!url.includes(projectGenesisOid)));
});
test('rejects scope, pagination and invalid SHA without further requests',async()=>{
  let f=fixture();f.state.wrong=true;await assert.rejects(f.compare({genesisOid,headOid}));assert.equal(f.state.calls.length,1);
  f=fixture();f.state.link=true;await assert.rejects(f.compare({genesisOid,headOid}));
  f=fixture();await assert.rejects(f.compare({genesisOid:'invalid',headOid}));assert.equal(f.state.calls.length,0);
});
