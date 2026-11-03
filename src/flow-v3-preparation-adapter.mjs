import { isDeepStrictEqual } from 'node:util';
import { matchesHandoffSubject } from './flow-handoff-binding.mjs';
import { matchesV3ProtectedContext } from './flow-v3-protected-context.mjs';
import { createV3CheckpointObjectPreparer } from './flow-checkpoint-object-preparer.mjs';

// Isolated App preparation only, not ref publication or authorization.
// policy, registration, independent registrationCommitment, keyring and
// collectContext must be authenticated and protected; a caller must independently prove bootstrap, protection and one
// writer. Do not log observations, callback results or credentials.
export function createV3PreparationAdapter({policy,projectRegistration,registrationCommitment,keyring,collectContext,appToken,request=fetch}={}){
  try{policy=structuredClone(policy);projectRegistration=structuredClone(projectRegistration);registrationCommitment=structuredClone(registrationCommitment);}
  catch{throw Error('invalid-v3-adapter');}
  if(!matchesV3ProtectedContext({policy,projectRegistration,registrationCommitment,keyring})
      ||typeof collectContext!=='function'||typeof request!=='function')throw Error('invalid-v3-adapter');
  const registration=projectRegistration.checkpoint,parts=policy.repository.split('/');
  if(parts.length!==2)throw Error('invalid-v3-adapter');
  return async({snapshot,after,registration:observed}={})=>{
    try{
      snapshot=structuredClone(snapshot);after=structuredClone(after);observed=structuredClone(observed);
      if(!isDeepStrictEqual(observed,registration)||snapshot?.schemaVersion!==3||snapshot.repositoryId!==policy.repositoryId
          ||snapshot.repositoryFullName!==policy.repository||snapshot.cutoverAt!==registration.cutoverAt
          ||snapshot.selection?.issueId!==policy.issueId||snapshot.selection?.number!==policy.issueNumber
          ||after?.issueId!==policy.issueId||after?.number!==policy.issueNumber)return {kind:'blocked',reason:'adapter-subject-mismatch'};
      const context=structuredClone(await collectContext());
      if(!matchesHandoffSubject(context?.observation,policy)||!isDeepStrictEqual(context.observation.checkpoint,snapshot))
        return {kind:'blocked',reason:'adapter-observation-mismatch'};
      const v3={...context.observation,repository:context.repository,projectRegistration,keyring};
      return await createV3CheckpointObjectPreparer({owner:parts[0],repo:parts[1],snapshot,after,registration,v3,appToken,request}).prepare();
    }catch{return {kind:'blocked',reason:'adapter-preparation-unavailable'};}
  };
}
