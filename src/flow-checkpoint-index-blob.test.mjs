import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decodeCheckpointIndexBlob } from './flow-checkpoint-index-blob.mjs';

const fixture = bytes => {
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  return { expectedOid: sha, repositoryId: 'repo', blob: { sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') } };
};
const valid = () => fixture(Buffer.from('{"version":1,"repositoryId":"repo","issues":[]}'));

test('validates Git blob bytes and decodes a canonical index', () => {
  const input = valid(); input.blob.content = input.blob.content.replace(/(.{20})/g, '$1\n');
  assert.deepEqual(decodeCheckpointIndexBlob(input), { kind: 'decoded-index', index: { version: 1, repositoryId: 'repo', issues: [] } });
});

test('blocks foreign blobs, wrong sizes, malformed base64 and modified content', () => {
  assert.equal(decodeCheckpointIndexBlob(null).reason, 'invalid-blob');
  let input = valid(); input.blob.sha = '0'.repeat(40);
  assert.equal(decodeCheckpointIndexBlob(input).reason, 'invalid-blob');
  input = valid(); input.blob.size++;
  assert.equal(decodeCheckpointIndexBlob(input).reason, 'invalid-blob-size-or-encoding');
  input = valid(); input.blob.content += '!';
  assert.equal(decodeCheckpointIndexBlob(input).reason, 'invalid-base64');
  input = valid(); input.blob.content = Buffer.alloc(input.blob.size, 'x').toString('base64');
  assert.equal(decodeCheckpointIndexBlob(input).reason, 'blob-hash-mismatch');
});

test('blocks invalid UTF-8, oversized blobs, wrong repository and noncanonical index', () => {
  assert.equal(decodeCheckpointIndexBlob(fixture(Buffer.from([0xff]))).reason, 'invalid-utf8');
  let input = valid(); input.blob.size = 1024 * 1024 + 1;
  assert.equal(decodeCheckpointIndexBlob(input).reason, 'invalid-blob');
  input = valid(); input.repositoryId = 'other';
  assert.equal(decodeCheckpointIndexBlob(input).reason, 'repository-mismatch');
  input = fixture(Buffer.from('{ "version": 1, "repositoryId": "repo", "issues": [] }'));
  assert.equal(decodeCheckpointIndexBlob(input).reason, 'noncanonical-index');
  input = fixture(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"version":1,"repositoryId":"repo","issues":[]}')]));
  assert.equal(decodeCheckpointIndexBlob(input).kind, 'blocked');
});
