import test from 'node:test';
import assert from 'node:assert/strict';
import { readSplitProjectIssue, readBranchProjectIssue, SPLIT_PROJECT_QUERY, BRANCH_PROJECT_QUERY, SPLIT_ISSUE_QUERY, BRANCH_ISSUE_QUERY } from './flow-github-split-project.mjs';

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

test('branch checkpoint reads the Project without legacy checkpoint fields or parsing issue markers', async () => {
  const value = input(); delete value.checkpointFieldId; delete value.checkpointFieldName;
  value.projectGraphql = async (query, variables) => {
    assert.equal(query, BRANCH_PROJECT_QUERY);
    assert.equal(Object.hasOwn(variables, 'checkpointName'), false);
    const response = project(); delete response.data.node.project.checkpointField; delete response.data.node.checkpoint;
    return response;
  };
  value.issueGraphql = async query => { assert.equal(query, BRANCH_ISSUE_QUERY); assert.doesNotMatch(query, /\bbody\b/);
    const response = issue(); delete response.data.node.body; return response; };
  const result = await readBranchProjectIssue(value);
  assert.equal(result.kind, 'branch-project-observed');
  assert.equal(result.currentStatus, 'needs-design');
  assert.equal(result.statusFieldName, value.statusFieldName);
  assert.equal(Object.hasOwn(result, 'marker'), false);
  assert.equal(Object.hasOwn(result, 'witness'), false);
  assert.equal(Object.hasOwn(result, 'issueBody'), false);
});
test('branch reader resolves the issue card once and confirms the same paginated list after GraphQL reads',async()=>{
  const value=input();delete value.itemId;let listCalls=0;
  value.listItems=async()=>{listCalls++;return {items:[card()],nextCursor:null};};
  value.projectGraphql=async(query,vars)=>{assert.equal(query,BRANCH_PROJECT_QUERY);assert.equal(vars.item,'item');return project();};
  value.issueGraphql=async query=>{assert.equal(query,BRANCH_ISSUE_QUERY);return issue();};
  const result=await readBranchProjectIssue(value);assert.equal(result.kind,'branch-project-observed');assert.equal(result.itemId,'item');
  assert.equal(listCalls,2);
});
test('resolved branch reader rejects duplicate cards and changes during the GraphQL interval',async()=>{
  let value=input();delete value.itemId;value.listItems=async()=>({items:[card(),{...card(),nodeId:'other'}],nextCursor:null});
  value.projectGraphql=async()=>project();value.issueGraphql=async()=>issue();
  assert.equal((await readBranchProjectIssue(value)).reason,'ambiguous-card');
  value=input();delete value.itemId;let count=0;
  value.listItems=async()=>({items:[{...card(),nodeId:++count===1?'item':'other'}],nextCursor:null});
  value.projectGraphql=async()=>project();value.issueGraphql=async()=>issue();
  assert.equal((await readBranchProjectIssue(value)).reason,'snapshot-changed');
});
test('resolved branch reader confirms every page in a multi-page Project',async()=>{
  const value=input();delete value.itemId;const seen=[];
  value.listItems=async args=>{seen.push(args.after);return args.after===null
    ?{items:[{...card(),nodeId:'other',contentNodeId:'other'}],nextCursor:'next'}:{items:[card()],nextCursor:null};};
  value.projectGraphql=async()=>project();value.issueGraphql=async()=>issue();
  assert.equal((await readBranchProjectIssue(value)).kind,'branch-project-observed');
  assert.deepEqual(seen,[null,'next',null,'next']);
});

test('branch Project reader rejects duplicate cards and changed issue data', async () => {
  let value = input(); value.projectGraphql = async () => project(); value.issueGraphql = async () => issue();
  value.listItems = async () => ({ items: [card(), { ...card(), nodeId: 'other' }], nextCursor: null });
  assert.deepEqual(await readBranchProjectIssue(value), { kind: 'blocked', reason: 'ambiguous-card' });
  value = input(); value.projectGraphql = async () => project(); let count = 0;
  value.issueGraphql = async () => { const response = issue(); if (++count > 1) response.data.node.updatedAt = '2026-01-01T00:00:01Z'; return response; };
  assert.deepEqual(await readBranchProjectIssue(value), { kind: 'blocked', reason: 'snapshot-changed' });
});
