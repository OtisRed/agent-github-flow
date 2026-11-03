import test from 'node:test';
import assert from 'node:assert/strict';
import { BRANCH_STATUS_UPDATE, createBranchStatusTransport } from './flow-project-status-transport.mjs';

const response = value => ({ status: 200, text: async () => JSON.stringify(value) });
const ok = { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item' } } } };
test('sends only the bound Project status mutation to the fixed GitHub endpoint', async () => {
  const calls = [];
  const transport = createBranchStatusTransport({ projectToken: 'token', projectId: 'project', statusFieldId: 'status',
    request: async (url, options) => { calls.push({ url, options }); return response(ok); } });
  assert.equal(Object.isFrozen(transport), true); assert.equal(transport.projectId, 'project'); assert.equal(transport.statusFieldId, 'status');
  assert.deepEqual(await transport.setStatus({ itemId: 'item', targetOptionId: 'ready' }), { kind: 'status-write-acknowledged' });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.github.com/graphql');
  assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal); assert.equal(calls[0].options.headers.Authorization, 'Bearer token');
  assert.deepEqual(JSON.parse(calls[0].options.body), { query: BRANCH_STATUS_UPDATE, variables: { project: 'project', item: 'item',
    field: 'status', value: { singleSelectOptionId: 'ready' } } });
});

test('unknown responses, errors and timeouts stay uncertain without retry or leakage', async () => {
  for (const result of [{ status: 403 }, response({ errors: [{ message: 'private data' }] }),
    response({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'other' } } } }),
    { status: 200, text: async () => 'x'.repeat(1_000_001) }, null]) {
    let calls = 0; const transport = createBranchStatusTransport({ projectToken: 'token', projectId: 'project', statusFieldId: 'status',
      request: async () => { calls += 1; if (result === null) throw Error('private'); return result; } });
    assert.deepEqual(await transport.setStatus({ itemId: 'item', targetOptionId: 'ready' }), { kind: 'status-write-uncertain' });
    assert.equal(calls, 1);
  }
});

test('rejects invalid configuration and target without invoking the transport', async () => {
  let calls = 0; const request = async () => { calls += 1; return response(ok); };
  assert.throws(() => createBranchStatusTransport({ projectToken: 'token\nvalue', projectId: 'project', statusFieldId: 'status', request }),
    /invalid-status-transport/);
  const transport = createBranchStatusTransport({ projectToken: 'token', projectId: 'project', statusFieldId: 'status', request });
  await assert.rejects(transport.setStatus({ itemId: 'item', targetOptionId: 'bad\nid' }), /invalid-status-target/);
  assert.equal(calls, 0);
});
