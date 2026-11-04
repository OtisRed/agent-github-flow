import test from 'node:test';
import assert from 'node:assert/strict';
import { standaloneRefs, evaluateRefs, evaluateHead, inspectPr } from '../scripts/pr-evidence.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40);

test('Refs parser follows the standalone VSone convention, including duplicate and invalid refs', () => {
  assert.deepEqual(standaloneRefs('  Refs #42  \r\nRefs #0\ntext Refs #3\nRefs #42'), [42, 42]);
  assert.equal(evaluateRefs('Refs #42', 42).code, 'refs-match');
  assert.equal(evaluateRefs('Refs #42', 43).state, 'conflict');
  assert.equal(evaluateRefs('Refs #42\nRefs #42', 42).state, 'conflict');
  assert.equal(evaluateRefs('Fixes #42', 42).state, 'missing');
  assert.equal(evaluateRefs('Refs #42').state, 'unverified');
  assert.equal(evaluateRefs(null, 42).state, 'unverified');
});

test('SHA requires agreement between both head reads, last PR commit and optional expected SHA', () => {
  assert.equal(evaluateHead({ initialHead: A, lastCommit: A, finalHead: A, expectedSha: A }).code, 'expected-head-current');
  assert.equal(evaluateHead({ initialHead: A, lastCommit: A, finalHead: A }).code, 'head-snapshot-consistent');
  assert.equal(evaluateHead({ initialHead: A, lastCommit: B, finalHead: A }).state, 'conflict');
  assert.equal(evaluateHead({ initialHead: A, lastCommit: A, finalHead: B }).state, 'conflict');
  assert.equal(evaluateHead({ initialHead: A, lastCommit: A, finalHead: A, expectedSha: B }).code, 'expected-sha-stale');
  assert.equal(evaluateHead({ initialHead: A, lastCommit: null, finalHead: A }).state, 'unverified');
});

test('read-only inspection queries the chosen PR twice, does not emit its body and does not imply review or CI success', () => {
  const seen = [];
  const read = (query, vars) => {
    seen.push({ query, vars });
    const pull = seen.length === 1 ? { number: 7, state: 'OPEN', isDraft: true, baseRefName: 'develop', body: 'private text\nRefs #3', headRefOid: A, commits: { nodes: [{ commit: { oid: A } }] } } : { number: 7, headRefOid: A };
    return { ok: true, data: { data: { repository: { pullRequest: pull } } } };
  };
  const result = inspectPr({ repository: 'owner/repo', pr: 7, issue: 3, expectedSha: A }, read);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((x) => x.query.startsWith('query(') && !x.query.includes('mutation')));
  assert.equal(result.checks.find((c) => c.id === 'refs').state, 'ok');
  assert.equal(result.checks.find((c) => c.id === 'head-sha').state, 'ok');
  assert.equal(JSON.stringify(result).includes('private text'), false);
  assert.equal(result.inventory.base, 'develop');
  assert.ok(result.limitations.some((text) => text.includes('not proof of CI')));
});

test('failure or inconsistent data never becomes a successful SHA check', () => {
  const pull = { number: 7, body: 'Refs #3', headRefOid: A, commits: { nodes: [{ commit: { oid: A } }] } };
  const first = { ok: true, data: { data: { repository: { pullRequest: pull } } } };
  let count = 0;
  const result = inspectPr({ repository: 'owner/repo', pr: 7, issue: 3 }, () => ++count === 1 ? first : { ok: false, code: 'timeout' });
  assert.deepEqual(result.checks.find((c) => c.id === 'head-sha'), { id: 'head-sha', state: 'unverified', code: 'timeout' });
  const failed = inspectPr({ repository: 'owner/repo', pr: 7 }, () => ({ ok: false, code: 'github-read-failed' }));
  assert.equal(failed.checks[0].state, 'unverified');
  const wrongPr = inspectPr({ repository: 'owner/repo', pr: 8 }, () => first);
  assert.equal(wrongPr.checks[0].state, 'unverified');
  const invalid = inspectPr({ repository: 'owner/repo/extra', pr: 7 }, () => { throw Error('must not be called'); });
  assert.equal(invalid.checks[0].code, 'invalid-arguments');
});
