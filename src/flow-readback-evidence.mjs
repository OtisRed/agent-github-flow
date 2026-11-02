import { createHash } from 'node:crypto';
import { isFlowMarker } from './flow-recovery.mjs';
import { matchesHandoffEpoch } from './flow-epoch-proof.mjs';
import { checkpointEvidenceMatches } from './flow-reentry-types.mjs';

// Construct only from the freshly planned snapshot; a numeric ID alone is not
// sufficient to prove that the readback concerns the same saved comment.
export function makeReadbackCheckpoint(snapshot) {
  if (!snapshot?.previousComment) return null;
  const marker = snapshot.witness?.previous ?? snapshot.witness?.current;
  const comment = snapshot.previousComment;
  if (!isFlowMarker(marker) || comment.id !== marker.commentId || typeof comment.body !== 'string'
    || createHash('sha256').update(comment.body, 'utf8').digest('hex') !== marker.digest) return null;
  const evidence = snapshot.checkpointEpochEvidence ?? snapshot.previousEpochEvidence;
  const valid = evidence?.kind === 'checkpoint-epoch-evidence'
    ? checkpointEvidenceMatches(snapshot, marker)
    : matchesHandoffEpoch(snapshot, comment, evidence);
  if (!valid) return null;
  return { issueNodeId: snapshot.issueNodeId, marker: structuredClone(marker), commentNodeId: comment.nodeId,
    epochEvidence: structuredClone(evidence), nativeReopenEvidence: structuredClone(snapshot.nativeReopenEvidence ?? null) };
}
