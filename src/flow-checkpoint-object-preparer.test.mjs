import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCheckpointObjectPreparer, createV3CheckpointObjectPreparer } from './flow-checkpoint-object-preparer.mjs';
import { createV2PreparationAdapter } from './flow-v2-preparation-adapter.mjs';
import { createV3PreparationAdapter } from './flow-v3-preparation-adapter.mjs';
import { planCheckpointCommit, planCheckpointV2Commit, planCheckpointV3Commit } from './flow-checkpoint-commit-plan.mjs';
import { encodeCheckpointV2 } from './flow-checkpoint-v2.mjs';
import { createCheckpointKeyring } from './flow-checkpoint-keyring.mjs';
import { FLOW_STATUSES } from './flow.mjs';
import { createV3CheckpointRefTransport } from './flow-checkpoint-ref-transport.mjs';
import { CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';

const hash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const oid = char => char.repeat(40);
const reply = (value, status = 200) => ({ status, text: async () => JSON.stringify(value) });
function fixture(version = 1, existing = false, expectedV3Private = false) {
  const epoch = { kind: 'initial', anchor: 'issue' };
  const after = { version: 1, repositoryId: 'repo-id', number: 1, issueId: 'issue', cutoverAt: '2026-01-01T10:00:00Z',
    epoch, reentry: null, current: { phase: 'pending', commentId: '4', digest: 'a'.repeat(64), fromStatus: 'needs-design',
      targetStatus: 'agent-ready', createdAt: '2026-01-01T10:01:00Z', epoch }, previous: null };
  const snapshot = { kind: 'checkpoint-snapshot-observed', headOid: oid('b'), repositoryId: 'repo-id',
    repositoryFullName: 'owner/project', cutoverAt: after.cutoverAt, selection: { number: 1, issueId: 'issue' },
    index: { version: 1, repositoryId: 'repo-id', issues: [] }, selectedRecord: null };
  const registration = { repositoryId: 'repo-id', ref: CHECKPOINT_BRANCH_REF, genesisOid: oid('a'), cutoverAt: after.cutoverAt, checkpointSchemaVersion: 2 };
  if (version === 2) { snapshot.schemaVersion = 2; after.version = 2; after.reservation = null; }
  let v3;
  if(version===3){
    snapshot.schemaVersion=3;after.version=3;after.reservation=null;registration.checkpointSchemaVersion=3;
    const body='[FLOW]\nRola: Designer\nStan docelowy: agent-ready\nWykonano: Praca\nNastępny krok: Kod';
    const statusOptions=FLOW_STATUSES.map((name,index)=>({name,id:name==='needs-design'?'design':name==='agent-ready'?'ready':`private-option-${index}`}));
    const keyring=createCheckpointKeyring({currentKeyId:1,keys:[{id:1,key:Buffer.alloc(32,1)}]});
    const projectRegistration={version:3,source:'a'.repeat(32),repository:'owner/project',repositoryId:'repo-id',expectedPrivate:expectedV3Private,
      dataPolicy:'common-v3',projectOwner:'board-owner',projectNumber:1,projectId:'project',statusFieldId:'status',statusFieldName:'Status',
      statusOptions:structuredClone(statusOptions),appId:12,updateRulesetId:1,historyRulesetId:2,trustedAuthorIds:['user'],checkpoint:structuredClone(registration)};
    delete after.current.digest;after.current.commentKeyId=1;
    after.current.commentMac=keyring.current().comment({repositoryId:'repo-id',issueId:'issue',commentId:'4',body});
    after.current.configKeyId=1;after.current.configMac=keyring.current().config(projectRegistration);
    const handoff={kind:'handoff',id:'4',nodeId:'comment',authorId:'user',createdAt:after.current.createdAt,body};
    v3={keyring,projectRegistration,repository:{node_id:'repo-id',full_name:'owner/project',private:expectedV3Private,fork:false},
      project:{kind:'branch-project-observed',issueNodeId:'issue',repository:'owner/project',issueState:'OPEN',currentStatus:'needs-design',
        projectId:'project',itemId:'item',statusFieldId:'status',statusFieldName:'Status',statusOptionId:'design',statusOptions},
      handoffEvidence:{kind:'evidence',handoff},trustedAuthorIds:['user'],expectedProjectId:'project',
      epochProof:{kind:'handoff-epoch-evidence',issueNodeId:'issue',commentNodeId:'comment',commentId:'4',commentCreatedAt:handoff.createdAt,
        commentDigest:createHash('sha256').update(body).digest('hex'),epoch}};
  }
  if (existing) {
    snapshot.selectedRecord = structuredClone(after); snapshot.index.issues = [{ number: 1, issueId: 'issue' }];
    after.reservation = { reservedAt: '2026-01-01T10:02:00Z', fromOptionId: 'source', targetOptionId: 'target' };
  }
  const plan = version === 3 ? planCheckpointV3Commit({registration,snapshot,after})
    : version === 2 ? planCheckpointV2Commit({ registration, snapshot, after }) : planCheckpointCommit({ snapshot, after });
  const oldBytes = Buffer.from(JSON.stringify(snapshot.index)); const oldIndex = hash(oldBytes);
  const additionHash = index => hash(Buffer.from(plan.additions[index].contents, 'base64'));
  const oldTree = { sha: oid('c'), truncated: false, tree: [{ path: 'index.json', mode: '100644', type: 'blob', sha: oldIndex, size: oldBytes.length },
    { path: 'keep', mode: '100644', type: 'blob', sha: oid('f'), size: 5 }] };
  const recordBytes = existing ? Buffer.from(encodeCheckpointV2(snapshot.selectedRecord).content) : null;
  const recordOid = recordBytes ? hash(recordBytes) : null;
  if (existing) oldTree.tree.push({ path: 'issues', mode: '040000', type: 'tree', sha: oid('e') },
    { path: 'issues/1.json', mode: '100644', type: 'blob', sha: recordOid, size: recordBytes.length });
  const newTree = { sha: oid('d'), truncated: false, tree: [
    { path: 'index.json', mode: '100644', type: 'blob', sha: additionHash(0) },
    { path: 'issues', mode: '040000', type: 'tree', sha: oid('e') },
    { path: 'issues/1.json', mode: '100644', type: 'blob', sha: additionHash(1) },
    { path: 'keep', mode: '100644', type: 'blob', sha: oid('f') }] };
  const state = { oldTree, newTree, scopePrivate:version!==3||expectedV3Private,scopeFork:false, failCommit: false, refsHead: snapshot.headOid, calls: [] };
  const request = async (url, options) => {
    state.calls.push({ url, method: options.method, body: options.body });
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, 'Bearer synthetic-app-token');
    if (url.endsWith('/installation/repositories')) return reply({ total_count: 1, repositories: [
      { node_id: 'repo-id', full_name: 'owner/project', private: state.scopePrivate, fork:state.scopeFork }] });
    if (url.endsWith('/git/ref/heads/agent-github-flow/checkpoints')) return reply({ ref: CHECKPOINT_BRANCH_REF, object: { type: 'commit', sha: state.refsHead } });
    if (url.endsWith('/git/ref/heads/agent-github-flow/checkpoint-anchor')) return reply({ ref: CHECKPOINT_ANCHOR_REF, object: { type: 'commit', sha: state.refsHead } });
    if (url.endsWith(`/git/commits/${snapshot.headOid}`)) return reply({ sha: snapshot.headOid, tree: { sha: oldTree.sha } });
    if (url.endsWith(`/git/trees/${oldTree.sha}?recursive=1`)) return reply(state.oldTree);
    if (url.endsWith(`/git/blobs/${oldIndex}`)) return reply({ sha: oldIndex, size: oldBytes.length, encoding: 'base64', content: oldBytes.toString('base64') });
    if (existing && url.endsWith(`/git/blobs/${recordOid}`)) return reply({ sha: recordOid, size: recordBytes.length, encoding: 'base64', content: recordBytes.toString('base64') });
    if (url.endsWith(`/git/trees/${newTree.sha}?recursive=1`)) return reply(state.newTree);
    if (url.endsWith('/git/trees') && options.method === 'POST') return reply({ sha: newTree.sha }, 201);
    if (url.endsWith('/git/commits') && options.method === 'POST') {
      if (state.failCommit) throw Error('private response');
      return reply({ sha: oid('a') }, 201);
    }
    if (url.endsWith(`/git/commits/${oid('a')}`)) return reply({ sha: oid('a'), tree: { sha: newTree.sha }, parents: [{ sha: snapshot.headOid }] });
    throw Error('unexpected-url');
  };
  const build = () => version===3?createV3CheckpointObjectPreparer({owner:'owner',repo:'project',snapshot,after,registration,v3,
    appToken:'synthetic-app-token',request}):createCheckpointObjectPreparer({ owner: 'owner', repo: 'project', snapshot, after, ...(version === 2 ? { registration } : {}),
    appToken: 'synthetic-app-token', request });
  return { build, state, snapshot, after, plan, request, registration, v3 };
}

