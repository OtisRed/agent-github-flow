import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runFlowCycle } from './flow-cycle.mjs';
import { replaceFlowMarker } from './flow-marker.mjs';

const body = '[FLOW]\nRola: Designer\nStan docelowy: agent-ready\nWykonano: Projekt\nNastępny krok: Praca';
const initial = () => ({ kind: 'snapshot', issueNodeId: 'issue', projectId: 'project', itemId: 'item', repository: 'owner/repo',
  statusFieldId: 'status', checkpointFieldId: 'checkpoint', issueState: 'OPEN', issueBody: 'Original',
  complete: true, trusted: true, singleWriterVerified: true, projectSourceVerified: true, singleCardVerified: true,
  currentStatus: 'needs-design', cutoverAt: '2026-01-01T00:00:00Z', epoch: { kind: 'initial', anchor: 'issue' },
  marker: null, witness: null, handoff: { kind: 'handoff', id: '1', nodeId: 'comment', authorId: 'author',
    body, createdAt: '2026-01-01T00:00:02Z' },
  handoffEpochEvidence: { kind: 'handoff-epoch-evidence', issueNodeId: 'issue', commentId: '1', commentNodeId: 'comment',
    commentCreatedAt: '2026-01-01T00:00:02Z', commentDigest: createHash('sha256').update(body).digest('hex'),
    epoch: { kind: 'initial', anchor: 'issue' } } });
function harness() {
  const state = initial(); let writes = 0;
  const readSnapshot = async options => ({ ...structuredClone(state), ...(options?.readbackCheckpoint ? {
    readbackPreviousComment: structuredClone(state.previousComment),
    readbackPreviousEpochEvidence: structuredClone(state.previousEpochEvidence), readbackNativeReopenEvidence: null,
  } : {}) });
  const writeStep = async (snapshot, plan) => {
    writes += 1;
    if (['write-bootstrap-witness', 'commit-project-checkpoint', 'normalize-project-checkpoint'].includes(plan.kind)) {
      state.witness = structuredClone(plan.witness);
      if (plan.kind === 'normalize-project-checkpoint') {
        const { kind, ...comment } = state.handoff; state.previousComment = comment;
        state.previousEpochEvidence = structuredClone(state.handoffEpochEvidence);
      }
    } else if (['write-issue-pending', 'commit-issue-marker'].includes(plan.kind)) {
      state.issueBody = replaceFlowMarker(snapshot.issueBody, snapshot.marker, plan.marker).body; state.marker = structuredClone(plan.marker);
    } else if (plan.kind === 'update-status') state.currentStatus = plan.targetStatus;
    else throw Error('unexpected-step');
  };
  return { state, readSnapshot, writeStep, writes: () => writes };
}

test('executes one bounded bootstrap and routes the normalized checkpoint to unchanged', async () => {
  const ctx = harness(); const result = await runFlowCycle({ mode: 'handoff', ...ctx });
  assert.equal(result.kind, 'complete'); assert.equal(result.outcome, 'unchanged');
  assert.deepEqual(result.steps, ['write-bootstrap-witness', 'write-issue-pending', 'update-status',
    'commit-project-checkpoint', 'commit-issue-marker', 'normalize-project-checkpoint']);
  assert.equal(ctx.state.currentStatus, 'agent-ready'); assert.equal(ctx.writes(), 6);
});

test('can resume after a step limit but does not retry uncertain writes', async () => {
  const ctx = harness();
  assert.deepEqual(await runFlowCycle({ mode: 'handoff', ...ctx, maxSteps: 1 }),
    { kind: 'blocked', reason: 'step-limit', steps: ['write-bootstrap-witness'] });
  const resumed = await runFlowCycle({ mode: 'handoff', ...ctx });
  assert.equal(resumed.kind, 'complete'); assert.equal(resumed.steps.length, 5);
  const other = harness(); let writes = 0;
  const failed = await runFlowCycle({ mode: 'handoff', readSnapshot: other.readSnapshot,
    writeStep: async () => { writes += 1; throw Error('timeout'); } });
  assert.deepEqual(failed, { kind: 'blocked', reason: 'write-uncertain', steps: [] }); assert.equal(writes, 1);
});

