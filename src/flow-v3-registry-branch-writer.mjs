import { isDeepStrictEqual } from 'node:util';
import { createV3RegistryGitReader } from './flow-v3-registry-git-reader.mjs';
import { planV3RegistryGitUpdate,V3_REGISTRY_REF,V3_REGISTRY_ANCHOR_REF } from './flow-v3-registry-git-plan.mjs';
import { verifyV3RegistryPreparedTree } from './flow-v3-registry-tree-verifier.mjs';
import { sealV3RegistryTransition } from './flow-v3-registry-anchor.mjs';
import { CHECKPOINT_UPDATE_REFS } from './flow-checkpoint-ref-transport.mjs';

const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)&&value!=='0'.repeat(40);
const blocked=reason=>({kind:'blocked',reason});
const uncertain=()=>({kind:'v3-registry-branch-write-uncertain',retryAllowed:false});

// Scoped one-shot branch writer; runtime MUST authenticate the configured
// repository/App, branch lineage, protection callback and global writer lock.
// No tokens, private registry, API responses or plans may be logged.
export function createV3RegistryBranchWriter({role,repository,repositoryId,appId,appToken,keyring,verifyProtection,request=fetch}={}){
  if(!Number.isSafeInteger(appId)||appId<1||typeof verifyProtection!=='function')throw Error('invalid-v3-registry-writer');
  const reader=createV3RegistryGitReader({role,repository,repositoryId,appToken,keyring,request});
  const expectedPrivate=role==='private',ref=expectedPrivate?V3_REGISTRY_REF:V3_REGISTRY_ANCHOR_REF;
  const api=`https://api.github.com/repos/${repository}`;let started=false;
  const call=async(url,method='GET',body)=>{
    const response=await request(url,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{
      Accept:'application/vnd.github+json',Authorization:`Bearer ${appToken}`,'Content-Type':'application/json','X-GitHub-Api-Version':'2026-03-10'},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!response||response.status!==(method==='POST'&&url!== 'https://api.github.com/graphql'?201:200)
        ||typeof response.text!=='function'||typeof response.headers?.get!=='function')throw Error('request-failed');
    const raw=await response.text();if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>2_000_000)throw Error('request-failed');
    return {data:JSON.parse(raw),link:response.headers.get('link')};
  };
  const scope=async()=>{const result=await call('https://api.github.com/installation/repositories'),items=result.data?.repositories,item=items?.[0];
    if(result.link||result.data?.total_count!==1||!Array.isArray(items)||items.length!==1||item?.node_id!==repositoryId
        ||item.full_name!==repository||item.private!==expectedPrivate||item.fork!==false)return false;
    const repo=(await call(api)).data;
    return repo?.node_id===repositoryId&&repo.full_name===repository&&repo.private===expectedPrivate&&repo.fork===false
      &&typeof repo.default_branch==='string'&&!!repo.default_branch&&`refs/heads/${repo.default_branch}`!==ref;};
  const guarded=async head=>{const proof=await verifyProtection({role,repositoryId,ref,appId,expectedHeadOid:head});
    return proof?.kind==='v3-registry-protection-observed'&&proof.role===role&&proof.repositoryId===repositoryId
      &&proof.ref===ref&&proof.appId===appId&&proof.expectedHeadOid===head;};
  const write=async({expectedHead,content,anchor}={})=>{
    if(started)return blocked('registry-writer-already-used');started=true;
    let before,plan,treeOid,commitOid,objectWriteStarted=false;
    try{
      anchor=structuredClone(anchor);before=await reader();
      if(before.kind!=='v3-registry-branch-observed'||before.head!==expectedHead)return blocked('registry-head-mismatch');
      plan=planV3RegistryGitUpdate({role,repository,repositoryId,expectedPrivate,expectedHeadOid:before.head,baseTreeOid:before.treeOid,content,anchor,keyring});
      if(plan.kind!=='v3-registry-git-plan')return blocked('registry-plan-invalid');
      if(expectedPrivate){const transition=sealV3RegistryTransition({content:before.content,anchor:before.anchor,afterContent:content,keyring});
        if(transition.kind!=='v3-registry-update-planned'||!isDeepStrictEqual(transition.anchor,anchor))return blocked('registry-transition-invalid');}
      else if(anchor.revision!==before.anchor.revision+1)return blocked('anchor-revision-invalid');
      if(!await guarded(before.head)||!await scope())return blocked('registry-protection-unverified');
      objectWriteStarted=true;
      const tree=(await call(`${api}/git/trees`,'POST',{tree:plan.additions.map(entry=>({path:entry.path,mode:'100644',type:'blob',
        content:Buffer.from(entry.contents,'base64').toString('utf8')}))})).data;
      treeOid=tree?.sha;if(!oid(treeOid))return uncertain();
      const observedTree=(await call(`${api}/git/trees/${treeOid}?recursive=1`)).data;
      if(verifyV3RegistryPreparedTree({plan,treeOid,tree:observedTree,content,anchor,keyring}).kind!=='v3-registry-tree-verified'||!await scope())return uncertain();
      const commit=(await call(`${api}/git/commits`,'POST',{message:'Update FLOW registry state',tree:treeOid,parents:[before.head]})).data;
      commitOid=commit?.sha;if(!oid(commitOid)||commitOid===before.head)return uncertain();
      const actual=(await call(`${api}/git/commits/${commitOid}`)).data;
      if(actual?.sha!==commitOid||actual.tree?.sha!==treeOid||!Array.isArray(actual.parents)||actual.parents.length!==1
          ||actual.parents[0]?.sha!==before.head)return uncertain();
      const fresh=await reader();
      if(!isDeepStrictEqual(fresh,before)||!await guarded(before.head)||!await scope())return uncertain();
    }catch{return objectWriteStarted?uncertain():blocked('registry-preflight-unavailable');}
    let response;
    try{response=(await call('https://api.github.com/graphql','POST',{query:CHECKPOINT_UPDATE_REFS,variables:{input:{repositoryId,
      refUpdates:[{name:ref,beforeOid:before.head,afterOid:commitOid,force:false}]}}})).data;}catch{return uncertain();}
    if(!response||(Object.hasOwn(response,'errors')&&(!Array.isArray(response.errors)||response.errors.length!==0))
        ||response.data?.updateRefs?.__typename!=='UpdateRefsPayload')return uncertain();
    try{
      const after=await reader();
      if(after.kind!=='v3-registry-branch-observed'||after.head!==commitOid||after.treeOid!==treeOid
          ||!isDeepStrictEqual(after.anchor,anchor)||(expectedPrivate&&after.content!==content)||!await guarded(commitOid))return uncertain();
    }catch{return uncertain();}
    return {kind:expectedPrivate?'registry-private-advanced':'registry-anchor-advanced',head:commitOid};
  };
  return Object.freeze({read:reader,write});
}
