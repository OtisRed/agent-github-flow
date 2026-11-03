// Rotation first stages a separate slot. It never overwrites the active slot.
// Data passed to this module must come from authenticated, fresh observations.
const oid = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

export function isStagingSafe(snapshot, policy) {
  if (!snapshot || !policy || !oid(policy.head) || !oid(policy.workflowBlob)
      || typeof policy.workflowInventoryDigest !== 'string' || !/^[a-f0-9]{64}$/.test(policy.workflowInventoryDigest)
      || typeof policy.repositoryId !== 'string' || !policy.repositoryId) return false;
  const { repository, branch, protection, environment, branchPolicies, secrets, variables, caller, workflowInventory } = snapshot;
  return repository?.complete === true && repository.nodeId === policy.repositoryId
    && repository.identityMatches === true && repository.archived === false && repository.admin === true
    && repository.defaultBranch === 'main'
    && branch?.complete === true && branch.name === 'main' && branch.head === policy.head
    && protection?.complete === true && protection.adminEnforced === true && protection.prRequired === true
    && protection.approvals === 0 && protection.codeownerRequired === false && protection.lastPushApproval === false
    && protection.allowForcePush === false && protection.allowDeletion === false
    && environment?.complete === true && environment.exists === true && environment.customBranchPolicies === true
    && branchPolicies?.complete === true && branchPolicies.onlyMain === true
    && secrets?.complete === true && secrets.sourcePresent === true && secrets.activePresent === true
    && secrets.nextInEnvironment === false && secrets.nextInRepository === false
    && variables?.complete === true && variables.targetMatches === true
    && caller?.complete === true && caller.blob === policy.workflowBlob
    && workflowInventory?.complete === true && workflowInventory.head === policy.head
    && workflowInventory.digest === policy.workflowInventoryDigest;
}

export async function stageNextRelayCredential({ policy, observe, readCredential, writeCredential } = {}) {
  if (typeof observe !== 'function' || typeof readCredential !== 'function' || typeof writeCredential !== 'function') {
    return { state: 'blocked' };
  }
  try {
    const first = await observe();
    if (!isStagingSafe(first, policy)) return { state: 'blocked' };
    const credential = await readCredential();
    if (typeof credential !== 'string' || credential.length > 2048 || !/^github_pat_[A-Za-z0-9_]+$/.test(credential)) {
      return { state: 'blocked' };
    }
    const last = await observe();
    if (!isStagingSafe(last, policy)) return { state: 'blocked' };
    // GitHub provides create-or-update, not compare-and-set. A concurrent
    // external writer between this observation and the write is not prevented.
    // Once a write is attempted, errors are always uncertain and never retried.
    let wrote;
    try { wrote = await writeCredential(credential); } catch { return { state: 'uncertain-no-retry' }; }
    if (wrote !== true) return { state: 'uncertain-no-retry' };
    let after;
    try { after = await observe(); } catch { return { state: 'uncertain-no-retry' }; }
    if (!after || after.secrets?.complete !== true || after.secrets.nextInEnvironment !== true
        || !isStagingSafe({ ...after, secrets: { ...after.secrets, nextInEnvironment: false } }, policy)) {
      return { state: 'uncertain-no-retry' };
    }
    return { state: 'staged-unverified' };
  } catch {
    return { state: 'blocked' };
  }
}
