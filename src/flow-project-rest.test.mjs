import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectItemsReader } from './flow-project-rest.mjs';

const item = { node_id: 'item', content_type: 'Issue', content: { node_id: 'issue' }, archived_at: null };
const response = (link = null, data = [item]) => ({ status: 200, headers: { get: name => name === 'link' ? link : null }, json: async () => data });

test('constructs the fixed GitHub endpoint and extracts only the next cursor', async () => {
  const calls = [];
  const read = createProjectItemsReader({ request: async url => { calls.push(url);
    return response('<https://api.github.com/user/123/projectsV2/13/items?per_page=100&after=YWJj%3D>; rel="next"'); } });
  const page = await read({ owner: 'Owner', projectNumber: 13, after: null });
  assert.deepEqual(page, { items: [{ nodeId: 'item', contentNodeId: 'issue', contentType: 'Issue', archived: false }], nextCursor: 'YWJj=' });
  assert.equal(calls[0], 'https://api.github.com/users/Owner/projectsV2/13/items?per_page=100');
  await read({ owner: 'Owner', projectNumber: 13, after: page.nextCursor });
  assert.equal(calls[1], 'https://api.github.com/users/Owner/projectsV2/13/items?per_page=100&after=YWJj%3D');
});

test('does not follow a forged external or unrelated Project pagination URL', async () => {
  for (const link of ['<https://evil.example/user/123/projectsV2/13/items?after=abc>; rel="next"',
    '<https://api.github.com/user/123/projectsV2/14/items?after=abc>; rel="next"',
    '<https://api.github.com/user/123/projectsV2/13/items?after=abc&after=def>; rel="next"', 'broken']) {
    const read = createProjectItemsReader({ request: async () => response(link) });
    await assert.rejects(read({ owner: 'Owner', projectNumber: 13, after: null }), /invalid-link/);
  }
});

test('rejects invalid owner, cursors, HTTP responses and malformed pages', async () => {
  let calls = 0; const read = createProjectItemsReader({ request: async () => { calls += 1; return response(); } });
  await assert.rejects(read({ owner: '../escape', projectNumber: 13, after: null }), /invalid-input/);
  await assert.rejects(read({ owner: 'Owner', projectNumber: 13, after: '\n' }), /invalid-input/); assert.equal(calls, 0);
  await assert.rejects(createProjectItemsReader({ request: async () => ({ status: 403 }) })({ owner: 'Owner', projectNumber: 13, after: null }), /request-failed/);
  await assert.rejects(createProjectItemsReader({ request: async () => response(null, [{ ...item, archived_at: undefined }]) })({ owner: 'Owner', projectNumber: 13, after: null }), /invalid-item/);
});
