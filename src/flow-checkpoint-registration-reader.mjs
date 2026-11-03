import { isCheckpointBranchRef, isCheckpointRegistration, observeCheckpointGenesis } from './flow-checkpoint-registration.mjs';

const blocked = reason => ({ kind: 'blocked', reason });

// The transport must be authenticated to the selected repository and the
// registration must come from the independently trusted configuration. No
// write is authorized by this read; genesis cannot prove no rollback.
export async function readCheckpointRegistration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return blocked('invalid-input');
  if (input.registration === null || input.registration === undefined) return blocked('not-registered');
  if (!isCheckpointRegistration(input.registration)) return blocked('invalid-registration');
  if (typeof input.readRepository !== 'function' || typeof input.readRef !== 'function' || typeof input.compare !== 'function') {
    return blocked('invalid-input');
  }
  const registration = structuredClone(input.registration);
  const { readRepository, readRef, compare } = input;
  let observedRepositoryId; let observedDefaultBranch; let ref; let comparison;
  try {
    const repository = await readRepository();
    observedRepositoryId = repository?.node_id;
    observedDefaultBranch = repository?.default_branch;
    if (observedRepositoryId !== registration.repositoryId) return blocked('repository-mismatch');
    if (typeof observedDefaultBranch !== 'string' || !isCheckpointBranchRef(`refs/heads/${observedDefaultBranch}`)) return blocked('invalid-default-branch');
    if (`refs/heads/${observedDefaultBranch}` === registration.ref) return blocked('checkpoint-ref-is-default');
    ref = structuredClone(await readRef(registration.ref));
    if (ref?.ref !== registration.ref || ref.object?.type !== 'commit'
        || typeof ref.object?.sha !== 'string' || !/^[0-9a-f]{40}$/.test(ref.object.sha)) return blocked('invalid-ref');
    comparison = await compare(registration.genesisOid, ref.object.sha);
  } catch { return blocked('registration-read-failed'); }
  const observed = observeCheckpointGenesis({ registration, repositoryId: observedRepositoryId, ref, comparison });
  if (observed.kind !== 'genesis-ancestry-observed') return observed;
  try {
    const freshRef = structuredClone(await readRef(registration.ref));
    const freshRepository = await readRepository();
    if (freshRepository?.node_id !== registration.repositoryId || freshRepository?.default_branch !== observedDefaultBranch
        || freshRef?.ref !== registration.ref
        || freshRef.object?.type !== 'commit' || freshRef.object?.sha !== observed.headOid) return blocked('registration-snapshot-changed');
  } catch { return blocked('registration-read-failed'); }
  return observed;
}
