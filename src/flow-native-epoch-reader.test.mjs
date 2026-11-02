import test from 'node:test';
import assert from 'node:assert/strict';
import { collectNativeReopenEvidence } from './flow-native-epoch-reader.mjs';

const close = { __typename: 'ClosedEvent', id: 'close', createdAt: '2026-01-01T00:00:01Z' };
const reopen = { __typename: 'ReopenedEvent', id: 'reopen', createdAt: '2026-01-01T00:00:02Z' };
const page = (nodes, hasNextPage = false, endCursor = null) => ({ data: { repository: { issue: {
  id: 'issue', state: 'OPEN', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:03Z',
  timelineItems: { totalCount: 2, updatedAt: '2026-01-01T00:00:03Z', nodes, pageInfo: { hasNextPage, endCursor } },
} } } });
const input = graphql => ({ graphql, issueNodeId: 'issue', owner: 'owner', repo: 'repo', number: 1, observedAt: '2026-01-01T00:01:00Z' });

test('reads and rechecks all native pages without needing a comment', async () => {
  const cursors = []; const graphql = async (_query, vars) => { cursors.push(vars.after);
    return vars.after ? page([reopen]) : page([close], true, 'next'); };
  assert.deepEqual(await collectNativeReopenEvidence(input(graphql)), { kind: 'native-reopen-evidence', issueNodeId: 'issue',
    epoch: { kind: 'reopened', anchor: 'reopen' }, eventCount: 2 });
  assert.deepEqual(cursors, [null, 'next', null, 'next']);
});

test('blocks foreign issues, incomplete history, changes during confirmation and cursor cycles', async () => {
  const foreign = page([close, reopen]); foreign.data.repository.issue.id = 'other';
  assert.deepEqual(await collectNativeReopenEvidence(input(async () => foreign)), { kind: 'blocked', reason: 'unavailable-or-invalid-page' });
  assert.deepEqual(await collectNativeReopenEvidence(input(async () => page([close]))), { kind: 'blocked', reason: 'incomplete-timeline' });
  let reads = 0; const changing = async () => { const result = page([close, reopen]); if (++reads > 1) result.data.repository.issue.timelineItems.nodes[1].id = 'changed'; return result; };
  assert.deepEqual(await collectNativeReopenEvidence(input(changing)), { kind: 'blocked', reason: 'snapshot-changed' });
  assert.deepEqual(await collectNativeReopenEvidence(input(async () => page([close], true, 'same'))), { kind: 'blocked', reason: 'invalid-cursor' });
});

test('never proves a closed or chronologically inconsistent issue', async () => {
  const closed = page([close]); closed.data.repository.issue.state = 'CLOSED'; closed.data.repository.issue.timelineItems.totalCount = 1;
  assert.deepEqual(await collectNativeReopenEvidence(input(async () => closed)), { kind: 'blocked', reason: 'issue-closed' });
  assert.deepEqual(await collectNativeReopenEvidence(input(async () => page([reopen, close]))), { kind: 'blocked', reason: 'inconsistent-timeline' });
});
