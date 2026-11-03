import test from 'node:test';
import assert from 'node:assert/strict';
import { readCheckpointRegistration } from './flow-checkpoint-registration-reader.mjs';
import { createCheckpointGitReader } from './flow-checkpoint-git-reader.mjs';
import { CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';

const fixture = () => {
  const calls = []; const genesisOid = 'a'.repeat(40); const headOid = 'b'.repeat(40);
  const registration = { repositoryId: 'repo-id', ref: 'refs/heads/agent-github-flow/checkpoints', genesisOid, cutoverAt: '2026-01-01T10:00:00Z' };
  const ref = name => ({ ref: name, object: { type: 'commit', sha: headOid } });
  return { calls, registration, args: { registration,
    readRepository: async () => { calls.push('repository'); return { node_id: 'repo-id', full_name: 'owner/project', default_branch: 'main' }; },
    readRef: async value => { calls.push(['ref', value]); return ref(value); },
    compare: async (base, head) => { calls.push(['compare', base, head]); return { status: 'ahead', ahead_by: 1, behind_by: 0,
      base_commit: { sha: genesisOid }, merge_base_commit: { sha: genesisOid }, commits: [{ sha: headOid }] }; },
  } };
};

test('reads the bound repository, exact ref and comparison, then rechecks the snapshot', async () => {
  const f = fixture(); const result = await readCheckpointRegistration(f.args);
  assert.deepEqual(result, { kind: 'genesis-ancestry-observed', headOid: 'b'.repeat(40), rollbackProtected: false,
    repositoryFullName: 'owner/project', pairedRefs: true });
  assert.deepEqual(f.calls, ['repository', ['ref', f.registration.ref], ['ref', CHECKPOINT_ANCHOR_REF],
    ['compare', 'a'.repeat(40), 'b'.repeat(40)], ['ref', f.registration.ref], ['ref', CHECKPOINT_ANCHOR_REF], 'repository']);
});

test('blocks absent configuration, wrong repository, failures and moved refs', async () => {
  let f = fixture(); f.args.registration = null;
  assert.equal((await readCheckpointRegistration(f.args)).reason, 'not-registered'); assert.equal(f.calls.length, 0);
  f = fixture(); f.args.readRepository = async () => ({ node_id: 'wrong' });
  assert.equal((await readCheckpointRegistration(f.args)).reason, 'repository-mismatch');
  f = fixture(); f.args.readRepository = async () => ({ node_id: 'repo-id', full_name: 'owner/project', default_branch: 'agent-github-flow/checkpoints' });
  assert.equal((await readCheckpointRegistration(f.args)).reason, 'checkpoint-ref-is-default');
  f = fixture(); f.args.readRepository = async () => ({ node_id: 'repo-id', full_name: 'owner/project', default_branch: 'agent-github-flow/checkpoint-anchor' });
  assert.equal((await readCheckpointRegistration(f.args)).reason, 'checkpoint-ref-is-default');
  f = fixture(); f.args.readRepository = async () => ({ node_id: 'repo-id', full_name: 'owner/project' });
  assert.equal((await readCheckpointRegistration(f.args)).reason, 'invalid-default-branch');
  f = fixture(); f.args.readRef = async () => { throw Error('missing'); };
  assert.equal((await readCheckpointRegistration(f.args)).reason, 'registration-read-failed');
  f = fixture(); let reads = 0; const original = f.args.readRef;
  f.args.readRef = async (...args) => { const result = await original(...args); if (++reads === 3) result.object.sha = 'c'.repeat(40); return result; };
  assert.equal((await readCheckpointRegistration(f.args)).reason, 'registration-snapshot-changed');
  f = fixture(); let repoReads = 0; const originalRepo = f.args.readRepository;
  f.args.readRepository = async () => { const result = await originalRepo(); if (++repoReads === 2) result.full_name = 'owner/renamed'; return result; };
  assert.equal((await readCheckpointRegistration(f.args)).reason, 'registration-snapshot-changed');
});

test('constructs only fixed read-only ref and unpaginated compare endpoints', async () => {
  const urls = []; const reader = createCheckpointGitReader({ owner: 'owner', repo: 'repo', request: async url => { urls.push(url); return {}; } });
  await reader.readRepository(); await reader.readRef('refs/heads/agent-github-flow/checkpoints'); await reader.compare('a'.repeat(40), 'b'.repeat(40));
  assert.deepEqual(urls, ['https://api.github.com/repos/owner/repo',
    'https://api.github.com/repos/owner/repo/git/ref/heads/agent-github-flow/checkpoints',
    `https://api.github.com/repos/owner/repo/compare/${'a'.repeat(40)}...${'b'.repeat(40)}`]);
  assert.throws(() => reader.readRef('refs/heads/../../main'), /invalid-ref/);
  assert.throws(() => reader.compare('../oops', 'b'.repeat(40)), /invalid-oid/);
});

test('keeps a changed final ref even when a later repository response mutates its original object', async () => {
  const f = fixture(); const originalRef = f.args.readRef; let reads = 0; let finalRef;
  f.args.readRef = async (...args) => { const result = await originalRef(...args);
    if (++reads === 3) { result.object.sha = 'c'.repeat(40); finalRef = result; } return result; };
  const originalRepository = f.args.readRepository;
  f.args.readRepository = async () => { const result = await originalRepository();
    if (finalRef) finalRef.object.sha = 'b'.repeat(40); return result; };
  assert.equal((await readCheckpointRegistration(f.args)).reason, 'registration-snapshot-changed');
});

test('blocks a missing or changed checkpoint anchor', async () => {
  let f = fixture(); const original = f.args.readRef;
  f.args.readRef = async name => name === CHECKPOINT_ANCHOR_REF ? null : original(name);
  assert.equal((await readCheckpointRegistration(f.args)).reason, 'anchor-mismatch');
  f = fixture(); const original2 = f.args.readRef; let anchorReads = 0;
  f.args.readRef = async name => { const result = await original2(name);
    if (name === CHECKPOINT_ANCHOR_REF && ++anchorReads === 2) result.object.sha = 'c'.repeat(40); return result; };
  assert.equal((await readCheckpointRegistration(f.args)).reason, 'registration-snapshot-changed');
});

test('keeps the captured registration and ref when earlier transport objects are mutated', async () => {
  const f = fixture(); const originalRef = f.args.readRef; const originalCompare = f.args.compare;
  let sharedRef;
  f.args.readRef = async (...args) => { const current = await originalRef(...args); if (!sharedRef) sharedRef = current; return current; };
  f.args.compare = async (...args) => { sharedRef.object.sha = 'c'.repeat(40); f.registration.genesisOid = 'd'.repeat(40);
    return originalCompare(...args); };
  const result = await readCheckpointRegistration(f.args);
  assert.equal(result.kind, 'genesis-ancestry-observed'); assert.equal(result.headOid, 'b'.repeat(40));
});
