import { isDeepStrictEqual } from 'node:util';
import { planReentry } from './flow-reentry.mjs';
import { removeFlowMarker } from './flow-marker.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const projectSteps = new Set(['start-reentry', 'finish-reentry']);
const steps = new Set([...projectSteps, 'update-status', 'remove-issue-marker']);

// A single native-reopen step. Caller owns proof collection and exclusive
// writing; repeated reads cannot create an atomic transaction on GitHub.
export async function runReentryStep({ readSnapshot, writeStep }) {
  if (typeof readSnapshot !== 'function' || typeof writeStep !== 'function') return blocked('invalid-input');
  let first, fresh;
  try { first = await readSnapshot(); fresh = await readSnapshot(); } catch { return blocked('read-failed'); }
  if (first?.kind !== 'snapshot' || fresh?.kind !== 'snapshot') return blocked('snapshot-unavailable');
  if (!isDeepStrictEqual(first, fresh)) return blocked('snapshot-changed');
  const plan = planReentry(fresh);
  if (!steps.has(plan.kind)) return plan;
  let expectedBody = fresh.issueBody;
  if (plan.kind === 'remove-issue-marker') {
    const update = removeFlowMarker(fresh.issueBody, plan.marker);
    if (update.kind !== 'updated') return blocked('marker-conflict');
    expectedBody = update.body;
  }
  try { await writeStep(fresh, plan); } catch { return blocked('write-uncertain'); }
  let after;
  try { after = await readSnapshot(); } catch { return blocked('readback-failed'); }
  if (after?.kind !== 'snapshot') return blocked('readback-failed');
  const stableKeys = ['projectId', 'itemId', 'issueNodeId', 'repository', 'statusFieldId', 'checkpointFieldId',
    'issueState', 'epoch', 'nativeReopenEvidence', 'previousComment', 'checkpointEpochEvidence'];
  if (stableKeys.some(key => !isDeepStrictEqual(fresh[key], after[key]))) return blocked('readback-conflict');
  const expectedWitness = projectSteps.has(plan.kind) ? plan.witness : fresh.witness;
  const expectedMarker = plan.kind === 'remove-issue-marker' ? null : fresh.marker;
  const expectedStatus = plan.kind === 'update-status' ? plan.targetStatus : fresh.currentStatus;
  if (!isDeepStrictEqual(after.witness, expectedWitness) || !isDeepStrictEqual(after.marker, expectedMarker)
    || after.issueBody !== expectedBody || after.currentStatus !== expectedStatus) return blocked('readback-conflict');
  return { kind: 'step-applied', step: plan.kind };
}
