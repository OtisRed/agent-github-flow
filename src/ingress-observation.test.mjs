import test from 'node:test';
import assert from 'node:assert/strict';
import {observeIngressDelivery} from './ingress-observation.mjs';

const base = () => ({kind:'delivery', deliveryId:'ca0f9c2d-0be8-4965-b9c1-975664ab9d43',
  installationId:'9007199254740993', repositoryId:'9007199254740995', event:'issue_comment',
  action:'created', issueNumber:'7', commentId:'9007199254740997'});
const route = (installationId, repositoryId, repository) => ({installationId, repositoryId,
  registration:{repository, source:'a'.repeat(32)}, registrationCommitment:{keyId:1,mac:'fixture'}});
const routes = () => [route('9007199254740993','9007199254740995','owner/one'),
  route('22','33','owner/two')];
const graphql = async () => ({});
const keyring = {};

test('routes two projects with large IDs as strings through the selected policy', async () => {
  let calls=[];
  const resolvePolicy = async input => {calls.push(input); return {kind:'project-policy-resolved'};};
  const first = await observeIngressDelivery({delivery:base(),routes:routes(),resolvePolicy,graphql,keyring});
  const other = {...base(),installationId:'22',repositoryId:'33',issueNumber:'9'};
  const second = await observeIngressDelivery({delivery:other,routes:routes(),resolvePolicy,graphql,keyring});
  assert.deepEqual(first,{kind:'observed'}); assert.deepEqual(second,{kind:'observed'});
  assert.equal(calls[0].candidate.repository,'owner/one'); assert.equal(calls[1].candidate.repository,'owner/two');
  assert.equal(calls[0].candidate.issueNumber,7); assert.equal(calls[0].keyring,keyring);
});

test('blocks unknown or ambiguous routes and unsafe issue numbers before calling resolver', async () => {
  let calls=0; const resolvePolicy=async()=>{calls++;return {kind:'project-policy-resolved'};};
  const input={delivery:base(),routes:routes(),resolvePolicy,graphql,keyring};
  assert.equal((await observeIngressDelivery(null)).reason,'invalid-input');
  assert.equal((await observeIngressDelivery({...input,delivery:{...base(),repositoryId:'34'}})).reason,'route-mismatch');
  assert.equal((await observeIngressDelivery({...input,routes:[...routes(),routes()[0]]})).reason,'route-mismatch');
  assert.equal((await observeIngressDelivery({...input,delivery:{...base(),issueNumber:'2147483648'}})).reason,'issue-number-out-of-range');
  assert.equal((await observeIngressDelivery({...input,delivery:{...base(),repositoryId:9007199254740995}})).reason,'invalid-input');
  assert.equal(calls,0);
});

test('never labels lifecycle events or a failed identity read observed', async () => {
  const resolvePolicy=async()=>({kind:'blocked',reason:'issue-identity-unavailable'});
  const input={delivery:base(),routes:routes(),resolvePolicy,graphql,keyring};
  for (const action of ['closed','reopened','deleted','transferred']) {
    assert.equal((await observeIngressDelivery({...input,delivery:{...base(),event:'issues',action,commentId:null}})).reason,'unsupported-event');
  }
  assert.equal((await observeIngressDelivery({...input,delivery:{...base(),event:{toString:null}}})).reason,'unsupported-event');
  assert.equal((await observeIngressDelivery(input)).reason,'policy-unavailable');
  assert.equal((await observeIngressDelivery({...input,resolvePolicy:async()=>{throw new Error('private');}})).reason,'policy-unavailable');
});
