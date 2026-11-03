import { isDeepStrictEqual } from 'node:util';
import { verifyV3BootstrapEnrollment } from './flow-v3-bootstrap-enrollment.mjs';
import { verifyV3Registry, sealV3RegistryTransition } from './flow-v3-registry-anchor.mjs';
import { pinV3ProjectGenesis } from './flow-v3-registry.mjs';

const blocked=reason=>({kind:'blocked',reason});
const uncertain=()=>({kind:'v3-genesis-pin-uncertain',retryAllowed:false});
const version=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x20\x7f]/.test(value);

// One attempt against an authenticated durable store that MUST atomically CAS
// both registry and its independently protected anchor. No current GitHub
// secret backend implements that contract here. Unknown writes never retry.
// The caller must serialize onboarding and keep keys/config out of logs.
export function createV3GenesisPinStep({keyring,load,commit}={}){
  if(!keyring||typeof keyring.current!=='function'||typeof keyring.forId!=='function'||typeof load!=='function'||typeof commit!=='function')
    throw Error('invalid-v3-pin-step');
  let started=false;
  return async(policy,bootstrap)=>{
    if(started)return blocked('pin-step-already-used');started=true;
    let before,update;
    try{
      policy=structuredClone(policy);bootstrap=structuredClone(bootstrap);before=structuredClone(await load());
      if(!before||!version(before.version))return blocked('registry-unavailable');
      const proof=verifyV3BootstrapEnrollment({content:before.content,anchor:before.anchor,keyring,policy});
      if(proof.kind!=='bootstrap-permitted'||proof.phase!=='reserved')return blocked('enrollment-unavailable');
      const verified=verifyV3Registry(before.content,before.anchor,keyring);
      const next=pinV3ProjectGenesis(verified.registry,policy.source,bootstrap);
      if(next.kind!=='v3-registry-transition-planned')return blocked('invalid-bootstrap');
      update=sealV3RegistryTransition({content:before.content,anchor:before.anchor,afterContent:next.content,keyring});
      if(update.kind!=='v3-registry-update-planned')return blocked('registry-plan-unavailable');
    }catch{return blocked('registry-preflight-unavailable');}
    let written;try{written=await commit({expectedVersion:before.version,content:update.content,anchor:structuredClone(update.anchor)});}
    catch{return uncertain();}
    if(written?.kind!=='registry-update-acknowledged')return uncertain();
    try{
      const after=structuredClone(await load());
      if(!after||!version(after.version)||after.version===before.version||after.content!==update.content
          ||!isDeepStrictEqual(after.anchor,update.anchor))return uncertain();
      const proof=verifyV3BootstrapEnrollment({content:after.content,anchor:after.anchor,keyring,policy});
      if(proof.kind!=='bootstrap-permitted'||proof.phase!=='initializing'||!isDeepStrictEqual(proof.bootstrap,bootstrap))return uncertain();
      return {kind:'v3-genesis-pinned',policy,bootstrap};
    }catch{return uncertain();}
  };
}
