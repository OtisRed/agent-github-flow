import { createHash } from 'node:crypto';
import { parseFlowComment } from './flow.mjs';
import { isFlowMarker, planRecovery } from './flow-recovery.mjs';
import { planActiveStatus } from './flow-transition.mjs';
import { isReentryWitness, checkpointEvidenceMatches } from './flow-reentry-types.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const validTime = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value.replace('Z', '.000Z') ? time : null;
};
const validEpoch = epoch => epoch && typeof epoch === 'object' && !Array.isArray(epoch)
  && Object.keys(epoch).length === 2 && Object.hasOwn(epoch, 'kind') && Object.hasOwn(epoch, 'anchor')
  && ['initial', 'reopened'].includes(epoch.kind) && typeof epoch.anchor === 'string' && !!epoch.anchor;
const same = (a, b) => isFlowMarker(a) && isFlowMarker(b)
  && ['version', 'phase', 'commentId', 'digest', 'fromStatus', 'targetStatus'].every(key => a[key] === b[key]);
const previousMatches = (marker, comment) => marker === null || (isFlowMarker(marker) && comment
  && comment.id === marker.commentId && typeof comment.body === 'string'
  && createHash('sha256').update(comment.body, 'utf8').digest('hex') === marker.digest);
const expected = input => ({ witness: structuredClone(input.witness), marker: structuredClone(input.marker),
  issueState: input.issueState, currentStatus: input.currentStatus, epoch: structuredClone(input.epoch),
  cutoverAt: input.cutoverAt, handoff: { id: input.handoff.id, nodeId: input.handoff.nodeId,
    authorId: input.handoff.authorId, createdAt: input.handoff.createdAt, digest: createHash('sha256').update(input.handoff.body, 'utf8').digest('hex') } });
const mutation = (input, plan) => ({ ...plan, expected: expected(input) });

