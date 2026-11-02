import test from 'node:test';
import assert from 'node:assert/strict';
import { selectLatestHandoff } from './flow-handoff.mjs';

const body = status => `[FLOW]\nRola: Coder\nStan docelowy: ${status}\nWykonano: Zmiana\nNastępny krok: Review`;
const item = (id, seconds, text = body('review'), authorId = 'trusted') => ({ id, nodeId: `node-${id}`, authorId, createdAt: `2026-01-01T10:00:${seconds}Z`, lastEditedAt: null, body: text });
const args = comments => ({ complete: true, trustedAuthorIds: ['trusted'], comments });

test('ignores legacy comments through the fixed cutover but never ignores new malformed handoffs', () => {
  const cutoverAt = '2026-01-01T10:00:02Z';
  const legacy = [item('10', '01', 'legacy'), item('11', '02', 'legacy at boundary')];
  assert.deepEqual(selectLatestHandoff({ ...args(legacy), cutoverAt }), { kind: 'absent' });
  assert.equal(selectLatestHandoff({ ...args([...legacy, item('12', '03')]), cutoverAt }).id, '12');
  assert.deepEqual(selectLatestHandoff({ ...args([...legacy, item('12', '03', 'new malformed')]), cutoverAt }),
    { kind: 'blocked', reason: 'invalid-latest-handoff' });
  assert.deepEqual(selectLatestHandoff({ ...args(legacy), cutoverAt: 'tomorrow' }), { kind: 'blocked', reason: 'invalid-input' });
  const invalidDate = item('10', '01', 'legacy'); invalidDate.createdAt = '2026-02-30T10:00:00Z';
  assert.deepEqual(selectLatestHandoff({ ...args([invalidDate]), cutoverAt }), { kind: 'blocked', reason: 'invalid-comment-metadata' });
  assert.deepEqual(selectLatestHandoff({ ...args([item('10', '01'), item('10', '03')]), cutoverAt }),
    { kind: 'blocked', reason: 'invalid-comment-metadata' });
});

test('selects the newest trusted handoff regardless of input order', () => {
  const latest = item('12', '02', body('smoke'));
  const result = selectLatestHandoff(args([latest, item('10', '01'), item('13', '03', 'ignored', 'other')]));
  assert.equal(result.kind, 'handoff'); assert.equal(result.id, '12'); assert.equal(result.nodeId, 'node-12'); assert.equal(result.parsed.targetStatus, 'smoke');
});

test('does not fall back when the latest trusted comment is malformed', () => {
  assert.deepEqual(selectLatestHandoff(args([item('10', '01'), item('12', '02', 'broken')])), { kind: 'blocked', reason: 'invalid-latest-handoff' });
  assert.equal(selectLatestHandoff(args([item('10', '01', 'broken'), item('12', '02')])).kind, 'handoff');
});

test('fails closed for ties, incomplete results and missing identity', () => {
  assert.deepEqual(selectLatestHandoff(args([item('10', '01'), item('12', '01')])), { kind: 'blocked', reason: 'ambiguous-order' });
  assert.deepEqual(selectLatestHandoff({ ...args([]), complete: false }), { kind: 'blocked', reason: 'incomplete-comments' });
  assert.deepEqual(selectLatestHandoff(args([item('10', '01', body('review'), '')])), { kind: 'blocked', reason: 'invalid-comment-metadata' });
  assert.deepEqual(selectLatestHandoff(args([item('10', '01'), item('10', '02')])), { kind: 'blocked', reason: 'invalid-comment-metadata' });
  const a = item('10', '01'); const b = item('12', '02'); b.nodeId = a.nodeId;
  assert.deepEqual(selectLatestHandoff(args([a, b])), { kind: 'blocked', reason: 'invalid-comment-metadata' });
});

test('stops for a visibly edited latest handoff or missing edit metadata', () => {
  const edited = item('12', '02'); edited.lastEditedAt = '2026-01-01T10:00:03Z';
  assert.deepEqual(selectLatestHandoff(args([item('10', '01'), edited])), { kind: 'blocked', reason: 'edited-latest-handoff' });
  const unknown = item('12', '02'); delete unknown.lastEditedAt;
  assert.deepEqual(selectLatestHandoff(args([unknown])), { kind: 'blocked', reason: 'invalid-comment-metadata' });
});

test('handles no trusted handoff and rejects invalid trusted metadata or allowlists', () => {
  assert.deepEqual(selectLatestHandoff(args([])), { kind: 'absent' });
  assert.deepEqual(selectLatestHandoff(args([item('10', '01', 'ignored', 'other')])), { kind: 'absent' });
  const invalidDate = item('10', '01'); invalidDate.createdAt = '2026-02-30T10:00:00Z';
  assert.deepEqual(selectLatestHandoff(args([invalidDate])), { kind: 'blocked', reason: 'invalid-comment-metadata' });
  assert.deepEqual(selectLatestHandoff({ ...args([]), trustedAuthorIds: [] }), { kind: 'blocked', reason: 'invalid-input' });
  assert.deepEqual(selectLatestHandoff({ ...args([]), trustedAuthorIds: ['trusted', 'trusted'] }), { kind: 'blocked', reason: 'invalid-input' });
});