test('prepares and reads back only a private repository tree and commit, without moving refs', async () => {
  const f = fixture(); const preparer = f.build(); const result = await preparer.prepare();
  assert.equal(result.kind, 'checkpoint-objects-prepared'); assert.equal(result.expectedHeadOid, f.snapshot.headOid);
  assert.equal(result.expectedTreeOid, f.state.newTree.sha); assert.equal(result.commit.parents[0].sha, f.snapshot.headOid);
  const writes = f.state.calls.filter(call => call.method === 'POST');
  assert.equal(writes.length, 2); assert.ok(writes[0].url.endsWith('/git/trees')); assert.ok(writes[1].url.endsWith('/git/commits'));
  const tree = JSON.parse(writes[0].body); assert.equal(tree.base_tree, f.state.oldTree.sha);
  assert.deepEqual(tree.tree.map(entry => entry.path), ['index.json', 'issues/1.json']);
  assert.deepEqual(JSON.parse(writes[1].body).parents, [f.snapshot.headOid]);
  assert.deepEqual(await preparer.prepare(), { kind: 'blocked', reason: 'preparer-already-used' });
});

test('prepares a v2 record only with v2 registration and a v2 snapshot', async () => {
  const f = fixture(2); const result = await f.build().prepare();
  assert.equal(result.kind, 'checkpoint-objects-prepared');
  const entries = JSON.parse(f.state.calls.find(call => call.url.endsWith('/git/trees') && call.method === 'POST').body).tree;
  assert.equal(JSON.parse(entries.find(entry => entry.path === 'issues/1.json').content).version, 2);
  assert.throws(() => createCheckpointObjectPreparer({ owner: 'owner', repo: 'project', snapshot: f.snapshot, after: f.after,
    appToken: 'synthetic-app-token' }), /invalid-object-plan/);
});

