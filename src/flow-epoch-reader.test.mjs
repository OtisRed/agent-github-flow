import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { collectEpochEvidence, collectCheckpointEpochEvidence } from './flow-epoch-reader.mjs';

const makePage = (nodes = [], hasNextPage = false, endCursor = null) => ({ data: {
  repository: { issue: { id: 'issue', state: 'OPEN', createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-01T10:05:00Z',
    timelineItems: { totalCount: 2, updatedAt: '2026-01-01T10:05:00Z', nodes, pageInfo: { hasNextPage, endCursor } } } },
  node: { id: 'comment', fullDatabaseId: '123', body: 'comment body', createdAt: '2026-01-01T10:03:00Z', issue: { id: 'issue' } },
} });
const close = { __typename: 'ClosedEvent', id: 'close', createdAt: '2026-01-01T10:01:00Z' };
const reopen = { __typename: 'ReopenedEvent', id: 'reopen', createdAt: '2026-01-01T10:02:00Z' };
const args = graphql => ({ graphql, owner: 'owner', repo: 'repo', number: 1, commentNodeId: 'comment', observedAt: '2026-01-01T10:10:00Z' });
const proof = (epoch, eventCount) => ({ kind: 'handoff-epoch-evidence', issueNodeId: 'issue', commentNodeId: 'comment',
  commentId: '123', commentCreatedAt: '2026-01-01T10:03:00Z', commentDigest: createHash('sha256').update('comment body').digest('hex'), epoch, eventCount });

test('reads every page and checks the first page again', async () => {
  const calls = [];
  const graphql = async (_query, vars) => { calls.push(vars.after); return vars.after ? makePage([reopen]) : makePage([close], true, 'next'); };
  assert.deepEqual(await collectEpochEvidence(args(graphql)), proof({ kind: 'reopened', anchor: 'reopen' }, 2));
  assert.deepEqual(calls, [null, 'next', null]);
});

test('returns the existing issue node as the anchor for an initial epoch', async () => {
  const empty = makePage([]); empty.data.repository.issue.timelineItems.totalCount = 0;
  assert.deepEqual(await collectEpochEvidence(args(async () => empty)),
    proof({ kind: 'initial', anchor: 'issue' }, 0));
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

test('binds checkpoint epoch evidence to the exact GitHub comment and issue', async () => {
  const graphql = async (_query, vars) => vars.after ? makePage([reopen]) : makePage([close], true, 'next');
  const value = { ...args(graphql), commentId: '123' };
  const expected = { kind: 'checkpoint-epoch-evidence', relation: 'current', issueNodeId: 'issue', commentNodeId: 'comment',
    commentId: '123', commentDigest: createHash('sha256').update('comment body').digest('hex'),
    epoch: { kind: 'reopened', anchor: 'reopen' }, eventCount: 2 };
  assert.deepEqual(await collectCheckpointEpochEvidence(value), expected);
  value.commentId = '124';
  assert.deepEqual(await collectCheckpointEpochEvidence(value), { kind: 'blocked', reason: 'unavailable-or-invalid-page' });
});

test('detects changed checkpoint body even when timestamps stay unchanged', async () => {
  let count = 0;
  const graphql = async () => { count += 1; const p = makePage([]); p.data.repository.issue.timelineItems.totalCount = 0;
    if (count > 1) p.data.node.body = 'changed'; return p; };
  assert.deepEqual(await collectCheckpointEpochEvidence({ ...args(graphql), commentId: '123' }), { kind: 'blocked', reason: 'snapshot-changed' });
});
