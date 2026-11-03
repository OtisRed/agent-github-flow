import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRelayOnboarding as assessWithPolicy } from './relay-onboarding-preflight.mjs';

const sha = 'a'.repeat(40);
const sharedSha = 'c'.repeat(40);
const policy = { appId: '123', projectRepositoryId: 'repository-node-id', centralRepositoryId: 'central-node-id', centralFullName: 'owner/flow',
  projectId: 'project-node-id', sharedWorkflowPath: '.github/workflows/flow-relay.yml', approvedSharedRevision: sharedSha };
const assessRelayOnboarding = evidence => assessWithPolicy(evidence, policy);
function trustedFixture() {
  return {
    repository: { complete: true, identityMatches: true, isArchived: false, adminAccess: true,
      nodeId: 'repository-node-id', defaultBranch: 'main' },
    centralRepository: { complete: true, nodeId: 'central-node-id', fullName: 'owner/flow', sharedWorkflowExists: true,
      sharedWorkflowRepositoryId: 'central-node-id', sharedWorkflowPath: '.github/workflows/flow-relay.yml', sharedWorkflowRevision: sharedSha },
    centralDefaultBranch: { complete: true, name: 'main', repositoryId: 'central-node-id', headOid: sha, finalHeadOid: sha,
      reviewedHeadOid: sha, protectedAgainstDirectWrites: true, protectedAgainstDeletionAndRewind: true },
    centralEnvironment: { complete: true, exists: true, name: 'flow-controller', repositoryId: 'central-node-id', onlyReviewedDefaultBranch: true },
    centralRuntimeSecrets: { complete: true, repositoryId: 'central-node-id', environmentName: 'flow-controller', appPrivateKeyExists: true, projectTokenExists: true,
      projectId: 'project-node-id', projectReadConfirmed: true, projectReadUsingEnvironmentSecret: true },
    appInstallation: { complete: true, installedForRepository: true, repositoryId: 'repository-node-id', appId: '123',
      installationActive: true, scopedTokenConfirmed: true, requiredPermissionsConfirmed: true, scopedTokenFromCentralRuntimeKey: true,
      credentialRepositoryId: 'central-node-id', credentialEnvironmentName: 'flow-controller' },
    defaultBranch: { complete: true, name: 'main', repositoryId: 'repository-node-id', headOid: sha, finalHeadOid: sha, reviewedHeadOid: sha,
      protectedAgainstDirectWrites: true, protectedAgainstDeletionAndRewind: true },
    environment: { complete: true, exists: true, name: 'flow-relay', repositoryId: 'repository-node-id', onlyReviewedDefaultBranch: true },
    sender: { complete: true, exists: true, repositoryId: 'repository-node-id', reviewedAtHead: true,
      sharedRepositoryId: 'central-node-id', sharedWorkflowPath: '.github/workflows/flow-relay.yml', sourceHeadOid: sha,
      pinnedSharedRevision: true, sharedRevision: sharedSha, eventsCorrect: true, explicitSecretsOnly: true,
      noInherit: true, environmentBound: true, callerPathReviewed: true },
    projectSecrets: { complete: true, repositoryId: 'repository-node-id', environmentName: 'flow-relay', relayTokenExists: false, sourceAliasExists: false, targetVariableExists: false },
    centralRoute: { complete: true, centralRepositoryId: 'central-node-id', candidateRepositoryId: 'repository-node-id', legacyRoutes: 'empty', independentRoutes: 'complete-no-match' },
  };
}
const check = (result, id) => result.checks.find(item => item.id === id)?.state;

test('complete matching evidence only produces a candidate, not a write', () => {
  const result = assessRelayOnboarding(trustedFixture());
  assert.equal(result.kind, 'ready-for-separate-authorization');
  assert.ok(result.checks.every(item => item.state === 'ok'));
});

test('unknown legacy route is never treated as a new or unique route', () => {
  for (const route of [undefined, { complete: false, centralRepositoryId: 'central-node-id', candidateRepositoryId: 'repository-node-id', legacyRoutes: 'empty', independentRoutes: 'complete-no-match' },
    { complete: true, centralRepositoryId: 'central-node-id', candidateRepositoryId: 'repository-node-id', legacyRoutes: 'unverified', independentRoutes: 'complete-no-match' },
    { complete: true, centralRepositoryId: 'central-node-id', candidateRepositoryId: 'repository-node-id', legacyRoutes: 'empty', independentRoutes: 'unverified' },
    { complete: true, centralRepositoryId: 'central-node-id', candidateRepositoryId: 'repository-node-id', legacyRoutes: null, independentRoutes: 'complete-no-match' }]) {
    const fixture = trustedFixture(); fixture.centralRoute = route;
    const result = assessRelayOnboarding(fixture);
    assert.equal(result.kind, 'blocked');
    assert.equal(check(result, 'central-route-uniqueness'), 'unverified');
  }
  for (const match of [{ legacyRoutes: 'match' }, { independentRoutes: 'match' }]) {
    const fixture = trustedFixture(); Object.assign(fixture.centralRoute, match);
    assert.equal(check(assessRelayOnboarding(fixture), 'central-route-uniqueness'), 'existing-configuration');
  }
});

