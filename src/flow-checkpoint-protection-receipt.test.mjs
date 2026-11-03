import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerProtectionReceipt, compareVisibleProtection } from './flow-checkpoint-protection-receipt.mjs';
import { CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';

function fixture() {
  const refs = [CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF];
  const common = { target:'branch', source_type:'Repository', source:'owner/repo', enforcement:'active',
    conditions:{ref_name:{include:refs,exclude:[]}}, updated_at:'2026-11-03T10:00:00Z' };
  const rule = (type,id) => ({type,ruleset_id:id,ruleset_source_type:'Repository',ruleset_source:'owner/repo'});
  return { repositoryId:'repo-id', repository:'owner/repo', appId:12, expectedPrivate:true,
    repositoryData:{node_id:'repo-id',full_name:'owner/repo',private:true,fork:false,default_branch:'main'},
    updateRuleset:{...common,id:1,rules:[{type:'update'}],bypass_actors:[{actor_type:'Integration',actor_id:12,bypass_mode:'always'}]},
    historyRuleset:{...structuredClone(common),id:2,rules:[{type:'deletion'},{type:'non_fast_forward'}],bypass_actors:[]},
    effective:refs.map(ref => ({ref,rules:[rule('update',1),rule('deletion',2),rule('non_fast_forward',2)]})) };
}
const observedAt='2026-11-03T10:01:00.000Z', expiresAt='2026-11-04T10:01:00.000Z', now='2026-11-03T11:00:00.000Z';
const registration={repositoryId:'repo-id',appId:12,updateRulesetId:1,historyRulesetId:2}, maxAgeMs=24*60*60*1000;
function observations(input) {
  const a=structuredClone(input), b=structuredClone(input);
  delete a.updateRuleset.bypass_actors; delete a.historyRuleset.bypass_actors;
  delete b.updateRuleset.bypass_actors; delete b.historyRuleset.bypass_actors;
  return [a,b];
}
test('matches two App observations to an independently audited owner receipt without claiming bypass proof', () => {
  const input=fixture(); const receipt=createOwnerProtectionReceipt({auditInput:input,observedAt,expiresAt});
  assert.equal(receipt.kind,'owner-protection-receipt');
  assert.equal(compareVisibleProtection({receipt,registration,observations:observations(input),now,maxAgeMs}).kind,'visible-profile-matches-owner-audit');
  input.updateRuleset.rules.push({type:'deletion'});
  assert.equal(receipt.profile.updateRuleset.rules.length,1);
  assert.equal('bypass_actors' in receipt.profile.updateRuleset,false);
});
test('cannot issue receipt without owner bypass evidence or valid timestamps', () => {
  let input=fixture(); delete input.updateRuleset.bypass_actors;
  assert.equal(createOwnerProtectionReceipt({auditInput:input,observedAt,expiresAt}).reason,'owner-audit-unavailable');
  input=fixture(); delete input.historyRuleset.updated_at;
  assert.equal(createOwnerProtectionReceipt({auditInput:input,observedAt,expiresAt}).reason,'ruleset-timestamps-unavailable');
  assert.equal(createOwnerProtectionReceipt({auditInput:fixture(),observedAt,expiresAt:observedAt}).reason,'invalid-receipt-period');
});
test('blocks visible drift, inconsistent reads, wrong registration and expired receipt', () => {
  const input=fixture(); const receipt=createOwnerProtectionReceipt({auditInput:input,observedAt,expiresAt});
  let pair=observations(input); pair[1].updateRuleset.updated_at='2026-11-03T10:30:00Z';
  assert.equal(compareVisibleProtection({receipt,registration,observations:pair,now,maxAgeMs}).reason,'app-observation-changed');
  pair=observations(input); for (const observation of pair) observation.historyRuleset.updated_at='2026-11-03T10:30:00Z';
  assert.equal(compareVisibleProtection({receipt,registration,observations:pair,now,maxAgeMs}).reason,'visible-protection-drift');
  assert.equal(compareVisibleProtection({receipt,registration:{...registration,appId:13},observations:observations(input),now,maxAgeMs}).reason,'registration-mismatch');
  assert.equal(compareVisibleProtection({receipt,registration,observations:observations(input),now:expiresAt,maxAgeMs}).reason,'receipt-expired-or-invalid');
  assert.equal(compareVisibleProtection({receipt,registration,observations:observations(input),now}).reason,'receipt-expired-or-invalid');
  assert.equal(compareVisibleProtection({receipt,registration,observations:observations(input),now,maxAgeMs:1000}).reason,'receipt-expired-or-invalid');
});
