import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readCheckpointInventory } from './flow-checkpoint-inventory-reader.mjs';
import { encodeCheckpointRecord } from './flow-checkpoint-record.mjs';

const blob = content => {
  const bytes = Buffer.from(content); const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  return { sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
};
const recordContent = issueId => encodeCheckpointRecord({ version: 1, repositoryId: 'repo', number: 1, issueId,
  cutoverAt: '2026-01-01T10:00:00Z', epoch: { kind: 'initial', anchor: issueId }, reentry: null,
  current: { phase: 'committed', commentId: '1', digest: 'a'.repeat(64), fromStatus: 'needs-design', targetStatus: 'agent-ready',
    createdAt: '2026-01-01T10:01:00Z', epoch: { kind: 'initial', anchor: issueId } }, previous: null }).content;
const fixture = () => {
  const commitOid = 'a'.repeat(40); const treeOid = 'b'.repeat(40); const calls = [];
  const index = blob('{"version":1,"repositoryId":"repo","issues":[{"number":1,"issueId":"one"}]}');
  const record = blob(recordContent('one'));
  const blobs = new Map([[index.sha, index], [record.sha, record]]);
  return { calls, blobs, record, args: { commitOid, repositoryId: 'repo',
    readCommit: async () => ({ sha: commitOid, tree: { sha: treeOid } }),
    readTree: async () => ({ sha: treeOid, truncated: false, tree: [
      { path: 'index.json', type: 'blob', mode: '100644', sha: index.sha, size: index.size },
      { path: 'issues', type: 'tree', mode: '040000', sha: 'c'.repeat(40) },
      { path: 'issues/1.json', type: 'blob', mode: '100644', sha: record.sha, size: record.size },
    ] }),
    readBlob: async oid => { calls.push(oid); return blobs.get(oid); },
  } };
};

test('reads all indexed record blobs and validates their identity and structure in the same tree', async () => {
  const f = fixture(); const result = await readCheckpointInventory(f.args);
  assert.equal(result.kind, 'inventory-records-structurally-valid'); assert.equal(result.issueCount, 1);
  assert.equal(result.commitOid, f.args.commitOid); assert.equal(result.records[0].value.issueId, 'one');
  assert.equal(Object.hasOwn(result.records[0].value, 'current'), false);
  assert.deepEqual(f.calls, [...f.blobs.keys()]);
});

test('blocks oversized inventories before reading any individual records', async () => {
  const f = fixture();
  const issues = Array.from({ length: 17 }, (_, i) => ({ number: i + 1, issueId: `issue-${i + 1}` }));
  const index = blob(JSON.stringify({ version: 1, repositoryId: 'repo', issues }));
  f.blobs.set(index.sha, index);
  f.args.readTree = async () => ({ sha: 'b'.repeat(40), truncated: false, tree: [
    { path: 'index.json', type: 'blob', mode: '100644', sha: index.sha, size: index.size },
    { path: 'issues', type: 'tree', mode: '040000', sha: 'c'.repeat(40) },
    ...issues.map(issue => ({ path: `issues/${issue.number}.json`, type: 'blob', mode: '100644', sha: 'd'.repeat(40), size: 1024 * 1024 })),
  ] });
  assert.equal((await readCheckpointInventory(f.args)).reason, 'inventory-too-large');
  assert.deepEqual(f.calls, [index.sha]);
});

test('blocks unreadable, absent or altered record blobs', async () => {
  let f = fixture(); f.blobs.delete(f.record.sha);
  assert.equal((await readCheckpointInventory(f.args)).reason, 'record-size-mismatch');
  f = fixture(); const read = f.args.readBlob; f.args.readBlob = async oid => {
    if (oid === f.record.sha) throw Error('network'); return read(oid);
  };
  assert.equal((await readCheckpointInventory(f.args)).reason, 'record-read-failed');
  f = fixture(); f.record.content = Buffer.alloc(f.record.size, 'x').toString('base64');
  assert.equal((await readCheckpointInventory(f.args)).reason, 'blob-hash-mismatch');
});

test('blocks a valid blob belonging to another issue even if its index path matches', async () => {
  const f = fixture(); const wrong = blob(recordContent('wrong'));
  f.blobs.set(wrong.sha, wrong); const originalTree = f.args.readTree;
  f.args.readTree = async (...args) => { const tree = await originalTree(...args);
    tree.tree[2].sha = wrong.sha; tree.tree[2].size = wrong.size; return tree; };
  assert.equal((await readCheckpointInventory(f.args)).reason, 'record-identity-mismatch');
});

test('blocks a correctly hashed record with invalid checkpoint content', async () => {
  const f = fixture(); const invalid = JSON.parse(recordContent('one')); invalid.current.targetStatus = 'done';
  const bad = blob(JSON.stringify(invalid)); f.blobs.set(bad.sha, bad); const originalTree = f.args.readTree;
  f.args.readTree = async (...args) => { const tree = await originalTree(...args);
    tree.tree[2].sha = bad.sha; tree.tree[2].size = bad.size; return tree; };
  assert.equal((await readCheckpointInventory(f.args)).reason, 'invalid-current');
});

test('selects an exact issue only after the complete inventory has passed', async () => {
  let f = fixture(); f.args.selection = { number: 1, issueId: 'one' };
  let result = await readCheckpointInventory(f.args);
  assert.equal(result.kind, 'inventory-records-structurally-valid'); assert.equal(result.selectedRecord.current.commentId, '1');
  f = fixture(); f.args.selection = { number: 1, issueId: 'wrong' };
  assert.equal((await readCheckpointInventory(f.args)).reason, 'selection-identity-mismatch');
  f = fixture(); f.args.selection = { number: 2, issueId: 'other' };
  result = await readCheckpointInventory(f.args); assert.equal(result.selectedRecord, null);
  f = fixture(); f.args.selection = { number: 2, issueId: 'x'.repeat(257) };
  result = await readCheckpointInventory(f.args); assert.equal(result.reason, 'invalid-selection'); assert.equal(f.calls.length, 0);
  f = fixture(); f.args.selection = { number: 1, issueId: 'one' }; f.blobs.delete(f.record.sha);
  result = await readCheckpointInventory(f.args); assert.equal(result.kind, 'blocked'); assert.equal(Object.hasOwn(result, 'selectedRecord'), false);
});
