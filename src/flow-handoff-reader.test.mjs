import test from 'node:test';
import assert from 'node:assert/strict';
import { collectHandoffEvidence } from './flow-handoff-reader.mjs';

const text = status => `[FLOW]\nRola: Coder\nStan docelowy: ${status}\nWykonano: Praca\nNastępny krok: Review`;
const comment = (number, second, body = text('review')) => ({ id: `node-${number}`, fullDatabaseId: String(number), body,
  createdAt: `2026-01-01T10:00:${second}Z`, updatedAt: `2026-01-01T10:00:${second}Z`, lastEditedAt: null,
  author: { __typename: 'User', id: 'user-1' } });
const page = (nodes, hasNextPage = false, endCursor = null, totalCount = 2) => ({ data: { repository: { issue: {
  id: 'issue-1', state: 'OPEN', createdAt: '2026-01-01T09:00:00Z', updatedAt: '2026-01-01T10:10:00Z',
  comments: { totalCount, nodes, pageInfo: { hasNextPage, endCursor } },
} } } });
const args = graphql => ({ graphql, owner: 'owner', repo: 'repo', number: 1, trustedAuthorIds: ['user-1'] });

test('reads and rechecks every page, then selects a bound numeric and node ID', async () => {
  const cursors = [];
  const graphql = async (_query, vars) => { cursors.push(vars.after); return vars.after ? page([comment(12, '02', text('smoke'))]) : page([comment(10, '01')], true, 'next'); };
  const result = await collectHandoffEvidence(args(graphql));
  assert.equal(result.kind, 'evidence'); assert.equal(result.commentCount, 2);
  assert.equal(result.handoff.id, '12'); assert.equal(result.handoff.nodeId, 'node-12');
  assert.equal(result.handoff.parsed.targetStatus, 'smoke');
  assert.deepEqual(cursors, [null, 'next', null, 'next']);
});

test('rejects changed content even if snapshot timestamps and counts stay unchanged', async () => {
  let count = 0;
  const graphql = async () => { count += 1; return page([comment(10, '01', text(count === 1 ? 'review' : 'smoke'))], false, null, 1); };
  assert.deepEqual(await collectHandoffEvidence(args(graphql)), { kind: 'blocked', reason: 'snapshot-changed' });
});

test('rejects missing pages, mismatched count, invalid cursors, API errors and unknown authors', async () => {
  const absent = page([], false, null, 2);
  assert.deepEqual(await collectHandoffEvidence(args(async () => absent)), { kind: 'blocked', reason: 'incomplete-comments' });
  assert.deepEqual(await collectHandoffEvidence(args(async () => page([comment(10, '01')], true, 'same'))), { kind: 'blocked', reason: 'invalid-cursor' });
  assert.deepEqual(await collectHandoffEvidence(args(async () => ({ errors: [{}], ...absent }))), { kind: 'blocked', reason: 'unavailable-or-invalid-page' });
  assert.deepEqual(await collectHandoffEvidence(args(async () => { throw Error('offline'); })), { kind: 'blocked', reason: 'unavailable-or-invalid-page' });
  const unknown = page([comment(10, '01')], false, null, 1); unknown.data.repository.issue.comments.nodes[0].author = null;
  assert.deepEqual(await collectHandoffEvidence(args(async () => unknown)), { kind: 'blocked', reason: 'unavailable-or-invalid-page' });
});

test('propagates a malformed, visibly edited or ambiguous latest trusted comment', async () => {
  const malformed = page([comment(10, '01'), comment(12, '02', 'bad')]);
  assert.deepEqual(await collectHandoffEvidence(args(async () => malformed)), { kind: 'blocked', reason: 'invalid-latest-handoff' });
  const edited = page([comment(10, '01')], false, null, 1); edited.data.repository.issue.comments.nodes[0].lastEditedAt = '2026-01-01T10:01:00Z';
  assert.deepEqual(await collectHandoffEvidence(args(async () => edited)), { kind: 'blocked', reason: 'edited-latest-handoff' });
  const tie = page([comment(10, '01'), comment(12, '01')]);
  assert.deepEqual(await collectHandoffEvidence(args(async () => tie)), { kind: 'blocked', reason: 'ambiguous-order' });
});

test('preserves exact large database IDs and returns no false handoff for another author', async () => {
  const big = comment('9223372036854775807', '01');
  const one = page([big], false, null, 1);
  assert.equal((await collectHandoffEvidence(args(async () => one))).handoff.id, '9223372036854775807');
  big.author.id = 'different-user';
  assert.deepEqual(await collectHandoffEvidence(args(async () => one)), { kind: 'evidence', handoff: { kind: 'absent' }, commentCount: 1 });
});

test('retrieves the exact trusted checkpointed comment across all pages and blocks missing or edited history', async () => {
  const graphql = async (_query, vars) => vars.after ? page([comment(12, '02')]) : page([comment(10, '01')], true, 'next');
  const result = await collectHandoffEvidence({ ...args(graphql), checkpointCommentId: '10' });
  assert.equal(result.previousComment.id, '10'); assert.equal(result.previousComment.nodeId, 'node-10');
  assert.equal(result.handoff.id, '12');
  assert.deepEqual(await collectHandoffEvidence({ ...args(graphql), checkpointCommentId: '11' }),
    { kind: 'blocked', reason: 'checkpoint-comment-missing-or-untrusted' });
  const edited = comment(10, '01'); edited.lastEditedAt = '2026-01-01T10:01:00Z';
  const withEdit = async () => page([edited, comment(12, '02')]);
  assert.deepEqual(await collectHandoffEvidence({ ...args(withEdit), checkpointCommentId: '10' }),
    { kind: 'blocked', reason: 'checkpoint-comment-missing-or-untrusted' });
});

test('rejects duplicate comment IDs even when a repeated page appears stable', async () => {
  const graphql = async (_query, vars) => vars.after ? page([comment(10, '01')]) : page([comment(10, '01')], true, 'next');
  assert.deepEqual(await collectHandoffEvidence(args(graphql)), { kind: 'blocked', reason: 'invalid-comment-metadata' });
});
