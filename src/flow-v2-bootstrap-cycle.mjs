import { isDeepStrictEqual } from 'node:util';
import { CHECKPOINT_BRANCH_REF } from './flow-checkpoint-registration.mjs';
import { parseFlowTimestamp } from './flow-epoch.mjs';

const blocked=reason=>({kind:'blocked',reason});
const uncertain=()=>({kind:'bootstrap-uncertain',retryAllowed:false});
const oid=value=>typeof value==='string'&&/^[0-9a-f]{40}$/.test(value)&&value!=='0'.repeat(40);
const validPolicy=p=>p&&typeof p==='object'&&!Array.isArray(p)
  &&typeof p.repositoryId==='string'&&p.repositoryId.length>0&&p.repositoryId.length<=256&&p.repositoryId.trim()===p.repositoryId
  &&typeof p.repository==='string'&&/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(p.repository)
  &&!['.','..'].includes(p.repository.split('/')[1])&&[p.appId,p.updateRulesetId,p.historyRulesetId].every(x=>Number.isSafeInteger(x)&&x>0)
  &&p.updateRulesetId!==p.historyRulesetId&&parseFlowTimestamp(p.cutoverAt)!==null;

// Disconnected orchestration. Every dependency must be authenticated, bound to
// protected enrollment/configuration and the expected App, and the caller must
// serialize bootstrap against all other writers. verifyEnrollment must prove
// this is a first enrollment, not infer it from missing refs. The returned
// candidate is not registered and does not activate any automation.
export async function runV2BootstrapCycle({policy,verifyEnrollment,verifyProtection,verifyApp,prepare,publish,observe,verifyGenesis}={}) {
  if(!validPolicy(policy)||![verifyEnrollment,verifyProtection,verifyApp,prepare,publish,observe,verifyGenesis].every(fn=>typeof fn==='function'))
    return blocked('invalid-input');
  policy=structuredClone(policy);
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
    prepared=structuredClone(await prepare(structuredClone(policy)));
    if(prepared?.kind!=='v2-genesis-objects-prepared'||!oid(prepared.genesisOid)||!oid(prepared.treeOid))return blocked('genesis-not-prepared');
    if(!await checks())return blocked('bootstrap-preflight-changed');
  }catch{return blocked('bootstrap-preflight-unavailable');}
  const registration={repositoryId:policy.repositoryId,ref:CHECKPOINT_BRANCH_REF,genesisOid:prepared.genesisOid,
    cutoverAt:policy.cutoverAt,checkpointSchemaVersion:2};
  const subject={repositoryId:policy.repositoryId,repositoryFullName:policy.repository,genesisOid:prepared.genesisOid,expectedTreeOid:prepared.treeOid};
  let write;
  try{write=await publish(structuredClone(subject));}catch{write={kind:'ref-update-uncertain'};}
  if(write?.kind==='blocked')return blocked('ref-publication-refused');
  if(!['ref-update-acknowledged','ref-update-uncertain'].includes(write?.kind))return uncertain();
  try{
    const seen=await observe(structuredClone(subject));
    if(seen?.kind!=='genesis-publication-observed')return uncertain();
    const proof=await verifyGenesis(structuredClone(registration));
    if(proof?.kind!=='v2-bootstrap-verified'||!isDeepStrictEqual(proof.registration,registration))return uncertain();
    if(!await checks())return uncertain();
  }catch{return uncertain();}
  return {kind:'v2-registration-candidate',registration,retryAllowed:false};
}