test('any existing secret or target variable prevents treating partial setup as first install', () => {
  for (const [token, alias, target] of [[true, false, false], [false, true, false],
    [true, true, false], [false, false, true]]) {
    const fixture = trustedFixture();
    fixture.projectSecrets = { complete: true, repositoryId: 'repository-node-id', environmentName: 'flow-relay', relayTokenExists: token, sourceAliasExists: alias, targetVariableExists: target };
    const result = assessRelayOnboarding(fixture);
    assert.equal(result.kind, 'blocked');
    assert.equal(check(result, 'existing-configuration'), 'existing-configuration');
  }
});

test('stale or unprotected default branch blocks credential delivery', () => {
  for (const change of [{ headOid: 'b'.repeat(40) }, { finalHeadOid: 'b'.repeat(40) }, { name: 'smoke' }, { repositoryId: 'other' },
    { protectedAgainstDirectWrites: false }, { protectedAgainstDeletionAndRewind: false }]) {
    const fixture = trustedFixture(); Object.assign(fixture.defaultBranch, change);
    const result = assessRelayOnboarding(fixture);
    assert.equal(result.kind, 'blocked');
    assert.equal(check(result, 'trusted-default-branch'), 'blocked');
  }
});

test('sender evidence must belong to the reviewed repository and exact head and approved reusable SHA', () => {
  for (const change of [{ repositoryId: 'other' }, { sharedRepositoryId: 'other' }, { sourceHeadOid: 'b'.repeat(40) },
    { sharedRevision: 'd'.repeat(40) }, { sharedWorkflowPath: '.github/workflows/other.yml' }, { reviewedAtHead: false },
    { pinnedSharedRevision: false }, { eventsCorrect: false }, { explicitSecretsOnly: false }, { noInherit: false },
    { environmentBound: false }, { callerPathReviewed: false }]) {
    const fixture = trustedFixture(); Object.assign(fixture.sender, change);
    assert.equal(check(assessRelayOnboarding(fixture), 'sender-workflow'), 'blocked');
  }
  const missing = trustedFixture(); delete missing.sender.sourceHeadOid;
  assert.equal(check(assessRelayOnboarding(missing), 'sender-workflow'), 'unverified');
});

test('configuration and routing evidence must be tied to the selected repositories', () => {
  for (const [key, field, id] of [['projectSecrets', 'repositoryId', 'existing-configuration'],
    ['projectSecrets', 'environmentName', 'existing-configuration'], ['environment', 'repositoryId', 'relay-environment'],
    ['centralRoute', 'centralRepositoryId', 'central-route-uniqueness'], ['centralRoute', 'candidateRepositoryId', 'central-route-uniqueness']]) {
    const fixture = trustedFixture(); fixture[key][field] = 'other';
    assert.equal(check(assessRelayOnboarding(fixture), id), 'blocked');
  }
  const fixture = trustedFixture(); fixture.environment.name = 'other';
  assert.equal(check(assessRelayOnboarding(fixture), 'relay-environment'), 'blocked');
});

test('app identity and separately supplied policy must match', () => {
  const fixture = trustedFixture(); fixture.appInstallation.appId = '456';
  assert.equal(check(assessRelayOnboarding(fixture), 'app-installation'), 'blocked');
  assert.equal(check(assessWithPolicy(trustedFixture(), null), 'trusted-policy'), 'unverified');
  assert.equal(assessWithPolicy(trustedFixture(), null).kind, 'blocked');
  assert.equal(assessWithPolicy(trustedFixture(), { ...policy, sharedWorkflowPath: 'other' }).kind, 'blocked');
  const wrongCentral = trustedFixture(); wrongCentral.centralRepository.nodeId = 'other';
  assert.equal(check(assessRelayOnboarding(wrongCentral), 'central-repository'), 'blocked');
});

