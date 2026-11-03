import { CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';
export { CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';
const blocked = reason => ({ kind: 'blocked', reason });
const oid = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) && value !== '0'.repeat(40);
const refAt = (value, name, expected) => value && value.ref === name && value.object?.type === 'commit' && value.object.sha === expected;

// Pure proposal for GraphQL updateRefs, not an executor or write authorization.
// The caller must authenticate the repo and refs, validate the prepared tree
// and commit, protect both refs, and repeat checks immediately before writing.
export function planCheckpointRefPairAdvance(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.repositoryId !== 'string'
      || !input.repositoryId || input.repositoryId.length > 256 || input.repositoryId.trim() !== input.repositoryId
      || !oid(input.expectedHeadOid) || !oid(input.expectedTreeOid)) return blocked('invalid-input');
  const { repositoryId, expectedHeadOid, expectedTreeOid, checkpointRef, anchorRef, commit } = input;
  if (!refAt(checkpointRef, CHECKPOINT_BRANCH_REF, expectedHeadOid)
      || !refAt(anchorRef, CHECKPOINT_ANCHOR_REF, expectedHeadOid)) return blocked('ref-pair-mismatch');
  if (!commit || !oid(commit.sha) || commit.sha === expectedHeadOid || commit.tree?.sha !== expectedTreeOid
      || !Array.isArray(commit.parents) || commit.parents.length !== 1 || commit.parents[0]?.sha !== expectedHeadOid) {
    return blocked('invalid-prepared-commit');
  }
  return { kind: 'atomic-ref-pair-plan', repositoryId, refUpdates: [
    { name: CHECKPOINT_BRANCH_REF, beforeOid: expectedHeadOid, afterOid: commit.sha, force: false },
    { name: CHECKPOINT_ANCHOR_REF, beforeOid: expectedHeadOid, afterOid: commit.sha, force: false },
  ] };
}

// One-time creation candidate only. Caller must independently establish that
// the repository has never been registered, both ref absences are fresh,
// genesis contents and protection are verified, and bootstrap is serialized.
export function planCheckpointRefPairCreate(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.repositoryId!=='string'
      ||!input.repositoryId||input.repositoryId.length>256||input.repositoryId.trim()!==input.repositoryId
      ||!oid(input.expectedTreeOid)||!Object.hasOwn(input,'checkpointRef')||!Object.hasOwn(input,'anchorRef'))return blocked('invalid-input');
  if(input.checkpointRef!==null||input.anchorRef!==null)return blocked('ref-pair-exists');
  const commit=input.commit;
  if(!commit||!oid(commit.sha)||commit.tree?.sha!==input.expectedTreeOid||!Array.isArray(commit.parents)||commit.parents.length!==0)
    return blocked('invalid-genesis-commit');
  return {kind:'atomic-ref-pair-plan',repositoryId:input.repositoryId,refUpdates:[CHECKPOINT_BRANCH_REF,CHECKPOINT_ANCHOR_REF]
    .map(name=>({name,beforeOid:'0'.repeat(40),afterOid:commit.sha,force:false}))};
}
