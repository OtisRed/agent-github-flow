import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFlowReadTransports } from './flow-read-transports.mjs';
import { createCheckpointGitReader } from './flow-checkpoint-git-reader.mjs';
import { readCheckpointTreePlan } from './flow-checkpoint-tree-reader.mjs';

test('uses the App token and exact read-only commit, recursive tree and blob URLs', async () => {
  const calls = [];
  const transports = createFlowReadTransports({ projectToken: 'project-token', issueToken: 'app-token', request: async (url, options) => {
    calls.push({ url, options }); return { status: 200, text: async () => '{}', headers: { get: () => null } };
  } });
  const reader = transports.checkpointGit({ owner: 'owner', repo: 'project.name' });
  const sha = 'a'.repeat(40);
  await reader.readCommit(sha); await reader.readTree(sha, { recursive: true }); await reader.readBlob(sha);
  assert.deepEqual(calls.map(c => c.url), [
    `https://api.github.com/repos/owner/project.name/git/commits/${sha}`,
    `https://api.github.com/repos/owner/project.name/git/trees/${sha}?recursive=1`,
    `https://api.github.com/repos/owner/project.name/git/blobs/${sha}`,
  ]);
  for (const call of calls) {
    assert.equal(call.options.method, 'GET'); assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers.Authorization, 'Bearer app-token');
    assert.equal(Object.hasOwn(call.options, 'body'), false);
  }
});

test('rejects untrusted repository paths, invalid object IDs and nonrecursive trees', () => {
  const request = () => { throw Error('should not call'); };
  for (const repo of ['../other', '.', '..', 'name?x=1', 'name/other', '%2e%2e']) {
    assert.throws(() => createCheckpointGitReader({ owner: 'owner', repo, request }), /invalid-checkpoint-reader/);
  }
  assert.throws(() => createCheckpointGitReader({ owner: 'owner@attacker', repo: 'repo', request }), /invalid-checkpoint-reader/);
  const reader = createCheckpointGitReader({ owner: 'owner', repo: 'repo', request });
  assert.throws(() => reader.readBlob('../etc'), /invalid-oid/);
  assert.throws(() => reader.readTree('a'.repeat(40), { recursive: false }), /recursive-read-required/);
  assert.throws(() => reader.readTree('a'.repeat(40), { recursive: true, extra: true }), /recursive-read-required/);
});

test('composes the authenticated reader with the commit-bound tree planner', async () => {
  const commitOid = 'a'.repeat(40); const treeOid = 'b'.repeat(40);
  const bytes = Buffer.from('{"version":1,"repositoryId":"repo-node","issues":[]}');
  const blobOid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const replies = [ { sha: commitOid, tree: { sha: treeOid } },
    { sha: treeOid, truncated: false, tree: [{ path: 'index.json', type: 'blob', mode: '100644', sha: blobOid, size: bytes.length }] },
    { sha: blobOid, encoding: 'base64', size: bytes.length, content: bytes.toString('base64') } ];
  const transports = createFlowReadTransports({ projectToken: 'project-token', issueToken: 'app-token', request: async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer app-token');
    return { status: 200, text: async () => JSON.stringify(replies.shift()), headers: { get: () => null } };
  } });
  const reader = transports.checkpointGit({ owner: 'owner', repo: 'repo' });
  const result = await readCheckpointTreePlan({ ...reader, commitOid, repositoryId: 'repo-node' });
  assert.equal(result.kind, 'record-reads-planned'); assert.deepEqual(result.records, []); assert.equal(replies.length, 0);
});
