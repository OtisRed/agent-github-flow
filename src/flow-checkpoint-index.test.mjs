import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCheckpointIndex, encodeCheckpointIndex } from './flow-checkpoint-index.mjs';

const index = () => ({ version: 1, repositoryId: 'repo', issues: [
  { number: 1, issueId: 'one' }, { number: 12, issueId: 'twelve' },
] });
const encoded = value => encodeCheckpointIndex(value).content;

test('round-trips a bounded, sorted canonical index and binds it to the repository', () => {
  const value = index(); const content = encoded(value);
  assert.deepEqual(decodeCheckpointIndex(content, 'repo'), { kind: 'decoded-index', index: value });
  assert.deepEqual(decodeCheckpointIndex(content, 'other'), { kind: 'blocked', reason: 'repository-mismatch' });
  assert.equal(decodeCheckpointIndex(encoded({ version: 1, repositoryId: 'repo', issues: [] }), 'repo').kind, 'decoded-index');
});

test('rejects ambiguous encodings and duplicate JSON keys', () => {
  const content = encoded(index());
  assert.deepEqual(decodeCheckpointIndex(`${content}\n`, 'repo'), { kind: 'blocked', reason: 'noncanonical-index' });
  assert.deepEqual(decodeCheckpointIndex(content.replace('"version":1', '"version":1,"version":1'), 'repo'),
    { kind: 'blocked', reason: 'noncanonical-index' });
  assert.deepEqual(decodeCheckpointIndex(content.replace('"number":1', '"number":1,"number":1'), 'repo'),
    { kind: 'blocked', reason: 'noncanonical-index' });
  assert.deepEqual(decodeCheckpointIndex('{', 'repo'), { kind: 'blocked', reason: 'invalid-json' });
});

test('rejects duplicate or unsorted issues, duplicate IDs and unknown fields', () => {
  let value = index(); value.issues.reverse(); assert.equal(encodeCheckpointIndex(value).kind, 'blocked');
  value = index(); value.issues[1].number = 1; assert.equal(encodeCheckpointIndex(value).kind, 'blocked');
  value = index(); value.issues[1].issueId = 'one'; assert.equal(encodeCheckpointIndex(value).kind, 'blocked');
  value = index(); value.issues[0].extra = true; assert.equal(encodeCheckpointIndex(value).kind, 'blocked');
  value = index(); value.extra = true; assert.equal(encodeCheckpointIndex(value).kind, 'blocked');
});

test('bounds untrusted input and issue identifiers', () => {
  assert.deepEqual(decodeCheckpointIndex(' '.repeat(1024 * 1024 + 1), 'repo'), { kind: 'blocked', reason: 'invalid-input' });
  const value = index(); value.issues[0].issueId = 'x'.repeat(257);
  assert.equal(encodeCheckpointIndex(value).kind, 'blocked');
  value.issues = Array.from({ length: 10001 }, (_, i) => ({ number: i + 1, issueId: `issue-${i}` }));
  assert.equal(encodeCheckpointIndex(value).kind, 'blocked');
});
