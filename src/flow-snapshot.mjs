import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { readProjectIssue } from './flow-github-project.mjs';
import { readSplitProjectIssue } from './flow-github-split-project.mjs';
import { collectHandoffEvidence } from './flow-handoff-reader.mjs';
import { collectEpochEvidence, collectCheckpointEpochEvidence } from './flow-epoch-reader.mjs';
import { collectNativeReopenEvidence } from './flow-native-epoch-reader.mjs';
import { matchesHandoffEpoch } from './flow-epoch-proof.mjs';
import { checkpointEvidenceMatches } from './flow-reentry-types.mjs';
import { isFlowMarker } from './flow-recovery.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const nonempty = value => typeof value === 'string' && value.length > 0;
const checkpoint = witness => {
  if (witness === null) return null;
  if (!witness || typeof witness !== 'object') return undefined;
  if (witness.kind === 'reentry' || witness.kind === 'bootstrap') return witness.previous;
  if (witness.version === 1 && witness.current?.phase === 'pending') return witness.previous;
  if (witness.version === 1 && witness.current?.phase === 'committed' && witness.previous === null) return witness.current;
  return undefined;
};

// Read-only composition. Author IDs are caller-supplied; successful reads
// do not establish that those IDs, the Project field, or a writer are trusted.
// Returned trust flags are deliberately false until independently established.
export async function collectFlowSnapshot(input, readers = {}, options = {}) {
  if (!input || typeof (input.issueGraphql ?? input.graphql) !== 'function' || !nonempty(input.owner) || !nonempty(input.repo)
    || !Number.isSafeInteger(input.number) || input.number < 1 || !nonempty(input.issueId)
    || !['projectId', 'itemId', 'statusFieldId', 'statusFieldName', 'checkpointFieldId', 'checkpointFieldName'].every(key => nonempty(input[key]))
    || !['handoff', 'reentry'].includes(input.mode) || !Array.isArray(input.trustedAuthorIds)
    || input.trustedAuthorIds.length === 0 || input.trustedAuthorIds.some(id => !nonempty(id)) || !nonempty(input.repository)
    || new Set(input.trustedAuthorIds).size !== input.trustedAuthorIds.length
    || input.repository?.toLowerCase() !== `${input.owner}/${input.repo}`.toLowerCase()) return blocked('invalid-input');
  const split = ['projectGraphql', 'issueGraphql', 'listItems'].some(key => Object.hasOwn(input, key));
  if (split && (typeof input.projectGraphql !== 'function' || typeof input.issueGraphql !== 'function'
    || typeof input.listItems !== 'function' || !nonempty(input.projectOwner)
    || !Number.isSafeInteger(input.projectNumber) || input.projectNumber < 1)) return blocked('invalid-split-transport');
  const projectReader = readers.project ?? (typeof input.projectGraphql === 'function' ? readSplitProjectIssue : readProjectIssue);
  const handoffReader = readers.handoff ?? collectHandoffEvidence;
  const epochReader = readers.epoch ?? collectEpochEvidence;
  const checkpointReader = readers.checkpoint ?? collectCheckpointEpochEvidence;
  const nativeReader = readers.native ?? collectNativeReopenEvidence;
  if (![projectReader, handoffReader, epochReader, checkpointReader, nativeReader].every(fn => typeof fn === 'function')) return blocked('invalid-readers');
  const readback = options?.readbackCheckpoint ?? null;
  if (readback !== null && (readback.issueNodeId !== input.issueId || !isFlowMarker(readback.marker)
    || readback.marker.phase !== 'committed' || !nonempty(readback.commentNodeId)
    || !['checkpoint-epoch-evidence', 'handoff-epoch-evidence'].includes(readback.epochEvidence?.kind)
    || !(readback.nativeReopenEvidence === null || readback.nativeReopenEvidence?.kind === 'native-reopen-evidence'))) return blocked('invalid-readback-checkpoint');
  const args = { graphql: input.issueGraphql ?? input.graphql, owner: input.owner, repo: input.repo, number: input.number, observedAt: input.observedAt };
  let first;
  try { first = await projectReader(input); } catch { return blocked('project-read-failed'); }
  if (first?.kind !== 'snapshot') return blocked('project-read-failed');
  if (first.issueNodeId !== input.issueId || first.repository?.toLowerCase() !== input.repository.toLowerCase()) return blocked('issue-mismatch');
  const previousMarker = checkpoint(first.witness);
  if (previousMarker === undefined || (previousMarker !== null && !isFlowMarker(previousMarker))) return blocked('invalid-checkpoint');
  let comments;
  try { comments = await handoffReader({ ...args, trustedAuthorIds: input.trustedAuthorIds,
    ...(previousMarker ? { checkpointCommentId: previousMarker.commentId } : {}) }); } catch { return blocked('handoff-read-failed'); }
  if (comments?.kind !== 'evidence') return blocked('handoff-read-failed');
  if (previousMarker && (!comments.previousComment || comments.previousComment.id !== previousMarker.commentId
    || typeof comments.previousComment.body !== 'string'
    || createHash('sha256').update(comments.previousComment.body, 'utf8').digest('hex') !== previousMarker.digest)) return blocked('previous-comment-mismatch');
  const output = { ...first, complete: true, trusted: false, singleWriterVerified: false,
    projectSourceVerified: false, singleCardVerified: false, handoff: comments.handoff,
    ...(previousMarker ? { previousComment: comments.previousComment } : {}) };
  if (input.mode === 'reentry') {
    let native;
    try { native = await nativeReader({ ...args, issueNodeId: input.issueId }); } catch { return blocked('native-read-failed'); }
    if (native?.kind !== 'native-reopen-evidence' || native.issueNodeId !== input.issueId) return blocked('native-read-failed');
    output.epoch = native.epoch; output.nativeReopenEvidence = native;
    if (previousMarker) {
      let evidence;
      try { evidence = await checkpointReader({ ...args, commentNodeId: comments.previousComment.nodeId, commentId: previousMarker.commentId }); }
      catch { return blocked('checkpoint-epoch-read-failed'); }
      if (!checkpointEvidenceMatches({ issueNodeId: input.issueId, epoch: native.epoch, previousComment: comments.previousComment,
        checkpointEpochEvidence: evidence }, previousMarker)) return blocked('checkpoint-epoch-read-failed');
      output.checkpointEpochEvidence = evidence;
    }
  } else {
    if (comments.handoff?.kind === 'absent') {
      if (first.marker !== null || first.witness !== null) return blocked('missing-checkpointed-handoff');
      let final; try { final = await projectReader(input); } catch { return blocked('project-read-failed'); }
      return final && isDeepStrictEqual(first, final) ? { kind: 'awaiting-handoff' } : blocked('project-snapshot-changed');
    }
    if (comments.handoff?.kind !== 'handoff') return blocked('handoff-read-failed');
    let current;
    try { current = await epochReader({ ...args, commentNodeId: comments.handoff.nodeId }); } catch { return blocked('handoff-epoch-read-failed'); }
    if (!matchesHandoffEpoch({ issueNodeId: input.issueId, epoch: current?.epoch }, comments.handoff, current)) return blocked('handoff-epoch-read-failed');
    output.epoch = current.epoch; output.handoffEpochEvidence = current; output.cutoverAt = input.cutoverAt;
    if (previousMarker) {
      if (first.witness?.kind === 'reentry' || first.witness?.kind === 'bootstrap') {
        let previous;
        try { previous = await checkpointReader({ ...args, commentNodeId: comments.previousComment.nodeId, commentId: previousMarker.commentId }); }
        catch { return blocked('checkpoint-epoch-read-failed'); }
        if (!checkpointEvidenceMatches({ issueNodeId: input.issueId, epoch: current.epoch, previousComment: comments.previousComment,
          checkpointEpochEvidence: previous }, previousMarker)) return blocked('checkpoint-epoch-read-failed');
        output.checkpointEpochEvidence = previous;
      } else {
        let previous;
        try { previous = comments.previousComment.nodeId === comments.handoff.nodeId ? current
          : await epochReader({ ...args, commentNodeId: comments.previousComment.nodeId }); }
        catch { return blocked('previous-epoch-read-failed'); }
        if (!matchesHandoffEpoch({ issueNodeId: input.issueId, epoch: current.epoch }, comments.previousComment, previous)) return blocked('previous-epoch-read-failed');
        output.previousEpochEvidence = previous;
      }
    }
  }
  if (readback) {
    let oldComments;
    try { oldComments = await handoffReader({ ...args, trustedAuthorIds: input.trustedAuthorIds,
      checkpointCommentId: readback.marker.commentId }); } catch { return blocked('readback-comment-failed'); }
    const oldComment = oldComments?.previousComment;
    if (oldComments?.kind !== 'evidence' || oldComment?.id !== readback.marker.commentId
      || oldComment?.nodeId !== readback.commentNodeId || typeof oldComment?.body !== 'string'
      || createHash('sha256').update(oldComment.body, 'utf8').digest('hex') !== readback.marker.digest) return blocked('readback-comment-failed');
    let oldProof;
    try { oldProof = readback.epochEvidence.kind === 'checkpoint-epoch-evidence'
      ? await checkpointReader({ ...args, commentNodeId: oldComment.nodeId, commentId: oldComment.id })
      : await epochReader({ ...args, commentNodeId: oldComment.nodeId }); }
    catch { return blocked('readback-epoch-failed'); }
    if (!isDeepStrictEqual(oldProof, readback.epochEvidence)) return blocked('readback-epoch-failed');
    const validProof = oldProof.kind === 'checkpoint-epoch-evidence'
      ? checkpointEvidenceMatches({ issueNodeId: input.issueId, epoch: oldProof.epoch, previousComment: oldComment, checkpointEpochEvidence: oldProof }, readback.marker)
      : matchesHandoffEpoch({ issueNodeId: input.issueId, epoch: oldProof.epoch }, oldComment, oldProof);
    if (!validProof) return blocked('readback-epoch-failed');
    let native = null;
    if (readback.nativeReopenEvidence !== null) {
      try { native = await nativeReader({ ...args, issueNodeId: input.issueId }); } catch { return blocked('readback-native-failed'); }
      if (!isDeepStrictEqual(native, readback.nativeReopenEvidence)) return blocked('readback-native-failed');
    }
    output.readbackPreviousComment = oldComment;
    output.readbackPreviousEpochEvidence = oldProof;
    output.readbackNativeReopenEvidence = native;
  }
  let final;
  try { final = await projectReader(input); } catch { return blocked('project-read-failed'); }
  if (!isDeepStrictEqual(first, final)) return blocked('project-snapshot-changed');
  return output;
}

// Preserve runner-supplied readback options and acquire a fresh observation
// time on every read. This wrapper never elevates any trust flags.
export function createFlowSnapshotReader(input, readers = {}, now = () => new Date()) {
  if (typeof now !== 'function') throw Error('invalid-clock');
  return async options => {
    let date;
    try { date = now(); } catch { return blocked('invalid-clock'); }
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return blocked('invalid-clock');
    const observedAt = date.toISOString().replace(/\.\d{3}Z$/, 'Z');
    return collectFlowSnapshot({ ...input, observedAt }, readers, options);
  };
}
