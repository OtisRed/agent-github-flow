import { parseFlowTimestamp } from './flow-epoch.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const oid = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
const branchRef = value => typeof value === 'string' && /^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/.test(value)
  && !value.includes('..') && !value.includes('//') && !value.includes('@{')
  && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
export const isCheckpointBranchRef = branchRef;
export const CHECKPOINT_BRANCH_REF = 'refs/heads/agent-github-flow/checkpoints';
export const CHECKPOINT_ANCHOR_REF = 'refs/heads/agent-github-flow/checkpoint-anchor';
export const isCheckpointRegistration = registration => object(registration) && id(registration.repositoryId)
  && registration.ref === CHECKPOINT_BRANCH_REF && oid(registration.genesisOid) && parseFlowTimestamp(registration.cutoverAt) !== null;

// This only checks a trusted registration against independently supplied GitHub
// observations. It cannot authenticate the registration or API responses, and
// genesis ancestry does not detect rollback to a different older descendant.
export function observeCheckpointGenesis(input) {
  if (!object(input)) return blocked('invalid-input');
  const { registration, repositoryId, ref, comparison } = input;
  if (registration === null || registration === undefined) return blocked('not-registered');
  if (!isCheckpointRegistration(registration)) return blocked('invalid-registration');
  if (repositoryId !== registration.repositoryId) return blocked('repository-mismatch');
  if (!object(ref)) return blocked('missing-ref');
  if (ref.ref !== registration.ref || ref.object?.type !== 'commit' || !oid(ref.object?.sha)) return blocked('invalid-ref');
  const headOid = ref.object.sha; const genesisOid = registration.genesisOid;
  if (!object(comparison) || comparison.base_commit?.sha !== genesisOid || comparison.merge_base_commit?.sha !== genesisOid
      || !Array.isArray(comparison.commits) || !Number.isSafeInteger(comparison.ahead_by)
      || !Number.isSafeInteger(comparison.behind_by) || comparison.behind_by !== 0) return blocked('invalid-ancestry');
  if (headOid === genesisOid) {
    if (comparison.status !== 'identical' || comparison.ahead_by !== 0 || comparison.commits.length !== 0) return blocked('invalid-ancestry');
  } else if (comparison.status !== 'ahead' || comparison.ahead_by < 1
      || comparison.commits.length === 0 || comparison.commits.at(-1)?.sha !== headOid) return blocked('invalid-ancestry');
  return { kind: 'genesis-ancestry-observed', headOid, rollbackProtected: false };
}
