import { encodeCheckpointIndex } from './flow-checkpoint-index.mjs';
import { encodeCheckpointRecord } from './flow-checkpoint-record.mjs';
import { verifyCheckpointContinuity } from './flow-checkpoint-continuity.mjs';
import { CHECKPOINT_BRANCH_REF } from './flow-checkpoint-registration.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const oid = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const repoName = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(value)
  && !['.', '..'].includes(value.split('/')[1]);
const content = text => Buffer.from(text, 'utf8').toString('base64');

// Pure construction only. This is not authority to write: before execution a
// caller must authenticate the snapshot, prove data visibility, revalidate
// issue/Project evidence, establish branch protection and handle rollback.
// The returned private metadata and file contents must never be logged.
export function planCheckpointCommit(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || !input.snapshot || input.snapshot.kind !== 'checkpoint-snapshot-observed'
      || !oid(input.snapshot.headOid) || !repoName(input.snapshot.repositoryFullName)
      || (input.repository !== undefined && input.repository !== input.snapshot.repositoryFullName)
      || !Object.hasOwn(input.snapshot, 'selectedRecord')) return blocked('invalid-input');
  const { snapshot, after } = input;
  const oldIndex = encodeCheckpointIndex(snapshot.index);
  const newRecord = encodeCheckpointRecord(after);
  if (oldIndex.kind !== 'encoded-index' || newRecord.kind !== 'encoded-record'
      || snapshot.index.repositoryId !== after.repositoryId || snapshot.repositoryId !== after.repositoryId
      || snapshot.cutoverAt !== after.cutoverAt) return blocked('invalid-snapshot-or-record');
  if (!snapshot.selection || snapshot.selection.number !== after.number || snapshot.selection.issueId !== after.issueId) {
    return blocked('selection-mismatch');
  }
  const before = snapshot.selectedRecord;
  if (before !== null && (!before || before.repositoryId !== after.repositoryId
      || before.number !== after.number || before.issueId !== after.issueId)) return blocked('selected-identity-mismatch');
  const existing = snapshot.index.issues.find(issue => issue.number === after.number);
  const duplicateId = snapshot.index.issues.find(issue => issue.issueId === after.issueId);
  if (before === null ? (existing || duplicateId) : (!existing || existing.issueId !== after.issueId || duplicateId !== existing)) {
    return blocked('index-record-mismatch');
  }
  const continuity = verifyCheckpointContinuity(before, after);
  if (continuity.kind !== 'continuity-verified') return continuity;
  if (before !== null && encodeCheckpointRecord(before).content === newRecord.content) return { kind: 'unchanged' };
  const issues = before === null
    ? [...snapshot.index.issues, { number: after.number, issueId: after.issueId }].sort((a, b) => a.number - b.number)
    : snapshot.index.issues;
  const index = encodeCheckpointIndex({ version: 1, repositoryId: snapshot.index.repositoryId, issues });
  if (index.kind !== 'encoded-index') return index;
  return { kind: 'checkpoint-commit-plan', branch: { repositoryNameWithOwner: snapshot.repositoryFullName,
    branchName: CHECKPOINT_BRANCH_REF.slice('refs/heads/'.length) }, expectedHeadOid: snapshot.headOid,
    additions: [{ path: 'index.json', contents: content(index.content) },
      { path: `issues/${after.number}.json`, contents: content(newRecord.content) }] };
}
