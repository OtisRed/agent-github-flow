import { isDeepStrictEqual } from 'node:util';
import { matchesHandoffSubject } from './flow-handoff-binding.mjs';
import { matchesV3ProtectedContext } from './flow-v3-protected-context.mjs';
import { v3HandoffBinding } from './flow-v3-handoff-binding.mjs';
import { planInitialV3Handoff } from './flow-v3-initial-handoff.mjs';
import { planV3StatusReservation, planV3HandoffCommit } from './flow-v3-reservation-plan.mjs';

const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)&&value!=='0'.repeat(40);
const blocked=reason=>({kind:'blocked',reason});
const uncertain=()=>({kind:'publication-uncertain',retryAllowed:false});
const protectedBy=(value,p)=>value?.kind==='checkpoint-protection-observed'&&value.repositoryId===p.repositoryId
  &&value.appId===p.appId&&value.updateRulesetId===p.updateRulesetId&&value.historyRulesetId===p.historyRulesetId;

// One disconnected publication step, not an Actions entrypoint. The caller
// must bind trusted readers, bootstrap/protection, restricted App publisher,
// observer and exclusive writer. Git publication uncertainty is never retried
// here. No secret, private context or plan may be logged.
export function createV3PublicationStep({policy,projectRegistration,registrationCommitment,keyring,collectContext,
  verifyProtection,prepare,publish,observe}={}){
  if(!matchesV3ProtectedContext({policy,projectRegistration,registrationCommitment,keyring})
      ||![collectContext,verifyProtection,prepare,publish,observe].every(fn=>typeof fn==='function'))throw Error('invalid-v3-publication-step');
  policy=structuredClone(policy);projectRegistration=structuredClone(projectRegistration);const registration=projectRegistration.checkpoint;
  const valid=context=>matchesHandoffSubject(context?.observation,policy)&&context.observation.expectedProjectId===policy.projectId
    &&context.observation.checkpoint?.schemaVersion===3&&context.observation.checkpoint.cutoverAt===registration.cutoverAt;
  const bind=context=>v3HandoffBinding(policy,context.observation.checkpoint.selectedRecord,context.observation.checkpoint.headOid);
  let started=false;
  return async({operation,expectedBinding,reservedAt}={})=>{
    if(started)return blocked('publication-step-already-used');started=true;
    if(!['initial','reservation','commit'].includes(operation))return blocked('invalid-operation');
    let first,plan,prepared;
    try{
      expectedBinding=structuredClone(expectedBinding);first=structuredClone(await collectContext());
      if(!valid(first))return blocked('policy-mismatch');
      const input={...first.observation,repository:first.repository,projectRegistration,registration,keyring};
      plan=operation==='initial'?planInitialV3Handoff(input):operation==='reservation'?planV3StatusReservation({...input,reservedAt}):planV3HandoffCommit(input);
      const expectedKind=operation==='initial'?'initial-handoff-v3-planned':operation==='reservation'?'v3-status-reservation-planned':'v3-commit-handoff-planned';
      if(plan.kind!==expectedKind)return blocked('publication-step-not-applicable');
      if(operation!=='initial'){
        const current=bind(first);if(!current||!isDeepStrictEqual(current,expectedBinding))return blocked('handoff-binding-mismatch');
      }
      if(!protectedBy(await verifyProtection(),policy)||!isDeepStrictEqual(first,await collectContext()))return blocked('preparation-preflight-changed');
      prepared=await prepare({snapshot:structuredClone(first.observation.checkpoint),after:structuredClone(plan.record),registration:structuredClone(registration)});
    }catch{return blocked('preparation-unavailable');}
    if(prepared?.kind!=='checkpoint-objects-prepared')return uncertain();
    const oldOid=first.observation.checkpoint.headOid,newOid=prepared.commit?.sha,treeOid=prepared.expectedTreeOid;
    if(prepared.expectedHeadOid!==oldOid||!oid(newOid)||!oid(treeOid)||newOid===oldOid||prepared.commit?.tree?.sha!==treeOid
        ||!Array.isArray(prepared.commit?.parents)||prepared.commit.parents.length!==1||prepared.commit.parents[0]?.sha!==oldOid)return uncertain();
    try{
      if(!isDeepStrictEqual(first,await collectContext())||!protectedBy(await verifyProtection(),policy))return blocked('publication-preflight-changed');
    }catch{return blocked('publication-preflight-unavailable');}
    let write;try{write=await publish({expectedHeadOid:oldOid,expectedTreeOid:treeOid,commit:structuredClone(prepared.commit)});}catch{write=null;}
    let seen;try{seen=await observe({oldOid,newOid,expectedTreeOid:treeOid});}catch{return uncertain();}
    if(write?.kind!=='ref-update-acknowledged'||seen?.kind!=='publication-observed')return uncertain();
    try{
      const expected=structuredClone(first),checkpoint=expected.observation.checkpoint;
      checkpoint.headOid=newOid;checkpoint.index=JSON.parse(Buffer.from(plan.commit.additions.find(x=>x.path==='index.json').contents,'base64').toString('utf8'));
      checkpoint.selectedRecord=plan.record;
      if(!isDeepStrictEqual(expected,await collectContext())||!protectedBy(await verifyProtection(),policy))return uncertain();
      if(operation==='commit'){
        const record=checkpoint.selectedRecord,marker=record.current;
        return {kind:'v3-commit-observed',receipt:{repositoryId:record.repositoryId,issueId:record.issueId,number:record.number,
          phase:'committed',commentId:marker.commentId,commentMac:marker.commentMac,commentKeyId:marker.commentKeyId,
          configMac:marker.configMac,configKeyId:marker.configKeyId,checkpointOid:newOid},retryAllowed:false};
      }
      const binding=bind(expected);
      return binding?{kind:`v3-${operation}-observed`,binding,retryAllowed:false}:uncertain();
    }catch{return uncertain();}
  };
}
