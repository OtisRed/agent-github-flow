import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCheckpointV2, decodeCheckpointV2, verifyCheckpointV2Continuity } from './flow-checkpoint-v2.mjs';

function pending() {
  const epoch = { kind: 'initial', anchor: 'issue' };
  return { version: 2, repositoryId: 'repo', number: 1, issueId: 'issue', cutoverAt: '2026-01-01T10:00:00Z',
    epoch, reentry: null, current: { phase: 'pending', commentId: '4', digest: 'a'.repeat(64),
      fromStatus: 'needs-design', targetStatus: 'agent-ready', createdAt: '2026-01-01T10:01:00Z', epoch },
    previous: null, reservation: null };
}
const reservation = (reservedAt = '2026-01-01T10:02:00Z') => ({ reservedAt, fromOptionId: 'from', targetOptionId: 'target' });
const clone = value => structuredClone(value);
const identity = { repositoryId: 'repo', number: 1, issueId: 'issue' };

test('canonical v2 records bind a reservation to an existing handoff without a new operation ID', () => {
  const value = pending(); value.reservation = reservation();
  const encoded = encodeCheckpointV2(value);
  assert.equal(encoded.kind, 'encoded-record');
  assert.deepEqual(decodeCheckpointV2(encoded.content, identity).record, value);
  assert.equal(decodeCheckpointV2(encoded.content + '\n', identity).kind, 'blocked');
  assert.equal(decodeCheckpointV2(encoded.content, { ...identity, issueId: 'other' }).kind, 'blocked');
  assert.equal(Object.hasOwn(value.reservation, 'operationId'), false);
});

test('rejects old and unknown schemas, invalid reservation shape or time, and reservations on committed handoffs', () => {
  const old = pending(); old.version = 1; delete old.reservation;
  assert.equal(encodeCheckpointV2(old).kind, 'blocked');
  for (const modify of [
    v => { v.reservation.reservedAt = '2026-01-01T10:00:59Z'; },
    v => { v.reservation.reservedAt = 'invalid'; },
    v => { v.reservation.fromOptionId = ''; },
    v => { v.reservation.targetOptionId = v.reservation.fromOptionId; },
    v => { v.reservation.operationId = 'extra'; },
    v => { v.current.phase = 'committed'; }
  ]) { const value = pending(); value.reservation = reservation(); modify(value); assert.equal(encodeCheckpointV2(value).kind, 'blocked'); }
});

test('continuity allows reservation, a later identical-subject reservation, then commit', () => {
  const first = pending(), reserved = clone(first); reserved.reservation = reservation();
  const retry = clone(reserved); retry.reservation.reservedAt = '2026-01-01T10:04:00Z';
  const committed = clone(retry); committed.current.phase = 'committed'; committed.reservation = null;
  for (const [before, after] of [[null, first], [first, reserved], [reserved, retry], [retry, committed]])
    assert.equal(verifyCheckpointV2Continuity(before, after).kind, 'continuity-verified');
});

test('continuity rejects fabricated or discarded reservations, changed option IDs, and changed handoff', () => {
  const first = pending(), reserved = clone(first); reserved.reservation = reservation();
  assert.equal(verifyCheckpointV2Continuity(null, reserved).kind, 'blocked');
  const cases = [
    v => { v.reservation = null; },
    v => { v.reservation.reservedAt = '2026-01-01T10:01:59Z'; },
    v => { v.reservation.fromOptionId = 'other'; v.reservation.reservedAt = '2026-01-01T10:04:00Z'; },
    v => { v.current.digest = 'b'.repeat(64); v.reservation.reservedAt = '2026-01-01T10:04:00Z'; }
  ];
  for (const modify of cases) { const next = clone(reserved); modify(next); assert.equal(verifyCheckpointV2Continuity(reserved, next).kind, 'blocked'); }
  const legacy = clone(first); legacy.version = 1; delete legacy.reservation;
  assert.equal(verifyCheckpointV2Continuity(legacy, first).kind, 'blocked');
});

test('a real status transition cannot be committed without a reservation', () => {
  const first = pending(), committed = clone(first); committed.current.phase = 'committed';
  assert.equal(verifyCheckpointV2Continuity(first, committed).kind, 'blocked');
});

test('an already-matching status may be committed without a needless mutation reservation', () => {
  const first = pending(); first.current.fromStatus = first.current.targetStatus;
  const committed = clone(first); committed.current.phase = 'committed';
  assert.equal(verifyCheckpointV2Continuity(first, committed).kind, 'continuity-verified');
});
