import test from 'node:test';
import assert from 'node:assert/strict';
import { CHECKPOINT_UPDATE_REFS, createCheckpointRefTransport } from './flow-checkpoint-ref-transport.mjs';
import { CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';

const oid = char => char.repeat(40);
const reply = value => ({ status: 200, text: async () => JSON.stringify(value) });
function fixture() {
  const calls = [];
  const state = { private: true, repositoryId: 'repo-id', head: oid('a'), tree: oid('b'), commit: oid('c'), defaultBranch: 'main', mutation: 'ok' };
  const request = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body });
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, 'Bearer synthetic-app-token');
    if (url.endsWith('/installation/repositories')) return reply({ total_count: 1, repositories: [{ node_id: state.repositoryId,
      full_name: 'owner/project', private: state.private }] });
    if (url.endsWith('/repos/owner/project')) return reply({ node_id: state.repositoryId, full_name: 'owner/project',
      private: state.private, default_branch: state.defaultBranch });
    if (url.endsWith('/git/ref/heads/agent-github-flow/checkpoints')) return reply({ ref: CHECKPOINT_BRANCH_REF, object: { type: 'commit', sha: state.head } });
    if (url.endsWith('/git/ref/heads/agent-github-flow/checkpoint-anchor')) return reply({ ref: CHECKPOINT_ANCHOR_REF, object: { type: 'commit', sha: state.head } });
    if (url.endsWith(`/git/commits/${state.commit}`)) return reply({ sha: state.commit, tree: { sha: state.tree }, parents: [{ sha: state.head }] });
    if (url === 'https://api.github.com/graphql') {
      if (state.mutation === 'throw') throw Error('private response');
      if (state.mutation === 'rejected') return reply({ errors: [{ message: 'private' }] });
      return reply({ data: { updateRefs: { __typename: 'UpdateRefsPayload' } } });
    }
    throw Error('unexpected-url');
  };
  const build = () => createCheckpointRefTransport({ owner: 'owner', repo: 'project', repositoryId: 'repo-id',
    expectedHeadOid: oid('a'), expectedTreeOid: oid('b'), commitOid: oid('c'), appToken: 'synthetic-app-token', request });
  return { state, calls, build };
}

test('issues one conditional atomic update for the exact technical ref pair', async () => {
  const f = fixture(); const transport = f.build();
  assert.deepEqual(await transport.publish(), { kind: 'ref-update-acknowledged', retryAllowed: false });
  const writes = f.calls.filter(call => call.method === 'POST'); assert.equal(writes.length, 1);
  assert.equal(writes[0].url, 'https://api.github.com/graphql');
  assert.deepEqual(JSON.parse(writes[0].body), { query: CHECKPOINT_UPDATE_REFS, variables: { input: { repositoryId: 'repo-id', refUpdates: [
    { name: CHECKPOINT_BRANCH_REF, beforeOid: oid('a'), afterOid: oid('c'), force: false },
    { name: CHECKPOINT_ANCHOR_REF, beforeOid: oid('a'), afterOid: oid('c'), force: false },
  ] } } });
  assert.deepEqual(await transport.publish(), { kind: 'blocked', reason: 'ref-transport-already-used' });
});

test('rejects public, foreign or default technical branches without mutation', async () => {
  let f = fixture(); f.state.private = false; assert.deepEqual(await f.build().publish(), { kind: 'blocked', reason: 'scope-mismatch' });
  assert.equal(f.calls.filter(x => x.method === 'POST').length, 0);
  f = fixture(); f.state.repositoryId = 'other'; assert.deepEqual(await f.build().publish(), { kind: 'blocked', reason: 'scope-mismatch' });
  f = fixture(); f.state.defaultBranch = 'agent-github-flow/checkpoints';
  assert.deepEqual(await f.build().publish(), { kind: 'blocked', reason: 'repository-mismatch' });
  assert.equal(f.calls.filter(x => x.method === 'POST').length, 0);
});

test('blocks stale refs or wrong prepared tree before mutation', async () => {
  let f = fixture(); f.state.head = oid('d');
  assert.deepEqual(await f.build().publish(), { kind: 'blocked', reason: 'invalid-ref-plan' });
  assert.equal(f.calls.filter(x => x.method === 'POST').length, 0);
  f = fixture(); f.state.tree = oid('d');
  assert.deepEqual(await f.build().publish(), { kind: 'blocked', reason: 'invalid-ref-plan' });
});

test('does not retry errors or unknown mutation results', async () => {
  for (const mode of ['throw', 'rejected']) {
    const f = fixture(); f.state.mutation = mode; const transport = f.build();
    assert.deepEqual(await transport.publish(), { kind: 'ref-update-uncertain', retryAllowed: false });
    assert.deepEqual(await transport.publish(), { kind: 'blocked', reason: 'ref-transport-already-used' });
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  }
});
