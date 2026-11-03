import { isDeepStrictEqual } from 'node:util';
import { CHECKPOINT_BRANCH_REF } from './flow-checkpoint-registration.mjs';
import { planV3Genesis } from './flow-v3-genesis-plan.mjs';

const blocked=reason=>({kind:'blocked',reason});
const uncertain=()=>({kind:'bootstrap-uncertain',retryAllowed:false});
const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)&&value!=='0'.repeat(40);
const fields=['source','repository','repositoryId','expectedPrivate','cutoverAt','appId','updateRulesetId','historyRulesetId'];

// Read-only recovery for a previously anchored initializing record. No new
// object, ref publication, registration or retry is attempted. All callbacks
// and the registry anchor must be independently authenticated and serialized.
export async function recoverV3Bootstrap({policy,verifyEnrollment,verifyApp,verifyProtection,observe,verifyGenesis}={}){
  try{policy=structuredClone(policy);}catch{return blocked('invalid-input');}
  if(!policy||typeof policy!=='object'||Array.isArray(policy)||Object.keys(policy).length!==fields.length
      ||!fields.every(field=>Object.hasOwn(policy,field))||typeof policy.source!=='string'||!/^[a-f0-9]{32}$/.test(policy.source)
      ||typeof policy.repository!=='string'||!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(policy.repository)
      ||['.','..'].includes(policy.repository.split('/')[1])||typeof policy.expectedPrivate!=='boolean'
      ||[policy.appId,policy.updateRulesetId,policy.historyRulesetId].some(value=>!Number.isSafeInteger(value)||value<1)
      ||policy.updateRulesetId===policy.historyRulesetId||planV3Genesis({repositoryId:policy.repositoryId,cutoverAt:policy.cutoverAt}).kind!=='v3-genesis-plan'
      ||![verifyEnrollment,verifyApp,verifyProtection,observe,verifyGenesis].every(fn=>typeof fn==='function'))return blocked('invalid-input');
  const checks=async expected=>{
    const enrollment=await verifyEnrollment(structuredClone(policy));
    if(enrollment?.kind!=='bootstrap-permitted'||enrollment.phase!=='initializing'||!isDeepStrictEqual(enrollment.policy,policy)
        ||!enrollment.bootstrap||!oid(enrollment.bootstrap.genesisOid)||!oid(enrollment.bootstrap.treeOid)
        ||(expected&&!isDeepStrictEqual(enrollment.bootstrap,expected)))return null;
    const app=await verifyApp(structuredClone(policy));if(app?.kind!=='app-identity-verified'||app.repositoryId!==policy.repositoryId||app.appId!==policy.appId)return null;
    const protection=await verifyProtection(structuredClone(policy));
    if(protection?.kind!=='checkpoint-protection-observed'||protection.repositoryId!==policy.repositoryId||protection.appId!==policy.appId
        ||protection.updateRulesetId!==policy.updateRulesetId||protection.historyRulesetId!==policy.historyRulesetId)return null;
    return structuredClone(enrollment.bootstrap);
  };
  try{
    const pinned=await checks();if(!pinned)return blocked('recovery-preflight-unverified');
    const setupIntent={repository:policy.repository,repositoryId:policy.repositoryId,expectedPrivate:policy.expectedPrivate,cutoverAt:policy.cutoverAt};
    const subject={setupIntent,genesisOid:pinned.genesisOid,expectedTreeOid:pinned.treeOid};
    const seen=await observe(structuredClone(subject));
    if(seen?.kind==='genesis-publication-not-observed')return await checks(pinned)
      ?{kind:'bootstrap-recovery-needed',reason:'refs-absent',retryAllowed:false}:uncertain();
    if(seen?.kind!=='genesis-publication-observed')return uncertain();
    const registration={repositoryId:policy.repositoryId,ref:CHECKPOINT_BRANCH_REF,genesisOid:pinned.genesisOid,
      cutoverAt:policy.cutoverAt,checkpointSchemaVersion:3};
    const proof=await verifyGenesis(structuredClone(registration));
    if(proof?.kind!=='v3-bootstrap-verified'||!isDeepStrictEqual(proof.registration,registration)||!await checks(pinned))return uncertain();
    return {kind:'v3-registration-candidate',registration,retryAllowed:false};
  }catch{return uncertain();}
}
