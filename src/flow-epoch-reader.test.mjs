import test from 'node:test';
import assert from 'node:assert/strict';
import { collectEpochEvidence } from './flow-epoch-reader.mjs';

const makePage = (nodes = [], hasNextPage = false, endCursor = null) => ({ data: {
  repository: { issue: { id: 'issue', state: 'OPEN', createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-01T10:05:00Z',
    timelineItems: { totalCount: 2, updatedAt: '2026-01-01T10:05:00Z', nodes, pageInfo: { hasNextPage, endCursor } } } },
  node: { id: 'comment', createdAt: '2026-01-01T10:03:00Z', issue: { id: 'issue' } },
} });
const close = { __typename: 'ClosedEvent', id: 'close', createdAt: '2026-01-01T10:01:00Z' };
const reopen = { __typename: 'ReopenedEvent', id: 'reopen', createdAt: '2026-01-01T10:02:00Z' };
const args = graphql => ({ graphql, owner: 'owner', repo: 'repo', number: 1, commentNodeId: 'comment', observedAt: '2026-01-01T10:10:00Z' });

test('reads every page and checks the first page again', async () => {
  const calls = [];
  const graphql = async (_query, vars) => { calls.push(vars.after); return vars.after ? makePage([reopen]) : makePage([close], true, 'next'); };
  assert.deepEqual(await collectEpochEvidence(args(graphql)), { kind: 'evidence', epoch: 'consistent', eventCount: 2 });
  assert.deepEqual(calls, [null, 'next', null]);
});

test('rejects a changed issue, comment or timeline during pagination', async () => {
  for (const mutate of [
    p => { p.data.repository.issue.state = 'CLOSED'; },
    p => { p.data.repository.issue.timelineItems.updatedAt = '2026-01-01T10:06:00Z'; },
    p => { p.data.node.createdAt = '2026-01-01T10:04:00Z'; },
  ]) {
    const graphql = async (_query, vars) => { const p = vars.after ? makePage([reopen]) : makePage([close], true, 'next'); if (vars.after) mutate(p); return p; };
    assert.deepEqual(await collectEpochEvidence(args(graphql)), { kind: 'blocked', reason: 'snapshot-changed' });
  }
});

test('rejects missing pages, GraphQL errors, foreign comments and cursor cycles', async () => {
  assert.deepEqual(await collectEpochEvidence(args(async () => { throw Error('offline'); })), { kind: 'blocked', reason: 'unavailable-or-invalid-page' });
  assert.deepEqual(await collectEpochEvidence(args(async () => ({ errors: [{}], ...makePage() }))), { kind: 'blocked', reason: 'unavailable-or-invalid-page' });
  const foreign = makePage(); foreign.data.node.issue.id = 'other';
  assert.deepEqual(await collectEpochEvidence(args(async () => foreign)), { kind: 'blocked', reason: 'unavailable-or-invalid-page' });
  assert.deepEqual(await collectEpochEvidence(args(async () => makePage([close], true, 'same'))), { kind: 'blocked', reason: 'invalid-cursor' });
});

test('fails closed if first page changes without metadata changing', async () => {
  let count = 0;
  const graphql = async () => { count += 1; const result = makePage(count === 1 ? [] : [close]); result.data.repository.issue.timelineItems.totalCount = 0; return result; };
  assert.deepEqual(await collectEpochEvidence(args(graphql)), { kind: 'blocked', reason: 'snapshot-changed' });
});

test('rejects missing timeline events even when pagination claims it is complete', async () => {
  assert.deepEqual(await collectEpochEvidence(args(async () => makePage([]))), { kind: 'blocked', reason: 'incomplete-timeline' });
});

test('propagates a closed issue as blocked, never as positive evidence', async () => {
  const page = makePage([close]); page.data.repository.issue.state = 'CLOSED'; page.data.repository.issue.timelineItems.totalCount = 1;
  assert.deepEqual(await collectEpochEvidence(args(async () => page)), { kind: 'blocked', reason: 'issue-closed' });
});
