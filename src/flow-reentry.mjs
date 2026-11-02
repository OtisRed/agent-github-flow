import { createHash } from 'node:crypto';
import { FLOW_STATUSES } from './flow.mjs';
import { isFlowMarker } from './flow-recovery.mjs';
import { isReentryWitness, checkpointEvidenceMatches } from './flow-reentry-types.mjs';
import { planBootstrap } from './flow-bootstrap.mjs';
import { parseFlowTimestamp } from './flow-epoch.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const same = (a, b) => isFlowMarker(a) && isFlowMarker(b)
  && ['version', 'phase', 'commentId', 'digest', 'fromStatus', 'targetStatus'].every(key => a[key] === b[key]);
const epochValid = epoch => epoch && typeof epoch === 'object' && !Array.isArray(epoch)
  && Object.keys(epoch).length === 2 && Object.hasOwn(epoch, 'kind') && Object.hasOwn(epoch, 'anchor')
  && epoch.kind === 'reopened' && typeof epoch.anchor === 'string' && !!epoch.anchor;
const sameEpoch = (a, b) => epochValid(a) && epochValid(b) && a.anchor === b.anchor;
const validPrevious = (marker, comment) => marker === null || (isFlowMarker(marker) && comment
  && comment.id === marker.commentId && typeof comment.body === 'string'
  && createHash('sha256').update(comment.body, 'utf8').digest('hex') === marker.digest);
const normalWitness = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 3 && ['version', 'current', 'previous'].every(key => Object.hasOwn(value, key))
  && value.version === 1 && value.previous === null && isFlowMarker(value.current) && value.current.phase === 'committed';
const expected = input => ({ witness: structuredClone(input.witness), marker: structuredClone(input.marker),
  issueState: input.issueState, currentStatus: input.currentStatus, epoch: structuredClone(input.epoch),
  cutoverAt: input.cutoverAt, reopenedAt: input.nativeReopenEvidence.reopenedAt });
const mutation = (input, plan) => ({ ...plan, expected: expected(input) });

// Models the native reopen owner only. The caller must prove the latest native
// event, one writer, a complete snapshot and the correct Project/card/field.
// Every returned mutation requires a fresh re-plan and readback; no CAS exists.
export function planReentry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return blocked('invalid-input');
  if (input.complete !== true || input.singleWriterVerified !== true || input.projectSourceVerified !== true
    || input.singleCardVerified !== true) return blocked('unverified-snapshot');
  if (input.issueState !== 'OPEN') return blocked('issue-not-open');
  if (!FLOW_STATUSES.includes(input.currentStatus) || !epochValid(input.epoch)
    || typeof input.issueNodeId !== 'string' || !input.issueNodeId) return blocked('invalid-state');
  if (input.nativeReopenEvidence?.kind !== 'native-reopen-evidence'
    || input.nativeReopenEvidence.issueNodeId !== input.issueNodeId
    || !sameEpoch(input.nativeReopenEvidence.epoch, input.epoch)) return blocked('unverified-native-reopen');
  const cutover = parseFlowTimestamp(input.cutoverAt);
  if (cutover === null) return blocked('invalid-policy');
  const reopenedAt = parseFlowTimestamp(input.nativeReopenEvidence.reopenedAt);
  if (reopenedAt === null) return blocked('unverified-native-reopen');
  if (reopenedAt <= cutover) return blocked('reopen-before-or-at-cutover');
  if (!Object.hasOwn(input, 'marker') || !Object.hasOwn(input, 'witness')) return blocked('missing-checkpoint-state');

  const witness = input.witness;
  if (isReentryWitness(witness)) {
    if (witness.cutoverAt !== input.cutoverAt) return blocked('cutover-changed');
    if (!validPrevious(witness.previous, input.previousComment)) return blocked('previous-comment-missing-or-changed');
    if (witness.previous !== null && (!checkpointEvidenceMatches(input, witness.previous)
      || input.checkpointEpochEvidence.relation !== 'prior')) return blocked('unverified-checkpoint-epoch');
    if (!sameEpoch(witness.epoch, input.epoch)) {
      // Start a new reset; never execute an older epoch's pending step.
      // A partial older reset is admissible only at a known intermediate
      // status and with its expected marker. Native done may follow closure.
      if (witness.phase === 'ready' && input.marker !== null) return blocked('epoch-changed');
      if (witness.phase === 'pending') {
        if (input.marker !== null && !same(input.marker, witness.previous)) return blocked('checkpoint-mismatch');
        if (![witness.fromStatus, 'needs-design', 'done'].includes(input.currentStatus)) return blocked('unexpected-status');
        if (witness.previous !== null && input.marker === null && input.currentStatus === witness.fromStatus
          && !['needs-design', 'done'].includes(input.currentStatus)) return blocked('unexpected-status');
      }
      return mutation(input, { kind: 'start-reentry', witness: { version: 3, kind: 'reentry', phase: 'pending',
        epoch: structuredClone(input.epoch), previous: structuredClone(witness.previous), fromStatus: input.currentStatus, cutoverAt: input.cutoverAt } });
    }
    if (witness.phase === 'ready') {
      if (input.marker !== null) return blocked('checkpoint-mismatch');
      return input.currentStatus === 'done' ? blocked('open-issue-in-done') : { kind: 'already-reentered' };
    }
    if (input.marker !== null && !same(input.marker, witness.previous)) return blocked('checkpoint-mismatch');
    if (input.currentStatus === witness.fromStatus && witness.fromStatus !== 'needs-design') {
      return mutation(input, { kind: 'update-status', expectedStatus: witness.fromStatus, targetStatus: 'needs-design' });
    }
    if (input.currentStatus !== 'needs-design') return blocked('unexpected-status');
    if (input.marker !== null) return mutation(input, { kind: 'remove-issue-marker', marker: structuredClone(input.marker) });
    return mutation(input, { kind: 'finish-reentry', witness: { ...structuredClone(witness), phase: 'ready' } });
  }

  if (witness?.version === 2 && witness.kind === 'bootstrap') {
    const plan = planBootstrap(input);
    return ['write-issue-pending', 'update-status', 'commit-project-checkpoint', 'commit-issue-marker', 'normalize-project-checkpoint']
      .includes(plan.kind) ? { kind: 'already-reentered' } : blocked('unverified-bootstrap');
  }
  let previous = null;
  if (normalWitness(witness)) {
    if (!same(input.marker, witness.current)) return blocked('checkpoint-mismatch');
    if (!validPrevious(witness.current, input.previousComment)) return blocked('previous-comment-missing-or-changed');
    if (!checkpointEvidenceMatches(input, witness.current)) return blocked('unverified-checkpoint-epoch');
    if (input.checkpointEpochEvidence.relation === 'current') {
      return input.currentStatus !== 'done' ? { kind: 'already-reentered' } : blocked('open-issue-in-done');
    }
    previous = structuredClone(witness.current);
  } else if (witness !== null || input.marker !== null) return blocked('checkpoint-mismatch');

  return mutation(input, { kind: 'start-reentry', witness: { version: 3, kind: 'reentry', phase: 'pending',
    epoch: structuredClone(input.epoch), previous, fromStatus: input.currentStatus, cutoverAt: input.cutoverAt } });
}
