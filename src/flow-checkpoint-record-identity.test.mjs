import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decodeCheckpointRecordIdentity } from './flow-checkpoint-record-identity.mjs';
import { decodeCheckpointGitBlob } from './flow-checkpoint-git-blob.mjs';

const fixture = (content = '{"version":1,"repositoryId":"repo","number":1,"issueId":"issue","payload":{}}') => {
  const bytes = Buffer.from(content); const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  return { repositoryId: 'repo', number: 1, issueId: 'issue', expectedOid: sha,
    blob: { sha, encoding: 'base64', size: bytes.length, content: bytes.toString('base64') } };
};

test('generic blob decoder returns verified UTF-8 without requiring JSON', () => {
  const input = fixture('Tekst kontrolny');
  assert.deepEqual(decodeCheckpointGitBlob(input), { kind: 'decoded-blob', content: 'Tekst kontrolny' });
});

test('binds immutable bytes to the expected repository and issue envelope', () => {
  const result = decodeCheckpointRecordIdentity(fixture());
  assert.equal(result.kind, 'record-identity-verified'); assert.equal(result.record.issueId, 'issue');
  for (const key of ['repositoryId', 'number', 'issueId']) {
    const input = fixture(); input[key] = key === 'number' ? 2 : 'other';
    assert.equal(decodeCheckpointRecordIdentity(input).reason, 'record-identity-mismatch');
  }
});

test('blocks modified bytes, invalid JSON and ambiguous duplicate keys at any depth', () => {
  let input = fixture(); input.blob.content = Buffer.alloc(input.blob.size, 'x').toString('base64');
  assert.equal(decodeCheckpointRecordIdentity(input).reason, 'blob-hash-mismatch');
  input = fixture('{'); assert.equal(decodeCheckpointRecordIdentity(input).reason, 'invalid-record-json');
  input = fixture('{"version":1,"repositoryId":"repo","number":1,"number":1,"issueId":"issue"}');
  assert.equal(decodeCheckpointRecordIdentity(input).reason, 'noncanonical-record');
  input = fixture('{"version":1,"repositoryId":"repo","number":1,"issueId":"issue","payload":{"x":1,"x":1}}');
  assert.equal(decodeCheckpointRecordIdentity(input).reason, 'noncanonical-record');
});

test('blocks noncanonical JSON and unsupported versions without interpreting payloads', () => {
  let input = fixture('{ "version": 1 }'); assert.equal(decodeCheckpointRecordIdentity(input).reason, 'noncanonical-record');
  input = fixture('{"version":2,"repositoryId":"repo","number":1,"issueId":"issue"}');
  assert.equal(decodeCheckpointRecordIdentity(input).reason, 'record-identity-mismatch');
});
