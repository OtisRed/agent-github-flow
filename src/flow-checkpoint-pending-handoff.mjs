import { createHash } from 'node:crypto';
import { parseFlowComment } from './flow.mjs';
import { matchesHandoffEpoch } from './flow-epoch-proof.mjs';
import { encodeCheckpointRecord } from './flow-checkpoint-record.mjs';
import { encodeCheckpointIndex } from './flow-checkpoint-index.mjs';
import { planCheckpointCommit } from './flow-checkpoint-commit-plan.mjs';

const blocked = reason => ({ kind: 'blocked', reason });

// Initial-epoch, first handoff only. Caller must authenticate all readers,
// confirm single-writer/protection and latest-comment evidence, and re-read
// immediately before any mutation. This pure plan does not authorize writes.
export function planPendingBranchHandoff(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return blocked('invalid-input');
  const { checkpoint, project, handoffEvidence, epochProof, trustedAuthorIds, expectedProjectId } = input;
  const handoff = handoffEvidence?.handoff;
  if (handoffEvidence?.kind !== 'evidence' || !Array.isArray(trustedAuthorIds) || trustedAuthorIds.length === 0
      || trustedAuthorIds.some(id => typeof id !== 'string' || !id) || new Set(trustedAuthorIds).size !== trustedAuthorIds.length
      || typeof expectedProjectId !== 'string' || !expectedProjectId) return blocked('invalid-evidence');
  const record = checkpoint?.selectedRecord;
  if (checkpoint?.kind !== 'checkpoint-snapshot-observed' || project?.kind !== 'branch-project-observed'
      || !checkpoint.selection || encodeCheckpointRecord(record).kind !== 'encoded-record'
      || typeof checkpoint.headOid !== 'string' || !/^[a-f0-9]{40}$/.test(checkpoint.headOid) || checkpoint.headOid === '0'.repeat(40)
      || encodeCheckpointIndex(checkpoint.index).kind !== 'encoded-index' || checkpoint.index.repositoryId !== checkpoint.repositoryId
      || !checkpoint.index.issues.some(issue => issue.number === record.number && issue.issueId === record.issueId)
      || record.repositoryId !== checkpoint.repositoryId || record.issueId !== checkpoint.selection.issueId
      || record.number !== checkpoint.selection.number || record.cutoverAt !== checkpoint.cutoverAt
      || project.issueNodeId !== record.issueId || project.repository !== checkpoint.repositoryFullName
      || project.projectId !== expectedProjectId || typeof project.itemId !== 'string' || !project.itemId) {
    return blocked('snapshot-mismatch');
  }
  if (record.epoch.kind !== 'initial' || record.reentry !== null || record.previous !== null
      || record.current?.phase !== 'pending') return blocked('unsupported-checkpoint');
  if (project.issueState !== 'OPEN') return blocked('issue-not-open');
  const marker = record.current;
  if (handoff?.kind !== 'handoff' || !trustedAuthorIds.includes(handoff.authorId)
      || handoff.id !== marker.commentId || handoff.createdAt !== marker.createdAt
      || typeof handoff.body !== 'string' || createHash('sha256').update(handoff.body, 'utf8').digest('hex') !== marker.digest
      || !matchesHandoffEpoch({ issueNodeId: record.issueId, epoch: record.epoch }, handoff, epochProof)) return blocked('handoff-mismatch');
  const parsed = parseFlowComment(handoff.body);
  if (!parsed.ok || parsed.targetStatus !== marker.targetStatus) return blocked('handoff-mismatch');
  if (typeof project.statusFieldId !== 'string' || !project.statusFieldId || !Array.isArray(project.statusOptions)
      || project.statusOptions.some(option => typeof option?.id !== 'string' || !option.id
        || typeof option.name !== 'string' || !option.name)
      || new Set(project.statusOptions.map(option => option.id)).size !== project.statusOptions.length
      || new Set(project.statusOptions.map(option => option.name)).size !== project.statusOptions.length) return blocked('invalid-status-options');
  const current = project.statusOptions.find(option => option.name === project.currentStatus);
  const target = project.statusOptions.find(option => option.name === marker.targetStatus);
  if (!current || current.id !== project.statusOptionId || !target) return blocked('status-option-mismatch');
  if (project.currentStatus === marker.targetStatus) {
    const after = structuredClone(record); after.current.phase = 'committed';
    const commit = planCheckpointCommit({ snapshot: checkpoint, after });
    if (commit.kind !== 'checkpoint-commit-plan') return commit;
    return { kind: 'commit-handoff-planned', record: after, commit };
  }
  if (project.currentStatus !== marker.fromStatus) return blocked('unexpected-status');
  return { kind: 'status-update-planned', projectId: project.projectId, itemId: project.itemId,
    statusFieldId: project.statusFieldId, fromOptionId: current.id, targetOptionId: target.id,
    expectedCheckpointOid: checkpoint.headOid, issueNodeId: record.issueId, commentId: marker.commentId, commentDigest: marker.digest };
}
