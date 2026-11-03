import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCheckpointRecord, decodeCheckpointRecord } from './flow-checkpoint-record.mjs';

const initial = { kind: 'initial', anchor: 'issue' };
const reopened = { kind: 'reopened', anchor: 'reopen-event' };
const handoff = (overrides = {}) => ({ phase: 'committed', commentId: '1', digest: 'a'.repeat(64),
  fromStatus: 'needs-design', targetStatus: 'agent-ready', createdAt: '2026-01-01T10:01:00Z', epoch: { ...initial }, ...overrides });
const fixture = () => ({ version: 1, repositoryId: 'repo', number: 1, issueId: 'issue',
  cutoverAt: '2026-01-01T10:00:00Z', epoch: { ...initial }, reentry: null, current: handoff(), previous: null });
const reject = (change, reason) => { const value = fixture(); change(value); assert.equal(encodeCheckpointRecord(value).reason, reason); };

test('round-trips canonical records bound to their repository and issue', () => {
  const value = fixture(); const encoded = encodeCheckpointRecord(value);
  assert.equal(encoded.kind, 'encoded-record');
  assert.deepEqual(decodeCheckpointRecord(encoded.content, { repositoryId: 'repo', number: 1, issueId: 'issue' }),
    { kind: 'decoded-record', record: value });
  assert.equal(decodeCheckpointRecord(encoded.content, { repositoryId: 'other', number: 1, issueId: 'issue' }).reason, 'record-identity-mismatch');
  assert.equal(decodeCheckpointRecord(encoded.content + '\n', { repositoryId: 'repo', number: 1, issueId: 'issue' }).reason, 'noncanonical-record');
});

test('represents first handoff, a subsequent handoff and repair without inventing IDs', () => {
  const first = fixture(); first.current.phase = 'pending'; assert.equal(encodeCheckpointRecord(first).kind, 'encoded-record');
  const next = fixture(); next.previous = handoff(); next.current = handoff({ phase: 'pending', commentId: '2',
    createdAt: '2026-01-01T10:02:00Z', fromStatus: 'agent-ready', targetStatus: 'review' });
  assert.equal(encodeCheckpointRecord(next).kind, 'encoded-record');
  next.current.fromStatus = 'smoke'; assert.equal(encodeCheckpointRecord(next).reason, 'previous-status-mismatch');
  const repair = fixture(); repair.previous = handoff(); repair.current = handoff({ phase: 'pending', fromStatus: 'smoke' });
  assert.equal(encodeCheckpointRecord(repair).kind, 'encoded-record');
  repair.current.digest = 'b'.repeat(64); assert.equal(encodeCheckpointRecord(repair).reason, 'invalid-repair');
});

test('preserves an older comment through reentry and a new post-reopen handoff', () => {
  const value = fixture(); value.epoch = { ...reopened };
  value.reentry = { phase: 'pending', reopenedAt: '2026-01-01T10:02:00Z', fromStatus: 'done', previous: handoff() };
  assert.equal(encodeCheckpointRecord(value).kind, 'encoded-record');
  value.reentry.phase = 'ready'; assert.equal(encodeCheckpointRecord(value).kind, 'encoded-record');
  value.previous = value.current; value.current = handoff({ phase: 'pending', commentId: '2', epoch: { ...reopened },
    createdAt: '2026-01-01T10:03:00Z' });
  assert.equal(encodeCheckpointRecord(value).kind, 'encoded-record');
  value.current.phase = 'committed'; value.previous = null;
  assert.equal(encodeCheckpointRecord(value).kind, 'encoded-record');
  assert.equal(value.reentry.previous.commentId, '1');
  value.current.phase = 'pending'; value.previous = handoff();
  value.previous.digest = 'b'.repeat(64); assert.equal(encodeCheckpointRecord(value).reason, 'reentry-previous-mismatch');
  value.previous = handoff();
  value.reentry.phase = 'pending'; assert.equal(encodeCheckpointRecord(value).reason, 'reentry-in-progress');
});

test('rejects reopened handoffs at or before reopen and impossible initial epochs', () => {
  const value = fixture(); value.epoch = { ...reopened };
  value.reentry = { phase: 'ready', reopenedAt: '2026-01-01T10:02:00Z', fromStatus: 'smoke', previous: handoff() };
  value.current = handoff({ epoch: { ...reopened }, createdAt: value.reentry.reopenedAt });
  assert.equal(encodeCheckpointRecord(value).reason, 'marker-epoch-mismatch');
  reject(v => { v.epoch.anchor = 'other-issue'; }, 'invalid-record');
  reject(v => { v.reentry = {}; }, 'invalid-reentry');
  reject(v => { v.current.createdAt = v.cutoverAt; }, 'marker-before-cutover');
  reject(v => { v.current = null; }, 'missing-initial-handoff');
  value.current = handoff(); value.reentry.previous = null;
  assert.equal(encodeCheckpointRecord(value).reason, 'reentry-previous-mismatch');
});

test('can represent the next reopen while preserving the preceding epoch marker', () => {
  const value = fixture();
  const firstEpoch = { kind: 'reopened', anchor: 'first-reopen' };
  const lastMarker = handoff({ commentId: '2', epoch: firstEpoch, createdAt: '2026-01-01T10:03:00Z' });
  value.epoch = { kind: 'reopened', anchor: 'second-reopen' };
  value.reentry = { phase: 'pending', reopenedAt: '2026-01-01T10:04:00Z', fromStatus: 'done', previous: lastMarker };
  value.current = lastMarker;
  const encoded = encodeCheckpointRecord(value);
  assert.equal(encoded.kind, 'encoded-record');
  const decoded = decodeCheckpointRecord(encoded.content, { repositoryId: 'repo', number: 1, issueId: 'issue' });
  assert.equal(decoded.record.reentry.previous.epoch.anchor, 'first-reopen');
  // Whether the earlier reentry was completed is a cross-record transition
  // precondition; one standalone record cannot establish it.
});

test('rejects unknown fields, invalid statuses, duplicate keys and out-of-order evidence', () => {
  reject(v => { v.extra = 'private'; }, 'invalid-record');
  reject(v => { v.current.targetStatus = 'done'; }, 'invalid-current');
  reject(v => { v.previous = handoff(); }, 'unexpected-previous');
  reject(v => { v.previous = handoff(); v.current = handoff({ phase: 'pending', commentId: '2' }); }, 'invalid-comment-order');
  const encoded = encodeCheckpointRecord(fixture()).content.replace('"version":1', '"version":1,"version":1');
  assert.equal(decodeCheckpointRecord(encoded, { repositoryId: 'repo', number: 1, issueId: 'issue' }).reason, 'noncanonical-record');
});