test('refuses missing trust, a changing snapshot and an unfinished reentry', async () => {
  const ctx = harness(); ctx.state.projectSourceVerified = false;
  assert.deepEqual(await runFlowCycle({ mode: 'handoff', ...ctx }), { kind: 'blocked', reason: 'unverified-snapshot', steps: [] });
  assert.equal(ctx.writes(), 0);
  let calls = 0;
  assert.deepEqual(await runFlowCycle({ mode: 'handoff', readSnapshot: async () => ({ kind: 'snapshot', issueBody: String(++calls) }),
    writeStep: async () => {} }), { kind: 'blocked', reason: 'snapshot-changed', steps: [] });
  ctx.state.witness = { kind: 'reentry', phase: 'pending' };
  assert.deepEqual(await runFlowCycle({ mode: 'handoff', ...ctx }), { kind: 'blocked', reason: 'reentry-required', steps: [] });
});

test('reports no handoff without creating a checkpoint', async () => {
  let writes = 0;
  const result = await runFlowCycle({ mode: 'handoff', readSnapshot: async () => ({ kind: 'awaiting-handoff' }),
    writeStep: async () => { writes += 1; } });
  assert.deepEqual(result, { kind: 'complete', outcome: 'awaiting-handoff', steps: [] }); assert.equal(writes, 0);
});

test('routes native reopen separately and requires its bound evidence', async () => {
  const ctx = harness(); ctx.state.epoch = { kind: 'reopened', anchor: 'reopen' };
  ctx.state.witness = { version: 3, kind: 'reentry', phase: 'ready', epoch: structuredClone(ctx.state.epoch), previous: null, fromStatus: 'done', cutoverAt: ctx.state.cutoverAt };
  const missing = await runFlowCycle({ mode: 'reentry', ...ctx });
  assert.deepEqual(missing, { kind: 'blocked', reason: 'unverified-native-reopen', steps: [] });
  ctx.state.nativeReopenEvidence = { kind: 'native-reopen-evidence', issueNodeId: 'issue', epoch: structuredClone(ctx.state.epoch), reopenedAt: '2026-01-01T00:00:01Z' };
  const ready = await runFlowCycle({ mode: 'reentry', ...ctx });
  assert.deepEqual(ready, { kind: 'complete', outcome: 'already-reentered', steps: [] }); assert.equal(ctx.writes(), 0);
});

test('never resets a real-looking active card for a historical reopen', async () => {
  const ctx = harness(); ctx.state.epoch = { kind: 'reopened', anchor: 'old-event' };
  ctx.state.currentStatus = 'smoke'; ctx.state.marker = null; ctx.state.witness = null;
  ctx.state.cutoverAt = '2026-01-01T00:00:00Z';
  ctx.state.nativeReopenEvidence = { kind: 'native-reopen-evidence', issueNodeId: 'issue',
    epoch: structuredClone(ctx.state.epoch), reopenedAt: '2025-12-31T23:59:59Z' };
  assert.deepEqual(await runFlowCycle({ mode: 'reentry', ...ctx }),
    { kind: 'blocked', reason: 'reopen-before-or-at-cutover', steps: [] });
  assert.equal(ctx.state.currentStatus, 'smoke'); assert.equal(ctx.writes(), 0);
});

test('does not process a fresh handoff before handling a newer native reopen', async () => {
  const ctx = harness();
  ctx.state.epoch = { kind: 'reopened', anchor: 'reopen' };
  ctx.state.currentStatus = 'review';
  ctx.state.handoffEpochEvidence.epoch = structuredClone(ctx.state.epoch);
  ctx.state.nativeReopenEvidence = { kind: 'native-reopen-evidence', issueNodeId: 'issue',
    epoch: structuredClone(ctx.state.epoch), reopenedAt: '2026-01-01T00:00:01Z' };
  const result = await runFlowCycle({ mode: 'handoff', ...ctx });
  assert.deepEqual(result, { kind: 'blocked', reason: 'reentry-required', steps: [] });
  assert.equal(ctx.writes(), 0);
});

test('allows initial onboarding after a historical reopen before the cutover', async () => {
  const ctx = harness();
  ctx.state.epoch = { kind: 'reopened', anchor: 'old-reopen' };
  ctx.state.handoffEpochEvidence.epoch = structuredClone(ctx.state.epoch);
  ctx.state.nativeReopenEvidence = { kind: 'native-reopen-evidence', issueNodeId: 'issue',
    epoch: structuredClone(ctx.state.epoch), reopenedAt: '2025-12-31T23:59:59Z' };
  const result = await runFlowCycle({ mode: 'handoff', ...ctx });
  assert.equal(result.kind, 'complete');
  assert.equal(ctx.state.currentStatus, 'agent-ready');
});
