import { isDeepStrictEqual } from 'node:util';
import { CHECKPOINT_BRANCH_REF } from './flow-checkpoint-registration.mjs';
import { planV3Genesis } from './flow-v3-genesis-plan.mjs';

const blocked=reason=>({kind:'blocked',reason});
const uncertain=()=>({kind:'bootstrap-uncertain',retryAllowed:false});
const oid=value=>typeof value==='string'&&/^[0-9a-f]{40}$/.test(value)&&value!=='0'.repeat(40);

// Disconnected one-shot bootstrap. The independently protected enrollment
// verifier must prove first enrollment; missing refs/config alone do not.
// All callbacks and policy must be authenticated and one-writer serialized.
// The result is only a candidate, not registration or active automation.
export async function runV3BootstrapCycle({policy,verifyEnrollment,verifyProtection,verifyApp,prepare,publish,observe,verifyGenesis}={}){
  try{policy=structuredClone(policy);}catch{return blocked('invalid-input');}
  if(!policy||typeof policy!=='object'||Array.isArray(policy)||typeof policy.repository!=='string'
      ||!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(policy.repository)||['.','..'].includes(policy.repository.split('/')[1])
      ||typeof policy.expectedPrivate!=='boolean'||[policy.appId,policy.updateRulesetId,policy.historyRulesetId].some(x=>!Number.isSafeInteger(x)||x<1)
      ||policy.updateRulesetId===policy.historyRulesetId||planV3Genesis({repositoryId:policy.repositoryId,cutoverAt:policy.cutoverAt}).kind!=='v3-genesis-plan'
      ||![verifyEnrollment,verifyProtection,verifyApp,prepare,publish,observe,verifyGenesis].every(fn=>typeof fn==='function'))return blocked('invalid-input');
  const setupIntent={repository:policy.repository,repositoryId:policy.repositoryId,expectedPrivate:policy.expectedPrivate,cutoverAt:policy.cutoverAt};
  const checks=async()=>{
    const enrollment=await verifyEnrollment(structuredClone(policy));
    if(enrollment?.kind!=='bootstrap-permitted'||!isDeepStrictEqual(enrollment.policy,policy))return false;
    const app=await verifyApp(structuredClone(policy));
    if(app?.kind!=='app-identity-verified'||app.repositoryId!==policy.repositoryId||app.appId!==policy.appId)return false;
    const protection=await verifyProtection(structuredClone(policy));
    return protection?.kind==='checkpoint-protection-observed'&&protection.repositoryId===policy.repositoryId
      &&protection.appId===policy.appId&&protection.updateRulesetId===policy.updateRulesetId&&protection.historyRulesetId===policy.historyRulesetId;
  };
  let prepared;
  try{
    if(!await checks())return blocked('bootstrap-preflight-unverified');
    prepared=structuredClone(await prepare(structuredClone(setupIntent)));
    if(prepared?.kind==='genesis-preparation-uncertain')return uncertain();
    if(prepared?.kind!=='v3-genesis-objects-prepared'||!oid(prepared.genesisOid)||!oid(prepared.treeOid))return blocked('genesis-not-prepared');
    if(!await checks())return blocked('bootstrap-preflight-changed');
  }catch{return blocked('bootstrap-preflight-unavailable');}
  const registration={repositoryId:policy.repositoryId,ref:CHECKPOINT_BRANCH_REF,genesisOid:prepared.genesisOid,
    cutoverAt:policy.cutoverAt,checkpointSchemaVersion:3};
  const subject={setupIntent,genesisOid:prepared.genesisOid,expectedTreeOid:prepared.treeOid};
  let write;try{write=await publish(structuredClone(subject));}catch{write={kind:'ref-update-uncertain'};}
  if(write?.kind==='blocked')return blocked('ref-publication-refused');
  if(!['ref-update-acknowledged','ref-update-uncertain'].includes(write?.kind))return uncertain();
  try{
    const seen=await observe(structuredClone(subject));if(seen?.kind!=='genesis-publication-observed')return uncertain();
    const proof=await verifyGenesis(structuredClone(registration));
    if(proof?.kind!=='v3-bootstrap-verified'||!isDeepStrictEqual(proof.registration,registration))return uncertain();
    if(!await checks())return uncertain();
  }catch{return uncertain();}
  return {kind:'v3-registration-candidate',registration,retryAllowed:false};
}
