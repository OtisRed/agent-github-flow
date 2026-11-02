import { createHash } from 'node:crypto';
import { parseFlowComment } from './flow.mjs';
import { isFlowMarker } from './flow-recovery.mjs';
import { planActiveStatus } from './flow-transition.mjs';
import { matchesHandoffEpoch } from './flow-epoch-proof.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const digest = body => createHash('sha256').update(body, 'utf8').digest('hex');
const sameMarker = (a, b) => isFlowMarker(a) && isFlowMarker(b)
  && ['version', 'phase', 'commentId', 'digest', 'fromStatus', 'targetStatus'].every(key => a[key] === b[key]);

// Plans the first Project write for a subsequent handoff. The latest
// trusted selection, both complete epoch reads and exclusive writer must be
// established by the caller and refreshed before every actual mutation.
export function planNextHandoff(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return blocked('invalid-input');
  if (input.complete !== true || input.singleWriterVerified !== true || input.projectSourceVerified !== true
    || input.singleCardVerified !== true || input.trusted !== true) return blocked('unverified-snapshot');
  if (input.issueState !== 'OPEN') return blocked('issue-not-open');
  const witness = input.witness;
  if (!witness || typeof witness !== 'object' || Array.isArray(witness) || Object.keys(witness).length !== 3
    || witness.version !== 1 || witness.previous !== null || !isFlowMarker(witness.current)
    || witness.current.phase !== 'committed' || !sameMarker(input.marker, witness.current)) return blocked('checkpoint-mismatch');
  const previous = input.previousComment;
  const handoff = input.handoff;
  if (handoff?.kind !== 'handoff' || !matchesHandoffEpoch(input, handoff, input.handoffEpochEvidence)
    || !matchesHandoffEpoch(input, previous, input.previousEpochEvidence)
    || previous.id !== witness.current.commentId || digest(previous.body) !== witness.current.digest) return blocked('unverified-comments');
  if (handoff.id === previous.id) return { kind: 'unchanged' };
  if (Date.parse(handoff.createdAt) <= Date.parse(previous.createdAt)) return blocked('ambiguous-or-older-handoff');
  if (input.currentStatus !== witness.current.targetStatus) return blocked('previous-status-mismatch');
  const parsed = parseFlowComment(handoff.body);
  if (!parsed.ok) return blocked('invalid-handoff');
  const transition = planActiveStatus({ issueState: input.issueState, currentStatus: input.currentStatus, targetStatus: parsed.targetStatus });
  if (transition.kind === 'blocked') return transition;
  const current = { version: 1, phase: 'pending', commentId: handoff.id, digest: digest(handoff.body),
    fromStatus: input.currentStatus, targetStatus: parsed.targetStatus };
  return { kind: 'start-handoff', witness: { version: 1, current, previous: structuredClone(witness.current) },
    expected: { witness: structuredClone(witness), marker: structuredClone(input.marker), issueState: input.issueState,
      currentStatus: input.currentStatus, epoch: structuredClone(input.epoch),
      handoff: { id: handoff.id, nodeId: handoff.nodeId, authorId: handoff.authorId, createdAt: handoff.createdAt, digest: current.digest },
      previous: { id: previous.id, nodeId: previous.nodeId, createdAt: previous.createdAt, digest: witness.current.digest } } };
}
