import { isDeepStrictEqual } from 'node:util';
import { isHandoffSubject, matchesHandoffSubject } from './flow-handoff-binding.mjs';
import { encodeProjectRegistrationV3 } from './flow-project-registration-v3.mjs';
import { createV3CheckpointObjectPreparer } from './flow-checkpoint-object-preparer.mjs';

// Isolated App preparation only, not ref publication or authorization.
// policy, registration, independent registrationCommitment, keyring and
// collectContext must be authenticated and protected; a caller must independently prove bootstrap, protection and one
// writer. Do not log observations, callback results or credentials.
export function createV3PreparationAdapter({policy,projectRegistration,registrationCommitment,keyring,collectContext,appToken,request=fetch}={}){
  if(!isHandoffSubject(policy)||encodeProjectRegistrationV3(projectRegistration).kind!=='encoded-registration'
      ||projectRegistration.repositoryId!==policy.repositoryId||projectRegistration.repository!==policy.repository
      ||projectRegistration.projectId!==policy.projectId||projectRegistration.statusFieldId!==policy.statusFieldId
      ||projectRegistration.appId!==policy.appId||projectRegistration.updateRulesetId!==policy.updateRulesetId
      ||projectRegistration.historyRulesetId!==policy.historyRulesetId||!isDeepStrictEqual(projectRegistration.trustedAuthorIds,policy.trustedAuthorIds)
      ||!keyring||typeof keyring.current!=='function'||typeof keyring.forId!=='function'
      ||typeof collectContext!=='function'||typeof request!=='function')throw Error('invalid-v3-adapter');
  policy=structuredClone(policy);projectRegistration=structuredClone(projectRegistration);
  try{
    const commitment=structuredClone(registrationCommitment);
    if(!commitment||Object.keys(commitment).length!==2||!Number.isSafeInteger(commitment.keyId)||commitment.keyId<1
        ||typeof commitment.mac!=='string'||!keyring.forId(commitment.keyId).verifyConfig(projectRegistration,commitment.mac))
      throw Error('invalid');
  }catch{throw Error('invalid-v3-adapter');}
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
