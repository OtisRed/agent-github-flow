import test from 'node:test';
import assert from 'node:assert/strict';
import { observeCheckpointPublication } from './flow-checkpoint-publication-observer.mjs';
import { CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';

const oldOid = 'a'.repeat(40), newOid = 'b'.repeat(40), treeOid = 'c'.repeat(40);
function fixture() {
  let heads = [oldOid, oldOid];
  const calls = [];
  const data = {
    repositoryId: 'repository-node', oldOid, newOid, expectedTreeOid: treeOid,
    readRepository: async () => ({ node_id: 'repository-node' }),
    readRef: async name => { calls.push(name); const i = name === CHECKPOINT_BRANCH_REF ? 0 : 1;
      return { ref: name, object: { type: 'commit', sha: heads[i] } }; },
    readCommit: async () => ({ sha: newOid, tree: { sha: treeOid }, parents: [{ sha: oldOid }] }),
  };
  return { data, calls, setHeads: values => { heads = values; } };
}

test('old pair remains uncertain and never permits a retry', async () => {
  const { data, calls } = fixture();
  data.readCommit = async () => { throw Error('must not read a new commit'); };
  assert.deepEqual(await observeCheckpointPublication(data), { kind: 'publication-not-observed', retryAllowed: false });
  assert.equal(calls.length, 4);
});

test('new pair and exact commit observed twice confirm only the publication', async () => {
  const f = fixture(); f.setHeads([newOid, newOid]);
  assert.deepEqual(await observeCheckpointPublication(f.data), { kind: 'publication-observed', retryAllowed: false });
  assert.equal(f.calls.length, 4);
});

test('mixed, missing and foreign ref states fail closed', async () => {
  for (const heads of [[oldOid, newOid], [newOid, null], ['d'.repeat(40), 'd'.repeat(40)]]) {
    const f = fixture(); f.setHeads(heads);
    assert.deepEqual(await observeCheckpointPublication(f.data), { kind: 'blocked', reason: 'unexpected-ref-pair' });
  }
});

test('wrong tree, parent or commit cannot count as a published plan', async () => {
  for (const commit of [
    { sha: newOid, tree: { sha: 'd'.repeat(40) }, parents: [{ sha: oldOid }] },
    { sha: newOid, tree: { sha: treeOid }, parents: [{ sha: oldOid }, { sha: oldOid }] },
    { sha: 'd'.repeat(40), tree: { sha: treeOid }, parents: [{ sha: oldOid }] },
  ]) {
    const f = fixture(); f.setHeads([newOid, newOid]); f.data.readCommit = async () => commit;
    assert.deepEqual(await observeCheckpointPublication(f.data), { kind: 'blocked', reason: 'unexpected-commit' });
  }
});

test('changed pair, changed repository and read failures block without leaking errors', async () => {
  let f = fixture(); let count = 0;
  const original = f.data.readRef;
  f.data.readRef = async name => { if (++count === 3) f.setHeads([newOid, newOid]); return original(name); };
  assert.deepEqual(await observeCheckpointPublication(f.data), { kind: 'blocked', reason: 'observation-changed' });
  f = fixture(); let repositories = 0;
  f.data.readRepository = async () => ({ node_id: ++repositories === 1 ? 'repository-node' : 'other' });
  assert.deepEqual(await observeCheckpointPublication(f.data), { kind: 'blocked', reason: 'observation-changed' });
  f = fixture(); f.data.readRef = async () => { throw Error('private error'); };
  assert.deepEqual(await observeCheckpointPublication(f.data), { kind: 'blocked', reason: 'publication-read-failed' });
});

test('rejects invalid identities and object IDs before any read', async () => {
  const f = fixture(); f.data.oldOid = f.data.newOid;
  assert.deepEqual(await observeCheckpointPublication(f.data), { kind: 'blocked', reason: 'invalid-input' });
  assert.equal(f.calls.length, 0);
});

test('initial foreign repository and unavailable new commit block without exposing responses', async () => {
  let f = fixture(); f.data.readRepository = async () => ({ node_id: 'foreign' });
  assert.deepEqual(await observeCheckpointPublication(f.data), { kind: 'blocked', reason: 'repository-mismatch' });
  assert.equal(f.calls.length, 0);
  f = fixture(); f.setHeads([newOid, newOid]); f.data.readCommit = async () => { throw Error('private commit error'); };
  assert.deepEqual(await observeCheckpointPublication(f.data), { kind: 'blocked', reason: 'publication-read-failed' });
});
