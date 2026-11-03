import test from 'node:test';
import assert from 'node:assert/strict';
import { stageNextRelayCredential } from './relay-rotation.mjs';

const policy = { repositoryId: 'repo-id', head: 'a'.repeat(40), workflowBlob: 'b'.repeat(40), workflowInventoryDigest: 'd'.repeat(64) };
function fixture(next = false) {
  return {
    repository: { complete: true, nodeId: 'repo-id', identityMatches: true, archived: false, admin: true, defaultBranch: 'main' },
    branch: { complete: true, name: 'main', head: policy.head },
    protection: { complete: true, adminEnforced: true, prRequired: true, approvals: 0, codeownerRequired: false,
      lastPushApproval: false, allowForcePush: false, allowDeletion: false },
    environment: { complete: true, exists: true, customBranchPolicies: true },
    branchPolicies: { complete: true, onlyMain: true },
    secrets: { complete: true, sourcePresent: true, activePresent: true, nextInEnvironment: next, nextInRepository: false },
    variables: { complete: true, targetMatches: true },
    caller: { complete: true, blob: policy.workflowBlob },
    workflowInventory: { complete: true, head: policy.head, digest: policy.workflowInventoryDigest },
  };
}
const fake = 'github_pat_synthetic_not_a_real_credential';

test('stages only the separate next slot after two matching observations', async () => {
  let reads = 0, writes = 0;
  const result = await stageNextRelayCredential({ policy, observe: async () => fixture(reads++ === 2),
    readCredential: async () => fake, writeCredential: async value => { assert.equal(value, fake); writes++; return true; } });
  assert.deepEqual(result, { state: 'staged-unverified' });
  assert.equal(reads, 3); assert.equal(writes, 1);
});

test('any existing next slot, missing protection or stale head blocks a write', async () => {
  const cases = [s => { s.secrets.nextInEnvironment = true; }, s => { s.secrets.nextInRepository = true; },
    s => { s.protection.adminEnforced = false; }, s => { s.protection.approvals = 1; },
    s => { s.branchPolicies.onlyMain = false; }, s => { s.branch.head = 'c'.repeat(40); },
    s => { s.caller.blob = 'c'.repeat(40); }, s => { s.repository.nodeId = 'other'; },
    s => { s.workflowInventory.digest = 'e'.repeat(64); }, s => { s.workflowInventory.head = 'c'.repeat(40); },
    s => { s.secrets.complete = false; }];
  for (const change of cases) {
    let writes = 0; const s = fixture(); change(s);
    const result = await stageNextRelayCredential({ policy, observe: async () => s,
      readCredential: async () => fake, writeCredential: async () => { writes++; return true; } });
    assert.equal(result.state, 'blocked'); assert.equal(writes, 0);
  }
});

test('a change immediately before writing stops without touching the existing configuration', async () => {
  let reads = 0, writes = 0;
  const result = await stageNextRelayCredential({ policy, observe: async () => fixture(reads++ === 1),
    readCredential: async () => fake, writeCredential: async () => { writes++; return true; } });
  assert.equal(result.state, 'blocked'); assert.equal(writes, 0);
});

test('an attempted write with unknown outcome is never retried or called successful', async () => {
  for (const writeCredential of [async () => false, async () => { throw new Error('unknown'); }, async () => true]) {
    let writes = 0;
    const result = await stageNextRelayCredential({ policy, observe: async () => fixture(false), readCredential: async () => fake,
      writeCredential: async value => { writes++; return writeCredential(value); } });
    assert.equal(result.state, 'uncertain-no-retry'); assert.equal(writes, 1);
  }
});

test('post-write identity change remains uncertain even when next slot appears', async () => {
  let reads = 0;
  const result = await stageNextRelayCredential({ policy, observe: async () => {
    const snapshot = fixture(reads++ === 2);
    if (reads === 3) snapshot.repository.nodeId = 'other';
    return snapshot;
  }, readCredential: async () => fake, writeCredential: async () => true });
  assert.equal(result.state, 'uncertain-no-retry');
});
