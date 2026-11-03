import { isDeepStrictEqual } from 'node:util';
import { planPendingBranchHandoff } from './flow-checkpoint-pending-handoff.mjs';
import { inspectReservedHandoff } from './flow-checkpoint-reservation-plan.mjs';
import { isHandoffSubject, matchesHandoffSubject, handoffBinding } from './flow-handoff-binding.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const nonempty = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
const validPolicy = policy => isHandoffSubject(policy)
  && ['repositoryId', 'repository', 'projectId', 'statusFieldId'].every(key => nonempty(policy[key]))
  && Array.isArray(policy.trustedAuthorIds) && policy.trustedAuthorIds.length > 0
  && policy.trustedAuthorIds.every(nonempty) && new Set(policy.trustedAuthorIds).size === policy.trustedAuthorIds.length;
const matchesPolicy = (observation, policy) => matchesHandoffSubject(observation,policy) && observation?.checkpoint?.repositoryId === policy.repositoryId
  && observation.checkpoint.repositoryFullName === policy.repository && observation.project?.repository === policy.repository
  && observation.project.projectId === policy.projectId && observation.expectedProjectId === policy.projectId
  && observation.project.statusFieldId === policy.statusFieldId && isDeepStrictEqual(observation.trustedAuthorIds, policy.trustedAuthorIds);
const protectedBy = (value,policy) => value?.kind==='checkpoint-protection-observed'&&value.repositoryId===policy.repositoryId
  &&value.appId===policy.appId&&value.updateRulesetId===policy.updateRulesetId&&value.historyRulesetId===policy.historyRulesetId;

// One bounded step, not a production entrypoint. collect must be a trusted,
// authenticated, complete branch-checkpoint/Project/handoff collector. The
// policy must be loaded independently from protected routing configuration.
// Caller must enforce one owner,
// ref protection and revalidation. Project has no conditional status mutation;
// a manual writer can still race even with identical pre/post observations.
// transport must be a dedicated PAT transport bound to the same policy, never
// an arbitrary GraphQL writer. No runtime wiring is provided here.
export async function runPendingProjectStatusStep(input = {}) {
  return runStatusStep(input, planPendingBranchHandoff);
}

// Only the caller may invoke this after publishing and observing the exact
// reservation. Retry waiting and single-writer policy are external duties.
export async function runReservedProjectStatusStep(input = {}) {
  return runStatusStep(input, inspectReservedHandoff);
}

async function runStatusStep({ collect, transport, policy, expectedBinding, verifyProtection } = {}, planner) {
  if (typeof collect !== 'function' || typeof verifyProtection !== 'function' || typeof transport?.setStatus !== 'function' || !validPolicy(policy)) return blocked('invalid-input');
  policy = structuredClone(policy);
  if (transport.projectId !== policy.projectId || transport.statusFieldId !== policy.statusFieldId) return blocked('transport-policy-mismatch');
  let first; let second; let plan;
  try {
    first = structuredClone(await collect());
    if (!matchesPolicy(first, policy)) return blocked('policy-mismatch');
    plan = planner(first);
    if (plan.kind !== 'status-update-planned') return blocked('status-step-not-applicable');
    const binding=handoffBinding(policy,plan.commentId,plan.commentDigest,plan.expectedCheckpointOid);
    if (!binding || !isDeepStrictEqual(binding,expectedBinding)) return blocked('handoff-binding-mismatch');
    second = structuredClone(await collect());
    if (!isDeepStrictEqual(first, second) || !isDeepStrictEqual(plan, planner(second))) return blocked('snapshot-changed');
    if (!protectedBy(await verifyProtection(),policy)) return blocked('protection-unverified');
  } catch { return blocked('preflight-unavailable'); }
  let result;
  try {
    if (transport.projectId !== policy.projectId || transport.statusFieldId !== policy.statusFieldId) return blocked('transport-policy-mismatch');
    result = await transport.setStatus({ itemId: plan.itemId, targetOptionId: plan.targetOptionId });
  } catch { return { kind: 'status-write-uncertain', retryAllowed: false }; }
  if (result?.kind !== 'status-write-acknowledged') {
    return { kind: 'status-write-uncertain', retryAllowed: false };
  }
  try {
    const after = structuredClone(await collect());
    const normalized = structuredClone(after);
    normalized.project.currentStatus = first.project.currentStatus;
    normalized.project.statusOptionId = first.project.statusOptionId;
    if (!matchesPolicy(after, policy) || !isDeepStrictEqual(first, normalized)
        || planner(after).kind !== 'commit-handoff-planned') {
      return { kind: 'status-write-uncertain', retryAllowed: false };
    }
    if (!protectedBy(await verifyProtection(),policy)) return { kind:'status-write-uncertain', retryAllowed:false };
  } catch { return { kind: 'status-write-uncertain', retryAllowed: false }; }
  const binding=handoffBinding(policy,plan.commentId,plan.commentDigest,plan.expectedCheckpointOid);
  if (!binding) return { kind:'status-write-uncertain', retryAllowed:false };
  return { kind: 'status-target-observed', binding, retryAllowed: false };
}
