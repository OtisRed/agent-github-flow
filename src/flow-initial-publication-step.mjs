import { isDeepStrictEqual } from 'node:util';
import { planInitialBranchHandoff, planInitialV2Handoff } from './flow-checkpoint-initial-handoff.mjs';
import { planPendingBranchHandoff } from './flow-checkpoint-pending-handoff.mjs';
import { planStatusReservation, planReservedHandoffCommit, planUnchangedHandoffCommit } from './flow-checkpoint-reservation-plan.mjs';
import { isHandoffSubject, matchesHandoffSubject, handoffBinding } from './flow-handoff-binding.mjs';

const blocked = reason => ({ kind:'blocked', reason });
const uncertain = () => ({ kind:'publication-uncertain', retryAllowed:false });
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && value !== '0'.repeat(40);
const positive = value => Number.isSafeInteger(value) && value > 0;
const validPolicy = p => isHandoffSubject(p)
  && ['repositoryId','repository','projectId','statusFieldId'].every(key => id(p[key]))
  && [p.appId,p.updateRulesetId,p.historyRulesetId].every(positive) && p.updateRulesetId !== p.historyRulesetId
  && Array.isArray(p.trustedAuthorIds) && p.trustedAuthorIds.length > 0 && p.trustedAuthorIds.every(id)
  && new Set(p.trustedAuthorIds).size === p.trustedAuthorIds.length;
const matches = (o,p) => matchesHandoffSubject(o,p) && o?.checkpoint?.repositoryId === p.repositoryId && o.checkpoint.repositoryFullName === p.repository
  && o.project?.repository === p.repository && o.project.projectId === p.projectId && o.expectedProjectId === p.projectId
  && o.project.statusFieldId === p.statusFieldId && isDeepStrictEqual(o.trustedAuthorIds,p.trustedAuthorIds);
const protectedBy = (value,p) => value?.kind === 'checkpoint-protection-observed' && value.repositoryId === p.repositoryId
  && value.appId === p.appId && value.updateRulesetId === p.updateRulesetId && value.historyRulesetId === p.historyRulesetId;

// Preparatory one-shot composition for the initial handoff only. All
// dependencies must be trusted, authenticated and bound to policy: complete
// collection, full fresh protection audit, object preparer, ref publisher and
// publication observer. The caller must enforce one writer and resolve any
// prior uncertain Git ref publication before another Git publication. Project
// mutations have a separate accepted late-request risk and waiting policy.
// This function is not wired into Actions and does not establish these conditions.
// Project/issue mutations can race Git and there is no cross-system CAS.
// Never log private inputs, plans or object identifiers.
async function runPublication({ policy, collect, verifyProtection, prepare, publish, observe, expectedBinding } = {}, planner, expectedKind, resultKind, notApplicable) {
  if (!validPolicy(policy) || ![collect,verifyProtection,prepare,publish,observe].every(fn => typeof fn === 'function')) return blocked('invalid-input');
  policy = structuredClone(policy);
  let first, plan, prepared;
  try {
    first = structuredClone(await collect());
    if (!matches(first,policy)) return blocked('policy-mismatch');
    plan = planner(first);
    if (plan.kind !== expectedKind) return blocked(notApplicable);
    if (['commit-handoff-planned','status-reservation-planned','commit-handoff-v2-planned'].includes(expectedKind)) {
      const binding=handoffBinding(policy,plan.record.current.commentId,plan.record.current.digest,first.checkpoint.headOid);
      if (!binding || !isDeepStrictEqual(binding,expectedBinding)) return blocked('handoff-binding-mismatch');
    }
    if (!protectedBy(await verifyProtection(),policy)) return blocked('protection-unverified');
    if (!isDeepStrictEqual(first,await collect())) return blocked('snapshot-changed');
    prepared = await prepare({ snapshot:structuredClone(first.checkpoint), after:structuredClone(plan.record) });
  } catch { return blocked('preparation-unavailable'); }
  if (prepared?.kind !== 'checkpoint-objects-prepared') return uncertain();
  const oldOid = first.checkpoint.headOid, newOid = prepared.commit?.sha, treeOid = prepared.expectedTreeOid;
  if (prepared.expectedHeadOid !== oldOid || !oid(newOid) || !oid(treeOid) || newOid === oldOid
      || prepared.commit?.tree?.sha !== treeOid || !Array.isArray(prepared.commit?.parents)
      || prepared.commit.parents.length !== 1 || prepared.commit.parents[0]?.sha !== oldOid) return uncertain();
  try {
    if (!isDeepStrictEqual(first,await collect()) || !protectedBy(await verifyProtection(),policy)) return blocked('publication-preflight-changed');
  } catch { return blocked('publication-preflight-unavailable'); }
  let write;
  try { write = await publish({ expectedHeadOid:oldOid, expectedTreeOid:treeOid, commit:structuredClone(prepared.commit) }); }
  catch { write = null; }
  let seen;
  try { seen = await observe({ oldOid, newOid, expectedTreeOid:treeOid }); }
  catch { return uncertain(); }
  if (write?.kind !== 'ref-update-acknowledged' || seen?.kind !== 'publication-observed') return uncertain();
  try {
    const expected = structuredClone(first);
    expected.checkpoint.headOid = newOid;
    expected.checkpoint.index = JSON.parse(Buffer.from(plan.commit.additions.find(x => x.path === 'index.json').contents,'base64').toString('utf8'));
    expected.checkpoint.selectedRecord = plan.record;
    if (!isDeepStrictEqual(expected,await collect()) || !protectedBy(await verifyProtection(),policy)) return uncertain();
  } catch { return uncertain(); }
  const binding=handoffBinding(policy,plan.record.current.commentId,plan.record.current.digest,
    ['initial-pending-observed','initial-v2-pending-observed','status-reservation-observed'].includes(resultKind)?newOid:oldOid);
  if (!binding) return uncertain();
  return { kind:resultKind, binding, retryAllowed:false };
}

