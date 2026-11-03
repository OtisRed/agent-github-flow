import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { planV3RegistryGitUpdate } from './flow-v3-registry-git-plan.mjs';

const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)&&value!=='0'.repeat(40);
const blocked=reason=>({kind:'blocked',reason});

// Structural exact-tree verification only. Callers must authenticate the plan,
// tree response, repository, root lineage and protection independently.
export function verifyV3RegistryPreparedTree({plan,treeOid,tree,content,anchor,keyring}={}){
  try{
    plan=structuredClone(plan);tree=structuredClone(tree);
    const authenticated=planV3RegistryGitUpdate({role:plan?.role,repository:plan?.repository,repositoryId:plan?.repositoryId,
      expectedPrivate:plan?.expectedPrivate,expectedHeadOid:plan?.expectedHeadOid,baseTreeOid:plan?.baseTreeOid,content,anchor,keyring});
    if(authenticated.kind!=='v3-registry-git-plan'||!isDeepStrictEqual(plan,authenticated))return blocked('registry-plan-unverified');
    const paths=plan?.role==='private'?['registry.json','anchor.json']:plan?.role==='anchor'?['anchor.json']:null;
    if(plan?.kind!=='v3-registry-git-plan'||!paths||!oid(treeOid)||tree?.sha!==treeOid||tree.truncated!==false
        ||!Array.isArray(tree.tree)||tree.tree.length!==paths.length||!Array.isArray(plan.additions)||plan.additions.length!==paths.length)
      return blocked('invalid-registry-tree');
    for(let index=0;index<paths.length;index++){
      const addition=plan.additions[index];if(addition?.path!==paths[index]||typeof addition.contents!=='string')return blocked('invalid-registry-tree');
      const bytes=Buffer.from(addition.contents,'base64');if(bytes.toString('base64')!==addition.contents)return blocked('invalid-registry-tree');
      const sha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      const entries=tree.tree.filter(entry=>entry?.path===paths[index]);
      if(entries.length!==1||entries[0].mode!=='100644'||entries[0].type!=='blob'||entries[0].sha!==sha)return blocked('registry-tree-mismatch');
    }
    return {kind:'v3-registry-tree-verified'};
  }catch{return blocked('invalid-registry-tree');}
}
