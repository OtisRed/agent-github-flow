import test from 'node:test';
import assert from 'node:assert/strict';
import { observeCheckpointGenesis } from './flow-checkpoint-registration.mjs';

const fixture = () => {
  const genesisOid = 'a'.repeat(40); const headOid = 'b'.repeat(40); const ref = 'refs/heads/agent-github-flow/checkpoints';
  return { registration: { repositoryId: 'repo', ref, genesisOid, cutoverAt: '2026-01-01T10:00:00Z' }, repositoryId: 'repo',
    ref: { ref, object: { type: 'commit', sha: headOid } },
    comparison: { status: 'ahead', ahead_by: 1, behind_by: 0, base_commit: { sha: genesisOid },
      merge_base_commit: { sha: genesisOid }, commits: [{ sha: headOid }] } };
};
const rejected = (change, reason) => { const v = fixture(); change(v); assert.equal(observeCheckpointGenesis(v).reason, reason); };

test('observes genesis ancestry without claiming rollback protection', () => {
  const value = fixture(); assert.deepEqual(observeCheckpointGenesis(value),
    { kind: 'genesis-ancestry-observed', headOid: 'b'.repeat(40), rollbackProtected: false });
  value.ref.object.sha = value.registration.genesisOid;
  value.comparison.status = 'identical'; value.comparison.ahead_by = 0; value.comparison.commits = [];
  assert.equal(observeCheckpointGenesis(value).kind, 'genesis-ancestry-observed');
});

test('accepts an unpaginated comparison over 250 commits when its last commit is the requested head', () => {
  const value = fixture(); value.comparison.ahead_by = 500;
  value.comparison.commits = Array.from({ length: 249 }, () => ({ sha: 'c'.repeat(40) }));
  value.comparison.commits.push({ sha: value.ref.object.sha });
  assert.equal(observeCheckpointGenesis(value).kind, 'genesis-ancestry-observed');
});

test('blocks missing registration, foreign repositories and missing or mismatched refs', () => {
  rejected(v => { v.registration = null; }, 'not-registered');
  rejected(v => { v.repositoryId = 'other'; }, 'repository-mismatch');
  rejected(v => { v.ref = null; }, 'missing-ref');
  rejected(v => { v.ref.ref = 'refs/heads/main'; }, 'invalid-ref');
  rejected(v => { v.ref.object.type = 'tag'; }, 'invalid-ref');
});

test('blocks invalid registration names, invalid ancestry and wrong compared head', () => {
  rejected(v => { v.registration.ref = 'refs/heads/../main'; }, 'invalid-registration');
  rejected(v => { v.registration.ref = 'refs/heads/thing.lock'; }, 'invalid-registration');
  rejected(v => { v.registration.ref = 'refs/heads/main'; }, 'invalid-registration');
  rejected(v => { v.registration.ref = 'refs/heads/smoke'; }, 'invalid-registration');
  rejected(v => { v.registration.cutoverAt = 'invalid'; }, 'invalid-registration');
  rejected(v => { v.comparison.status = 'diverged'; }, 'invalid-ancestry');
  rejected(v => { v.comparison.merge_base_commit.sha = 'c'.repeat(40); }, 'invalid-ancestry');
  rejected(v => { v.comparison.commits[0].sha = 'c'.repeat(40); }, 'invalid-ancestry');
  rejected(v => { v.comparison.behind_by = 1; }, 'invalid-ancestry');
});
