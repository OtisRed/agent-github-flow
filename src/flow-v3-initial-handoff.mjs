import { isDeepStrictEqual } from 'node:util';
import { planInitialBranchHandoff } from './flow-checkpoint-initial-handoff.mjs';
import { planCheckpointV3Commit } from './flow-checkpoint-commit-plan.mjs';
import { verifyV3ProjectContext, verifyV3Commitments } from './flow-v3-commitment-verifier.mjs';

const blocked=reason=>({kind:'blocked',reason});

// Pure candidate only. Inputs, keyring and registration must come from trusted
// fresh readers; bootstrap, protection, exclusivity and write authority are
// separate. Private observations and option IDs must never be logged.
export function planInitialV3Handoff(input={}){
  try{
    const {keyring}=input;
    const observed=structuredClone({checkpoint:input.checkpoint,project:input.project,handoffEvidence:input.handoffEvidence,
      epochProof:input.epochProof,trustedAuthorIds:input.trustedAuthorIds,expectedProjectId:input.expectedProjectId,
      registration:input.registration,projectRegistration:input.projectRegistration,repository:input.repository});
    const {checkpoint,project,projectRegistration,registration,repository}=observed;
    if(checkpoint?.schemaVersion!==3||!isDeepStrictEqual(projectRegistration?.checkpoint,registration)
        ||!isDeepStrictEqual(projectRegistration?.trustedAuthorIds,observed.trustedAuthorIds)
        ||observed.expectedProjectId!==projectRegistration?.projectId
        ||verifyV3ProjectContext({registration:projectRegistration,repository,project,issueId:checkpoint?.selection?.issueId}).kind!=='v3-project-context-verified'
        ||!keyring||typeof keyring.current!=='function'||typeof keyring.forId!=='function')return blocked('v3-context-unverified');
    const projected=structuredClone(observed);projected.checkpoint.schemaVersion=1;
    const initial=planInitialBranchHandoff(projected);
    if(initial.kind!=='initial-handoff-planned')return blocked('initial-handoff-invalid');
    const currentKey=keyring.current(),handoff=observed.handoffEvidence.handoff;
    if(!currentKey||!Number.isSafeInteger(currentKey.keyId)||currentKey.keyId<1
        ||typeof currentKey.comment!=='function'||typeof currentKey.config!=='function')return blocked('v3-key-unavailable');
    const {digest,...marker}=initial.record.current;
    const record={...initial.record,version:3,current:{...marker,
      commentMac:currentKey.comment({repositoryId:checkpoint.repositoryId,issueId:checkpoint.selection.issueId,commentId:handoff.id,body:handoff.body}),
      commentKeyId:currentKey.keyId,configMac:currentKey.config(projectRegistration),configKeyId:currentKey.keyId},reservation:null};
    if(verifyV3Commitments({registration:projectRegistration,record,keyring,repository,project,
      comments:[{id:handoff.id,authorId:handoff.authorId,createdAt:handoff.createdAt,body:handoff.body}]}).kind!=='v3-commitments-verified')
      return blocked('v3-commitments-unverified');
    const commit=planCheckpointV3Commit({snapshot:checkpoint,after:record,registration});
    if(commit.kind!=='checkpoint-commit-plan')return blocked('initial-v3-plan-invalid');
    return {kind:'initial-handoff-v3-planned',record,commit};
  }catch{return blocked('initial-v3-plan-unavailable');}
}
