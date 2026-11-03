import { isDeepStrictEqual } from 'node:util';
import { verifyV3Registry,sealV3RegistryTransition } from './flow-v3-registry-anchor.mjs';
import { reserveV3Project,activateV3Project } from './flow-v3-registry.mjs';
import { verifyV3BootstrapEnrollment } from './flow-v3-bootstrap-enrollment.mjs';

const blocked=reason=>({kind:'blocked',reason});
const uncertain=()=>({kind:'v3-registry-lifecycle-uncertain',retryAllowed:false});
const version=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x20\x7f]/.test(value);

// One-shot reserve/activate operation over an authenticated staged store.
// Authorization, App identity, protection, enrollment provenance, genesis
// verification and global serialization are independently trusted callbacks.
// Never log private policy, registration, registry, anchors or credentials.
export function createV3RegistryLifecycleStep({keyring,load,commit,verifyAuthorization,verifyGenesis}={}){
  if(!keyring||typeof keyring.forId!=='function'||typeof keyring.current!=='function'
      ||![load,commit,verifyAuthorization,verifyGenesis].every(fn=>typeof fn==='function'))throw Error('invalid-v3-lifecycle-step');
  let started=false;
  return async({operation,policy,registration}={})=>{
    if(started)return blocked('lifecycle-step-already-used');started=true;
    if(!['reserve','activate'].includes(operation))return blocked('invalid-operation');
    let before,update,verify,verifyPinnedGenesis;
    try{
      policy=structuredClone(policy);registration=structuredClone(registration);before=structuredClone(await load());
      if(!before||!version(before.version))return blocked('registry-unavailable');
      verify=async()=>{const proof=await verifyAuthorization({operation,policy:structuredClone(policy),registration:structuredClone(registration)});
        return proof?.kind==='registry-lifecycle-authorized'&&proof.operation===operation&&isDeepStrictEqual(proof.policy,policy)
          &&isDeepStrictEqual(proof.registration,registration);};
      if(!await verify())return blocked('lifecycle-unauthorized');
      const current=verifyV3Registry(before.content,before.anchor,keyring);if(current.kind!=='v3-registry-verified')return blocked('registry-unverified');
      let plan;
      if(operation==='reserve')plan=reserveV3Project(current.registry,policy);
      else{
        const enrollment=verifyV3BootstrapEnrollment({content:before.content,anchor:before.anchor,keyring,policy});
        if(enrollment.kind!=='bootstrap-permitted'||enrollment.phase!=='initializing'
            ||registration?.checkpoint?.genesisOid!==enrollment.bootstrap.genesisOid)return blocked('enrollment-unavailable');
        verifyPinnedGenesis=async()=>{const proof=await verifyGenesis({registration:structuredClone(registration.checkpoint),
          expectedTreeOid:enrollment.bootstrap.treeOid});
          return proof?.kind==='v3-bootstrap-verified'&&proof.treeOid===enrollment.bootstrap.treeOid
            &&isDeepStrictEqual(proof.registration,registration.checkpoint);};
        if(!await verifyPinnedGenesis())return blocked('genesis-unverified');
        plan=activateV3Project(current.registry,policy.source,registration);
      }
      if(plan.kind!=='v3-registry-transition-planned')return blocked('lifecycle-plan-invalid');
      update=sealV3RegistryTransition({content:before.content,anchor:before.anchor,afterContent:plan.content,keyring});
      if(update.kind!=='v3-registry-update-planned'||!await verify()||(verifyPinnedGenesis&&!await verifyPinnedGenesis()))
        return blocked('lifecycle-preflight-changed');
    }catch{return blocked('lifecycle-preflight-unavailable');}
    let written;try{written=await commit({expectedVersion:before.version,content:update.content,anchor:structuredClone(update.anchor)});}
    catch{return uncertain();}
    if(written?.kind!=='registry-update-acknowledged')return uncertain();
    try{
      const after=structuredClone(await load());
      if(!after||!version(after.version)||after.version===before.version||after.content!==update.content||!isDeepStrictEqual(after.anchor,update.anchor)
          ||verifyV3Registry(after.content,after.anchor,keyring).kind!=='v3-registry-verified'||!await verify()
          ||(verifyPinnedGenesis&&!await verifyPinnedGenesis()))return uncertain();
      return {kind:'v3-registry-lifecycle-observed',operation,revision:update.anchor.revision,retryAllowed:false};
    }catch{return uncertain();}
  };
}
