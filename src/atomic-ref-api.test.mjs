import test from 'node:test';
import assert from 'node:assert/strict';
import { createAtomicRefApiTransport, validAtomicRefTarget, validAtomicRefIdentity } from './atomic-ref-api.mjs';

const suffix = 'ab'.repeat(10); const names = [`refs/heads/probe/agf-atomic-${suffix}/a`, `refs/heads/probe/agf-atomic-${suffix}/b`];
const response = data => ({ status: 200, text: async () => JSON.stringify(data) });
const fixture = () => {
  const calls = []; const queue = [
    { total_count: 1, repositories: [{ node_id: 'repo-id', full_name: 'owner/repo', private: true }] },
    { data: { repository: { id: 'repo-id', nameWithOwner: 'owner/repo', isPrivate: true,
      defaultBranchRef: { name: 'main', target: { oid: 'b'.repeat(40), parents: { nodes: [{ oid: 'a'.repeat(40) }] } } } } } },
  ];
  const request = async (url, options) => { calls.push({ url, options }); return response(queue.shift()); };
  const transport = createAtomicRefApiTransport({ owner: 'owner', repo: 'repo', expectedSlug: 'app', actualSlug: 'app', token: 'test-token',
    expectedRepositoryId: 'repo-id', expectedHead: 'b'.repeat(40), expectedParent: 'a'.repeat(40), request });
  return { calls, queue, transport };
};

test('validates exactly one owner and repository before token creation', () => {
  assert.equal(validAtomicRefTarget('owner', 'repo.name'), true);
  for (const value of ['repo,other', 'repo\nother', '../repo', '.', '..', 'repo/other']) assert.equal(validAtomicRefTarget('owner', value), false);
  assert.equal(validAtomicRefTarget('owner\nother', 'repo'), false);
  assert.equal(validAtomicRefIdentity('repo-id', 'b'.repeat(40), 'a'.repeat(40)), true);
  assert.equal(validAtomicRefIdentity('repo-id', 'a'.repeat(40), 'a'.repeat(40)), false);
  assert.throws(() => createAtomicRefApiTransport({ owner: 'owner', repo: 'repo', expectedSlug: 'app', actualSlug: 'other', token: 'test' }), /invalid-probe-configuration/);
});

test('verifies one private installation repository with fixed endpoints and no redirects', async () => {
  const f = fixture(); const value = await f.transport.initial();
  assert.equal(value.repositoryId, 'repo-id'); assert.equal(value.scopeVerified, true); assert.equal(value.private, true);
  assert.deepEqual(f.calls.map(call => call.url), ['https://api.github.com/installation/repositories', 'https://api.github.com/graphql']);
  for (const call of f.calls) {
    assert.equal(call.options.redirect, 'error'); assert.equal(call.options.headers.Authorization, 'Bearer test-token');
    assert.ok(call.options.signal instanceof AbortSignal);
  }
});

test('rejects wrong scope or repository identity without exposing API contents', async () => {
  let f = fixture(); f.queue[0].repositories.push({ node_id: 'other' }); f.queue[0].total_count = 2;
  await assert.rejects(f.transport.initial(), { message: 'scope' }); assert.equal(f.calls.length, 1);
  f = fixture(); f.queue[1].data.repository.id = 'other';
  await assert.rejects(f.transport.initial(), { message: 'identity' });
});

test('permits only the generated ref pair and sanitizes unknown mutation failures', async () => {
  const f = fixture(); await f.transport.initial();
  const updates = names.map(name => ({ name, beforeOid: 'a'.repeat(40), afterOid: 'b'.repeat(40), force: false }));
  const current = { data: { repository: { id: 'repo-id', nameWithOwner: 'owner/repo', isPrivate: true,
    defaultBranchRef: { name: 'main', target: { oid: 'b'.repeat(40), parents: { nodes: [{ oid: 'a'.repeat(40) }] } } } } } };
  f.queue.push(structuredClone(current));
  f.queue.push({ data: { updateRefs: { __typename: 'UpdateRefsPayload' } } });
  assert.deepEqual(await f.transport.update({ repositoryId: 'repo-id', refUpdates: updates }), { kind: 'ok' });
  const wrong = structuredClone(updates); wrong[0].name = 'refs/heads/main';
  await assert.rejects(f.transport.update({ repositoryId: 'repo-id', refUpdates: wrong }), { message: 'invalid-input' });
  f.queue.push(structuredClone(current)); f.queue.push({ errors: [{ message: 'private diagnostic' }] });
  assert.deepEqual(await f.transport.update({ repositoryId: 'repo-id', refUpdates: updates }), { kind: 'rejected', staleConfirmed: false });
  current.data.repository.defaultBranchRef.target.oid = 'c'.repeat(40); f.queue.push(current);
  assert.deepEqual(await f.transport.update({ repositoryId: 'repo-id', refUpdates: updates }), { kind: 'unknown' });
});
