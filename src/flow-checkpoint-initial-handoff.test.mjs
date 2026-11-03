import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planInitialBranchHandoff, planInitialV2Handoff } from './flow-checkpoint-initial-handoff.mjs';
import { planInitialV3Handoff } from './flow-v3-initial-handoff.mjs';
import { createCheckpointKeyring } from './flow-checkpoint-keyring.mjs';
import { FLOW_STATUSES } from './flow.mjs';
import { verifyV3Preparation } from './flow-v3-preparation-guard.mjs';

const body = '[FLOW]\nRola: Designer\nStan docelowy: agent-ready\nWykonano: Praca\nNastępny krok: Kod';
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
function fixture() {
  const epoch = { kind: 'initial', anchor: 'issue' };
  const handoff = { kind: 'handoff', id: '4', nodeId: 'comment', authorId: 'user', createdAt: '2026-01-01T10:01:00Z', body };
  return { checkpoint: { kind: 'checkpoint-snapshot-observed', headOid: 'b'.repeat(40), repositoryId: 'repo-id',
    repositoryFullName: 'owner/project', cutoverAt: '2026-01-01T10:00:00Z', selection: { number: 1, issueId: 'issue' },
    index: { version: 1, repositoryId: 'repo-id', issues: [] }, selectedRecord: null },
  project: { kind: 'branch-project-observed', issueNodeId: 'issue', repository: 'owner/project', issueState: 'OPEN',
    currentStatus: 'needs-design', projectId: 'project', itemId: 'item', statusFieldId: 'status', statusOptionId: 'design',
    statusOptions: [{ id: 'design', name: 'needs-design' }, { id: 'ready', name: 'agent-ready' }] },
  handoffEvidence: { kind: 'evidence', handoff }, trustedAuthorIds: ['user'], expectedProjectId: 'project',
  epochProof: { kind: 'handoff-epoch-evidence', issueNodeId: 'issue', commentNodeId: 'comment', commentId: '4',
    commentCreatedAt: handoff.createdAt, commentDigest: digest(body), epoch } };
}

test('plans only a pending record tied to the observed Project and checkpoint HEAD', () => {
  const value = fixture(); const result = planInitialBranchHandoff(value);
  assert.equal(result.kind, 'initial-handoff-planned');
  assert.equal(result.record.current.phase, 'pending'); assert.equal(result.record.current.fromStatus, 'needs-design');
  assert.equal(result.record.current.targetStatus, 'agent-ready'); assert.equal(result.record.current.digest, digest(body));
  assert.equal(result.commit.expectedHeadOid, value.checkpoint.headOid);
  assert.deepEqual(result.commit.additions.map(item => item.path), ['index.json', 'issues/1.json']);
  assert.equal(result.itemId, 'item');
  assert.equal(result.targetOptionId, 'ready');
});

test('plans the first v2 handoff without a reservation only for explicit matching v2 registration', () => {
  const v = fixture(); v.checkpoint.schemaVersion = 2;
  v.registration = { repositoryId: 'repo-id', ref: 'refs/heads/agent-github-flow/checkpoints', genesisOid: 'a'.repeat(40),
    cutoverAt: v.checkpoint.cutoverAt, checkpointSchemaVersion: 2 };
  const plan = planInitialV2Handoff(v);
  assert.equal(plan.kind, 'initial-handoff-v2-planned'); assert.equal(plan.record.version, 2); assert.equal(plan.record.reservation, null);
  assert.equal(plan.commit.expectedHeadOid, v.checkpoint.headOid); assert.equal(v.checkpoint.selectedRecord, null);
  v.registration.checkpointSchemaVersion = 1; assert.equal(planInitialV2Handoff(v).kind, 'blocked');
  v.registration.checkpointSchemaVersion = 2; v.checkpoint.schemaVersion = 1; assert.equal(planInitialV2Handoff(v).kind, 'blocked');
  v.checkpoint.schemaVersion = 2; v.checkpoint.index.issues.push({ number: 1, issueId: 'issue' });
  assert.equal(planInitialV2Handoff(v).kind, 'blocked');
});