test('prepares guarded public v3 objects using the recomputed plan without private options or comment text',async()=>{
  const f=fixture(3),result=await f.build().prepare();assert.equal(result.kind,'checkpoint-objects-prepared');
  const entries=JSON.parse(f.state.calls.find(call=>call.url.endsWith('/git/trees')&&call.method==='POST').body).tree;
  const issue=entries.find(entry=>entry.path==='issues/1.json').content;
  assert.equal(JSON.parse(issue).version,3);assert.equal(issue.includes('private-option-'),false);assert.equal(issue.includes('Wykonano:'),false);
  assert.deepEqual(JSON.parse(f.state.calls.find(call=>call.url.endsWith('/git/commits')&&call.method==='POST').body).parents,[f.snapshot.headOid]);
});

test('uses the same guarded v3 format with a private repository',async()=>{
  const f=fixture(3,false,true),result=await f.build().prepare();assert.equal(result.kind,'checkpoint-objects-prepared');
  const entries=JSON.parse(f.state.calls.find(call=>call.url.endsWith('/git/trees')&&call.method==='POST').body).tree;
  assert.equal(JSON.parse(entries.find(entry=>entry.path==='issues/1.json').content).version,3);
});

test('v3 adapter prepares only the exact protected subject and fresh observation',async()=>{
  const f=fixture(3),policy={repositoryId:'repo-id',repository:'owner/project',projectId:'project',statusFieldId:'status',
    issueId:'issue',issueNumber:1,appId:12,updateRulesetId:1,historyRulesetId:2,trustedAuthorIds:['user']};
  let changed=false;
  const collectContext=async()=>({repository:f.v3.repository,observation:{checkpoint:changed?{...f.snapshot,headOid:oid('8')}:f.snapshot,
    project:f.v3.project,handoffEvidence:f.v3.handoffEvidence,epochProof:f.v3.epochProof,
    expectedProjectId:f.v3.expectedProjectId,trustedAuthorIds:f.v3.trustedAuthorIds}});
  const registrationCommitment={keyId:1,mac:f.v3.keyring.current().config(f.v3.projectRegistration)};
  const prepare=createV3PreparationAdapter({policy,projectRegistration:f.v3.projectRegistration,registrationCommitment,keyring:f.v3.keyring,
    collectContext,appToken:'synthetic-app-token',request:f.request});
  assert.equal((await prepare({snapshot:f.snapshot,after:f.after,registration:f.registration})).kind,'checkpoint-objects-prepared');
  const calls=f.state.calls.length;changed=true;
  assert.deepEqual(await prepare({snapshot:f.snapshot,after:f.after,registration:f.registration}),{kind:'blocked',reason:'adapter-observation-mismatch'});
  assert.equal(f.state.calls.length,calls);
  const wrong={...f.registration,genesisOid:oid('8')};
  assert.deepEqual(await prepare({snapshot:f.snapshot,after:f.after,registration:wrong}),{kind:'blocked',reason:'adapter-subject-mismatch'});
  assert.equal(f.state.calls.length,calls);
  for(const modify of [r=>r.source='b'.repeat(32),r=>r.expectedPrivate=true,r=>r.statusOptions[0].id='other']){
    const registration=structuredClone(f.v3.projectRegistration);modify(registration);
    assert.throws(()=>createV3PreparationAdapter({policy,projectRegistration:registration,registrationCommitment,keyring:f.v3.keyring,
      collectContext,appToken:'synthetic-app-token',request:f.request}),/invalid-v3-adapter/);
  }
});

