import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectIssue, PROJECT_ITEM_QUERY, ISSUE_CARDS_QUERY } from './flow-github-project.mjs';

const item = () => ({ id: 'item', isArchived: false, project: { id: 'project',
  statusField: { id: 'status-field', name: 'Status', dataType: 'SINGLE_SELECT', options: [
    { id: 'design-id', name: 'needs-design' }, { id: 'ready-id', name: 'agent-ready' }] },
  checkpointField: { id: 'checkpoint-field', name: 'FLOW checkpoint', dataType: 'TEXT' } },
  content: { id: 'issue', number: 1, state: 'OPEN', body: 'Original\nbody', updatedAt: '2026-01-01T00:00:00Z',
    repository: { nameWithOwner: 'owner/repo' } },
  status: { name: 'needs-design', optionId: 'design-id', field: { id: 'status-field' } }, checkpoint: null });
const cards = () => ({ id: 'issue', updatedAt: '2026-01-01T00:00:00Z', projectItems: { totalCount: 1,
  pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'item', isArchived: false, project: { id: 'project' } }] } });
const input = graphql => ({ graphql, projectId: 'project', itemId: 'item', issueId: 'issue', repository: 'owner/repo',
  statusFieldId: 'status-field', statusFieldName: 'Status', checkpointFieldId: 'checkpoint-field', checkpointFieldName: 'FLOW checkpoint' });
const fake = (itemFn = item, cardsFn = cards) => async query => ({ data: { node: query === PROJECT_ITEM_QUERY ? itemFn() : cardsFn() } });

test('reads and rechecks the exact issue, fields and unique active project card', async () => {
  const calls = [];
  const graphql = async (query, variables) => { calls.push([query, variables]); return fake()(query, variables); };
  const result = await readProjectIssue(input(graphql));
  assert.equal(result.kind, 'snapshot'); assert.equal(result.issueBody, 'Original\nbody');
  assert.equal(result.currentStatus, 'needs-design'); assert.equal(result.marker, null); assert.equal(result.witness, null);
  assert.deepEqual(calls.map(c => c[0]), [PROJECT_ITEM_QUERY, ISSUE_CARDS_QUERY, ISSUE_CARDS_QUERY, PROJECT_ITEM_QUERY]);
  assert.deepEqual(calls.map(c => c[1]), [
    { item: 'item', statusName: 'Status', checkpointName: 'FLOW checkpoint' }, { issue: 'issue', after: null },
    { issue: 'issue', after: null }, { item: 'item', statusName: 'Status', checkpointName: 'FLOW checkpoint' },
  ]);
});

test('reads and rechecks all card pages, rejects changes and cursor cycles', async () => {
  const makePage = after => { const page = cards(); page.projectItems.totalCount = 2;
    if (!after) page.projectItems.pageInfo = { hasNextPage: true, endCursor: 'cursor' };
    else page.projectItems.nodes = [{ id: 'other', isArchived: false, project: { id: 'other-project' } }];
    return page; };
  const calls = []; let secondReads = 0;
  const graphql = async (query, vars) => {
    if (query === PROJECT_ITEM_QUERY) return { data: { node: item() } };
    calls.push(vars); return { data: { node: makePage(vars.after) } };
  };
  assert.equal((await readProjectIssue(input(graphql))).kind, 'snapshot');
  assert.deepEqual(calls, [{ issue: 'issue', after: null }, { issue: 'issue', after: 'cursor' },
    { issue: 'issue', after: null }, { issue: 'issue', after: 'cursor' }]);
  const changed = async (query, vars) => {
    if (query === PROJECT_ITEM_QUERY) return { data: { node: item() } };
    const page = makePage(vars.after); if (vars.after && ++secondReads > 1) page.projectItems.nodes[0].id = 'different';
    return { data: { node: page } };
  };
  assert.deepEqual(await readProjectIssue(input(changed)), { kind: 'blocked', reason: 'snapshot-changed' });
  const cycle = async query => { if (query === PROJECT_ITEM_QUERY) return { data: { node: item() } };
    const page = makePage(null); return { data: { node: page } }; };
  assert.deepEqual(await readProjectIssue(input(cycle)), { kind: 'blocked', reason: 'invalid-cursor' });
});

test('rejects another issue, archived card, wrong fields, invalid status or checkpoint', async () => {
  const cases = [
    [v => { v.content.id = 'other'; }, 'invalid-item'], [v => { v.isArchived = true; }, 'invalid-item'],
    [v => { v.content.repository.nameWithOwner = 'other/repo'; }, 'invalid-item'],
    [v => { v.project.checkpointField.dataType = 'NUMBER'; }, 'invalid-fields'],
    [v => { v.project.statusField.options.push({ id: 'different', name: 'needs-design' }); }, 'invalid-options'],
    [v => { v.status.optionId = 'unknown'; }, 'invalid-status'],
    [v => { v.checkpoint = {}; }, 'invalid-checkpoint-field'],
    [v => { v.checkpoint = { text: '{broken', field: { id: 'checkpoint-field' } }; }, 'invalid-checkpoint-json'],
  ];
  for (const [change, reason] of cases) {
    const current = item(); change(current);
    assert.deepEqual(await readProjectIssue(input(fake(() => current))), { kind: 'blocked', reason });
  }
});

test('detects duplicate cards and changing issue or card snapshots', async () => {
  const duplicate = cards(); duplicate.projectItems.totalCount = 2;
  duplicate.projectItems.nodes.push({ id: 'other-item', isArchived: false, project: { id: 'project' } });
  assert.deepEqual(await readProjectIssue(input(fake(item, () => duplicate))), { kind: 'blocked', reason: 'ambiguous-card' });
  let count = 0;
  const changing = () => { const c = cards(); if (++count > 1) c.projectItems.nodes[0].isArchived = true; return c; };
  assert.deepEqual(await readProjectIssue(input(fake(item, changing))), { kind: 'blocked', reason: 'snapshot-changed' });
  const wrongTime = cards(); wrongTime.updatedAt = '2026-01-01T00:00:01Z';
  assert.deepEqual(await readProjectIssue(input(fake(item, () => wrongTime))), { kind: 'blocked', reason: 'snapshot-changed' });
});

test('fails closed on missing pages, errors and corrupted marker', async () => {
  assert.deepEqual(await readProjectIssue(input(async () => ({ errors: [{ message: 'no access' }] }))), { kind: 'blocked', reason: 'invalid-item' });
  const broken = item(); broken.content.body = 'agent-github-flow:state';
  assert.deepEqual(await readProjectIssue(input(fake(() => broken))), { kind: 'blocked', reason: 'malformed-marker' });
  const missing = cards(); missing.projectItems.totalCount = 2;
  assert.deepEqual(await readProjectIssue(input(fake(item, () => missing))), { kind: 'blocked', reason: 'incomplete-cards' });
});

test('preserves exact valid checkpoint value', async () => {
  const current = item(); const witness = { version: 2, kind: 'bootstrap', current: { commentId: '42' } };
  current.checkpoint = { text: JSON.stringify(witness), field: { id: 'checkpoint-field' } };
  const result = await readProjectIssue(input(fake(() => current)));
  assert.deepEqual(result.witness, witness); assert.equal(result.witnessText, JSON.stringify(witness));
});
