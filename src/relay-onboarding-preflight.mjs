// Pure, non-authorizing assessment. Its caller must independently collect and
// authenticate all evidence; booleans passed here are not proof by themselves.
// This module neither reads credential values nor writes GitHub state.
const validOid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const state = (id, value) => ({ id, state: value });
const boolean = value => typeof value === 'boolean';

export function assessRelayOnboarding(evidence, policy) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { kind: 'blocked', checks: [state('evidence', 'unverified')] };
  }
  const checks = [];
  // The policy must come from a separately authenticated, trusted source.
  // This pure model can validate its shape, not establish its provenance.
  const validPolicy = !!policy && typeof policy === 'object' && !Array.isArray(policy)
    && typeof policy.appId === 'string' && /^[1-9][0-9]*$/.test(policy.appId)
    && typeof policy.projectRepositoryId === 'string' && !!policy.projectRepositoryId
    && typeof policy.centralRepositoryId === 'string' && !!policy.centralRepositoryId
    && typeof policy.projectId === 'string' && !!policy.projectId
    && typeof policy.centralFullName === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(policy.centralFullName)
    && policy.sharedWorkflowPath === '.github/workflows/flow-relay.yml' && validOid(policy.approvedSharedRevision);
  checks.push(state('trusted-policy', validPolicy ? 'ok' : 'unverified'));
  const repo = evidence.repository;
  checks.push(state('repository', !repo || repo.complete !== true ? 'unverified'
    : !boolean(repo.identityMatches) || !boolean(repo.isArchived) || !boolean(repo.adminAccess)
      || typeof repo.nodeId !== 'string' || !repo.nodeId || typeof repo.defaultBranch !== 'string' || !repo.defaultBranch
      ? 'unverified'
      : !validPolicy ? 'unverified'
        : repo.nodeId !== policy.projectRepositoryId || repo.identityMatches !== true || repo.isArchived !== false || repo.adminAccess !== true || repo.defaultBranch !== 'main'
        ? 'blocked' : 'ok'));

  const central = evidence.centralRepository;
  checks.push(state('central-repository', !central || central.complete !== true ? 'unverified'
    : typeof central.nodeId !== 'string' || !central.nodeId || typeof central.fullName !== 'string'
      || !central.fullName || !boolean(central.sharedWorkflowExists) || !validOid(central.sharedWorkflowRevision)
      || typeof central.sharedWorkflowRepositoryId !== 'string' || !central.sharedWorkflowRepositoryId
      || typeof central.sharedWorkflowPath !== 'string' || !central.sharedWorkflowPath || !validPolicy ? 'unverified'
      : central.fullName !== policy.centralFullName || central.nodeId !== policy.centralRepositoryId
        || central.sharedWorkflowRepositoryId !== policy.centralRepositoryId || central.sharedWorkflowPath !== policy.sharedWorkflowPath
        || central.sharedWorkflowRevision !== policy.approvedSharedRevision || central.sharedWorkflowExists !== true ? 'blocked' : 'ok'));

  const centralBranch = evidence.centralDefaultBranch;
  checks.push(state('central-trusted-branch', !centralBranch || centralBranch.complete !== true || !validPolicy ? 'unverified'
    : typeof centralBranch.name !== 'string' || !centralBranch.name
      || typeof centralBranch.repositoryId !== 'string' || !centralBranch.repositoryId
      || !validOid(centralBranch.headOid) || !validOid(centralBranch.finalHeadOid) || !validOid(centralBranch.reviewedHeadOid)
      || !boolean(centralBranch.protectedAgainstDirectWrites) || !boolean(centralBranch.protectedAgainstDeletionAndRewind)
      ? 'unverified'
      : centralBranch.name !== 'main' || centralBranch.repositoryId !== policy.centralRepositoryId
        || centralBranch.headOid !== centralBranch.finalHeadOid || centralBranch.headOid !== centralBranch.reviewedHeadOid
        || centralBranch.protectedAgainstDirectWrites !== true || centralBranch.protectedAgainstDeletionAndRewind !== true
        ? 'blocked' : 'ok'));

  const centralEnvironment = evidence.centralEnvironment;
  checks.push(state('central-environment', !centralEnvironment || centralEnvironment.complete !== true || !validPolicy ? 'unverified'
    : !boolean(centralEnvironment.exists) ? 'unverified'
      : centralEnvironment.exists === false ? 'needs-setup'
        : typeof centralEnvironment.name !== 'string' || !centralEnvironment.name
          || typeof centralEnvironment.repositoryId !== 'string' || !centralEnvironment.repositoryId
          || !boolean(centralEnvironment.onlyReviewedDefaultBranch) ? 'unverified'
          : centralEnvironment.name !== 'flow-controller' || centralEnvironment.repositoryId !== policy.centralRepositoryId
            || centralEnvironment.onlyReviewedDefaultBranch !== true ? 'blocked' : 'ok'));

  const centralSecrets = evidence.centralRuntimeSecrets;
  checks.push(state('central-runtime-secrets', !centralSecrets || centralSecrets.complete !== true || !validPolicy
    || typeof centralSecrets.repositoryId !== 'string' || !centralSecrets.repositoryId
    || typeof centralSecrets.environmentName !== 'string' || !centralSecrets.environmentName
    || !boolean(centralSecrets.appPrivateKeyExists) || !boolean(centralSecrets.projectTokenExists) ? 'unverified'
    : centralSecrets.repositoryId !== policy.centralRepositoryId || centralSecrets.environmentName !== 'flow-controller' ? 'blocked'
      : !centralSecrets.appPrivateKeyExists || !centralSecrets.projectTokenExists ? 'needs-setup'
        : !boolean(centralSecrets.projectReadConfirmed) || typeof centralSecrets.projectId !== 'string' || !centralSecrets.projectId
          || !boolean(centralSecrets.projectReadUsingEnvironmentSecret) ? 'unverified'
          : centralSecrets.projectId !== policy.projectId || !centralSecrets.projectReadConfirmed
            || !centralSecrets.projectReadUsingEnvironmentSecret ? 'blocked' : 'ok'));

  const app = evidence.appInstallation;
  checks.push(state('app-installation', !app || app.complete !== true ? 'unverified'
    : !boolean(app.installedForRepository) || typeof app.repositoryId !== 'string' || !app.repositoryId
      || typeof app.appId !== 'string' || !app.appId || !validPolicy ? 'unverified'
      : app.repositoryId !== repo?.nodeId || app.appId !== policy.appId ? 'blocked'
        : app.installedForRepository === false ? 'needs-setup'
          : !boolean(app.installationActive) || !boolean(app.scopedTokenConfirmed) || !boolean(app.requiredPermissionsConfirmed)
            || !boolean(app.scopedTokenFromCentralRuntimeKey) || typeof app.credentialRepositoryId !== 'string' || !app.credentialRepositoryId
            || typeof app.credentialEnvironmentName !== 'string' || !app.credentialEnvironmentName ? 'unverified'
            : app.installationActive && app.scopedTokenConfirmed && app.requiredPermissionsConfirmed && app.scopedTokenFromCentralRuntimeKey
              && app.credentialRepositoryId === policy.centralRepositoryId && app.credentialEnvironmentName === 'flow-controller' ? 'ok' : 'blocked'));

  const branch = evidence.defaultBranch;
  checks.push(state('trusted-default-branch', !branch || branch.complete !== true ? 'unverified'
    : !validOid(branch.headOid) || !validOid(branch.finalHeadOid) || !validOid(branch.reviewedHeadOid) || typeof branch.name !== 'string' || !branch.name
      || typeof branch.repositoryId !== 'string' || !branch.repositoryId
      || !boolean(branch.protectedAgainstDirectWrites) || !boolean(branch.protectedAgainstDeletionAndRewind) ? 'unverified'
      : branch.name !== repo?.defaultBranch || branch.repositoryId !== repo?.nodeId
        || branch.headOid !== branch.finalHeadOid || branch.headOid !== branch.reviewedHeadOid || branch.protectedAgainstDirectWrites !== true
        || branch.protectedAgainstDeletionAndRewind !== true ? 'blocked' : 'ok'));

  const env = evidence.environment;
  checks.push(state('relay-environment', !env || env.complete !== true ? 'unverified'
    : !boolean(env.exists) ? 'unverified'
      : env.exists === false ? 'needs-setup'
        : !boolean(env.onlyReviewedDefaultBranch) || typeof env.repositoryId !== 'string' || !env.repositoryId
          || typeof env.name !== 'string' || !env.name ? 'unverified'
          : env.name !== 'flow-relay' || env.repositoryId !== repo?.nodeId || env.onlyReviewedDefaultBranch !== true ? 'blocked' : 'ok'));

  const sender = evidence.sender;
  checks.push(state('sender-workflow', !sender || sender.complete !== true ? 'unverified'
    : !boolean(sender.exists) ? 'unverified'
      : sender.exists === false ? 'needs-setup'
        : !boolean(sender.reviewedAtHead) || !boolean(sender.pinnedSharedRevision)
          || !boolean(sender.eventsCorrect) || !boolean(sender.explicitSecretsOnly) || !boolean(sender.noInherit)
          || !boolean(sender.environmentBound) || !boolean(sender.callerPathReviewed)
          || !validOid(sender.sourceHeadOid) || !validOid(sender.sharedRevision) || !validPolicy
          || typeof sender.repositoryId !== 'string' || !sender.repositoryId
          || typeof sender.sharedRepositoryId !== 'string' || !sender.sharedRepositoryId
          || typeof sender.sharedWorkflowPath !== 'string' || !sender.sharedWorkflowPath ? 'unverified'
          : sender.repositoryId !== repo?.nodeId || sender.sourceHeadOid !== branch?.headOid
            || sender.sharedRepositoryId !== policy.centralRepositoryId || sender.sharedWorkflowPath !== policy.sharedWorkflowPath
            || sender.sharedRevision !== policy.approvedSharedRevision || sender.reviewedAtHead !== true
            || sender.pinnedSharedRevision !== true || sender.eventsCorrect !== true || sender.explicitSecretsOnly !== true
            || sender.noInherit !== true || sender.environmentBound !== true || sender.callerPathReviewed !== true ? 'blocked' : 'ok'));

  const secrets = evidence.projectSecrets;
  checks.push(state('existing-configuration', !secrets || secrets.complete !== true
    || !boolean(secrets.relayTokenExists) || !boolean(secrets.sourceAliasExists)
    || !boolean(secrets.targetVariableExists) || typeof secrets.repositoryId !== 'string' || !secrets.repositoryId
    || typeof secrets.environmentName !== 'string' || !secrets.environmentName ? 'unverified'
    : secrets.repositoryId !== repo?.nodeId || secrets.environmentName !== 'flow-relay' ? 'blocked'
      : secrets.relayTokenExists || secrets.sourceAliasExists || secrets.targetVariableExists
      ? 'existing-configuration' : 'ok'));

  // A complete uniqueness assessment must cover both the legacy secret list
  // and all independent routes. Names alone cannot establish their contents.
  const route = evidence.centralRoute;
  checks.push(state('central-route-uniqueness', !route || route.complete !== true
    || typeof route.centralRepositoryId !== 'string' || !route.centralRepositoryId
    || typeof route.candidateRepositoryId !== 'string' || !route.candidateRepositoryId || !validPolicy ? 'unverified'
    : route.centralRepositoryId !== policy.centralRepositoryId || route.candidateRepositoryId !== repo?.nodeId ? 'blocked'
      : route.legacyRoutes === 'match' || route.independentRoutes === 'match' ? 'existing-configuration'
      : ['empty', 'no-match'].includes(route.legacyRoutes) && route.independentRoutes === 'complete-no-match'
        ? 'ok' : 'unverified'));

  const kind = checks.every(check => check.state === 'ok') ? 'ready-for-separate-authorization' : 'blocked';
  return { kind, checks };
}
