import { isDeepStrictEqual } from 'node:util';
import { matchesHandoffSubject } from './flow-handoff-binding.mjs';
import { v3HandoffBinding } from './flow-v3-handoff-binding.mjs';
import { matchesV3ProtectedContext } from './flow-v3-protected-context.mjs';
import { inspectV3ReservedHandoff } from './flow-v3-reservation-plan.mjs';

const blocked=reason=>({kind:'blocked',reason});
const uncertain=()=>({kind:'status-write-uncertain',retryAllowed:false});
const protectedBy=(value,p)=>value?.kind==='checkpoint-protection-observed'&&value.repositoryId===p.repositoryId
  &&value.appId===p.appId&&value.updateRulesetId===p.updateRulesetId&&value.historyRulesetId===p.historyRulesetId;

// Disconnected one-shot step. Trusted collector, protected config/commitment,
// bootstrap, single writer and reservation/retry wait are caller obligations.
// GitHub Project status mutation is not conditional; a late old request can
// still overwrite a later status. Never log inputs, plans or credentials.
export function createV3ProjectStatusStep({policy,projectRegistration,registrationCommitment,keyring,collectContext,verifyProtection,transport}={}){
  try{policy=structuredClone(policy);projectRegistration=structuredClone(projectRegistration);registrationCommitment=structuredClone(registrationCommitment);}
  catch{throw Error('invalid-v3-status-step');}
  if(!matchesV3ProtectedContext({policy,projectRegistration,registrationCommitment,keyring})
      ||typeof collectContext!=='function'||typeof verifyProtection!=='function'||typeof transport?.setStatus!=='function')
    throw Error('invalid-v3-status-step');
  const registration=projectRegistration.checkpoint;
  const inspect=context=>inspectV3ReservedHandoff({...context.observation,repository:context.repository,projectRegistration,registration,keyring});
  const binding=context=>v3HandoffBinding(policy,context.observation.checkpoint.selectedRecord,context.observation.checkpoint.headOid);
  const valid=context=>matchesHandoffSubject(context?.observation,policy)&&context.observation.expectedProjectId===policy.projectId
    &&context.observation.checkpoint?.schemaVersion===3&&context.observation.checkpoint.cutoverAt===registration.cutoverAt;
  const transportMatches=()=>transport.projectId===policy.projectId&&transport.statusFieldId===policy.statusFieldId;
  let started=false;
  return async({expectedBinding}={})=>{
    if(started)return blocked('status-step-already-used');started=true;
    if(!transportMatches())return blocked('transport-policy-mismatch');
    let first,second,firstBinding,target;
    try{
      expectedBinding=structuredClone(expectedBinding);first=structuredClone(await collectContext());
      if(!valid(first)||inspect(first).kind!=='status-update-planned')return blocked('status-step-not-applicable');
      firstBinding=binding(first);if(!firstBinding||!isDeepStrictEqual(firstBinding,expectedBinding))return blocked('handoff-binding-mismatch');
      const project=first.observation.project,marker=first.observation.checkpoint.selectedRecord.current;
      target=project.statusOptions.find(option=>option.name===marker.targetStatus)?.id;
      if(typeof project.itemId!=='string'||!project.itemId||typeof target!=='string'||!target)return blocked('status-option-unavailable');
      second=structuredClone(await collectContext());
      if(!isDeepStrictEqual(first,second)||inspect(second).kind!=='status-update-planned')return blocked('snapshot-changed');
      if(!protectedBy(await verifyProtection(),policy))return blocked('protection-unverified');
      const final=structuredClone(await collectContext());
      if(!isDeepStrictEqual(first,final)||inspect(final).kind!=='status-update-planned')return blocked('snapshot-changed');
      if(!protectedBy(await verifyProtection(),policy))return blocked('protection-unverified');
    }catch{return blocked('preflight-unavailable');}
    let result;
    try{
      if(!transportMatches())return blocked('transport-policy-mismatch');
      result=await transport.setStatus({itemId:first.observation.project.itemId,targetOptionId:target});
    }catch{return uncertain();}
    if(result?.kind!=='status-write-acknowledged')return uncertain();
    try{
      const after=structuredClone(await collectContext()),normalized=structuredClone(after);
      normalized.observation.project.currentStatus=first.observation.project.currentStatus;
      normalized.observation.project.statusOptionId=first.observation.project.statusOptionId;
      if(!valid(after)||!isDeepStrictEqual(first,normalized)||inspect(after).kind!=='commit-handoff-planned'
          ||!isDeepStrictEqual(binding(after),firstBinding)||!protectedBy(await verifyProtection(),policy))return uncertain();
    }catch{return uncertain();}
    return {kind:'status-target-observed',binding:firstBinding,retryAllowed:false};
  };
}
