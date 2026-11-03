import { isDeepStrictEqual } from 'node:util';
import { isHandoffSubject } from './flow-handoff-binding.mjs';
import { encodeProjectRegistrationV3 } from './flow-project-registration-v3.mjs';

// Checks inputs supplied from independent protected sources; cannot itself
// establish their origin, freshness or protect them against rollback.
export function matchesV3ProtectedContext({policy,projectRegistration,registrationCommitment,keyring}={}){
  try{
    if(!isHandoffSubject(policy)||encodeProjectRegistrationV3(projectRegistration).kind!=='encoded-registration'
        ||projectRegistration.repositoryId!==policy.repositoryId||projectRegistration.repository!==policy.repository
        ||projectRegistration.projectId!==policy.projectId||projectRegistration.statusFieldId!==policy.statusFieldId
        ||projectRegistration.appId!==policy.appId||projectRegistration.updateRulesetId!==policy.updateRulesetId
        ||projectRegistration.historyRulesetId!==policy.historyRulesetId||!isDeepStrictEqual(projectRegistration.trustedAuthorIds,policy.trustedAuthorIds)
        ||!keyring||typeof keyring.current!=='function'||typeof keyring.forId!=='function')return false;
    const commitment=structuredClone(registrationCommitment);
    return !!commitment&&Object.keys(commitment).length===2&&Number.isSafeInteger(commitment.keyId)&&commitment.keyId>0
      &&typeof commitment.mac==='string'&&keyring.forId(commitment.keyId).verifyConfig(projectRegistration,commitment.mac)===true;
  }catch{return false;}
}
