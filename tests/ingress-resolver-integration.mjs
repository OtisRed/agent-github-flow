// Synthetic integration with the actual, separately checked-out controller #5.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {observeIngressDelivery} from '../src/ingress-observation.mjs';

const root = process.env.AGF_CONTROLLER_ROOT;
if (!root) throw new Error('AGF_CONTROLLER_ROOT is required');
const load = file => import(pathToFileURL(join(root, 'src', file)).href);
const {resolveV3ProjectPolicy} = await load('flow-project-policy-resolver.mjs');
const {CHECKPOINT_BRANCH_REF} = await load('flow-checkpoint-registration.mjs');
const {createCheckpointKeyring} = await load('flow-checkpoint-keyring.mjs');
const {FLOW_STATUSES} = await load('flow.mjs');
const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
const deliveries = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const keyring=createCheckpointKeyring({currentKeyId:1,keys:[{id:1,key:Buffer.alloc(32,1)}]});
const registration=(repo,repoId) => ({version:3,source:'a'.repeat(32),repository:repo,repositoryId:repoId,
  projectOwner:'owner',projectNumber:4,projectId:'project-id',statusFieldId:'field-id',statusFieldName:'Status',appId:12,
  updateRulesetId:1,historyRulesetId:2,trustedAuthorIds:['user'],expectedPrivate:true,dataPolicy:'common-v3',
  statusOptions:FLOW_STATUSES.map((name,index)=>({name,id:`option-${index}`})),
  checkpoint:{repositoryId:repoId,ref:CHECKPOINT_BRANCH_REF,genesisOid:'b'.repeat(40),
    cutoverAt:'2026-01-01T10:00:00Z',checkpointSchemaVersion:3}});
const registrations=[registration('owner/one','repo-node-one'),registration('owner/two','repo-node-two')];
const routes=registrations.map((r,i)=>({installationId:i?'102':'101',repositoryId:i?'202':'201',
  registration:r,registrationCommitment:{keyId:1,mac:keyring.current().config(r)}}));
let calls=0;
const graphql=async(_query,vars)=>{calls++; const i=vars.repo==='one'?0:1;
  return {data:{repository:{id:registrations[i].repositoryId,nameWithOwner:registrations[i].repository,
    issue:{id:`issue-node-${i}`,number:vars.number}}}};};
for(const delivery of deliveries) assert.deepEqual(await observeIngressDelivery({delivery,routes,
  resolvePolicy:resolveV3ProjectPolicy,graphql,keyring}),{kind:'observed'});
assert.equal(calls,4);
const wrong=structuredClone(routes); wrong[0].registration.statusOptions[0].id='tampered';
assert.deepEqual(await observeIngressDelivery({delivery:deliveries[0],routes:wrong,
  resolvePolicy:resolveV3ProjectPolicy,graphql,keyring}),{kind:'blocked',reason:'policy-unavailable'});
assert.equal(calls,4);
process.stdout.write('synthetic queue-to-real-resolver passed\n');
