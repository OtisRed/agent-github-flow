import { createHash } from 'node:crypto';
import { FLOW_STATUSES, parseFlowComment } from './flow.mjs';
import { planActiveStatus } from './flow-transition.mjs';

const active = status => FLOW_STATUSES.includes(status) && status !== 'done';
const blocked = reason => ({ kind: 'blocked', reason });

export function isFlowMarker(marker) {
  const keys = ['version', 'phase', 'commentId', 'digest', 'fromStatus', 'targetStatus'];
  return !!marker && typeof marker === 'object' && !Array.isArray(marker)
    && Object.keys(marker).length === keys.length && keys.every(key => Object.hasOwn(marker, key))
    && marker.version === 1 && (marker.phase === 'pending' || marker.phase === 'committed')
    && typeof marker.commentId === 'string' && /^[1-9][0-9]*$/.test(marker.commentId)
    && typeof marker.digest === 'string' && /^[a-f0-9]{64}$/.test(marker.digest)
    && active(marker.fromStatus) && active(marker.targetStatus);
}

// The caller owns full pagination, authentication and fresh readbacks. This
// pure decision does not write anything or make the subsequent write atomic.
export function planRecovery(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return blocked('invalid-input');
  const { marker, latestComment, complete, trusted, markerProvenanceVerified, currentEpochVerified, singleWriterVerified, issueState, currentStatus } = input;
  if (complete !== true) return blocked('incomplete-snapshot');
  if (trusted !== true) return blocked('untrusted-comment');
  if (markerProvenanceVerified !== true) return blocked('unverified-marker-provenance');
  if (currentEpochVerified !== true) return blocked('unverified-reopen-history');
  if (singleWriterVerified !== true) return blocked('unverified-writer');
  if (!isFlowMarker(marker)) return blocked('invalid-marker');
  if (!latestComment || typeof latestComment !== 'object'
    || typeof latestComment.id !== 'string' || typeof latestComment.body !== 'string') {
    return blocked('missing-comment');
  }
  if (latestComment.id !== marker.commentId) return blocked('comment-mismatch');
  const digest = createHash('sha256').update(latestComment.body, 'utf8').digest('hex');
  if (digest !== marker.digest) return blocked('comment-changed');
  const parsed = parseFlowComment(latestComment.body);
  if (!parsed.ok || parsed.targetStatus !== marker.targetStatus) return blocked('invalid-comment');

  const transition = planActiveStatus({ issueState, currentStatus, targetStatus: marker.targetStatus });
  if (transition.kind === 'blocked') return transition;
  if (marker.phase === 'committed') {
    return transition.kind === 'unchanged'
      ? { kind: 'unchanged' }
      : { kind: 'update-status', expectedStatus: currentStatus, targetStatus: marker.targetStatus };
  }
  if (currentStatus === marker.targetStatus) return { kind: 'commit-marker' };
  if (currentStatus !== marker.fromStatus) return blocked('unexpected-status');
  return { kind: 'update-status', expectedStatus: marker.fromStatus, targetStatus: marker.targetStatus };
}
