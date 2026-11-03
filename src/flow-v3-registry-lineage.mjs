import { isDeepStrictEqual } from 'node:util';
import { V3_REGISTRY_REF,V3_REGISTRY_ANCHOR_REF } from './flow-v3-registry-git-plan.mjs';

const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)&&value!=='0'.repeat(40);
const blocked=reason=>({kind:'blocked',reason});

// Requires an independently authenticated repository-scoped comparison and
// a trusted pinned genesis. Ancestry alone cannot detect rollback to an older
// descendant; protected rules and exclusive writers remain separate duties.
export function observeV3RegistryLineage({role,repositoryId,genesisOid,headOid,comparison}={}){
  const ref=role==='private'?V3_REGISTRY_REF:role==='anchor'?V3_REGISTRY_ANCHOR_REF:null;
  if(!ref||typeof repositoryId!=='string'||!repositoryId||repositoryId.length>256||!oid(genesisOid)||!oid(headOid))return blocked('lineage-input-invalid');
  if(!comparison||comparison.base_commit?.sha!==genesisOid||comparison.merge_base_commit?.sha!==genesisOid
      ||!Number.isSafeInteger(comparison.ahead_by)||comparison.ahead_by<0||comparison.behind_by!==0
      ||!Array.isArray(comparison.commits)||comparison.commits.length!==comparison.ahead_by)return blocked('lineage-unverified');
  if(headOid===genesisOid){if(comparison.status!=='identical'||comparison.ahead_by!==0)return blocked('lineage-unverified');}
  else if(comparison.status!=='ahead'||comparison.ahead_by<1||comparison.commits.at(-1)?.sha!==headOid)return blocked('lineage-unverified');
  return {kind:'v3-registry-lineage-observed',role,repositoryId,ref,genesisOid,headOid,rollbackProtected:false};
}

// All inputs and callbacks must be bound to independently trusted App scope,
// repository and registration. A fixed SHA compare is read between two exact
// branch reads; this does not authorize mutation or prove absence of rollback.
// registryGenesisOid is the root of this registry branch, independently
// pinned for its own repo; never use a project's checkpoint genesis here.
export function createV3RegistryLineageGuard({role,repositoryId,registryGenesisOid,readBranch,compare}={}){
  if(!['private','anchor'].includes(role)||typeof repositoryId!=='string'||!repositoryId||!oid(registryGenesisOid)
      ||typeof readBranch!=='function'||typeof compare!=='function')throw Error('invalid-lineage-guard');
  return async({expectedHeadOid}={})=>{
    try{
      if(!oid(expectedHeadOid))return blocked('lineage-head-invalid');
      const first=structuredClone(await readBranch());
      if(first?.kind!=='v3-registry-branch-observed'||first.role!==role||first.repositoryId!==repositoryId||first.head!==expectedHeadOid)
        return blocked('lineage-branch-mismatch');
      const comparison=structuredClone(await compare({genesisOid:registryGenesisOid,headOid:expectedHeadOid}));
      const proof=observeV3RegistryLineage({role,repositoryId,genesisOid:registryGenesisOid,headOid:expectedHeadOid,comparison});
      const second=structuredClone(await readBranch());
      if(proof.kind!=='v3-registry-lineage-observed'||!isDeepStrictEqual(first,second))return blocked('lineage-unverified');
      return proof;
    }catch{return blocked('lineage-unavailable');}
  };
}
