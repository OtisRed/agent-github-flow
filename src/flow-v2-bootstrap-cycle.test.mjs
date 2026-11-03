import test from 'node:test';
import assert from 'node:assert/strict';
import { runV2BootstrapCycle } from './flow-v2-bootstrap-cycle.mjs';
import { CHECKPOINT_BRANCH_REF } from './flow-checkpoint-registration.mjs';
import { runV3BootstrapCycle } from './flow-v3-bootstrap-cycle.mjs';

const oid=c=>c.repeat(40);
function fixture(){
  const policy={repositoryId:'repo',repository:'owner/project',appId:12,updateRulesetId:1,historyRulesetId:2,
    cutoverAt:'2026-01-01T10:00:00Z'};
  const registration={repositoryId:'repo',ref:CHECKPOINT_BRANCH_REF,genesisOid:oid('a'),cutoverAt:policy.cutoverAt,checkpointSchemaVersion:2};
  const state={calls:[],publishResult:'ref-update-acknowledged',observed:'genesis-publication-observed',changed:false};
  const verifyEnrollment=async()=>{state.calls.push('enrollment');return {kind:'bootstrap-permitted',policy:state.changed?{...policy,appId:13}:structuredClone(policy)};};
  const verifyProtection=async()=>{state.calls.push('protection');return {kind:'checkpoint-protection-observed',repositoryId:'repo',appId:12,updateRulesetId:1,historyRulesetId:2};};
  const verifyApp=async()=>{state.calls.push('app');return {kind:'app-identity-verified',repositoryId:'repo',appId:12};};
  const prepare=async()=>{state.calls.push('prepare');return {kind:'v2-genesis-objects-prepared',genesisOid:oid('a'),treeOid:oid('b')};};
  const publish=async()=>{state.calls.push('publish');return {kind:state.publishResult};};
  const observe=async()=>{state.calls.push('observe');return {kind:state.observed};};
  const verifyGenesis=async()=>{state.calls.push('genesis');return {kind:'v2-bootstrap-verified',registration:structuredClone(registration)};};
  return {state,policy,registration,input:{policy,verifyEnrollment,verifyProtection,verifyApp,prepare,publish,observe,verifyGenesis}};
}
test('prepares a verified registration candidate only after protected one-shot creation and readback',async()=>{
  const f=fixture(),result=await runV2BootstrapCycle(f.input);
  assert.deepEqual(result,{kind:'v2-registration-candidate',registration:f.registration,retryAllowed:false});
  assert.equal(f.state.calls.filter(x=>x==='publish').length,1);assert.deepEqual(f.state.calls.slice(-3),['enrollment','app','protection']);
});
test('uncertain publication with exact readback can be independently verified, absent pair never retries',async()=>{
  let f=fixture();f.state.publishResult='ref-update-uncertain';assert.equal((await runV2BootstrapCycle(f.input)).kind,'v2-registration-candidate');
  f=fixture();f.state.publishResult='ref-update-uncertain';f.state.observed='genesis-publication-not-observed';
  assert.equal((await runV2BootstrapCycle(f.input)).kind,'bootstrap-uncertain');assert.equal(f.state.calls.filter(x=>x==='publish').length,1);
});
test('blocks changed enrollment, wrong App, protection or genesis evidence before a candidate',async()=>{
  let f=fixture();f.state.changed=true;assert.equal((await runV2BootstrapCycle(f.input)).kind,'blocked');assert.equal(f.state.calls.includes('publish'),false);
  f=fixture();f.input.verifyApp=async()=>({kind:'app-identity-verified',repositoryId:'repo',appId:13});
  assert.equal((await runV2BootstrapCycle(f.input)).kind,'blocked');assert.equal(f.state.calls.includes('prepare'),false);
  f=fixture();f.input.verifyGenesis=async()=>({kind:'v2-bootstrap-verified',registration:{...f.registration,genesisOid:oid('c')}});
  assert.equal((await runV2BootstrapCycle(f.input)).kind,'bootstrap-uncertain');
});

test('distinguishes a known pre-mutation refusal from an uncertain write',async()=>{
  const f=fixture();f.state.publishResult='blocked';
  assert.deepEqual(await runV2BootstrapCycle(f.input),{kind:'blocked',reason:'ref-publication-refused'});
  assert.equal(f.state.calls.includes('observe'),false);
});

