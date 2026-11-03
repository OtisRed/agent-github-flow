import { isDeepStrictEqual } from 'node:util';
import { V3_REGISTRY_REF,V3_REGISTRY_ANCHOR_REF } from './flow-v3-registry-git-plan.mjs';

const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)&&value!=='0'.repeat(40);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const blocked=reason=>({kind:'blocked',reason});

// The independently authenticated callbacks must be scoped to the exact
// protected repository/App and report complete ruleset and branch reads.
// This snapshot is not an atomic lock or permission to bypass the rules.
export function createV3RegistryWriteGuard({role,repositoryId,appId,updateRulesetId,historyRulesetId,readBranch,readProtection}={}){
  if(!['private','anchor'].includes(role)||typeof repositoryId!=='string'||!repositoryId||repositoryId.length>256
      ||repositoryId.trim()!==repositoryId||![appId,updateRulesetId,historyRulesetId].every(positive)||updateRulesetId===historyRulesetId
      ||typeof readBranch!=='function'||typeof readProtection!=='function')throw Error('invalid-v3-registry-guard');
  const ref=role==='private'?V3_REGISTRY_REF:V3_REGISTRY_ANCHOR_REF;
  return async candidate=>{
    try{
      candidate=structuredClone(candidate);
      if(!candidate||candidate.role!==role||candidate.repositoryId!==repositoryId||candidate.ref!==ref||candidate.appId!==appId
          ||!oid(candidate.expectedHeadOid))return blocked('registry-guard-subject-mismatch');
      const first=structuredClone(await readBranch()),audit=structuredClone(await readProtection()),second=structuredClone(await readBranch());
      if(first?.kind!=='v3-registry-branch-observed'||first.role!==role||first.repositoryId!==repositoryId
          ||first.head!==candidate.expectedHeadOid||!isDeepStrictEqual(first,second)
          ||audit?.kind!=='v3-registry-protection-audit-observed'||audit.role!==role||audit.ref!==ref||audit.repositoryId!==repositoryId
          ||audit.appId!==appId||audit.updateRulesetId!==updateRulesetId||audit.historyRulesetId!==historyRulesetId)
        return blocked('registry-guard-unverified');
      return {kind:'v3-registry-protection-observed',role,repositoryId,ref,appId,expectedHeadOid:candidate.expectedHeadOid};
    }catch{return blocked('registry-guard-unavailable');}
  };
}
