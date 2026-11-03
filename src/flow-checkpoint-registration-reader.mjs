import { CHECKPOINT_ANCHOR_REF, isCheckpointBranchRef, isCheckpointRegistration, observeCheckpointGenesis } from './flow-checkpoint-registration.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const repoName = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(value)
  && !['.', '..'].includes(value.split('/')[1]);

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
  let observedRepositoryId; let observedRepositoryFullName; let observedDefaultBranch; let ref; let anchor; let comparison;
  try {
    const repository = await readRepository();
    observedRepositoryId = repository?.node_id;
    observedRepositoryFullName = repository?.full_name;
    observedDefaultBranch = repository?.default_branch;
    if (observedRepositoryId !== registration.repositoryId) return blocked('repository-mismatch');
    if (!repoName(observedRepositoryFullName)) return blocked('invalid-repository-name');
    if (typeof observedDefaultBranch !== 'string' || !isCheckpointBranchRef(`refs/heads/${observedDefaultBranch}`)) return blocked('invalid-default-branch');
    if ([registration.ref, CHECKPOINT_ANCHOR_REF].includes(`refs/heads/${observedDefaultBranch}`)) return blocked('checkpoint-ref-is-default');
    ref = structuredClone(await readRef(registration.ref));
    if (ref?.ref !== registration.ref || ref.object?.type !== 'commit'
        || typeof ref.object?.sha !== 'string' || !/^[0-9a-f]{40}$/.test(ref.object.sha)) return blocked('invalid-ref');
    anchor = structuredClone(await readRef(CHECKPOINT_ANCHOR_REF));
    if (anchor?.ref !== CHECKPOINT_ANCHOR_REF || anchor.object?.type !== 'commit'
        || anchor.object?.sha !== ref.object.sha) return blocked('anchor-mismatch');
    comparison = await compare(registration.genesisOid, ref.object.sha);
  } catch { return blocked('registration-read-failed'); }
  const observed = observeCheckpointGenesis({ registration, repositoryId: observedRepositoryId, ref, comparison });
  if (observed.kind !== 'genesis-ancestry-observed') return observed;
  try {
    const freshRef = structuredClone(await readRef(registration.ref));
    const freshAnchor = structuredClone(await readRef(CHECKPOINT_ANCHOR_REF));
    const freshRepository = await readRepository();
    if (freshRepository?.node_id !== registration.repositoryId || freshRepository?.full_name !== observedRepositoryFullName
        || freshRepository?.default_branch !== observedDefaultBranch
        || freshRef?.ref !== registration.ref
        || freshRef.object?.type !== 'commit' || freshRef.object?.sha !== observed.headOid
        || freshAnchor?.ref !== CHECKPOINT_ANCHOR_REF || freshAnchor.object?.type !== 'commit'
        || freshAnchor.object?.sha !== observed.headOid) return blocked('registration-snapshot-changed');
  } catch { return blocked('registration-read-failed'); }
  return { ...observed, repositoryFullName: observedRepositoryFullName, pairedRefs: true };
}
