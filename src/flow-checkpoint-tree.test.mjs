import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planCheckpointRecordReads } from './flow-checkpoint-tree.mjs';

const blob = text => {
  const bytes = Buffer.from(text); const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  return { sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
};
const fixture = () => {
  const indexBlob = blob('{"version":1,"repositoryId":"repo","issues":[{"number":1,"issueId":"one"}]}');
  const treeOid = 'a'.repeat(40);
  return { expectedTreeOid: treeOid, repositoryId: 'repo', indexBlob, tree: { sha: treeOid, truncated: false, tree: [
    { path: 'index.json', type: 'blob', mode: '100644', sha: indexBlob.sha, size: indexBlob.size },
    { path: 'issues', type: 'tree', mode: '040000', sha: 'b'.repeat(40) },
    { path: 'issues/1.json', type: 'blob', mode: '100644', sha: 'c'.repeat(40), size: 20 },
  ] } };
};
const blockedBy = (change, reason) => { const input = fixture(); change(input); assert.equal(planCheckpointRecordReads(input).reason, reason); };

test('binds a decoded index to the listed blob and plans its exact record read', () => {
  assert.deepEqual(planCheckpointRecordReads(fixture()), { kind: 'record-reads-planned',
    index: { version: 1, repositoryId: 'repo', issues: [{ number: 1, issueId: 'one' }] },
    records: [{ path: 'issues/1.json', oid: 'c'.repeat(40), size: 20 }] });
});

test('blocks truncated trees, wrong roots and duplicate paths', () => {
  blockedBy(v => { v.tree.truncated = true; }, 'incomplete-or-invalid-tree');
  blockedBy(v => { v.tree.sha = '0'.repeat(40); }, 'incomplete-or-invalid-tree');
  blockedBy(v => { v.tree.tree.push(v.tree.tree[0]); }, 'invalid-tree-entry');
});

test('blocks a mismatched index blob, missing and orphan record paths', () => {
  blockedBy(v => { v.indexBlob.sha = '0'.repeat(40); }, 'invalid-blob');
  blockedBy(v => { v.tree.tree[0].size++; }, 'index-size-mismatch');
  blockedBy(v => { v.tree.tree.pop(); }, 'inventory-count-mismatch');
  blockedBy(v => { v.tree.tree[2].path = 'issues/2.json'; }, 'inventory-path-mismatch');
  blockedBy(v => { v.tree.tree.push({ path: 'issues/2.json', type: 'blob', mode: '100644', sha: 'd'.repeat(40), size: 1 }); }, 'inventory-count-mismatch');
});

test('blocks noncanonical paths, symlinks, subdirectories and missing directory', () => {
  blockedBy(v => { v.tree.tree[2].path = 'issues/01.json'; }, 'invalid-record-entry');
  blockedBy(v => { v.tree.tree[2].mode = '120000'; }, 'invalid-record-entry');
  blockedBy(v => { v.tree.tree[2].type = 'tree'; }, 'invalid-record-entry');
  blockedBy(v => { v.tree.tree.splice(1, 1); }, 'missing-issues-directory');
});