// A pure proposal, not an API adapter or a write permit. The caller must
// establish the complete snapshot, trusted selection, epoch and single writer,
// then re-plan from a fresh snapshot before each separate GitHub mutation.
export function planBootstrap(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return blocked('invalid-input');
  if (input.complete !== true || input.singleWriterVerified !== true || input.projectSourceVerified !== true
    || input.singleCardVerified !== true) return blocked('unverified-snapshot');
  if (input.issueState !== 'OPEN') return blocked('issue-not-open');
  const cutover = validTime(input.cutoverAt);
  if (cutover === null || !validEpoch(input.epoch)) return blocked('invalid-policy');
  const state = planActiveStatus({ issueState: input.issueState, currentStatus: input.currentStatus, targetStatus: input.currentStatus });
  if (state.kind === 'blocked') return state;
  if (!Object.hasOwn(input, 'marker') || !Object.hasOwn(input, 'witness')) return blocked('missing-checkpoint-state');
  if (isReentryWitness(input.witness) && input.witness.cutoverAt !== input.cutoverAt) return blocked('cutover-changed');
  const reentryReady = isReentryWitness(input.witness) && input.witness.phase === 'ready'
    && input.epoch.kind === 'reopened' && input.witness.epoch.anchor === input.epoch.anchor && input.marker === null;
  if (reentryReady && !previousMatches(input.witness.previous, input.previousComment)) return blocked('previous-comment-missing-or-changed');
  if (reentryReady && input.witness.previous !== null && (!checkpointEvidenceMatches(input, input.witness.previous)
    || input.checkpointEpochEvidence.relation !== 'prior')) return blocked('unverified-checkpoint-epoch');
  if (!input.handoff || input.handoff.kind === 'blocked') return blocked('unverified-handoff');
  if (input.handoff.kind === 'absent') {
    return input.marker === null && (input.witness === null || reentryReady)
      ? { kind: 'awaiting-handoff' } : blocked('missing-checkpointed-handoff');
  }
  const handoff = input.handoff;
  if (handoff.kind !== 'handoff' || typeof handoff.id !== 'string' || !/^[1-9][0-9]*$/.test(handoff.id)
    || typeof handoff.nodeId !== 'string' || !handoff.nodeId || typeof handoff.body !== 'string'
    || validTime(handoff.createdAt) === null) return blocked('invalid-handoff');
  const parsed = parseFlowComment(handoff.body);
  if (!parsed.ok) return blocked('invalid-handoff');
  if (input.trusted !== true) return blocked('unverified-handoff');
  if (validTime(handoff.createdAt) <= cutover) {
    return input.marker === null && (input.witness === null || reentryReady)
      ? { kind: 'awaiting-fresh-handoff' } : blocked('handoff-before-cutover');
  }
  const transition = planActiveStatus({ issueState: input.issueState, currentStatus: input.currentStatus, targetStatus: parsed.targetStatus });
  if (transition.kind === 'blocked') return transition;
  const digest = createHash('sha256').update(handoff.body, 'utf8').digest('hex');
  const proof = input.handoffEpochEvidence;
  if (!proof || proof.kind !== 'handoff-epoch-evidence' || typeof input.issueNodeId !== 'string' || !input.issueNodeId
    || proof.issueNodeId !== input.issueNodeId || proof.commentNodeId !== handoff.nodeId || proof.commentId !== handoff.id || proof.commentCreatedAt !== handoff.createdAt
    || proof.commentDigest !== digest || proof.epoch?.kind !== input.epoch.kind || proof.epoch?.anchor !== input.epoch.anchor) {
    return blocked('unverified-handoff');
  }

  if (input.witness === null || reentryReady) {
    if (input.marker !== null) return blocked('checkpoint-mismatch');
    if (reentryReady && input.witness.previous?.commentId === handoff.id) return blocked('old-handoff');
    const marker = { version: 1, phase: 'pending', commentId: handoff.id, digest,
      fromStatus: input.currentStatus, targetStatus: parsed.targetStatus };
    const witness = { version: 2, kind: 'bootstrap', epoch: structuredClone(input.epoch), cutoverAt: input.cutoverAt,
      current: marker, previous: reentryReady ? structuredClone(input.witness.previous) : null };
    return mutation(input, { kind: 'write-bootstrap-witness', witness });
  }

  const witness = input.witness;
  if (witness && Object.keys(witness).length === 3 && ['version', 'current', 'previous'].every(key => Object.hasOwn(witness, key))
    && witness.version === 1 && witness.previous === null && isFlowMarker(witness.current)
    && witness.current.phase === 'committed' && same(input.marker, witness.current)
    && witness.current.commentId === handoff.id && witness.current.digest === digest
    && witness.current.targetStatus === parsed.targetStatus && input.currentStatus === parsed.targetStatus) {
    return { kind: 'bootstrap-complete' };
  }
  if (!witness || typeof witness !== 'object' || Array.isArray(witness) || Object.keys(witness).length !== 6
    || !['version', 'kind', 'epoch', 'cutoverAt', 'current', 'previous'].every(key => Object.hasOwn(witness, key))
    || witness.version !== 2 || witness.kind !== 'bootstrap' || !validEpoch(witness.epoch)
    || !isFlowMarker(witness.current) || !(witness.previous === null
      || (isFlowMarker(witness.previous) && witness.previous.phase === 'committed'))) return blocked('invalid-bootstrap-witness');
  if (witness.epoch.kind !== input.epoch.kind || witness.epoch.anchor !== input.epoch.anchor) return blocked('epoch-changed');
  if (witness.cutoverAt !== input.cutoverAt) return blocked('cutover-changed');
  if (!previousMatches(witness.previous, input.previousComment)) return blocked('previous-comment-missing-or-changed');
  if (witness.previous !== null && (!checkpointEvidenceMatches(input, witness.previous)
    || input.checkpointEpochEvidence.relation !== 'prior')) return blocked('unverified-checkpoint-epoch');
  if (witness.previous?.commentId === witness.current.commentId) return blocked('old-handoff');
  const marker = witness.current;
  if (marker.commentId !== handoff.id || marker.digest !== digest || marker.targetStatus !== parsed.targetStatus) return blocked('handoff-changed');
  if (marker.phase === 'committed') {
    if (input.currentStatus !== marker.targetStatus) return blocked('unexpected-status');
    if (same(input.marker, { ...marker, phase: 'pending' })) {
      return mutation(input, { kind: 'commit-issue-marker', marker: structuredClone(marker) });
    }
    if (same(input.marker, marker)) {
      return mutation(input, { kind: 'normalize-project-checkpoint', witness: {
        version: 1, current: structuredClone(marker), previous: null,
      } });
    }
    return blocked('checkpoint-mismatch');
  }
  const recovery = planRecovery({ marker, latestComment: { id: handoff.id, body: handoff.body },
    issueState: input.issueState, currentStatus: input.currentStatus, complete: input.complete,
    trusted: input.trusted, currentEpochVerified: true,
    singleWriterVerified: input.singleWriterVerified, markerProvenanceVerified: input.projectSourceVerified });
  if (recovery.kind === 'blocked') return recovery;
  if (input.marker === null) {
    return input.currentStatus === marker.fromStatus
      ? mutation(input, { kind: 'write-issue-pending', marker: structuredClone(marker) })
      : blocked('unexpected-status');
  }
  if (!same(input.marker, marker)) return blocked('checkpoint-mismatch');
  if (recovery.kind === 'update-status') return mutation(input, recovery);
  if (recovery.kind === 'commit-marker') {
    return mutation(input, { kind: 'commit-project-checkpoint', witness: { ...structuredClone(witness),
      current: { ...marker, phase: 'committed' } } });
  }
  return blocked('unexpected-recovery');
}
