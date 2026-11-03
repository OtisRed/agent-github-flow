import { verifyV3Registry } from './flow-v3-registry-anchor.mjs';

const fields=['source','repository','repositoryId','expectedPrivate','cutoverAt','appId','updateRulesetId','historyRulesetId'];

// Read-only enrollment proof from a complete HMAC-verified registry and its
// independently protected anchor. Coordinated rollback, storage durability,
// App identity and bootstrap serialization remain external obligations.
export function verifyV3BootstrapEnrollment({content,anchor,keyring,policy}={}){
  try{
    policy=structuredClone(policy);
    if(!policy||typeof policy!=='object'||Array.isArray(policy)||Object.keys(policy).length!==fields.length
        ||!fields.every(field=>Object.hasOwn(policy,field)))return {kind:'blocked',reason:'invalid-policy'};
    const verified=verifyV3Registry(content,anchor,keyring);
    if(verified.kind!=='v3-registry-verified')return {kind:'blocked',reason:'registry-unverified'};
    const entry=verified.registry.entries.find(item=>item.source===policy.source);
    if(!entry||!['reserved','initializing'].includes(entry.state)||!fields.every(field=>entry[field]===policy[field]))
      return {kind:'blocked',reason:'enrollment-unavailable'};
    return {kind:'bootstrap-permitted',policy,phase:entry.state,bootstrap:entry.bootstrap===null?null:structuredClone(entry.bootstrap)};
  }catch{return {kind:'blocked',reason:'enrollment-unavailable'};}
}
