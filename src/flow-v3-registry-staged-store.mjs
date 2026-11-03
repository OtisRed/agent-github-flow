import { isDeepStrictEqual } from 'node:util';
import { verifyV3Registry, sealV3RegistryTransition } from './flow-v3-registry-anchor.mjs';

const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)&&value!=='0'.repeat(40);
const blocked=reason=>({kind:'blocked',reason});
const uncertain=()=>({kind:'v3-registry-write-uncertain',retryAllowed:false});
const same=(a,b)=>isDeepStrictEqual(a,b);
const validHeads=value=>value&&oid(value.privateHead)&&oid(value.anchorHead);
const version=value=>`${value.privateHead}:${value.anchorHead}`;

// Logical staged transaction over two independently protected CAS branches.
// read/write callbacks must authenticate exact repositories, App identity,
// ancestry and rules; ALL writers must be serialized externally. GitHub has
// no cross-repository transaction: during a partial update load fails closed.
// This is an adapter contract, not an implemented GitHub backend. Never log
// its private content, protected anchor, keyring or callback results.
export function createV3RegistryStagedStore({keyring,read,writePrivate,writeAnchor}={}){
  if(!keyring||typeof keyring.current!=='function'||typeof keyring.forId!=='function'
      ||![read,writePrivate,writeAnchor].every(fn=>typeof fn==='function'))throw Error('invalid-v3-registry-store');
  let started=false;
  const stable=async()=>{
    const state=structuredClone(await read());
    if(!validHeads(state)||!same(state.stagedAnchor,state.anchor)
        ||verifyV3Registry(state.content,state.anchor,keyring).kind!=='v3-registry-verified')throw Error('registry-unavailable');
    return state;
  };
  const load=async()=>{const state=await stable();return {content:state.content,anchor:state.anchor,version:version(state)};};
  const commit=async({expectedVersion,content,anchor}={})=>{
    if(started)return blocked('registry-store-already-used');started=true;
    let before,planned;
    try{
      anchor=structuredClone(anchor);before=await stable();
      if(version(before)!==expectedVersion)return blocked('registry-version-changed');
      planned=sealV3RegistryTransition({content:before.content,anchor:before.anchor,afterContent:content,keyring});
      if(planned.kind!=='v3-registry-update-planned'||!same(planned.anchor,anchor))return blocked('registry-plan-mismatch');
    }catch{return blocked('registry-preflight-unavailable');}
    let first;
    try{first=await writePrivate({expectedHead:before.privateHead,content,stagedAnchor:structuredClone(anchor)});}catch{return uncertain();}
    if(first?.kind!=='registry-private-advanced'||!oid(first.head)||first.head===before.privateHead)return uncertain();
    try{
      const middle=structuredClone(await read());
      if(!validHeads(middle)||middle.privateHead!==first.head||middle.anchorHead!==before.anchorHead||middle.content!==content
          ||!same(middle.stagedAnchor,anchor)||!same(middle.anchor,before.anchor))return uncertain();
    }catch{return uncertain();}
    let second;
    try{second=await writeAnchor({expectedHead:before.anchorHead,anchor:structuredClone(anchor)});}catch{return uncertain();}
    if(second?.kind!=='registry-anchor-advanced'||!oid(second.head)||second.head===before.anchorHead)return uncertain();
    try{
      const after=await stable();
      if(after.privateHead!==first.head||after.anchorHead!==second.head||after.content!==content||!same(after.anchor,anchor))return uncertain();
    }catch{return uncertain();}
    return {kind:'registry-update-acknowledged'};
  };
  return Object.freeze({load,commit});
}

// Read-only diagnosis of a partially advanced private branch. The caller must
// supply authenticated predecessor history and exact current heads. This does
// not publish the anchor, authorize retry, or establish writer quiescence.
export function inspectV3RegistryStaging({before,current,keyring}={}){
  try{
    before=structuredClone(before);current=structuredClone(current);
    if(!validHeads(before)||!validHeads(current)||before.privateHead===current.privateHead||before.anchorHead!==current.anchorHead
        ||!same(before.stagedAnchor,before.anchor)||!same(current.anchor,before.anchor)
        ||current.privateParent!==before.privateHead||verifyV3Registry(before.content,before.anchor,keyring).kind!=='v3-registry-verified')
      return blocked('staging-unverified');
    const planned=sealV3RegistryTransition({content:before.content,anchor:before.anchor,afterContent:current.content,keyring});
    if(planned.kind!=='v3-registry-update-planned'||!same(planned.anchor,current.stagedAnchor))return blocked('staging-unverified');
    return {kind:'v3-registry-staging-observed',revision:planned.anchor.revision,retryAllowed:false};
  }catch{return blocked('staging-unverified');}
}
