import { createHash } from 'node:crypto';
import { FLOW_STATUSES, parseFlowComment } from './flow.mjs';
import { matchesHandoffEpoch } from './flow-epoch-proof.mjs';
import { planCheckpointCommit } from './flow-checkpoint-commit-plan.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const active = value => FLOW_STATUSES.includes(value) && value !== 'done';

// Narrow initial-epoch candidate only. The caller must authenticate all
// observations, author identity, registration and protection; prove that the
// handoff is the latest complete selection; and re-read before any mutation.
// Returned plan and record may contain private metadata and must not be logged.
export function planInitialBranchHandoff(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return blocked('invalid-input');
  const { checkpoint, project, handoffEvidence, epochProof, trustedAuthorIds, expectedProjectId } = input;
  const handoff = handoffEvidence?.handoff;
  if (handoffEvidence?.kind !== 'evidence' || !Array.isArray(trustedAuthorIds) || trustedAuthorIds.length === 0
      || trustedAuthorIds.some(id => typeof id !== 'string' || !id) || new Set(trustedAuthorIds).size !== trustedAuthorIds.length
      || typeof expectedProjectId !== 'string' || !expectedProjectId) return blocked('invalid-evidence');
  if (checkpoint?.kind !== 'checkpoint-snapshot-observed' || project?.kind !== 'branch-project-observed'
      || !checkpoint.selection || checkpoint.selectedRecord !== null
      || project.issueNodeId !== checkpoint.selection.issueId || project.repository !== checkpoint.repositoryFullName
      || project.projectId !== expectedProjectId || typeof project.itemId !== 'string' || !project.itemId) {
    return blocked('snapshot-mismatch');
  }
  if (project.issueState !== 'OPEN' || !active(project.currentStatus)) return blocked('inactive-issue-or-status');
  if (handoff?.kind !== 'handoff' || !trustedAuthorIds.includes(handoff.authorId)) return blocked('invalid-handoff');
  const parsed = parseFlowComment(handoff.body);
  if (!parsed.ok || !active(parsed.targetStatus)) return blocked('invalid-handoff');
  if (typeof project.statusFieldId !== 'string' || !project.statusFieldId || !Array.isArray(project.statusOptions)
      || project.statusOptions.some(option => typeof option?.id !== 'string' || !option.id
        || typeof option.name !== 'string' || !option.name)
      || new Set(project.statusOptions.map(option => option.id)).size !== project.statusOptions.length
      || new Set(project.statusOptions.map(option => option.name)).size !== project.statusOptions.length) return blocked('invalid-status-options');
  const currentOption = project.statusOptions.find(option => option.name === project.currentStatus);
  const targetOption = project.statusOptions.find(option => option.name === parsed.targetStatus);
  if (!currentOption || currentOption.id !== project.statusOptionId || !targetOption) return blocked('status-option-mismatch');
  const epoch = { kind: 'initial', anchor: project.issueNodeId };
  if (!matchesHandoffEpoch({ issueNodeId: project.issueNodeId, epoch }, handoff, epochProof)) return blocked('unverified-epoch');
  if (handoff.createdAt <= checkpoint.cutoverAt) return blocked('handoff-before-cutover');
  const record = { version: 1, repositoryId: checkpoint.repositoryId, number: checkpoint.selection.number,
    issueId: checkpoint.selection.issueId, cutoverAt: checkpoint.cutoverAt, epoch, reentry: null,
    current: { phase: 'pending', commentId: handoff.id, digest: createHash('sha256').update(handoff.body, 'utf8').digest('hex'),
      fromStatus: project.currentStatus, targetStatus: parsed.targetStatus, createdAt: handoff.createdAt, epoch }, previous: null };
  const commit = planCheckpointCommit({ snapshot: checkpoint, after: record });
  if (commit.kind !== 'checkpoint-commit-plan') return commit;
  return { kind: 'initial-handoff-planned', record, commit, projectId: project.projectId, itemId: project.itemId,
    statusFieldId: project.statusFieldId, fromOptionId: currentOption.id, targetOptionId: targetOption.id };
}
