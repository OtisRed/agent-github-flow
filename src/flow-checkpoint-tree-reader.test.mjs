import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readCheckpointTreePlan } from './flow-checkpoint-tree-reader.mjs';

const fixture = () => {
  const bytes = Buffer.from('{"version":1,"repositoryId":"repo","issues":[{"number":1,"issueId":"one"}]}');
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const index = { sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
  const commitOid = 'a'.repeat(40); const treeOid = 'b'.repeat(40); const calls = [];
  return { calls, args: { commitOid, repositoryId: 'repo',
    readCommit: async value => { calls.push(['commit', value]); return { sha: commitOid, tree: { sha: treeOid } }; },
    readTree: async (value, options) => { calls.push(['tree', value, options]); return { sha: treeOid, truncated: false, tree: [
      { path: 'index.json', mode: '100644', type: 'blob', sha, size: bytes.length },
      { path: 'issues', mode: '040000', type: 'tree', sha: 'c'.repeat(40) },
      { path: 'issues/1.json', mode: '100644', type: 'blob', sha: 'd'.repeat(40), size: 2 },
    ] }; },
    readBlob: async value => { calls.push(['blob', value]); return index; },
  } };
};

test('requests the exact commit, recursive tree and listed index blob', async () => {
  const value = fixture(); const result = await readCheckpointTreePlan(value.args);
  assert.equal(result.kind, 'record-reads-planned');
  assert.equal(result.commitOid, 'a'.repeat(40)); assert.equal(result.treeOid, 'b'.repeat(40));
  assert.deepEqual(result.records, [{ path: 'issues/1.json', oid: 'd'.repeat(40), size: 2 }]);
  assert.deepEqual(value.calls.map(call => call[0]), ['commit', 'tree', 'blob']);
  assert.deepEqual(value.calls[1][2], { recursive: true });
});

test('fails closed on transport errors and mismatched commit or tree', async () => {
  let value = fixture(); value.args.readCommit = async () => { throw Error('network'); };
  assert.equal((await readCheckpointTreePlan(value.args)).reason, 'commit-read-failed');
  value = fixture(); value.args.readCommit = async () => ({ sha: '0'.repeat(40), tree: { sha: 'b'.repeat(40) } });
  assert.equal((await readCheckpointTreePlan(value.args)).reason, 'invalid-commit');
  value = fixture(); value.args.readTree = async () => { throw Error('network'); };
  assert.equal((await readCheckpointTreePlan(value.args)).reason, 'tree-read-failed');
  value = fixture(); value.args.readTree = async () => ({ sha: 'b'.repeat(40), truncated: true, tree: [] });
  assert.equal((await readCheckpointTreePlan(value.args)).reason, 'incomplete-or-invalid-tree');
  assert.deepEqual(value.calls.map(call => call[0]), ['commit']);
  value = fixture(); value.args.readBlob = async () => { throw Error('network'); };
  assert.equal((await readCheckpointTreePlan(value.args)).reason, 'index-read-failed');
});

test('blocks incomplete index or record evidence returned by an otherwise successful transport', async () => {
  let value = fixture(); value.args.readBlob = async () => ({ sha: '0'.repeat(40), size: 1 });
  assert.equal((await readCheckpointTreePlan(value.args)).kind, 'blocked');
  value = fixture(); const original = value.args.readTree;
  value.args.readTree = async (...args) => { const tree = await original(...args); tree.tree.pop(); return tree; };
  assert.equal((await readCheckpointTreePlan(value.args)).reason, 'inventory-count-mismatch');
});

test('preserves the captured commit and tree when the transport mutates earlier responses', async () => {
  const value = fixture(); const originalTree = value.args.readTree; const originalBlob = value.args.readBlob;
  let observedTree;
  value.args.readTree = async (...args) => { observedTree = await originalTree(...args); return observedTree; };
  value.args.readBlob = async (...args) => { observedTree.tree.pop(); value.args.commitOid = '0'.repeat(40); return originalBlob(...args); };
  const result = await readCheckpointTreePlan(value.args);
  assert.equal(result.kind, 'record-reads-planned');
  assert.equal(result.commitOid, 'a'.repeat(40));
  assert.equal(result.records.length, 1);
});