function fixtureV3(){
  const v=fixture();v.checkpoint.schemaVersion=3;
  v.registration={repositoryId:'repo-id',ref:'refs/heads/agent-github-flow/checkpoints',genesisOid:'a'.repeat(40),
    cutoverAt:v.checkpoint.cutoverAt,checkpointSchemaVersion:3};
  v.project.statusFieldName='Status';v.project.statusOptions=FLOW_STATUSES.map((name,index)=>({name,
    id:name==='needs-design'?'design':name==='agent-ready'?'ready':`private-option-${index}`}));
  v.repository={node_id:'repo-id',full_name:'owner/project',private:false,fork:false};
  v.projectRegistration={version:3,source:'a'.repeat(32),repository:'owner/project',repositoryId:'repo-id',expectedPrivate:false,
    dataPolicy:'common-v3',projectOwner:'board-owner',projectNumber:1,projectId:'project',statusFieldId:'status',statusFieldName:'Status',
    statusOptions:structuredClone(v.project.statusOptions),appId:12,updateRulesetId:1,historyRulesetId:2,trustedAuthorIds:['user'],checkpoint:structuredClone(v.registration)};
  v.keyring=createCheckpointKeyring({currentKeyId:1,keys:[{id:1,key:Buffer.alloc(32,1)}]});return v;
}

test('plans a first keyed v3 checkpoint without exposing private option IDs or comment body in its files',()=>{
  const v=fixtureV3(),result=planInitialV3Handoff(v);
  assert.equal(result.kind,'initial-handoff-v3-planned');assert.equal(result.record.version,3);assert.equal(result.record.reservation,null);
  assert.equal(result.record.current.commentKeyId,1);assert.equal(result.record.current.configKeyId,1);
  assert.equal(result.commit.expectedHeadOid,v.checkpoint.headOid);
  const published=result.commit.additions.map(entry=>Buffer.from(entry.contents,'base64').toString('utf8')).join('\n');
  assert.equal(published.includes('private-option-'),false);assert.equal(published.includes(body),false);
  assert.equal(published.includes('"design"'),false);assert.equal(published.includes('"ready"'),false);
  const serialized=JSON.stringify(result);for(const name of ['projectId','itemId','statusFieldId','fromOptionId','targetOptionId'])
    assert.equal(serialized.includes(`"${name}":`),false);
  assert.equal(serialized.includes(body),false);assert.equal(serialized.includes('private-option-'),false);
  assert.equal(Object.hasOwn(result.record.current,'digest'),false);
  const checked=verifyV3Preparation({...v,after:result.record});assert.equal(checked.kind,'v3-preparation-consistent');
  assert.deepEqual(checked.commit,result.commit);assert.equal(Object.isFrozen(checked.commit.additions),true);
  const newer=structuredClone(v.checkpoint);newer.headOid='d'.repeat(40);
  const checkedNew=verifyV3Preparation({...v,checkpoint:newer,after:result.record});
  assert.equal(checkedNew.commit.expectedHeadOid,newer.headOid);assert.notDeepEqual(checkedNew.commit,result.commit);
  const forged=structuredClone(result.record);forged.current.fromStatus='spike';
  assert.equal(verifyV3Preparation({...v,after:forged}).kind,'blocked');
});

test('v3 first handoff refuses changed private configuration, visibility, comments and keys',()=>{
  let v=fixtureV3();v.project.statusOptions[0].id='changed';assert.equal(planInitialV3Handoff(v).kind,'blocked');
  v=fixtureV3();v.repository.private=true;assert.equal(planInitialV3Handoff(v).kind,'blocked');
  v=fixtureV3();v.trustedAuthorIds=['different'];assert.equal(planInitialV3Handoff(v).kind,'blocked');
  v=fixtureV3();v.handoffEvidence.handoff.body+='edited';assert.equal(planInitialV3Handoff(v).kind,'blocked');
  v=fixtureV3();v.registration.cutoverAt='2025-01-01T00:00:00Z';assert.equal(planInitialV3Handoff(v).kind,'blocked');
  v=fixtureV3();v.keyring={current:()=>null,forId:()=>null};assert.equal(planInitialV3Handoff(v).kind,'blocked');
  v=fixtureV3();const other=createCheckpointKeyring({currentKeyId:1,keys:[{id:1,key:Buffer.alloc(32,2)}]});
  v.keyring={current:v.keyring.current,forId:other.forId};assert.equal(planInitialV3Handoff(v).reason,'v3-commitments-unverified');
});

