import test from 'node:test';
import assert from 'node:assert/strict';
import { planCheckpointCommit } from './flow-checkpoint-commit-plan.mjs';

const record = () => ({ version: 1, repositoryId: 'repo-id', number: 1, issueId: 'issue', cutoverAt: '2026-01-01T10:00:00Z',
  epoch: { kind: 'initial', anchor: 'issue' }, reentry: null,
  current: { phase: 'pending', commentId: '1', digest: 'a'.repeat(64), fromStatus: 'needs-design', targetStatus: 'agent-ready',
    createdAt: '2026-01-01T10:01:00Z', epoch: { kind: 'initial', anchor: 'issue' } }, previous: null });
const fixture = () => ({ snapshot: { kind: 'checkpoint-snapshot-observed', headOid: 'b'.repeat(40),
  repositoryId: 'repo-id', repositoryFullName: 'owner/project', cutoverAt: '2026-01-01T10:00:00Z', selection: { number: 1, issueId: 'issue' },
  index: { version: 1, repositoryId: 'repo-id', issues: [] }, selectedRecord: null }, after: record() });

test('plans first record and index additions against the observed exact HEAD', () => {
  const v = fixture(); const plan = planCheckpointCommit(v);
  assert.equal(plan.kind, 'checkpoint-commit-plan'); assert.equal(plan.expectedHeadOid, v.snapshot.headOid);
  assert.deepEqual(plan.branch, { repositoryNameWithOwner: 'owner/project', branchName: 'agent-github-flow/checkpoints' });
  assert.deepEqual(plan.additions.map(item => item.path), ['index.json', 'issues/1.json']);
  assert.deepEqual(JSON.parse(Buffer.from(plan.additions[0].contents, 'base64').toString()),
    { version: 1, repositoryId: 'repo-id', issues: [{ number: 1, issueId: 'issue' }] });
});

test('preserves indexed issues and permits only a structurally continuous next step', () => {
  const v = fixture(); const before = record(); before.current.phase = 'committed';
  v.snapshot.index.issues = [{ number: 1, issueId: 'issue' }, { number: 7, issueId: 'other' }]; v.snapshot.selectedRecord = before;
  v.after = structuredClone(before); v.after.current = { ...structuredClone(before.current), phase: 'pending', commentId: '2',
    fromStatus: 'agent-ready', targetStatus: 'review', createdAt: '2026-01-01T10:02:00Z' }; v.after.previous = structuredClone(before.current);
  const plan = planCheckpointCommit(v); assert.equal(plan.kind, 'checkpoint-commit-plan');
  assert.deepEqual(JSON.parse(Buffer.from(plan.additions[0].contents, 'base64').toString()).issues, v.snapshot.index.issues);
  v.after.cutoverAt = '2026-01-01T09:59:00Z'; assert.equal(planCheckpointCommit(v).reason, 'invalid-snapshot-or-record');
});

test('rejects mismatched index, invalid head, wrong issue and unsafe repository paths', () => {
  let v = fixture(); v.snapshot.index.issues = [{ number: 1, issueId: 'issue' }];
  assert.equal(planCheckpointCommit(v).reason, 'index-record-mismatch');
  v = fixture(); v.snapshot.headOid = 'bad'; assert.equal(planCheckpointCommit(v).reason, 'invalid-input');
  v = fixture(); v.repository = 'owner/../other'; assert.equal(planCheckpointCommit(v).reason, 'invalid-input');
  v = fixture(); v.repository = 'owner/other'; assert.equal(planCheckpointCommit(v).reason, 'invalid-input');
  v = fixture(); v.after.cutoverAt = '2026-01-01T09:59:00Z'; assert.equal(planCheckpointCommit(v).reason, 'invalid-snapshot-or-record');
  v = fixture(); v.snapshot.repositoryId = 'another-repo'; assert.equal(planCheckpointCommit(v).reason, 'invalid-snapshot-or-record');
  v = fixture(); v.snapshot.selection = { number: 2, issueId: 'other' }; assert.equal(planCheckpointCommit(v).reason, 'selection-mismatch');
  v = fixture(); v.snapshot.selectedRecord = { ...record(), issueId: 'other' };
  assert.equal(planCheckpointCommit(v).reason, 'selected-identity-mismatch');
});

test('leaves an identical validated record unchanged', () => {
  const v = fixture(); v.snapshot.index.issues = [{ number: 1, issueId: 'issue' }];
  v.snapshot.selectedRecord = record(); v.after = structuredClone(v.snapshot.selectedRecord);
  assert.deepEqual(planCheckpointCommit(v), { kind: 'unchanged' });
});