test('app capability and approved reusable workflow must be demonstrably usable', () => {
  for (const field of ['installationActive', 'scopedTokenConfirmed', 'requiredPermissionsConfirmed']) {
    const bad = trustedFixture(); bad.appInstallation[field] = false;
    assert.equal(check(assessRelayOnboarding(bad), 'app-installation'), 'blocked');
    delete bad.appInstallation[field];
    assert.equal(check(assessRelayOnboarding(bad), 'app-installation'), 'unverified');
  }
  for (const change of [{ sharedWorkflowExists: false }, { sharedWorkflowRepositoryId: 'other' },
    { sharedWorkflowPath: 'other' }, { sharedWorkflowRevision: 'd'.repeat(40) }]) {
    const fixture = trustedFixture(); Object.assign(fixture.centralRepository, change);
    assert.equal(check(assessRelayOnboarding(fixture), 'central-repository'), 'blocked');
  }
});

test('central controller requires protected branch, protected environment and both credential names', () => {
  const branch = trustedFixture(); branch.centralDefaultBranch.finalHeadOid = 'b'.repeat(40);
  assert.equal(check(assessRelayOnboarding(branch), 'central-trusted-branch'), 'blocked');
  const environment = trustedFixture(); environment.centralEnvironment.onlyReviewedDefaultBranch = false;
  assert.equal(check(assessRelayOnboarding(environment), 'central-environment'), 'blocked');
  const missing = trustedFixture(); missing.centralRuntimeSecrets.projectTokenExists = false;
  assert.equal(check(assessRelayOnboarding(missing), 'central-runtime-secrets'), 'needs-setup');
  delete missing.centralRuntimeSecrets.projectTokenExists;
  assert.equal(check(assessRelayOnboarding(missing), 'central-runtime-secrets'), 'unverified');
});

test('runtime probes must use the central environment and the intended project', () => {
  for (const change of [{ scopedTokenFromCentralRuntimeKey: false }, { credentialRepositoryId: 'other' }, { credentialEnvironmentName: 'other' }]) {
    const fixture = trustedFixture(); Object.assign(fixture.appInstallation, change);
    assert.equal(check(assessRelayOnboarding(fixture), 'app-installation'), 'blocked');
  }
  for (const change of [{ projectReadConfirmed: false }, { projectReadUsingEnvironmentSecret: false }, { projectId: 'other' }]) {
    const fixture = trustedFixture(); Object.assign(fixture.centralRuntimeSecrets, change);
    assert.equal(check(assessRelayOnboarding(fixture), 'central-runtime-secrets'), 'blocked');
  }
  const unknown = trustedFixture(); delete unknown.centralRuntimeSecrets.projectReadConfirmed;
  assert.equal(check(assessRelayOnboarding(unknown), 'central-runtime-secrets'), 'unverified');
  const keyMissing = trustedFixture(); keyMissing.centralRuntimeSecrets.appPrivateKeyExists = false;
  assert.equal(check(assessRelayOnboarding(keyMissing), 'central-runtime-secrets'), 'needs-setup');
});

test('missing boolean evidence stays unverified rather than being interpreted as absence', () => {
  for (const [key, prop, id] of [['repository', 'adminAccess', 'repository'],
    ['appInstallation', 'installedForRepository', 'app-installation'],
    ['environment', 'exists', 'relay-environment'], ['sender', 'exists', 'sender-workflow'],
    ['defaultBranch', 'protectedAgainstDirectWrites', 'trusted-default-branch']]) {
    const fixture = trustedFixture(); delete fixture[key][prop];
    assert.equal(check(assessRelayOnboarding(fixture), id), 'unverified');
  }
});

test('missing or partially read protection, environment, workflow and app are not guessed', () => {
  for (const [key, id] of [['repository', 'repository'], ['appInstallation', 'app-installation'],
    ['defaultBranch', 'trusted-default-branch'], ['environment', 'relay-environment'],
    ['sender', 'sender-workflow'], ['projectSecrets', 'existing-configuration']]) {
    const fixture = trustedFixture(); fixture[key].complete = false;
    const result = assessRelayOnboarding(fixture);
    assert.equal(result.kind, 'blocked'); assert.equal(check(result, id), 'unverified');
  }
  const fixture = trustedFixture(); fixture.environment.exists = false;
  assert.equal(check(assessRelayOnboarding(fixture), 'relay-environment'), 'needs-setup');
  fixture.environment.exists = true; fixture.environment.onlyReviewedDefaultBranch = false;
  assert.equal(check(assessRelayOnboarding(fixture), 'relay-environment'), 'blocked');
});
