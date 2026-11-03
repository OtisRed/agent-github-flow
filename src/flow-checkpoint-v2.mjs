import { encodeCheckpointRecord, decodeCheckpointRecord } from './flow-checkpoint-record.mjs';
import { verifyCheckpointContinuity } from './flow-checkpoint-continuity.mjs';
import { parseFlowTimestamp } from './flow-epoch.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = ['version', 'repositoryId', 'number', 'issueId', 'cutoverAt', 'epoch', 'reentry', 'current', 'previous', 'reservation'];

// Structural schema only: callers must separately verify trusted v2 bootstrap,
// history, authorization, a fresh observation, and CAS before any write.
export function encodeCheckpointV2(record) {
  if (!exact(record, keys) || record.version !== 2) return blocked('invalid-v2-record');
  const { reservation, ...base } = record;
  const encoded = encodeCheckpointRecord({ ...base, version: 1 });
  if (encoded.kind !== 'encoded-record') return blocked('invalid-base-record');
  if (reservation !== null) {
    if (!exact(reservation, ['reservedAt', 'fromOptionId', 'targetOptionId']) || record.current?.phase !== 'pending'
        || parseFlowTimestamp(reservation.reservedAt) === null || reservation.reservedAt < record.current.createdAt
        || !id(reservation.fromOptionId) || !id(reservation.targetOptionId)
        || reservation.fromOptionId === reservation.targetOptionId) return blocked('invalid-reservation');
  }
  const canonical = JSON.parse(encoded.content);
  canonical.version = 2;
  canonical.reservation = reservation === null ? null : { reservedAt: reservation.reservedAt,
    fromOptionId: reservation.fromOptionId, targetOptionId: reservation.targetOptionId };
  const content = JSON.stringify(canonical);
  return Buffer.byteLength(content, 'utf8') <= 16384 ? { kind: 'encoded-record', content } : blocked('record-too-large');
}

export function decodeCheckpointV2(content, identity) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 16384) return blocked('invalid-input');
  let record; try { record = JSON.parse(content); } catch { return blocked('invalid-json'); }
  const encoded = encodeCheckpointV2(record);
  if (encoded.kind !== 'encoded-record') return encoded;
  if (content !== encoded.content) return blocked('noncanonical-record');
  const { reservation: _reservation, ...base } = record;
  const validated = decodeCheckpointRecord(JSON.stringify({ ...base, version: 1 }), identity);
  return validated.kind === 'decoded-record' ? { kind: 'decoded-record', record } : blocked('invalid-identity');
}

const baseRecord = record => {
  const { reservation: _reservation, ...base } = record;
  return { ...base, version: 1 };
};

// Does not authorize retries or establish that a remote request has stopped.
export function verifyCheckpointV2Continuity(before, after) {
  if (encodeCheckpointV2(after).kind !== 'encoded-record') return blocked('invalid-next-record');
  if (before === null) {
    if (after.reservation !== null) return blocked('initial-reservation');
    return verifyCheckpointContinuity(null, baseRecord(after));
  }
  if (encodeCheckpointV2(before).kind !== 'encoded-record') return blocked('invalid-previous-record');
  const previous = baseRecord(before), next = baseRecord(after);
  if (verifyCheckpointContinuity(previous, next).kind !== 'continuity-verified') return blocked('invalid-base-transition');
  if (same(previous, next)) {
    if (same(before.reservation, after.reservation)) return { kind: 'continuity-verified' };
    if (after.reservation === null || after.current?.phase !== 'pending') return blocked('reservation-removed');
    if (before.reservation !== null && (after.reservation.reservedAt <= before.reservation.reservedAt
        || after.reservation.fromOptionId !== before.reservation.fromOptionId
        || after.reservation.targetOptionId !== before.reservation.targetOptionId)) return blocked('reservation-changed');
    return { kind: 'continuity-verified' };
  }
  if (after.reservation !== null) return blocked('reservation-with-handoff-change');
  if (before.current?.phase === 'pending' && after.current?.phase === 'committed'
      && before.reservation === null && before.current.fromStatus !== before.current.targetStatus)
    return blocked('missing-transition-reservation');
  if (before.reservation !== null && !(before.current?.phase === 'pending' && after.current?.phase === 'committed'))
    return blocked('reservation-discarded');
  return { kind: 'continuity-verified' };
}
