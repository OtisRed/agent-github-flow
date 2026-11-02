import test from 'node:test';
import assert from 'node:assert/strict';
import { readFlowMarker, replaceFlowMarker } from './flow-marker.mjs';

const marker = () => ({ version: 1, phase: 'pending', commentId: '123', digest: 'a'.repeat(64), fromStatus: 'agent-ready', targetStatus: 'review' });

test('adds and replaces a marker while preserving surrounding issue text exactly', () => {
  const original = '## Kontrakt\r\nTreść użytkownika 📝\r\n';
  const added = replaceFlowMarker(original, null, marker());
  assert.equal(added.kind, 'updated');
  assert.ok(added.body.startsWith(original));
  assert.deepEqual(readFlowMarker(added.body), { kind: 'found', marker: marker() });
  const withTail = `${added.body}\n\n## Dodatkowe dane\nTreść`;
  const committed = { ...marker(), phase: 'committed' };
  const replaced = replaceFlowMarker(withTail, marker(), committed);
  assert.equal(replaced.kind, 'updated');
  assert.ok(replaced.body.startsWith(original));
  assert.ok(replaced.body.endsWith('\n\n## Dodatkowe dane\nTreść'));
  assert.deepEqual(readFlowMarker(replaced.body), { kind: 'found', marker: committed });
});

test('refuses duplicate, damaged, extended and noncanonical markers', () => {
  const valid = replaceFlowMarker('', null, marker()).body;
  for (const body of [
    `${valid}\n${valid}`, valid.replace('agent-github-flow:state -->', 'broken -->'),
    `agent-github-flow:state`, valid.replace('"version":1', '"version":1,"version":1'),
    valid.replace('"version":1', '"unknown":true,"version":1'),
    valid.replace('"version":1', '"version": 1'), valid.replaceAll('\n', '\r\n'),
  ]) assert.deepEqual(readFlowMarker(body), { kind: 'blocked', reason: 'malformed-marker' });
});

test('requires the expected previous marker and never initializes implicitly', () => {
  const body = replaceFlowMarker('body', null, marker()).body;
  assert.deepEqual(replaceFlowMarker(body, null, marker()), { kind: 'blocked', reason: 'marker-conflict' });
  assert.deepEqual(replaceFlowMarker(body, { ...marker(), commentId: '124' }, marker()), { kind: 'blocked', reason: 'marker-conflict' });
  assert.deepEqual(replaceFlowMarker('body', marker(), marker()), { kind: 'blocked', reason: 'marker-conflict' });
  assert.deepEqual(replaceFlowMarker('body', undefined, marker()), { kind: 'blocked', reason: 'marker-conflict' });
  assert.deepEqual(replaceFlowMarker('body', null, { ...marker(), phase: 'bad' }), { kind: 'blocked', reason: 'invalid-marker' });
});
