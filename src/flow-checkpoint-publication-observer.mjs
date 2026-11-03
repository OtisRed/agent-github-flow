import { CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const oid = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) && value !== '0'.repeat(40);
const refAt = (value, name, expected) => value?.ref === name && value.object?.type === 'commit'
  && value.object.sha === expected;

// Observation after a single attempted publication. Callers must bind the
// expected object IDs to their verified plan and use trusted App transports.
// This does not authorize writes, prove branch protection or end an in-flight
// request. In particular, observing the old pair NEVER permits a retry.
export async function observeCheckpointPublication(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.repositoryId !== 'string' || !input.repositoryId || input.repositoryId.trim() !== input.repositoryId
      || input.repositoryId.length > 256 || !oid(input.oldOid) || !oid(input.newOid) || input.oldOid === input.newOid
      || !oid(input.expectedTreeOid) || !['readRepository', 'readRef', 'readCommit'].every(k => typeof input[k] === 'function')) {
    return blocked('invalid-input');
  }
  const { repositoryId, oldOid, newOid, expectedTreeOid, readRepository, readRef, readCommit } = input;
  try {
    const readPair = async () => [await readRef(CHECKPOINT_BRANCH_REF), await readRef(CHECKPOINT_ANCHOR_REF)];
    const repo = await readRepository();
    if (repo?.node_id !== repositoryId) return blocked('repository-mismatch');
    const pair = await readPair();
    const both = expected => refAt(pair[0], CHECKPOINT_BRANCH_REF, expected) && refAt(pair[1], CHECKPOINT_ANCHOR_REF, expected);
    if (!both(oldOid) && !both(newOid)) return blocked('unexpected-ref-pair');
    const observed = both(oldOid) ? oldOid : newOid;
    if (observed === newOid) {
      const commit = await readCommit(newOid);
      if (commit?.sha !== newOid || commit.tree?.sha !== expectedTreeOid || !Array.isArray(commit.parents)
          || commit.parents.length !== 1 || commit.parents[0]?.sha !== oldOid) return blocked('unexpected-commit');
    }
    const finalPair = await readPair();
    const finalRepo = await readRepository();
    if (finalRepo?.node_id !== repositoryId || !refAt(finalPair[0], CHECKPOINT_BRANCH_REF, observed)
        || !refAt(finalPair[1], CHECKPOINT_ANCHOR_REF, observed)) return blocked('observation-changed');
    return observed === oldOid ? { kind: 'publication-not-observed', retryAllowed: false }
      : { kind: 'publication-observed', retryAllowed: false };
  } catch {
    return blocked('publication-read-failed');
  }
}
