import { FLOW_STATUSES } from './flow.mjs';
import { parseFlowTimestamp } from './flow-epoch.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
const active = value => FLOW_STATUSES.includes(value) && value !== 'done';
const timestamp = value => parseFlowTimestamp(value) !== null;
const epoch = (value, issueId) => exact(value, ['kind', 'anchor']) && id(value.anchor)
  && (value.kind === 'reopened' || (value.kind === 'initial' && value.anchor === issueId));
const sameEpoch = (left, right) => left.kind === right.kind && left.anchor === right.anchor;

function marker(value, issueId) {
  const keys = ['phase', 'commentId', 'digest', 'fromStatus', 'targetStatus', 'createdAt', 'epoch'];
  return exact(value, keys) && ['pending', 'committed'].includes(value.phase)
    && typeof value.commentId === 'string' && /^[1-9][0-9]{0,19}$/.test(value.commentId)
    && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest)
    && active(value.fromStatus) && active(value.targetStatus) && timestamp(value.createdAt) && epoch(value.epoch, issueId);
}
const copyEpoch = value => ({ kind: value.kind, anchor: value.anchor });
const copyMarker = value => value === null ? null : ({ phase: value.phase, commentId: value.commentId, digest: value.digest,
  fromStatus: value.fromStatus, targetStatus: value.targetStatus, createdAt: value.createdAt, epoch: copyEpoch(value.epoch) });

// Candidate on-disk schema only. It does not establish comment provenance,
// public-data eligibility, branch history, freshness or permission to write.
export function encodeCheckpointRecord(record) {
  const keys = ['version', 'repositoryId', 'number', 'issueId', 'cutoverAt', 'epoch', 'reentry', 'current', 'previous'];
  if (!exact(record, keys) || record.version !== 1 || !id(record.repositoryId) || !id(record.issueId)
      || !Number.isSafeInteger(record.number) || record.number < 1 || !timestamp(record.cutoverAt)
      || !epoch(record.epoch, record.issueId)) return blocked('invalid-record');
  const { reentry, current, previous } = record;
  if (record.epoch.kind === 'initial') {
    if (reentry !== null) return blocked('invalid-reentry');
  } else if (!exact(reentry, ['phase', 'reopenedAt', 'fromStatus', 'previous']) || !['pending', 'ready'].includes(reentry.phase)
      || !timestamp(reentry.reopenedAt) || reentry.reopenedAt <= record.cutoverAt || !FLOW_STATUSES.includes(reentry.fromStatus)) {
    return blocked('invalid-reentry');
  }
  if (record.epoch.kind === 'initial' && current === null) return blocked('missing-initial-handoff');
  if (current !== null && !marker(current, record.issueId)) return blocked('invalid-current');
  if (previous !== null && (!marker(previous, record.issueId) || previous.phase !== 'committed')) return blocked('invalid-previous');
  if (reentry && reentry.previous !== null && (!marker(reentry.previous, record.issueId)
      || reentry.previous.phase !== 'committed' || sameEpoch(reentry.previous.epoch, record.epoch)
      || reentry.previous.createdAt >= reentry.reopenedAt)) return blocked('invalid-reentry-previous');
  if (previous !== null && (current === null || current.phase !== 'pending')) return blocked('unexpected-previous');
  if (reentry?.phase === 'pending' && current?.phase === 'pending') return blocked('reentry-in-progress');
  for (const item of [current, previous, reentry?.previous ?? null]) {
    if (item === null) continue;
    if (item.epoch.kind === 'initial' && item.createdAt <= record.cutoverAt) return blocked('marker-before-cutover');
    if (record.epoch.kind === 'initial') {
      if (!sameEpoch(item.epoch, record.epoch)) return blocked('marker-epoch-mismatch');
    } else if (sameEpoch(item.epoch, record.epoch) ? item.createdAt <= reentry.reopenedAt : item.createdAt >= reentry.reopenedAt) {
      return blocked('marker-epoch-mismatch');
    }
  }
  if (reentry && (current === null || !sameEpoch(current.epoch, record.epoch))
      && JSON.stringify(copyMarker(current)) !== JSON.stringify(copyMarker(reentry.previous))) return blocked('reentry-previous-mismatch');
  if (current && reentry?.phase === 'pending' && sameEpoch(current.epoch, record.epoch)) return blocked('reentry-in-progress');
  if (current?.phase === 'pending' && !sameEpoch(current.epoch, record.epoch)) return blocked('marker-epoch-mismatch');
  if (reentry && current?.phase === 'pending' && previous === null && reentry.previous !== null) return blocked('reentry-previous-mismatch');
  if (reentry && current?.phase === 'pending' && previous && !sameEpoch(previous.epoch, record.epoch)
      && JSON.stringify(copyMarker(previous)) !== JSON.stringify(copyMarker(reentry.previous))) return blocked('reentry-previous-mismatch');
  if (previous) {
    if (current.commentId === previous.commentId) {
      if (current.digest !== previous.digest || current.targetStatus !== previous.targetStatus
          || current.createdAt !== previous.createdAt || !sameEpoch(current.epoch, previous.epoch)) return blocked('invalid-repair');
    } else {
      if (current.createdAt <= previous.createdAt) return blocked('invalid-comment-order');
      if (sameEpoch(current.epoch, previous.epoch) && current.fromStatus !== previous.targetStatus) return blocked('previous-status-mismatch');
    }
  }
  const content = JSON.stringify({ version: 1, repositoryId: record.repositoryId, number: record.number, issueId: record.issueId,
    cutoverAt: record.cutoverAt, epoch: copyEpoch(record.epoch),
    reentry: reentry === null ? null : { phase: reentry.phase, reopenedAt: reentry.reopenedAt,
      fromStatus: reentry.fromStatus, previous: copyMarker(reentry.previous) },
    current: copyMarker(current), previous: copyMarker(previous) });
  if (Buffer.byteLength(content, 'utf8') > 16384) return blocked('record-too-large');
  return { kind: 'encoded-record', content };
}

export function decodeCheckpointRecord(content, identity) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 16384 || !object(identity)
      || !id(identity.repositoryId) || !id(identity.issueId) || !Number.isSafeInteger(identity.number) || identity.number < 1) {
    return blocked('invalid-input');
  }
  let record; try { record = JSON.parse(content); } catch { return blocked('invalid-json'); }
  const encoded = encodeCheckpointRecord(record);
  if (encoded.kind !== 'encoded-record') return encoded;
  if (encoded.content !== content) return blocked('noncanonical-record');
  if (record.repositoryId !== identity.repositoryId || record.number !== identity.number || record.issueId !== identity.issueId) {
    return blocked('record-identity-mismatch');
  }
  return { kind: 'decoded-record', record };
}