test('v3 refuses invalid commitments, visibility or fork before object creation',async()=>{
  let f=fixture(3);f.after.current.commentMac='f'.repeat(64);assert.throws(()=>f.build(),/invalid-v3-object-plan/);assert.equal(f.state.calls.length,0);
  f=fixture(3);f.state.scopePrivate=true;assert.equal((await f.build().prepare()).kind,'blocked');
  assert.equal(f.state.calls.filter(call=>call.method==='POST').length,0);
  f=fixture(3);f.state.scopeFork=true;assert.equal((await f.build().prepare()).kind,'blocked');
  assert.equal(f.state.calls.filter(call=>call.method==='POST').length,0);
  f=fixture(3);assert.throws(()=>createCheckpointObjectPreparer({owner:'owner',repo:'project',snapshot:f.snapshot,after:f.after,
    registration:f.registration,appToken:'synthetic-app-token',request:f.request}),/invalid-object-plan/);
});

function v3RefFixture(expectedPrivate=false){
  const f=fixture(3,false,expectedPrivate),policy={repositoryId:'repo-id',repository:'owner/project',projectId:'project',statusFieldId:'status',
    issueId:'issue',issueNumber:1,appId:12,updateRulesetId:1,historyRulesetId:2,trustedAuthorIds:['user']};
  let writes=0;
  const request=async(url,options)=>{
    if(url.endsWith('/repos/owner/project'))return reply({node_id:'repo-id',full_name:'owner/project',private:f.state.scopePrivate,
      fork:f.state.scopeFork,default_branch:'main'});
    if(url==='https://api.github.com/graphql'){writes++;return reply({data:{updateRefs:{__typename:'UpdateRefsPayload'}}});}
    return f.request(url,options);
  };
  const args={policy,projectRegistration:f.v3.projectRegistration,
    registrationCommitment:{keyId:1,mac:f.v3.keyring.current().config(f.v3.projectRegistration)},keyring:f.v3.keyring,
    snapshot:f.snapshot,after:f.after,v3:{...f.v3,checkpoint:f.snapshot},expectedTreeOid:oid('d'),commitOid:oid('a'),
    appToken:'synthetic-app-token',request};
  return {f,args,writes:()=>writes};
}
test('v3 ref transport verifies exact public and private tree changes before the atomic ref pair',async()=>{
  for(const expectedPrivate of [false,true]){
    const t=v3RefFixture(expectedPrivate),transport=createV3CheckpointRefTransport(t.args);
    assert.deepEqual(await transport.publish(),{kind:'ref-update-acknowledged',retryAllowed:false});assert.equal(t.writes(),1);
    assert.equal((await transport.publish()).kind,'blocked');assert.equal(t.writes(),1);
  }
});
test('v3 ref transport blocks unrelated tree changes, wrong visibility and forged config',async()=>{
  let t=v3RefFixture();t.f.state.newTree.tree.find(entry=>entry.path==='keep').sha=oid('9');
  assert.equal((await createV3CheckpointRefTransport(t.args).publish()).reason,'prepared-tree-mismatch');assert.equal(t.writes(),0);
  t=v3RefFixture();t.f.state.scopePrivate=true;
  assert.equal((await createV3CheckpointRefTransport(t.args).publish()).reason,'scope-mismatch');assert.equal(t.writes(),0);
  t=v3RefFixture();t.args.registrationCommitment.mac='0'.repeat(64);
  assert.throws(()=>createV3CheckpointRefTransport(t.args),/invalid-v3-ref-context/);assert.equal(t.writes(),0);
});

