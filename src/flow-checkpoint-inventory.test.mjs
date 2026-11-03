import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCheckpointInventory } from './flow-checkpoint-inventory.mjs';

const inventory = () => ({ repositoryId: 'repo-id', complete: true,
  index: { version: 1, repositoryId: 'repo-id', issues: [
    { number: 1, issueId: 'issue-1' }, { number: 42, issueId: 'issue-42' },
  ] }, records: [
    { path: 'issues/1.json', value: { version: 1, repositoryId: 'repo-id', number: 1, issueId: 'issue-1' } },
    { path: 'issues/42.json', value: { version: 1, repositoryId: 'repo-id', number: 42, issueId: 'issue-42' } },
  ] });
const rejected = (change, reason) => {
  const value = inventory(); change(value);
  assert.deepEqual(validateCheckpointInventory(value), { kind: 'blocked', reason });
};

test('accepts a complete empty or matching inventory independent of record order', () => {
  const empty = inventory(); empty.index.issues = []; empty.records = [];
  assert.deepEqual(validateCheckpointInventory(empty), { kind: 'valid-inventory', issueCount: 0 });
  const value = inventory(); value.records.reverse();
  assert.deepEqual(validateCheckpointInventory(value), { kind: 'valid-inventory', issueCount: 2 });
});

test('blocks incomplete reads and a missing or foreign index', () => {
  rejected(v => { v.complete = false; }, 'incomplete-tree');
  rejected(v => { v.index = null; }, 'invalid-index');
  rejected(v => { v.index.repositoryId = 'other'; }, 'invalid-index');
  rejected(v => { v.index.version = 2; }, 'invalid-index');
});

test('blocks duplicate issue numbers or IDs even when all records are present', () => {
  rejected(v => { v.index.issues[1].number = 1; }, 'invalid-index-entry');
  rejected(v => { v.index.issues[1].issueId = 'issue-1'; }, 'invalid-index-entry');
});

test('blocks missing, duplicate and orphan files', () => {
  rejected(v => { v.records.pop(); }, 'missing-record');
  rejected(v => { v.records.push(structuredClone(v.records[0])); }, 'duplicate-record');
  rejected(v => { v.index.issues.pop(); }, 'orphan-record');
});

test('binds each record to the exact repository, issue and canonical path', () => {
  rejected(v => { v.records[0].value.repositoryId = 'other'; }, 'invalid-record');
  rejected(v => { v.records[0].value.issueId = 'other'; }, 'record-identity-mismatch');
  rejected(v => { v.records[0].path = 'issues/01.json'; }, 'invalid-record');
  rejected(v => { v.records[0].path = '../issues/1.json'; }, 'invalid-record');
  rejected(v => { v.records[0].value.number = Number.MAX_SAFE_INTEGER + 1; }, 'invalid-record');
});
