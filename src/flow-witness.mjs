import { createHash } from 'node:crypto';
import { isFlowMarker, planRecovery } from './flow-recovery.mjs';
import { matchesHandoffEpoch } from './flow-epoch-proof.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const same = (a, b) => isFlowMarker(a) && isFlowMarker(b)
  && ['version', 'phase', 'commentId', 'digest', 'fromStatus', 'targetStatus'].every(key => a[key] === b[key]);
const withPhase = (marker, phase) => ({ ...marker, phase });
const mutation = (plan, witness, marker, snapshot) => ({ ...plan, expected: {
  witness: structuredClone(witness), marker: structuredClone(marker), issueState: snapshot.issueState,
  currentStatus: snapshot.currentStatus, commentId: witness.current.commentId, commentDigest: witness.current.digest,
} });

// Experimental two-copy model only: the caller must establish project field
// integrity, exclusive ownership and a current, complete GitHub snapshot.
// It does not read or write GitHub and cannot make separate writes atomic.
export function planWitnessRecovery(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return blocked('invalid-input');
  const { witness, marker, projectSourceVerified, previousComment, ...snapshot } = input;
  if (projectSourceVerified !== true) return blocked('unverified-project-checkpoint');
  if (!witness || typeof witness !== 'object' || Array.isArray(witness)
    || Object.keys(witness).length !== 3 || !['version', 'current', 'previous'].every(key => Object.hasOwn(witness, key))
    || witness.version !== 1 || !isFlowMarker(witness.current)) return blocked('invalid-project-checkpoint');
  const current = witness.current;
  if (!isFlowMarker(marker)) return blocked('invalid-issue-marker');
  if (current.phase === 'pending') {
    if (!isFlowMarker(witness.previous) || witness.previous.phase !== 'committed'
      || witness.previous.targetStatus !== current.fromStatus
      || witness.previous.commentId === current.commentId) return blocked('invalid-project-checkpoint');
    if (!previousComment || previousComment.id !== witness.previous.commentId || typeof previousComment.body !== 'string') {
      return blocked('missing-previous-comment');
    }
    if (createHash('sha256').update(previousComment.body, 'utf8').digest('hex') !== witness.previous.digest) {
      return blocked('previous-comment-changed');
    }
    if (!matchesHandoffEpoch(input, previousComment, input.previousEpochEvidence)) return blocked('unverified-previous-epoch');
    if (!matchesHandoffEpoch(input, snapshot.latestComment, input.handoffEpochEvidence)) return blocked('unverified-reopen-history');
    const recovery = planRecovery({ ...snapshot, currentEpochVerified: true, marker: current, markerProvenanceVerified: true });
    if (recovery.kind === 'blocked') return recovery;
    if (same(marker, witness.previous)) {
      if (snapshot.currentStatus !== current.fromStatus) return blocked('unexpected-status');
      return mutation({ kind: 'write-issue-pending', marker: structuredClone(current) }, witness, marker, snapshot);
    }
    if (!same(marker, current)) return blocked('checkpoint-mismatch');
    if (recovery.kind === 'update-status') return mutation(recovery, witness, marker, snapshot);
    if (recovery.kind === 'commit-marker') return mutation({ kind: 'commit-project-checkpoint', marker: withPhase(current, 'committed') }, witness, marker, snapshot);
    return blocked('unexpected-recovery');
  }
  if (witness.previous !== null) return blocked('invalid-project-checkpoint');
  if (!matchesHandoffEpoch(input, snapshot.latestComment, input.handoffEpochEvidence)) return blocked('unverified-reopen-history');
  const recovery = planRecovery({ ...snapshot, currentEpochVerified: true, marker: current, markerProvenanceVerified: true });
  if (recovery.kind === 'blocked') return recovery;
  if (same(marker, current)) return recovery.kind === 'update-status' ? mutation(recovery, witness, marker, snapshot) : recovery;
  if (same(marker, withPhase(current, 'pending')) && recovery.kind === 'unchanged') {
    return mutation({ kind: 'commit-issue-marker', marker: structuredClone(current) }, witness, marker, snapshot);
  }
  return blocked('checkpoint-mismatch');
}
