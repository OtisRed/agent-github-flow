import test from 'node:test';
import assert from 'node:assert/strict';
import {observeStatusRecovery} from './worker-recovery-observe.mjs';

const deliveryId='ca0f9c2d-0be8-4965-b9c1-975664ab9d43';
function fixture(){
  const keyring={},policy={issueId:'issue-one'},registration={repository:'owner/one',source:'a'.repeat(32)};
  const registrationCommitment={keyId:1,mac:'synthetic'};
  const state={kind:'recovering',deliveryId,refIntent:0,statusIntent:1};
  const delivery={kind:'delivery',deliveryId,installationId:'11',repositoryId:'22',event:'issue_comment',
    action:'created',issueNumber:'7',commentId:'77'};
  const routes=[{installationId:'11',repositoryId:'22',registration,registrationCommitment}];
  const graphql=async()=>({});let writes=0;
  const cycleInput={policy,projectRegistration:registration,registrationCommitment,keyring,wait:async()=>{},
    makePublicationStep:()=>async()=>{writes++;},makeStatusStep:()=>async()=>{writes++;}};
  return {state,delivery,routes,graphql,keyring,cycleInput,
    resolvePolicy:async()=>({kind:'project-policy-resolved',policy}),writes:()=>writes};
}
test('prevents mutation callbacks and distinguishes old status from visible target', async()=>{
  const f=fixture();
  const old=async i=>{await i.wait(120000);await i.makePublicationStep()({operation:'reservation'});
    return {kind:'v3-cycle-stopped',phase:'reservation'};};
  const target=async i=>{await i.makePublicationStep()({operation:'commit'});
    return {kind:'v3-cycle-stopped',phase:'commit'};};
  assert.deepEqual(await observeStatusRecovery({...f,runCycle:old}),{kind:'retry-path-observation'});
  assert.deepEqual(await observeStatusRecovery({...f,runCycle:target}),{kind:'target-path-observation'});
  assert.equal(f.writes(),0);
});
test('blocks foreign delivery, policy, uncertain ref and unexpected callbacks', async()=>{
  const f=fixture();let cycleCalls=0;const runCycle=async()=>{cycleCalls++;return {kind:'v3-cycle-stopped'};};
  assert.deepEqual(await observeStatusRecovery(null),{kind:'blocked'});
  const broken={...f,runCycle};Object.defineProperty(broken,'state',{get(){throw Error('broken');}});
  assert.deepEqual(await observeStatusRecovery(broken),{kind:'blocked'});
  assert.deepEqual(await observeStatusRecovery({...f,state:{...f.state,refIntent:1},runCycle}),{kind:'blocked'});
  assert.deepEqual(await observeStatusRecovery({...f,state:{...f.state,deliveryId:'different'},runCycle}),{kind:'blocked'});
  assert.deepEqual(await observeStatusRecovery({...f,resolvePolicy:async()=>({kind:'project-policy-resolved',policy:{issueId:'other'}}),runCycle}),{kind:'blocked'});
  const otherRoutes=structuredClone(f.routes);otherRoutes[0].registration.source='b'.repeat(32);
  assert.deepEqual(await observeStatusRecovery({...f,routes:otherRoutes,runCycle}),{kind:'blocked'});
  assert.equal(cycleCalls,0);
  const short=async i=>{await i.wait(1);await i.makePublicationStep()({operation:'reservation'});return {kind:'v3-cycle-stopped',phase:'reservation'};};
  assert.deepEqual(await observeStatusRecovery({...f,runCycle:short}),{kind:'blocked'});
  const write=async i=>{await i.makeStatusStep()();return {kind:'v3-cycle-stopped',phase:'status'};};
  assert.deepEqual(await observeStatusRecovery({...f,runCycle:write}),{kind:'blocked'});
});
