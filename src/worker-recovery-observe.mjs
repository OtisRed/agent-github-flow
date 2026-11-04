// Read-only composition with the real v3 cycle. This is not a worker and does
// not authorize writes: publication/status steps are deliberately blocked.
import {isDeepStrictEqual} from 'node:util';
import {observeIngressDelivery} from './ingress-observation.mjs';

export async function observeStatusRecovery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {kind:'blocked'};
  try {
    const {routes, graphql, keyring, resolvePolicy, runCycle, cycleInput}=input;
    const state=structuredClone(input.state), delivery=structuredClone(input.delivery);
    if (!state || state.kind !== 'recovering' || state.refIntent !== 0 || state.statusIntent !== 1
        || !delivery || state.deliveryId !== delivery.deliveryId || typeof resolvePolicy !== 'function'
        || typeof graphql !== 'function' || typeof runCycle !== 'function' || !cycleInput
        || keyring !== cycleInput.keyring || typeof cycleInput.wait !== 'function')
      return {kind:'blocked'};
    const publications=[], waits=[]; let statusCalls=0;
    let resolved=null, usedRegistration=null, usedCommitment=null;
    const route=await observeIngressDelivery({delivery,routes,graphql,keyring,resolvePolicy:async args=>{
      usedRegistration=args.registration;usedCommitment=args.registrationCommitment;
      resolved=await resolvePolicy(args);return resolved;
    }});
    if (route.kind!=='observed' || !isDeepStrictEqual(resolved?.policy,cycleInput.policy)
        || !isDeepStrictEqual(usedRegistration,cycleInput.projectRegistration)
        || !isDeepStrictEqual(usedCommitment,cycleInput.registrationCommitment)) return {kind:'blocked'};
    const result=await runCycle({...cycleInput,
      wait:async ms=>{waits.push(ms); await cycleInput.wait(ms);},
      makePublicationStep:()=>async args=>{publications.push(args?.operation); return {kind:'blocked'};},
      makeStatusStep:()=>async()=>{statusCalls++; return {kind:'blocked'};}});
    if (statusCalls!==0 || result?.kind!=='v3-cycle-stopped') return {kind:'blocked'};
    if (result.phase==='reservation' && publications.length===1 && publications[0]==='reservation'
        && waits.length===1 && waits[0]===120000) return {kind:'retry-path-observation'};
    if (result.phase==='commit' && publications.length===1 && publications[0]==='commit' && waits.length===0)
      return {kind:'target-path-observation'};
    return {kind:'blocked'};
  } catch { return {kind:'blocked'}; }
}
