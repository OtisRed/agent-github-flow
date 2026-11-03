import test from 'node:test';
import assert from 'node:assert/strict';
import { CHECKPOINT_BRANCH_REF } from './flow-checkpoint-registration.mjs';
import { CHECKPOINT_ANCHOR_REF, planCheckpointRefPairAdvance, planCheckpointRefPairCreate } from './flow-checkpoint-ref-pair.mjs';

const fixture = () => ({ repositoryId: 'repo', expectedHeadOid: 'a'.repeat(40), expectedTreeOid: 'b'.repeat(40),
  checkpointRef: { ref: CHECKPOINT_BRANCH_REF, object: { type: 'commit', sha: 'a'.repeat(40) } },
  anchorRef: { ref: CHECKPOINT_ANCHOR_REF, object: { type: 'commit', sha: 'a'.repeat(40) } },
  commit: { sha: 'c'.repeat(40), tree: { sha: 'b'.repeat(40) }, parents: [{ sha: 'a'.repeat(40) }] } });

test('plans two fixed refs with the same exact before and after OIDs and no force', () => {
  const value = fixture(); const result = planCheckpointRefPairAdvance(value);
  assert.equal(result.kind, 'atomic-ref-pair-plan'); assert.equal(result.repositoryId, 'repo');
  assert.deepEqual(result.refUpdates, [CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF].map(name => ({
    name, beforeOid: 'a'.repeat(40), afterOid: 'c'.repeat(40), force: false,
  })));
});

test('blocks missing, different or incorrectly named refs', () => {
  let value = fixture(); value.anchorRef.object.sha = 'd'.repeat(40);
  assert.equal(planCheckpointRefPairAdvance(value).reason, 'ref-pair-mismatch');
  value = fixture(); value.anchorRef = null; assert.equal(planCheckpointRefPairAdvance(value).reason, 'ref-pair-mismatch');
  value = fixture(); value.checkpointRef.ref = 'refs/heads/main'; assert.equal(planCheckpointRefPairAdvance(value).reason, 'ref-pair-mismatch');
});

test('blocks unrelated, merge, unchanged or wrong-tree commits and zero OIDs', () => {
  let value = fixture(); value.commit.parents[0].sha = 'd'.repeat(40);
  assert.equal(planCheckpointRefPairAdvance(value).reason, 'invalid-prepared-commit');
  value = fixture(); value.commit.parents.push({ sha: 'e'.repeat(40) });
  assert.equal(planCheckpointRefPairAdvance(value).reason, 'invalid-prepared-commit');
  value = fixture(); value.commit.tree.sha = 'd'.repeat(40);
  assert.equal(planCheckpointRefPairAdvance(value).reason, 'invalid-prepared-commit');
  value = fixture(); value.commit.sha = value.expectedHeadOid;
  assert.equal(planCheckpointRefPairAdvance(value).reason, 'invalid-prepared-commit');
  value = fixture(); value.expectedHeadOid = '0'.repeat(40);
  assert.equal(planCheckpointRefPairAdvance(value).reason, 'invalid-input');
});

test('plans creation of two absent fixed refs against a verified root commit',()=>{
  const v={repositoryId:'repo',checkpointRef:null,anchorRef:null,expectedTreeOid:'b'.repeat(40),
    commit:{sha:'c'.repeat(40),tree:{sha:'b'.repeat(40)},parents:[]}};
  const result=planCheckpointRefPairCreate(v);assert.equal(result.kind,'atomic-ref-pair-plan');
  assert.deepEqual(result.refUpdates,[CHECKPOINT_BRANCH_REF,CHECKPOINT_ANCHOR_REF].map(name=>({name,beforeOid:'0'.repeat(40),afterOid:'c'.repeat(40),force:false})));
  v.anchorRef={ref:CHECKPOINT_ANCHOR_REF};assert.equal(planCheckpointRefPairCreate(v).kind,'blocked');
  v.anchorRef=null;v.commit.parents=[{sha:'a'.repeat(40)}];assert.equal(planCheckpointRefPairCreate(v).kind,'blocked');
  v.commit.parents=[];delete v.checkpointRef;assert.equal(planCheckpointRefPairCreate(v).kind,'blocked');
});
