import test from 'node:test';
import assert from 'node:assert/strict';
import { runReadOnlyFlowPreflight } from './flow-readonly-preflight.mjs';
import { SPLIT_PROJECT_QUERY, SPLIT_ISSUE_QUERY } from './flow-github-split-project.mjs';
import { HANDOFF_QUERY } from './flow-handoff-reader.mjs';
import { EPOCH_QUERY } from './flow-epoch-reader.mjs';
import { NATIVE_EPOCH_QUERY } from './flow-native-epoch-reader.mjs';
import { createFlowReadTransports } from './flow-read-transports.mjs';

const text = '[FLOW]\nRola: Designer\nStan docelowy: agent-ready\nWykonano: Praca\nNastępny krok: Dalej';
const timestamp = '2026-01-01T00:00:00Z';
const created = '2026-01-01T00:00:02Z';
const updated = '2026-01-01T00:10:00Z';
function fixture({ absent = false, change = false } = {}) {
  let projectReads = 0;
  const calls = [];
  const projectGraphql = async query => {
    calls.push(query); assert.equal(query, SPLIT_PROJECT_QUERY); projectReads += 1;
    const ready = change && projectReads > 2;
    return { data: { user: { projectV2: { id: 'project' } }, node: { id: 'item', isArchived: false,
      project: { id: 'project', statusField: { id: 'status', name: 'Status', dataType: 'SINGLE_SELECT',
        options: [{ id: 'design', name: 'needs-design' }, { id: 'ready', name: 'agent-ready' }] },
      checkpointField: { id: 'checkpoint', name: 'Checkpoint', dataType: 'TEXT' } },
      status: { name: ready ? 'agent-ready' : 'needs-design', optionId: ready ? 'ready' : 'design', field: { id: 'status' } },
      checkpoint: null } } };
  };
  const issueGraphql = async query => {
    calls.push(query);
    if (query === SPLIT_ISSUE_QUERY) return { data: { node: { id: 'issue', number: 1, state: 'OPEN', body: 'Body',
      updatedAt: updated, repository: { nameWithOwner: 'owner/repo' } } } };
    const base = { id: 'issue', state: 'OPEN', createdAt: timestamp, updatedAt: updated };
    if (query === NATIVE_EPOCH_QUERY) return { data: { repository: { issue: { ...base, timelineItems: {
      totalCount: 2, updatedAt: updated, pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ __typename: 'ClosedEvent', id: 'close', createdAt: '2026-01-01T00:00:01Z' },
        { __typename: 'ReopenedEvent', id: 'reopen', createdAt: created }] } } } } };
    if (query === HANDOFF_QUERY) return { data: { repository: { issue: { ...base, comments: {
      totalCount: absent ? 0 : 1, pageInfo: { hasNextPage: false, endCursor: null },
      nodes: absent ? [] : [{ id: 'comment', fullDatabaseId: '1', body: text, createdAt: created,
        updatedAt: created, lastEditedAt: null, author: { __typename: 'User', id: 'author' } }] } } } } };
    assert.equal(query, EPOCH_QUERY);
    return { data: { repository: { issue: { ...base, timelineItems: { totalCount: 0, updatedAt: updated,
      pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
    node: { id: 'comment', fullDatabaseId: '1', body: text, createdAt: created, issue: { id: 'issue' } } } };
  };
  const listItems = async () => ({ items: [{ nodeId: 'item', contentNodeId: 'issue', contentType: 'Issue', archived: false }], nextCursor: null });
  return { calls, input: { mode: 'handoff', owner: 'owner', repo: 'repo', repository: 'owner/repo', number: 1,
    issueId: 'issue', projectId: 'project', itemId: 'item', statusFieldId: 'status', statusFieldName: 'Status',
    checkpointFieldId: 'checkpoint', checkpointFieldName: 'Checkpoint', projectOwner: 'board-owner', projectNumber: 13,
    trustedAuthorIds: ['author'], cutoverAt: timestamp, projectGraphql, issueGraphql, listItems } };
}

test('composes split reads and refuses to promote successful reads into write authority', async () => {
  const { input, calls } = fixture();
  assert.deepEqual(await runReadOnlyFlowPreflight(input), { kind: 'blocked', reason: 'unverified-snapshot', steps: [] });
  assert.ok(calls.includes(SPLIT_PROJECT_QUERY)); assert.ok(calls.includes(SPLIT_ISSUE_QUERY)); assert.ok(calls.includes(HANDOFF_QUERY));
  assert.ok(calls.every(query => [SPLIT_PROJECT_QUERY, SPLIT_ISSUE_QUERY, HANDOFF_QUERY, EPOCH_QUERY].includes(query)));
});

test('reports absence of handoff without a write', async () => {
  const { input, calls } = fixture({ absent: true });
  assert.deepEqual(await runReadOnlyFlowPreflight(input), { kind: 'complete', outcome: 'awaiting-handoff', steps: [] });
  assert.ok(calls.every(query => [SPLIT_PROJECT_QUERY, SPLIT_ISSUE_QUERY, HANDOFF_QUERY].includes(query)));
});

test('detects a status change between complete observations', async () => {
  const { input } = fixture({ change: true });
  assert.deepEqual(await runReadOnlyFlowPreflight(input), { kind: 'blocked', reason: 'snapshot-changed', steps: [] });
});

test('does not accept a supplied writer or trust flags', async () => {
  for (const key of ['writeStep', 'trusted', 'singleWriterVerified', 'projectSourceVerified', 'singleCardVerified', 'graphql']) {
    const { input, calls } = fixture(); input[key] = key === 'writeStep' ? () => assert.fail('writer invoked') : true;
    assert.deepEqual(await runReadOnlyFlowPreflight(input), { kind: 'blocked', reason: 'invalid-input', steps: [] });
    assert.equal(calls.length, 0);
  }
});

test('reads native reopen evidence without granting authority to write', async () => {
  const { input, calls } = fixture(); input.mode = 'reentry';
  assert.deepEqual(await runReadOnlyFlowPreflight(input), { kind: 'blocked', reason: 'unverified-snapshot', steps: [] });
  assert.ok(calls.includes(NATIVE_EPOCH_QUERY));
  assert.ok(calls.every(query => [SPLIT_PROJECT_QUERY, SPLIT_ISSUE_QUERY, HANDOFF_QUERY, NATIVE_EPOCH_QUERY].includes(query)));
});

test('composes HTTP transport adapters with the split preflight without performing mutations', async () => {
  const { input, calls } = fixture(); const requests = [];
  const request = async (url, options) => {
    requests.push({ url, method: options.method, authorization: options.headers.Authorization });
    let value;
    if (options.method === 'GET') {
      assert.equal(options.headers.Authorization, 'Bearer project-token');
      value = [{ node_id: 'item', content_type: 'Issue', archived_at: null, content: { node_id: 'issue' } }];
    } else {
      const { query, variables } = JSON.parse(options.body);
      const project = options.headers.Authorization === 'Bearer project-token';
      assert.equal(options.headers.Authorization, project ? 'Bearer project-token' : 'Bearer issue-token');
      value = await (project ? input.projectGraphql(query, variables) : input.issueGraphql(query, variables));
    }
    return { status: 200, text: async () => JSON.stringify(value), headers: { get: () => null } };
  };
  const transports = createFlowReadTransports({ projectToken: 'project-token', issueToken: 'issue-token', request });
  assert.deepEqual(await runReadOnlyFlowPreflight({ ...input, ...transports }),
    { kind: 'blocked', reason: 'unverified-snapshot', steps: [] });
  assert.ok(requests.some(r => r.method === 'GET')); assert.ok(calls.includes(HANDOFF_QUERY));
  assert.ok(requests.every(r => r.url === 'https://api.github.com/graphql' || r.url.startsWith('https://api.github.com/users/board-owner/')));
});
