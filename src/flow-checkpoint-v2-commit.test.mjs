import test from 'node:test';
import assert from 'node:assert/strict';
import { planCheckpointV2Commit } from './flow-checkpoint-commit-plan.mjs';

const pending = () => ({ version: 2, repositoryId: 'repo-id', number: 1, issueId: 'issue', cutoverAt: '2026-01-01T10:00:00Z',
  epoch: { kind: 'initial', anchor: 'issue' }, reentry: null, current: { phase: 'pending', commentId: '1',
    digest: 'a'.repeat(64), fromStatus: 'needs-design', targetStatus: 'agent-ready', createdAt: '2026-01-01T10:01:00Z',
    epoch: { kind: 'initial', anchor: 'issue' } }, previous: null, reservation: null });
const fixture = () => ({ registration: { repositoryId: 'repo-id', ref: 'refs/heads/agent-github-flow/checkpoints',
  genesisOid: 'a'.repeat(40), cutoverAt: '2026-01-01T10:00:00Z', checkpointSchemaVersion: 2 },
  snapshot: { kind: 'checkpoint-snapshot-observed', headOid: 'b'.repeat(40), repositoryId: 'repo-id',
    repositoryFullName: 'owner/project', cutoverAt: '2026-01-01T10:00:00Z', selection: { number: 1, issueId: 'issue' },
    index: { version: 1, repositoryId: 'repo-id', issues: [{ number: 1, issueId: 'issue' }] }, selectedRecord: pending() },
  after: { ...pending(), reservation: { reservedAt: '2026-01-01T10:02:00Z', fromOptionId: 'source', targetOptionId: 'target' } } });

test('plans a v2 reservation against the exact observed head without changing the issue index', () => {
  const value = fixture(), result = planCheckpointV2Commit(value);
  assert.equal(result.kind, 'checkpoint-commit-plan');
  assert.equal(result.expectedHeadOid, value.snapshot.headOid);
  assert.deepEqual(JSON.parse(Buffer.from(result.additions[1].contents, 'base64').toString()), value.after);
  assert.deepEqual(JSON.parse(Buffer.from(result.additions[0].contents, 'base64').toString()), value.snapshot.index);
});

test('requires the explicitly registered v2 schema, matching repository, cutover and observed selected record', () => {
  for (const change of [
    v => { delete v.registration.checkpointSchemaVersion; },
    v => { v.registration.checkpointSchemaVersion = 1; },
    v => { v.registration.repositoryId = 'other'; },
    v => { v.registration.cutoverAt = '2025-01-01T00:00:00Z'; },
    v => { v.registration.genesisOid = 'invalid'; },
    v => { v.snapshot.selection.issueId = 'other'; },
    v => { v.snapshot.selectedRecord.version = 1; delete v.snapshot.selectedRecord.reservation; }
  ]) { const value = fixture(); change(value); assert.equal(planCheckpointV2Commit(value).kind, 'blocked'); }
});

test('does not create a reservation as a first record or silently remove an existing one', () => {
  let value = fixture(); value.snapshot.selectedRecord = null; value.snapshot.index.issues = [];
  assert.equal(planCheckpointV2Commit(value).kind, 'blocked');
  value = fixture(); value.snapshot.selectedRecord.reservation = value.after.reservation; value.after.reservation = null;
  assert.equal(planCheckpointV2Commit(value).kind, 'blocked');
});

test('plans initial unreserved records and commits only a continuous reserved transition', () => {
  let value = fixture(); value.snapshot.selectedRecord = null; value.snapshot.index.issues = []; value.after.reservation = null;
  assert.equal(planCheckpointV2Commit(value).kind, 'checkpoint-commit-plan');
  value = fixture(); value.snapshot.selectedRecord.reservation = value.after.reservation;
  value.after = structuredClone(value.snapshot.selectedRecord); value.after.current.phase = 'committed'; value.after.reservation = null;
  assert.equal(planCheckpointV2Commit(value).kind, 'checkpoint-commit-plan');
  value = fixture(); value.after.reservation = null; value.after.current.phase = 'committed';
  assert.equal(planCheckpointV2Commit(value).kind, 'blocked');
});