export async function runInitialPublicationStep(input) {
  return runPublication(input, planInitialBranchHandoff, 'initial-handoff-planned', 'initial-pending-observed', 'initial-step-not-applicable');
}

export async function runInitialV2PublicationStep(input = {}) {
  let registration;
  try { registration = structuredClone(input.registration); } catch { return blocked('invalid-input'); }
  if (typeof input.prepare !== 'function') return blocked('invalid-input');
  const prepare = input.prepare;
  return runPublication({ ...input, prepare: args => prepare({ ...args, registration: structuredClone(registration) }) },
    observed => planInitialV2Handoff({ ...observed, registration }),
    'initial-handoff-v2-planned', 'initial-v2-pending-observed', 'initial-v2-step-not-applicable');
}

// Only commits an existing first pending record after the target status is
// independently observed; it does not itself change a Project card.
export async function runPendingCommitPublicationStep(input) {
  return runPublication(input, planPendingBranchHandoff, 'commit-handoff-planned', 'pending-commit-observed', 'pending-commit-not-applicable');
}

// This only publishes the reservation. The caller is responsible for waiting
// before retries and for a complete fresh read before any Project mutation.
// Neither this step nor a successful readback proves an old request ended.
export async function runStatusReservationPublicationStep(input = {}) {
  let registration;
  try { registration = structuredClone(input.registration); } catch { return blocked('invalid-input'); }
  if (typeof input.prepare !== 'function') return blocked('invalid-input');
  const prepare = input.prepare;
  return runPublication({ ...input, prepare: args => prepare({ ...args, registration: structuredClone(registration) }) },
    observed => planStatusReservation({ ...observed, registration, reservedAt: input.reservedAt }),
    'status-reservation-planned', 'status-reservation-observed', 'reservation-step-not-applicable');
}

// A final v2 checkpoint may only be published after the reserved target was
// observed. The caller supplies authenticated collection and one-writer policy.
export async function runReservedCommitPublicationStep(input = {}) {
  let registration;
  try { registration = structuredClone(input.registration); } catch { return blocked('invalid-input'); }
  if (typeof input.prepare !== 'function') return blocked('invalid-input');
  const prepare = input.prepare;
  return runPublication({ ...input, prepare: args => prepare({ ...args, registration: structuredClone(registration) }) },
    observed => planReservedHandoffCommit({ ...observed, registration }),
    'commit-handoff-v2-planned', 'reserved-commit-observed', 'reserved-commit-not-applicable');
}

export async function runUnchangedCommitPublicationStep(input = {}) {
  let registration;
  try { registration = structuredClone(input.registration); } catch { return blocked('invalid-input'); }
  if (typeof input.prepare !== 'function') return blocked('invalid-input');
  const prepare = input.prepare;
  return runPublication({ ...input, prepare: args => prepare({ ...args, registration: structuredClone(registration) }) },
    observed => planUnchangedHandoffCommit({ ...observed, registration }),
    'commit-handoff-v2-planned', 'unchanged-commit-observed', 'unchanged-commit-not-applicable');
}
