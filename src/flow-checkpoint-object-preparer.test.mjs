import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCheckpointObjectPreparer } from './flow-checkpoint-object-preparer.mjs';
import { createV2PreparationAdapter } from './flow-v2-preparation-adapter.mjs';
import { planCheckpointCommit, planCheckpointV2Commit } from './flow-checkpoint-commit-plan.mjs';
import { encodeCheckpointV2 } from './flow-checkpoint-v2.mjs';
import { CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';

const hash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const oid = char => char.repeat(40);
const reply = (value, status = 200) => ({ status, text: async () => JSON.stringify(value) });
function fixture(version = 1, existing = false) {
  const epoch = { kind: 'initial', anchor: 'issue' };
  const after = { version: 1, repositoryId: 'repo-id', number: 1, issueId: 'issue', cutoverAt: '2026-01-01T10:00:00Z',
    epoch, reentry: null, current: { phase: 'pending', commentId: '4', digest: 'a'.repeat(64), fromStatus: 'needs-design',
      targetStatus: 'agent-ready', createdAt: '2026-01-01T10:01:00Z', epoch }, previous: null };
  const snapshot = { kind: 'checkpoint-snapshot-observed', headOid: oid('b'), repositoryId: 'repo-id',
    repositoryFullName: 'owner/project', cutoverAt: after.cutoverAt, selection: { number: 1, issueId: 'issue' },
    index: { version: 1, repositoryId: 'repo-id', issues: [] }, selectedRecord: null };
  const registration = { repositoryId: 'repo-id', ref: CHECKPOINT_BRANCH_REF, genesisOid: oid('a'), cutoverAt: after.cutoverAt, checkpointSchemaVersion: 2 };
  if (version === 2) { snapshot.schemaVersion = 2; after.version = 2; after.reservation = null; }
  if (existing) {
    snapshot.selectedRecord = structuredClone(after); snapshot.index.issues = [{ number: 1, issueId: 'issue' }];
    after.reservation = { reservedAt: '2026-01-01T10:02:00Z', fromOptionId: 'source', targetOptionId: 'target' };
  }
  const plan = version === 2 ? planCheckpointV2Commit({ registration, snapshot, after }) : planCheckpointCommit({ snapshot, after });
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
  const state = { oldTree, newTree, scopePrivate: true, failCommit: false, refsHead: snapshot.headOid, calls: [] };
  const request = async (url, options) => {
    state.calls.push({ url, method: options.method, body: options.body });
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, 'Bearer synthetic-app-token');
    if (url.endsWith('/installation/repositories')) return reply({ total_count: 1, repositories: [
      { node_id: 'repo-id', full_name: 'owner/project', private: state.scopePrivate }] });
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
  const build = () => createCheckpointObjectPreparer({ owner: 'owner', repo: 'project', snapshot, after, ...(version === 2 ? { registration } : {}),
    appToken: 'synthetic-app-token', request });
  return { build, state, snapshot, after, plan, request, registration };
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
