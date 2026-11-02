import { isDeepStrictEqual } from 'node:util';
import { planBootstrap } from './flow-bootstrap.mjs';
import { replaceFlowMarker } from './flow-marker.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const projectSteps = new Set(['write-bootstrap-witness', 'commit-project-checkpoint', 'normalize-project-checkpoint']);
const issueSteps = new Set(['write-issue-pending', 'commit-issue-marker']);
const steps = new Set([...projectSteps, ...issueSteps, 'update-status']);

// Executes at most one mutation. readSnapshot must independently establish
// complete, trusted input and bind all IDs and evidence; this function does
// not grant trust or provide an atomic GitHub compare-and-swap.
export async function runBootstrapStep({ readSnapshot, writeStep }) {
  if (typeof readSnapshot !== 'function' || typeof writeStep !== 'function') return blocked('invalid-input');
  let first, fresh;
  try { first = await readSnapshot(); fresh = await readSnapshot(); } catch { return blocked('read-failed'); }
  if (first?.kind !== 'snapshot' || fresh?.kind !== 'snapshot') return blocked('snapshot-unavailable');
  if (!isDeepStrictEqual(first, fresh)) return blocked('snapshot-changed');
  const plan = planBootstrap(fresh);
  if (!steps.has(plan.kind)) return plan;
  let expectedBody = fresh.issueBody;
  if (issueSteps.has(plan.kind)) {
    const update = replaceFlowMarker(fresh.issueBody, fresh.marker, plan.marker);
    if (update.kind !== 'updated') return blocked('marker-conflict');
    expectedBody = update.body;
  }
  try { await writeStep(fresh, plan); } catch { return blocked('write-uncertain'); }
  let after;
  // After normalization the witness no longer contains the previous comment;
  // require the reader to re-fetch it once for this step's readback.
  try { after = await readSnapshot({ checkpointCommentId: fresh.previousComment?.id }); } catch { return blocked('readback-failed'); }
  if (after?.kind !== 'snapshot') return blocked('readback-failed');
  const stableKeys = ['projectId', 'itemId', 'issueNodeId', 'repository', 'statusFieldId', 'checkpointFieldId',
    'issueState', 'epoch', 'handoff', 'handoffEpochEvidence', 'cutoverAt',
    'previousComment', 'checkpointEpochEvidence', 'nativeReopenEvidence'];
  if (stableKeys.some(key => !isDeepStrictEqual(fresh[key], after[key]))) return blocked('readback-conflict');
  const expectedWitness = projectSteps.has(plan.kind) ? plan.witness : fresh.witness;
  const expectedMarker = issueSteps.has(plan.kind) ? plan.marker : fresh.marker;
  const expectedStatus = plan.kind === 'update-status' ? plan.targetStatus : fresh.currentStatus;
  if (!isDeepStrictEqual(after.witness, expectedWitness) || !isDeepStrictEqual(after.marker, expectedMarker)
    || after.issueBody !== expectedBody || after.currentStatus !== expectedStatus) return blocked('readback-conflict');
  return { kind: 'step-applied', step: plan.kind };
}
