import { isDeepStrictEqual } from 'node:util';
import { encodeV3Registry, decodeV3Registry, reserveV3Project, pinV3ProjectGenesis, activateV3Project, retireV3Project } from './flow-v3-registry.mjs';

const blocked=reason=>({kind:'blocked',reason});
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));

// This anchor must be stored independently of the registry under protected
// administration. Verifying an old registry plus its old anchor cannot itself
// detect coordinated rollback. Key creation, storage and recovery are external.
export function createV3RegistryAnchor(registry,keyring){
  try{
    const encoded=encodeV3Registry(registry);if(encoded.kind!=='encoded-v3-registry'||typeof keyring?.current!=='function')return blocked('invalid-registry');
    const canonical=JSON.parse(encoded.content),key=keyring.current();
    if(!key||!Number.isSafeInteger(key.keyId)||key.keyId<1||typeof key.registry!=='function')return blocked('key-unavailable');
    return {kind:'v3-registry-anchor-planned',anchor:{version:1,revision:canonical.revision,keyId:key.keyId,mac:key.registry(canonical)}};
  }catch{return blocked('anchor-unavailable');}
}

export function verifyV3Registry(content,anchor,keyring){
  try{
    anchor=structuredClone(anchor);const decoded=decodeV3Registry(content);
    if(decoded.kind!=='decoded-v3-registry'||!exact(anchor,['version','revision','keyId','mac'])||anchor.version!==1
        ||!Number.isSafeInteger(anchor.revision)||anchor.revision!==decoded.registry.revision
        ||!Number.isSafeInteger(anchor.keyId)||anchor.keyId<1||typeof anchor.mac!=='string'||typeof keyring?.forId!=='function'
        ||keyring.forId(anchor.keyId).verifyRegistry(decoded.registry,anchor.mac)!==true)return blocked('registry-unverified');
    return {kind:'v3-registry-verified',registry:decoded.registry};
  }catch{return blocked('registry-unverified');}
}

// Recomputes one allowed lifecycle transition from the verified predecessor.
// It does not prove enrollment or genesis; trusted callers must do so before
// activation. It plans writes but never persists or activates a project.
export function sealV3RegistryTransition({content,anchor,afterContent,keyring}={}){
  try{
    const before=verifyV3Registry(content,anchor,keyring),after=decodeV3Registry(afterContent);
    if(before.kind!=='v3-registry-verified'||after.kind!=='decoded-v3-registry'||after.registry.revision!==before.registry.revision+1)
      return blocked('invalid-registry-transition');
    const old=before.registry.entries,next=after.registry.entries,oldBySource=new Map(old.map(entry=>[entry.source,entry]));
    const changed=next.filter(entry=>!oldBySource.has(entry.source)||!isDeepStrictEqual(oldBySource.get(entry.source),entry));
    if(changed.length!==1||next.length<old.length||next.length>old.length+1)return blocked('invalid-registry-transition');
    const entry=changed[0],prior=oldBySource.get(entry.source);let plan;
    if(!prior&&entry.state==='reserved')plan=reserveV3Project(before.registry,{source:entry.source,repository:entry.repository,repositoryId:entry.repositoryId,
      expectedPrivate:entry.expectedPrivate,cutoverAt:entry.cutoverAt,appId:entry.appId,updateRulesetId:entry.updateRulesetId,
      historyRulesetId:entry.historyRulesetId});
    else if(prior?.state==='reserved'&&entry.state==='initializing')plan=pinV3ProjectGenesis(before.registry,entry.source,entry.bootstrap);
    else if(prior?.state==='initializing'&&entry.state==='active')plan=activateV3Project(before.registry,entry.source,entry.registration);
    else if(prior?.state==='active'&&entry.state==='retired')plan=retireV3Project(before.registry,entry.source);
    if(plan?.kind!=='v3-registry-transition-planned'||plan.content!==afterContent)return blocked('invalid-registry-transition');
    const sealed=createV3RegistryAnchor(after.registry,keyring);
    return sealed.kind==='v3-registry-anchor-planned'?{kind:'v3-registry-update-planned',content:afterContent,anchor:sealed.anchor}:blocked('anchor-unavailable');
  }catch{return blocked('invalid-registry-transition');}
}
