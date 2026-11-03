import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlowReadTransports } from './flow-read-transports.mjs';
import { SPLIT_PROJECT_QUERY, BRANCH_PROJECT_QUERY, SPLIT_ISSUE_QUERY, BRANCH_ISSUE_QUERY } from './flow-github-split-project.mjs';
import { HANDOFF_QUERY } from './flow-handoff-reader.mjs';
import { EPOCH_QUERY } from './flow-epoch-reader.mjs';
import { NATIVE_EPOCH_QUERY } from './flow-native-epoch-reader.mjs';
import { ISSUE_IDENTITY_QUERY } from './flow-project-policy-resolver.mjs';
import { PROJECT_WRITE, ISSUE_WRITE } from '../test-support/legacy-flow-github-write.mjs';

const response = (value, link = null) => ({ status: 200, text: async () => JSON.stringify(value), headers: { get: name => name === 'link' ? link : null } });
const fixture = () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return options.method === 'GET' ? response([{ node_id: 'card', content_type: 'Issue', archived_at: null,
      content: { node_id: 'issue' } }]) : response({ data: { ok: true } });
  };
  return { calls, transports: createFlowReadTransports({ projectToken: 'project-token', issueToken: 'issue-token', request }) };
};

test('routes only approved GraphQL reads to the appropriate token and fixed endpoint', async () => {
  const { calls, transports } = fixture();
  assert.deepEqual(await transports.projectGraphql(SPLIT_PROJECT_QUERY, { number: 1 }), { data: { ok: true } });
  assert.deepEqual(await transports.issueGraphql(SPLIT_ISSUE_QUERY, { issue: 'issue' }), { data: { ok: true } });
  await transports.issueGraphql(HANDOFF_QUERY, {});
  await transports.issueGraphql(EPOCH_QUERY, {});
  await transports.issueGraphql(NATIVE_EPOCH_QUERY, {});
  assert.equal(calls.length, 5);
  for (const call of calls) { assert.equal(call.url, 'https://api.github.com/graphql'); assert.equal(call.options.method, 'POST');
    assert.equal(call.options.redirect, 'error'); assert.ok(call.options.signal instanceof AbortSignal); }
  assert.equal(calls[0].options.headers.Authorization, 'Bearer project-token');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer issue-token');
  assert.equal(calls[2].options.headers.Authorization, 'Bearer issue-token');
  assert.equal(calls[3].options.headers.Authorization, 'Bearer issue-token');
  assert.equal(calls[4].options.headers.Authorization, 'Bearer issue-token');
  assert.throws(() => transports.projectGraphql(PROJECT_WRITE, {}), /unsupported-read/);
  assert.throws(() => transports.issueGraphql(ISSUE_WRITE, {}), /unsupported-read/);
  assert.throws(() => transports.issueGraphql(SPLIT_PROJECT_QUERY, {}), /unsupported-read/);
  assert.equal(calls.length, 5);
});

test('uses project token and a fixed GET endpoint for Project item bindings', async () => {
  const { calls, transports } = fixture();
  assert.deepEqual(await transports.listItems({ owner: 'owner', projectNumber: 13, after: null }),
    { items: [{ nodeId: 'card', contentNodeId: 'issue', contentType: 'Issue', archived: false }], nextCursor: null });
  assert.equal(calls[0].url, 'https://api.github.com/users/owner/projectsV2/13/items?per_page=100');
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.headers.Authorization, 'Bearer project-token');
  assert.equal(Object.hasOwn(calls[0].options, 'body'), false);
});

test('routes the branch-checkpoint Project query to the Project token only', async () => {
  const { calls, transports } = fixture();
  await transports.projectGraphql(BRANCH_PROJECT_QUERY, {});
  assert.equal(calls[0].options.headers.Authorization, 'Bearer project-token');
  assert.throws(() => transports.issueGraphql(BRANCH_PROJECT_QUERY, {}), /unsupported-read/);
  assert.equal(calls.length, 1);
  await transports.issueGraphql(BRANCH_ISSUE_QUERY, {});
  assert.equal(calls[1].options.headers.Authorization, 'Bearer issue-token');
  assert.throws(() => transports.projectGraphql(BRANCH_ISSUE_QUERY, {}), /unsupported-read/);
});

test('routes the issue identity query exclusively through the App token',async()=>{
  const {calls,transports}=fixture();await transports.issueGraphql(ISSUE_IDENTITY_QUERY,{owner:'owner',repo:'project',number:1});
  assert.equal(calls[0].options.headers.Authorization,'Bearer issue-token');
  assert.throws(()=>transports.projectGraphql(ISSUE_IDENTITY_QUERY,{}),/unsupported-read/);
});

test('rejects invalid credentials and sanitizes transport or response failures', async () => {
  assert.throws(() => createFlowReadTransports({ projectToken: 'line\nbreak', issueToken: 'issue', request: async () => {} }), /invalid-read-transport/);
  let attempts = 0;
  const failing = createFlowReadTransports({ projectToken: 'project-token', issueToken: 'issue-token',
    request: async () => { attempts += 1; throw Error('sensitive response'); } });
  await assert.rejects(failing.projectGraphql(SPLIT_PROJECT_QUERY, {}), { message: 'github-read-failed' });
  assert.equal(attempts, 1);
  const bad = createFlowReadTransports({ projectToken: 'project-token', issueToken: 'issue-token',
    request: async () => ({ status: 403, text: async () => 'sensitive response', headers: { get: () => null } }) });
  await assert.rejects(bad.issueGraphql(SPLIT_ISSUE_QUERY, {}), { message: 'github-read-failed' });
  const large = createFlowReadTransports({ projectToken: 'project-token', issueToken: 'issue-token',
    request: async () => ({ status: 200, text: async () => 'x'.repeat(8_000_001), headers: { get: () => null } }) });
  await assert.rejects(large.projectGraphql(SPLIT_PROJECT_QUERY, {}), { message: 'github-read-failed' });
});
