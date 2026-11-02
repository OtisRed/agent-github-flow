import { FLOW_STATUSES } from './flow.mjs';
import { isFlowMarker } from './flow-recovery.mjs';

const epochValid = epoch => epoch && typeof epoch === 'object' && !Array.isArray(epoch)
  && Object.keys(epoch).length === 2 && Object.hasOwn(epoch, 'kind') && Object.hasOwn(epoch, 'anchor')
  && epoch.kind === 'reopened' && typeof epoch.anchor === 'string' && !!epoch.anchor;

export function isReentryWitness(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 6
    && ['version', 'kind', 'phase', 'epoch', 'previous', 'fromStatus'].every(key => Object.hasOwn(value, key))
    && value.version === 2 && value.kind === 'reentry' && ['pending', 'ready'].includes(value.phase)
    && epochValid(value.epoch) && (value.previous === null || (isFlowMarker(value.previous) && value.previous.phase === 'committed'))
    && FLOW_STATUSES.includes(value.fromStatus);
}

export function checkpointEvidenceMatches(input, marker) {
  const proof = input?.checkpointEpochEvidence;
  return proof && proof.kind === 'checkpoint-epoch-evidence' && ['prior', 'current'].includes(proof.relation)
    && typeof input.issueNodeId === 'string' && !!input.issueNodeId && proof.issueNodeId === input.issueNodeId
    && proof.commentId === marker.commentId && proof.commentDigest === marker.digest
    && typeof input.previousComment?.nodeId === 'string' && !!input.previousComment.nodeId
    && proof.commentNodeId === input.previousComment.nodeId && epochValid(proof.epoch) && epochValid(input.epoch)
    && proof.epoch.anchor === input.epoch.anchor;
}
