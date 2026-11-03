import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyPreparedCheckpointTree } from './flow-checkpoint-tree-diff.mjs';

const oid = character => character.repeat(40);
const content = value => Buffer.from(value).toString('base64');
const hash = value => { const bytes = Buffer.from(value, 'base64'); return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); };
function fixture() {
  const additions = [{ path: 'index.json', contents: content('index') }, { path: 'issues/1.json', contents: content('record') }];
  return { baseTreeOid: oid('a'), newTreeOid: oid('b'), additions,
    baseTree: { sha: oid('a'), truncated: false, tree: [{ path: 'index.json', mode: '100644', type: 'blob', sha: oid('c') },
      { path: 'other', mode: '100644', type: 'blob', sha: oid('d') }] },
    newTree: { sha: oid('b'), truncated: false, tree: [{ path: 'index.json', mode: '100644', type: 'blob', sha: hash(additions[0].contents) },
      { path: 'issues', mode: '040000', type: 'tree', sha: oid('e') },
      { path: 'issues/1.json', mode: '100644', type: 'blob', sha: hash(additions[1].contents) },
      { path: 'other', mode: '100644', type: 'blob', sha: oid('d') }] } };
}
test('accepts exactly the intended additions while preserving unrelated paths', () => {
  assert.deepEqual(verifyPreparedCheckpointTree(fixture()), { kind: 'prepared-tree-diff-verified' });
});
test('rejects changed, added and removed unrelated paths', () => {
  let v = fixture(); v.newTree.tree.at(-1).sha = oid('f'); assert.equal(verifyPreparedCheckpointTree(v).reason, 'unrelated-tree-change');
  v = fixture(); v.newTree.tree.push({ path: 'extra', mode: '100644', type: 'blob', sha: oid('f') });
  assert.equal(verifyPreparedCheckpointTree(v).reason, 'unrelated-tree-change');
  v = fixture(); v.newTree.tree.pop(); assert.equal(verifyPreparedCheckpointTree(v).reason, 'unrelated-tree-change');
});
test('rejects altered bytes, unsupported modes, duplicates and incomplete trees', () => {
  let v = fixture(); v.newTree.tree[2].sha = oid('f'); assert.equal(verifyPreparedCheckpointTree(v).reason, 'addition-mismatch');
  v = fixture(); v.newTree.tree[2].mode = '120000'; assert.equal(verifyPreparedCheckpointTree(v).reason, 'addition-mismatch');
  v = fixture(); v.newTree.tree.push(v.newTree.tree[2]); assert.equal(verifyPreparedCheckpointTree(v).reason, 'invalid-tree');
  v = fixture(); v.newTree.truncated = true; assert.equal(verifyPreparedCheckpointTree(v).reason, 'invalid-tree');
});
test('rejects arbitrary paths, invalid encodings and tree identity mismatch', () => {
  let v = fixture(); v.additions[1].path = 'issues/../other'; assert.equal(verifyPreparedCheckpointTree(v).reason, 'invalid-additions');
  v = fixture(); v.additions[1].contents = '%%%%'; assert.equal(verifyPreparedCheckpointTree(v).reason, 'invalid-additions');
  v = fixture(); v.newTree.sha = oid('f'); assert.equal(verifyPreparedCheckpointTree(v).reason, 'invalid-tree');
  v = fixture(); v.newTreeOid = v.baseTreeOid; v.newTree.sha = v.baseTreeOid;
  assert.equal(verifyPreparedCheckpointTree(v).reason, 'invalid-input');
});
