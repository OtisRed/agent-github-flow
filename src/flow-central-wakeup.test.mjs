import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCentralWakeup } from './flow-central-wakeup.mjs';

test('accepts only an allowlisted hint and preserves canonical repository spelling', () => {
  assert.deepEqual(selectCentralWakeup({ repository: 'OWNER/Project', issueNumber: 42 }, ['Owner/project']),
    { kind: 'candidate', repository: 'Owner/project', issueNumber: 42 });
  assert.deepEqual(selectCentralWakeup({ repository: 'other/project', issueNumber: 42 }, ['Owner/project']),
    { kind: 'blocked', reason: 'repository-not-allowed' });
});

test('rejects malformed payloads without echoing private data', () => {
  for (const payload of [null, [], {}, { repository: 'a/b', issueNumber: 0 },
    { repository: 'a/b', issueNumber: Number.MAX_SAFE_INTEGER + 1 },
    { repository: 'a/b', issueNumber: '1' }, { repository: '../bad/path', issueNumber: 1 },
    { repository: '../repo', issueNumber: 1 }, { repository: 'owner/..', issueNumber: 1 },
    { repository: 'owner/.', issueNumber: 1 }, { repository: 'invalid_owner/repo', issueNumber: 1 },
    { repository: 'a/b', issueNumber: 1, targetStatus: 'done' },
    { repository: 'a/b', issueNumber: 1, secret: 'do-not-echo' }]) {
    assert.deepEqual(selectCentralWakeup(payload, ['a/b']), { kind: 'blocked', reason: 'invalid-wakeup' });
  }
});

test('fails closed on absent, invalid, or ambiguous allowlist', () => {
  const payload = { repository: 'a/b', issueNumber: 1 };
  for (const list of [null, [], ['invalid'], ['a/b', 'A/B'], ['a/b', null]]) {
    assert.deepEqual(selectCentralWakeup(payload, list), { kind: 'blocked', reason: 'invalid-allowlist' });
  }
});
