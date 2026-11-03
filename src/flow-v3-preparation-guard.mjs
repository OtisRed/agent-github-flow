import { isDeepStrictEqual } from 'node:util';
import { planInitialV3Handoff } from './flow-v3-initial-handoff.mjs';
import { planV3StatusReservation, planV3HandoffCommit } from './flow-v3-reservation-plan.mjs';

const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

// Pure consistency check, not authorization. Caller must supply authenticated
// fresh issue/Project/repository reads, protected registration/keyring and
// independently verified bootstrap, branch protection and exclusive writer.
// Only the narrow first-handoff v3 transitions are accepted. A preparer must
// consume the returned plan, not a cached one. Do not log its private context.
export function verifyV3Preparation(input={}){
  try{
    const after=structuredClone(input.after),before=input.checkpoint?.selectedRecord;
    let plan;
    if(before===null)plan=planInitialV3Handoff(input);
    else if(after?.current?.phase==='pending'&&after.reservation!==null)
      plan=planV3StatusReservation({...input,reservedAt:after.reservation.reservedAt});
    else if(after?.current?.phase==='committed')plan=planV3HandoffCommit(input);
    else return {kind:'blocked',reason:'unsupported-transition'};
    if(!['initial-handoff-v3-planned','v3-status-reservation-planned','v3-commit-handoff-planned'].includes(plan.kind)
        ||!isDeepStrictEqual(plan.record,after))return {kind:'blocked',reason:'v3-plan-mismatch'};
    return {kind:'v3-preparation-consistent',commit:freeze(structuredClone(plan.commit))};
  }catch{return {kind:'blocked',reason:'v3-guard-unavailable'};}
}