test('blocks invalid prepared objects without attempting publication',async()=>{
  for(const prepared of [{kind:'other'},{kind:'v2-genesis-objects-prepared',genesisOid:'bad',treeOid:oid('b')},
    {kind:'v2-genesis-objects-prepared',genesisOid:oid('a'),treeOid:'bad'}]){
    const f=fixture();f.input.prepare=async()=>prepared;
    assert.equal((await runV2BootstrapCycle(f.input)).kind,'blocked');assert.equal(f.state.calls.includes('publish'),false);
  }
});

test('does not return a candidate if enrollment, App or protection changes after publication',async()=>{
  for(const target of ['verifyEnrollment','verifyApp','verifyProtection']){
    const f=fixture(),original=f.input[target];let calls=0;
    f.input[target]=async(...args)=>++calls===3?{kind:'blocked'}:original(...args);
    assert.equal((await runV2BootstrapCycle(f.input)).kind,'bootstrap-uncertain');
    assert.equal(f.state.calls.filter(x=>x==='publish').length,1);
  }
});

function fixtureV3(expectedPrivate=false){
  const f=fixture();f.policy.expectedPrivate=expectedPrivate;f.policy.source='a'.repeat(32);f.registration.checkpointSchemaVersion=3;
  f.state.phase='reserved';f.state.bootstrap=null;
  f.input.verifyEnrollment=async p=>{f.state.calls.push('enrollment');return {kind:'bootstrap-permitted',policy:p,phase:f.state.phase,bootstrap:f.state.bootstrap};};
  f.input.pinGenesis=async(p,bootstrap)=>{f.state.calls.push('pin');f.state.phase='initializing';f.state.bootstrap=structuredClone(bootstrap);
    return {kind:'v3-genesis-pinned',policy:p,bootstrap};};
  f.input.prepare=async intent=>{f.state.calls.push('prepare');assert.deepEqual(intent,{repository:'owner/project',repositoryId:'repo',expectedPrivate,
    cutoverAt:f.policy.cutoverAt});return {kind:'v3-genesis-objects-prepared',genesisOid:oid('a'),treeOid:oid('b')};};
  f.input.verifyGenesis=async()=>{f.state.calls.push('genesis');return {kind:'v3-bootstrap-verified',registration:structuredClone(f.registration)};};
  return f;
}
test('v3 bootstrap produces only a verified registration candidate for public and private projects',async()=>{
  for(const expectedPrivate of [false,true]){const f=fixtureV3(expectedPrivate),result=await runV3BootstrapCycle(f.input);
    assert.deepEqual(result,{kind:'v3-registration-candidate',registration:f.registration,retryAllowed:false});
    assert.equal(f.state.calls.filter(x=>x==='publish').length,1);}
});
test('v3 bootstrap never infers enrollment from missing refs or retries uncertain publication',async()=>{
  let f=fixtureV3();f.input.verifyEnrollment=async()=>({kind:'blocked'});
  assert.equal((await runV3BootstrapCycle(f.input)).kind,'blocked');assert.equal(f.state.calls.includes('prepare'),false);
  f=fixtureV3();f.state.publishResult='ref-update-uncertain';f.state.observed='genesis-publication-not-observed';
  assert.equal((await runV3BootstrapCycle(f.input)).kind,'bootstrap-uncertain');assert.equal(f.state.calls.filter(x=>x==='publish').length,1);
  f=fixtureV3();f.input.verifyApp=async()=>({kind:'app-identity-verified',repositoryId:'repo',appId:13});
  assert.equal((await runV3BootstrapCycle(f.input)).kind,'blocked');assert.equal(f.state.calls.includes('publish'),false);
  f=fixtureV3();f.input.prepare=async()=>({kind:'genesis-preparation-uncertain',retryAllowed:false});
  assert.equal((await runV3BootstrapCycle(f.input)).kind,'bootstrap-uncertain');assert.equal(f.state.calls.includes('publish'),false);
  f=fixtureV3();f.input.pinGenesis=async()=>{throw Error('uncertain');};
  assert.equal((await runV3BootstrapCycle(f.input)).kind,'bootstrap-uncertain');assert.equal(f.state.calls.includes('publish'),false);
});
