import test from 'node:test';
import assert from 'node:assert/strict';
import { readSplitProjectIssue, SPLIT_PROJECT_QUERY, SPLIT_ISSUE_QUERY } from './flow-github-split-project.mjs';

const project = () => ({ data: { user: { projectV2: { id: 'project' } }, node: { id: 'item', isArchived: false,
  project: { id: 'project', statusField: { id: 'status-field', name: 'Status', dataType: 'SINGLE_SELECT',
    options: [{ id: 'design', name: 'needs-design' }, { id: 'ready', name: 'agent-ready' }] },
  checkpointField: { id: 'checkpoint-field', name: 'Checkpoint', dataType: 'TEXT' } },
  status: { name: 'needs-design', optionId: 'design', field: { id: 'status-field' } }, checkpoint: null } } });
const issue = () => ({ data: { node: { id: 'issue', number: 1, state: 'OPEN', body: 'Private synthetic issue',
  updatedAt: '2026-01-01T00:00:00Z', repository: { nameWithOwner: 'owner/repo' } } } });
const card = () => ({ nodeId: 'item', contentNodeId: 'issue', contentType: 'Issue', archived: false });
const input = () => ({ number: 1, projectId: 'project', itemId: 'item', issueId: 'issue', repository: 'owner/repo', projectOwner: 'board-owner', projectNumber: 13,
  statusFieldId: 'status-field', statusFieldName: 'Status', checkpointFieldId: 'checkpoint-field', checkpointFieldName: 'Checkpoint',
  projectGraphql: async (query, vars) => { assert.equal(query, SPLIT_PROJECT_QUERY); assert.equal(vars.owner, 'board-owner'); return project(); },
  issueGraphql: async query => { assert.equal(query, SPLIT_ISSUE_QUERY); return issue(); },
  listItems: async () => ({ items: [card()], nextCursor: null }) });

test('combines separate Project and issue identities with the REST binding', async () => {
  const calls = []; const value = input();
  value.listItems = async args => { calls.push(args); return { items: [card()], nextCursor: null }; };
  const result = await readSplitProjectIssue(value);
  assert.equal(result.kind, 'snapshot'); assert.equal(result.issueBody, 'Private synthetic issue');
  assert.equal(result.currentStatus, 'needs-design'); assert.equal(result.marker, null); assert.equal(result.witness, null);
  assert.deepEqual(calls, [{ owner: 'board-owner', projectNumber: 13, after: null }, { owner: 'board-owner', projectNumber: 13, after: null }]);
});

test('paginates and rechecks REST bindings, and rejects a changing later page', async () => {
  const value = input(); let later = 0; const calls = [];
  value.listItems = async args => { calls.push(args.after); return args.after
    ? { items: [{ nodeId: 'other', contentNodeId: 'other-issue', contentType: 'Issue', archived: false }], nextCursor: null }
    : { items: [card()], nextCursor: 'next' }; };
  assert.equal((await readSplitProjectIssue(value)).kind, 'snapshot');
  assert.deepEqual(calls, [null, 'next', null, 'next']);
  value.listItems = async args => args.after
    ? { items: [{ nodeId: ++later > 1 ? 'changed' : 'other', contentNodeId: 'other-issue', contentType: 'Issue', archived: false }], nextCursor: null }
    : { items: [card()], nextCursor: 'next' };
  assert.deepEqual(await readSplitProjectIssue(value), { kind: 'blocked', reason: 'snapshot-changed' });
});

test('blocks incorrect owner mapping, foreign issue, invalid fields and hidden active content', async () => {
  let value = input(); const wrongProject = project(); wrongProject.data.user.projectV2.id = 'other';
  value.projectGraphql = async () => wrongProject;
  assert.deepEqual(await readSplitProjectIssue(value), { kind: 'blocked', reason: 'invalid-item' });
  value = input(); const foreign = issue(); foreign.data.node.repository.nameWithOwner = 'other/repo'; value.issueGraphql = async () => foreign;
  assert.deepEqual(await readSplitProjectIssue(value), { kind: 'blocked', reason: 'invalid-issue' });
  value = input(); const wrongNumber = issue(); wrongNumber.data.node.number = 2; value.issueGraphql = async () => wrongNumber;
  assert.deepEqual(await readSplitProjectIssue(value), { kind: 'blocked', reason: 'invalid-issue' });
  value = input(); const wrongField = project(); wrongField.data.node.project.checkpointField.dataType = 'NUMBER'; value.projectGraphql = async () => wrongField;
  assert.deepEqual(await readSplitProjectIssue(value), { kind: 'blocked', reason: 'invalid-fields' });
  value = input(); value.listItems = async () => ({ items: [{ ...card(), contentNodeId: null }], nextCursor: null });
  assert.deepEqual(await readSplitProjectIssue(value), { kind: 'blocked', reason: 'invalid-item-page' });
});

test('blocks duplicate, ambiguous or changed bindings and changed issue contents', async () => {
  let value = input(); value.listItems = async () => ({ items: [card(), card()], nextCursor: null });
  assert.deepEqual(await readSplitProjectIssue(value), { kind: 'blocked', reason: 'duplicate-card' });
  value = input(); value.listItems = async () => ({ items: [card(), { ...card(), nodeId: 'other' }], nextCursor: null });
  assert.deepEqual(await readSplitProjectIssue(value), { kind: 'blocked', reason: 'ambiguous-card' });
  value = input(); let count = 0; value.issueGraphql = async () => { const result = issue(); if (++count > 1) result.data.node.body += ' changed'; return result; };
  assert.deepEqual(await readSplitProjectIssue(value), { kind: 'blocked', reason: 'snapshot-changed' });
});

test('rejects missing or repeated REST cursors and API failures without leaking data', async () => {
  let value = input(); value.listItems = async () => ({ items: [card()], nextCursor: '' });
  assert.deepEqual(await readSplitProjectIssue(value), { kind: 'blocked', reason: 'invalid-item-page' });
  value = input(); value.listItems = async () => ({ items: [card()], nextCursor: 'same' });
  assert.deepEqual(await readSplitProjectIssue(value), { kind: 'blocked', reason: 'invalid-cursor' });
  value = input(); value.issueGraphql = async () => ({ errors: [{ message: 'no access' }] });
  assert.deepEqual(await readSplitProjectIssue(value), { kind: 'blocked', reason: 'invalid-issue' });
});
