import { matchesHandoffSubject } from './flow-handoff-binding.mjs';
import { matchesV3ProtectedContext } from './flow-v3-protected-context.mjs';
import { createV3CheckpointRefTransport } from './flow-checkpoint-ref-transport.mjs';

// One-shot App publisher. Trusted runtime must independently verify the App
// identity, bootstrap, ref protection and exclusive writer. A separate
// observer must read back the ref pair and inventory after every attempt.
export function createV3PublicationAdapter({policy,projectRegistration,registrationCommitment,keyring,collectContext,appToken,request=fetch}={}){
  try{policy=structuredClone(policy);projectRegistration=structuredClone(projectRegistration);registrationCommitment=structuredClone(registrationCommitment);}
  catch{throw Error('invalid-v3-publisher');}
  if(!matchesV3ProtectedContext({policy,projectRegistration,registrationCommitment,keyring})
      ||typeof collectContext!=='function'||typeof request!=='function')throw Error('invalid-v3-publisher');
  let started=false;
  return async({expectedHeadOid,expectedTreeOid,commit,after}={})=>{
    if(started)return {kind:'blocked',reason:'publisher-already-used'};started=true;
    let transport;
    try{
      commit=structuredClone(commit);after=structuredClone(after);const context=structuredClone(await collectContext()),observation=context?.observation;
      if(!matchesHandoffSubject(observation,policy)||observation.expectedProjectId!==policy.projectId
          ||observation.checkpoint?.schemaVersion!==3||observation.checkpoint.headOid!==expectedHeadOid
          ||commit?.tree?.sha!==expectedTreeOid||!Array.isArray(commit.parents)||commit.parents.length!==1
          ||commit.parents[0]?.sha!==expectedHeadOid||projectRegistration.checkpoint.repositoryId!==policy.repositoryId)
        return {kind:'blocked',reason:'publisher-observation-mismatch'};
      const v3={...observation,repository:context.repository,projectRegistration};
      transport=createV3CheckpointRefTransport({policy,projectRegistration,registrationCommitment,keyring,
        snapshot:observation.checkpoint,after,v3,expectedTreeOid,commitOid:commit.sha,appToken,request});
    }catch{return {kind:'blocked',reason:'publisher-preparation-unavailable'};}
    try{return await transport.publish();}catch{return {kind:'ref-update-uncertain',retryAllowed:false};}
  };
}
