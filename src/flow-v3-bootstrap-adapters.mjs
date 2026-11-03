import { isDeepStrictEqual } from 'node:util';
import { CHECKPOINT_BRANCH_REF } from './flow-checkpoint-registration.mjs';
import { createV3GenesisPreparer } from './flow-v3-genesis-preparer.mjs';
import { createV3GenesisRefTransport } from './flow-v3-genesis-ref-transport.mjs';
import { createV3SetupGitReader } from './flow-v3-git-reader.mjs';
import { observeV3GenesisPublication } from './flow-v3-genesis-observer.mjs';
import { createV3BootstrapVerifier } from './flow-v3-bootstrap.mjs';

// Restricted one-shot transport composition for bootstrap only. A caller
// still must authenticate this administrative intent, prove first enrollment,
// App identity, branch protection and exclusive writer. No secrets or private
// context may be logged. Candidate creation never activates a project.
export function createV3BootstrapAdapters({setupIntent,appToken,request=fetch}={}){
  try{setupIntent=structuredClone(setupIntent);}catch{throw Error('invalid-v3-bootstrap-adapters');}
  const reader=createV3SetupGitReader({setupIntent,appToken,request});
  const preparer=createV3GenesisPreparer({setupIntent,appToken,request});
  let prepared=null,prepareStarted=false,publishStarted=false,publishAttempted=false,observed=false;
  const sameSubject=subject=>!!prepared&&isDeepStrictEqual(subject?.setupIntent,setupIntent)
    &&subject.genesisOid===prepared.genesisOid&&subject.expectedTreeOid===prepared.treeOid;
  const prepare=async intent=>{
    if(prepareStarted||!isDeepStrictEqual(intent,setupIntent))return {kind:'blocked',reason:'bootstrap-intent-mismatch'};
    prepareStarted=true;const result=await preparer.prepare();
    if(result?.kind==='v3-genesis-objects-prepared')prepared=structuredClone(result);
    return result;
  };
  const publish=async subject=>{
    if(publishStarted||!sameSubject(subject))return {kind:'blocked',reason:'bootstrap-subject-mismatch'};
    publishStarted=true;let transport;
    try{transport=createV3GenesisRefTransport({setupIntent,genesisOid:prepared.genesisOid,treeOid:prepared.treeOid,appToken,request});}
    catch{return {kind:'blocked',reason:'bootstrap-transport-unavailable'};}
    publishAttempted=true;
    try{return await transport.publish();}catch{return {kind:'ref-update-uncertain',retryAllowed:false};}
  };
  const observe=async subject=>{
    if(!publishAttempted||!sameSubject(subject))return {kind:'blocked',reason:'bootstrap-subject-mismatch'};
    const result=await observeV3GenesisPublication({...subject,readRepository:reader.readRepository,readRef:reader.readRef,readCommit:reader.readCommit});
    observed=result.kind==='genesis-publication-observed';return result;
  };
  const verifyGenesis=async registration=>{
    const expected=prepared?{repositoryId:setupIntent.repositoryId,ref:CHECKPOINT_BRANCH_REF,genesisOid:prepared.genesisOid,
      cutoverAt:setupIntent.cutoverAt,checkpointSchemaVersion:3}:null;
    if(!observed||!isDeepStrictEqual(registration,expected))return {kind:'blocked',reason:'bootstrap-registration-mismatch'};
    try{return await createV3BootstrapVerifier({registration,...reader})(registration);}
    catch{return {kind:'blocked',reason:'bootstrap-verifier-unavailable'};}
  };
  return Object.freeze({prepare,publish,observe,verifyGenesis});
}