test('rechecks the existing v2 record before preparing its reservation', async () => {
  const f = fixture(2, true); const result = await f.build().prepare();
  assert.equal(result.kind, 'checkpoint-objects-prepared');
  const entries = JSON.parse(f.state.calls.find(call => call.url.endsWith('/git/trees') && call.method === 'POST').body).tree;
  assert.deepEqual(JSON.parse(entries.find(entry => entry.path === 'issues/1.json').content).reservation, f.after.reservation);
});

test('v2 cycle adapter uses the real preparer and binds it to the selected subject', async () => {
  const f=fixture(2,true),policy={repositoryId:'repo-id',repository:'owner/project',projectId:'project',statusFieldId:'status',
    issueId:'issue',issueNumber:1,appId:12,updateRulesetId:1,historyRulesetId:2,trustedAuthorIds:['user']};
  const prepare=createV2PreparationAdapter({policy,registration:f.registration,appToken:'synthetic-app-token',request:f.request});
  const result=await prepare({snapshot:f.snapshot,after:f.after,registration:f.registration});
  assert.equal(result.kind,'checkpoint-objects-prepared');
  const other=structuredClone(f.snapshot);other.selection.issueId='other';
  assert.deepEqual(await prepare({snapshot:other,after:f.after,registration:f.registration}),{kind:'blocked',reason:'adapter-subject-mismatch'});
  const wrongRegistration=structuredClone(f.registration);wrongRegistration.genesisOid='8'.repeat(40);
  const calls=f.state.calls.length;
  assert.deepEqual(await prepare({snapshot:f.snapshot,after:f.after,registration:wrongRegistration}),{kind:'blocked',reason:'adapter-subject-mismatch'});
  assert.equal(f.state.calls.length,calls);
});

test('rejects a public or wrongly scoped repository before any object creation', async () => {
  const f = fixture(); f.state.scopePrivate = false;
  assert.deepEqual(await f.build().prepare(), { kind: 'blocked', reason: 'scope-or-ref-mismatch' });
  assert.equal(f.state.calls.filter(call => call.method === 'POST').length, 0);
});

test('ref mismatch or inconsistent checkpoint snapshot blocks before any creation', async () => {
  let f = fixture(); f.state.refsHead = oid('a');
  assert.deepEqual(await f.build().prepare(), { kind: 'blocked', reason: 'scope-or-ref-mismatch' });
  assert.equal(f.state.calls.filter(call => call.method === 'POST').length, 0);
  f = fixture(); f.snapshot.index.issues = [{ number: 3, issueId: 'other' }];
  assert.deepEqual(await f.build().prepare(), { kind: 'blocked', reason: 'snapshot-mismatch' });
  assert.equal(f.state.calls.filter(call => call.method === 'POST').length, 0);
});

test('unrelated tree modification stops before the commit, without retry', async () => {
  const f = fixture(); f.state.newTree.tree.at(-1).sha = oid('a'); const preparer = f.build();
  assert.deepEqual(await preparer.prepare(), { kind: 'object-preparation-uncertain', retryAllowed: false });
  assert.deepEqual(await preparer.prepare(), { kind: 'blocked', reason: 'preparer-already-used' });
  assert.equal(f.state.calls.filter(call => call.method === 'POST').length, 1);
});

test('uncertain commit creation is never retried', async () => {
  const f = fixture(); f.state.failCommit = true; const preparer = f.build();
  assert.deepEqual(await preparer.prepare(), { kind: 'object-preparation-uncertain', retryAllowed: false });
  assert.deepEqual(await preparer.prepare(), { kind: 'blocked', reason: 'preparer-already-used' });
  assert.equal(f.state.calls.filter(call => call.method === 'POST').length, 2);
});
