import { isDeepStrictEqual } from 'node:util';
import { planNextHandoff } from './flow-next-handoff.mjs';
import { planWitnessRecovery } from './flow-witness.mjs';
import { replaceFlowMarker } from './flow-marker.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const projectSteps = new Set(['start-handoff', 'commit-project-checkpoint']);
const issueSteps = new Set(['write-issue-pending', 'commit-issue-marker']);
const steps = new Set([...projectSteps, ...issueSteps, 'update-status']);

export function planTransitionSnapshot(snapshot) {
  const witness = snapshot?.witness;
  if (snapshot?.complete !== true || snapshot.singleWriterVerified !== true || snapshot.projectSourceVerified !== true
    || snapshot.singleCardVerified !== true || snapshot.trusted !== true) return blocked('unverified-snapshot');
  if (!witness || witness.version !== 1 || !witness.current || snapshot?.handoff?.kind !== 'handoff') return blocked('invalid-transition-snapshot');
  const latestComment = snapshot.handoff;
  if (witness.current.phase === 'committed' && witness.previous === null
    && snapshot.marker?.phase === 'committed' && witness.current.commentId !== latestComment.id) return planNextHandoff(snapshot);
  return planWitnessRecovery({ ...snapshot, latestComment });
}

export function transitionProjectValue(plan) {
  if (plan.kind === 'start-handoff') return plan.witness;
  if (plan.kind === 'commit-project-checkpoint') return { version: 1, current: plan.marker, previous: null };
  return null;
}

// Like bootstrap, this is one planned mutation followed by exact readback.
// The supplied snapshot reader must establish trust and exclusive ownership.
export async function runTransitionStep({ readSnapshot, writeStep }) {
  if (typeof readSnapshot !== 'function' || typeof writeStep !== 'function') return blocked('invalid-input');
  let first, fresh;
  try { first = await readSnapshot(); fresh = await readSnapshot(); } catch { return blocked('read-failed'); }
  if (first?.kind !== 'snapshot' || fresh?.kind !== 'snapshot') return blocked('snapshot-unavailable');
  if (!isDeepStrictEqual(first, fresh)) return blocked('snapshot-changed');
  const plan = planTransitionSnapshot(fresh);
  if (!steps.has(plan.kind)) return plan;
  let expectedBody = fresh.issueBody;
  if (issueSteps.has(plan.kind)) {
    const update = replaceFlowMarker(fresh.issueBody, fresh.marker, plan.marker);
    if (update.kind !== 'updated') return blocked('marker-conflict');
    expectedBody = update.body;
  }
  try { await writeStep(fresh, plan); } catch { return blocked('write-uncertain'); }
  let after;
  // The committed Project checkpoint discards `previous`; the reader must
  // nevertheless re-read the exact previous comment once after that write.
  try { after = await readSnapshot({ checkpointCommentId: fresh.previousComment?.id }); } catch { return blocked('readback-failed'); }
  if (after?.kind !== 'snapshot') return blocked('readback-failed');
  const stableKeys = ['projectId', 'itemId', 'issueNodeId', 'repository', 'statusFieldId', 'checkpointFieldId',
    'issueState', 'epoch', 'handoff', 'handoffEpochEvidence', 'previousComment', 'previousEpochEvidence'];
  if (stableKeys.some(key => !isDeepStrictEqual(fresh[key], after[key]))) return blocked('readback-conflict');
  const expectedWitness = projectSteps.has(plan.kind) ? transitionProjectValue(plan) : fresh.witness;
  const expectedMarker = issueSteps.has(plan.kind) ? plan.marker : fresh.marker;
  const expectedStatus = plan.kind === 'update-status' ? plan.targetStatus : fresh.currentStatus;
  if (!isDeepStrictEqual(after.witness, expectedWitness) || !isDeepStrictEqual(after.marker, expectedMarker)
    || after.issueBody !== expectedBody || after.currentStatus !== expectedStatus) return blocked('readback-conflict');
  return { kind: 'step-applied', step: plan.kind };
}
