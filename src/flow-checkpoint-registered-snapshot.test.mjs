import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readRegisteredCheckpointSnapshot } from './flow-checkpoint-registered-snapshot.mjs';
import { encodeCheckpointRecord } from './flow-checkpoint-record.mjs';

const blob = content => { const bytes = Buffer.from(content);
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  return { sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') }; };
const fixture = () => {
  const genesisOid = 'a'.repeat(40); const headOid = 'b'.repeat(40); const treeOid = 'c'.repeat(40);
  const registration = { repositoryId: 'repo', ref: 'refs/heads/agent-github-flow/checkpoints', genesisOid,
    cutoverAt: '2026-01-01T10:00:00Z' };
  const record = { version: 1, repositoryId: 'repo', number: 1, issueId: 'issue', cutoverAt: registration.cutoverAt,
    epoch: { kind: 'initial', anchor: 'issue' }, reentry: null,
    current: { phase: 'committed', commentId: '1', digest: 'd'.repeat(64), fromStatus: 'needs-design', targetStatus: 'agent-ready',
      createdAt: '2026-01-01T10:01:00Z', epoch: { kind: 'initial', anchor: 'issue' } }, previous: null };
  const recordBlob = blob(encodeCheckpointRecord(record).content);
  const indexBlob = blob('{"version":1,"repositoryId":"repo","issues":[{"number":1,"issueId":"issue"}]}');
  const blobs = new Map([[recordBlob.sha, recordBlob], [indexBlob.sha, indexBlob]]);
  const ref = () => ({ ref: registration.ref, object: { type: 'commit', sha: headOid } });
  return { registration, record, blobs, args: { registration, selection: { number: 1, issueId: 'issue' },
    readRepository: async () => ({ node_id: 'repo', full_name: 'owner/project', default_branch: 'main' }), readRef: async () => ref(),
    compare: async () => ({ status: 'ahead', ahead_by: 1, behind_by: 0, base_commit: { sha: genesisOid },
      merge_base_commit: { sha: genesisOid }, commits: [{ sha: headOid }] }),
    readCommit: async () => ({ sha: headOid, tree: { sha: treeOid } }),
    readTree: async () => ({ sha: treeOid, truncated: false, tree: [
      { path: 'index.json', type: 'blob', mode: '100644', sha: indexBlob.sha, size: indexBlob.size },
      { path: 'issues', type: 'tree', mode: '040000', sha: 'e'.repeat(40) },
      { path: 'issues/1.json', type: 'blob', mode: '100644', sha: recordBlob.sha, size: recordBlob.size },
    ] }), readBlob: async oid => blobs.get(oid),
  } };
};

test('returns only a selected record after stable registration and complete structural checks', async () => {
  const f = fixture(); const result = await readRegisteredCheckpointSnapshot(f.args);
  assert.equal(result.kind, 'checkpoint-snapshot-observed'); assert.equal(result.rollbackProtected, false);
  assert.equal(result.repositoryFullName, 'owner/project'); assert.equal(result.cutoverAt, f.registration.cutoverAt);
  assert.deepEqual(result.selection, f.args.selection);
  assert.deepEqual(result.selectedRecord, f.record);
  f.args.selection = { number: 2, issueId: 'other' };
  assert.equal((await readRegisteredCheckpointSnapshot(f.args)).selectedRecord, null);
});

test('blocks a changed head, cutover or incomplete record without returning data', async () => {
  let f = fixture(); let refReads = 0; const originalRef = f.args.readRef;
  f.args.readRef = async () => { const ref = await originalRef(); if (++refReads > 2) ref.object.sha = 'f'.repeat(40); return ref; };
  assert.equal((await readRegisteredCheckpointSnapshot(f.args)).kind, 'blocked');
  f = fixture(); f.registration.cutoverAt = '2026-01-01T09:59:00Z';
  assert.equal((await readRegisteredCheckpointSnapshot(f.args)).reason, 'cutover-mismatch');
  f = fixture(); f.args.readBlob = async () => { throw Error('unavailable'); };
  const result = await readRegisteredCheckpointSnapshot(f.args);
  assert.equal(result.kind, 'blocked'); assert.equal(Object.hasOwn(result, 'selectedRecord'), false);
  f = fixture(); f.args.readCommit = async () => ({ sha: 'f'.repeat(40), tree: { sha: 'c'.repeat(40) } });
  assert.equal((await readRegisteredCheckpointSnapshot(f.args)).reason, 'invalid-commit');
});