test('rejects foreign card or repository, an existing record, closed issues and done', () => {
  let v = fixture(); v.project.issueNodeId = 'other'; assert.equal(planInitialBranchHandoff(v).reason, 'snapshot-mismatch');
  v = fixture(); v.project.repository = 'owner/other'; assert.equal(planInitialBranchHandoff(v).reason, 'snapshot-mismatch');
  v = fixture(); v.checkpoint.selectedRecord = {}; assert.equal(planInitialBranchHandoff(v).reason, 'snapshot-mismatch');
  v = fixture(); v.project.issueState = 'CLOSED'; assert.equal(planInitialBranchHandoff(v).reason, 'inactive-issue-or-status');
  v = fixture(); v.project.currentStatus = 'done'; assert.equal(planInitialBranchHandoff(v).reason, 'inactive-issue-or-status');
  v = fixture(); v.handoffEvidence.handoff.body = body.replace('agent-ready', 'done'); assert.equal(planInitialBranchHandoff(v).reason, 'invalid-handoff');
});

test('rejects altered comments, foreign epochs and handoff at cutover', () => {
  let v = fixture(); v.handoffEvidence.handoff.body += '!'; assert.equal(planInitialBranchHandoff(v).reason, 'unverified-epoch');
  v = fixture(); v.epochProof.epoch = { kind: 'reopened', anchor: 'event' }; assert.equal(planInitialBranchHandoff(v).reason, 'unverified-epoch');
  v = fixture(); v.handoffEvidence.handoff.createdAt = v.checkpoint.cutoverAt; v.epochProof.commentCreatedAt = v.handoffEvidence.handoff.createdAt;
  assert.equal(planInitialBranchHandoff(v).reason, 'handoff-before-cutover');
  v = fixture(); v.epochProof.commentNodeId = 'other'; assert.equal(planInitialBranchHandoff(v).reason, 'unverified-epoch');
});

test('rejects malformed flow and a contradictory index rather than inventing a bootstrap', () => {
  let v = fixture(); v.handoffEvidence.handoff.body = 'text'; assert.equal(planInitialBranchHandoff(v).reason, 'invalid-handoff');
  v = fixture(); v.checkpoint.index.issues.push({ number: 1, issueId: 'issue' });
  assert.equal(planInitialBranchHandoff(v).reason, 'index-record-mismatch');
});

test('requires an allowed author and the registered target Project', () => {
  let v = fixture(); v.handoffEvidence.handoff.authorId = 'other'; assert.equal(planInitialBranchHandoff(v).reason, 'invalid-handoff');
  v = fixture(); v.expectedProjectId = 'other'; assert.equal(planInitialBranchHandoff(v).reason, 'snapshot-mismatch');
  v = fixture(); delete v.handoffEvidence; assert.equal(planInitialBranchHandoff(v).reason, 'invalid-evidence');
});

test('does not plan an unrepresentable or ambiguous Project status', () => {
  let v = fixture(); v.project.statusOptions.pop(); assert.equal(planInitialBranchHandoff(v).reason, 'status-option-mismatch');
  v = fixture(); v.project.statusOptionId = 'other'; assert.equal(planInitialBranchHandoff(v).reason, 'status-option-mismatch');
  v = fixture(); v.project.statusOptions.push({ id: 'another', name: 'agent-ready' });
  assert.equal(planInitialBranchHandoff(v).reason, 'invalid-status-options');
});
