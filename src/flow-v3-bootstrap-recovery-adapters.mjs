import { isDeepStrictEqual } from 'node:util';
import { CHECKPOINT_BRANCH_REF } from './flow-checkpoint-registration.mjs';
import { createV3SetupGitReader } from './flow-v3-git-reader.mjs';
import { observeV3GenesisPublication } from './flow-v3-genesis-observer.mjs';
import { createV3BootstrapVerifier } from './flow-v3-bootstrap.mjs';

const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)&&value!=='0'.repeat(40);

// Read-only recovery against an independently authenticated pinned setup. No
// object/ref mutations are provided. App identity, registry provenance,
// protection and exclusive writer are obligations of the surrounding cycle.
export function createV3BootstrapRecoveryAdapters({setupIntent,bootstrap,appToken,request=fetch}={}){
  try{setupIntent=structuredClone(setupIntent);bootstrap=structuredClone(bootstrap);}catch{throw Error('invalid-v3-bootstrap-recovery');}
  if(!bootstrap||typeof bootstrap!=='object'||Array.isArray(bootstrap)||Object.keys(bootstrap).length!==2
      ||!oid(bootstrap.genesisOid)||!oid(bootstrap.treeOid))throw Error('invalid-v3-bootstrap-recovery');
  const reader=createV3SetupGitReader({setupIntent,appToken,request});
  const subject={setupIntent,genesisOid:bootstrap.genesisOid,expectedTreeOid:bootstrap.treeOid};
  const registration={repositoryId:setupIntent.repositoryId,ref:CHECKPOINT_BRANCH_REF,genesisOid:bootstrap.genesisOid,
    cutoverAt:setupIntent.cutoverAt,checkpointSchemaVersion:3};
  let observed=false;
  const observe=async candidate=>{
    if(!isDeepStrictEqual(candidate,subject))return {kind:'blocked',reason:'bootstrap-subject-mismatch'};
    const result=await observeV3GenesisPublication({...subject,readRepository:reader.readRepository,readRef:reader.readRef,readCommit:reader.readCommit});
    observed=result.kind==='genesis-publication-observed';return result;
  };
  const verifyGenesis=async candidate=>{
    if(!observed||!isDeepStrictEqual(candidate,registration))return {kind:'blocked',reason:'bootstrap-registration-mismatch'};
    try{return await createV3BootstrapVerifier({registration,...reader})(registration);}
    catch{return {kind:'blocked',reason:'bootstrap-verifier-unavailable'};}
  };
  return Object.freeze({observe,verifyGenesis});
}
