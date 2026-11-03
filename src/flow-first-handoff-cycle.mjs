import { planPendingBranchHandoff } from './flow-checkpoint-pending-handoff.mjs';
import { isDeepStrictEqual } from 'node:util';
import { isHandoffSubject, matchesHandoffSubject, handoffBinding, handoffSubject } from './flow-handoff-binding.mjs';
import { runInitialPublicationStep, runPendingCommitPublicationStep } from './flow-initial-publication-step.mjs';
import { runPendingProjectStatusStep } from './flow-project-status-step.mjs';

const stopped = phase => ({ kind:'cycle-stopped', phase, retryAllowed:false });

// One bounded composition of the first handoff, not a production runner.
// Callers must supply one trusted policy, authenticated full collector, Git
// preparation/publication/observation and Project transport. Each dependency
// must be bound to that policy and subject; single-writer discipline is also
// required. The concrete steps below receive the same cloned policy. Before
// any publication, an independently trusted confirmStart must prove no prior
// uncertain request remains in flight for this subject and writer.
// Never continue or retry automatically after an uncertain result. A precise
// initial-not-applicable result may be a previously completed pending write;
// after confirmStart, only a fresh, complete pending plan may advance it.
// There is no production implementation of confirmStart in this module.
export async function runFirstHandoffCycle({ policy, collect, verifyProtection, prepare, publish, observe, transport, confirmStart } = {}) {
  if (!isHandoffSubject(policy)||![collect,verifyProtection,prepare,publish,observe,confirmStart].every(value=>typeof value==='function')
      ||typeof transport?.setStatus!=='function') return stopped('configuration');
  policy=structuredClone(policy);
  let result;
  const subject=handoffSubject(policy);
  try { result=await confirmStart(structuredClone(subject)); } catch { return stopped('start'); }
  if (result?.kind!=='execution-safe'||!isDeepStrictEqual(result.subject,subject)) return stopped('start');
  try { result=await runInitialPublicationStep({policy,collect,verifyProtection,prepare,publish,observe}); } catch { return stopped('initial'); }
  if (result?.kind!=='initial-pending-observed'
      && !(result?.kind==='blocked' && result.reason==='initial-step-not-applicable')) return stopped('initial');
  const initialResult=result; let plan, observation, binding;
  try {
    observation=structuredClone(await collect());
    if(!matchesHandoffSubject(observation,policy)) return stopped('pending-read');
    plan=planPendingBranchHandoff(observation);
    if(!['status-update-planned','commit-handoff-planned'].includes(plan.kind)) return stopped('pending-read');
    const current=observation.checkpoint.selectedRecord.current;
    binding=handoffBinding(policy,current.commentId,current.digest,observation.checkpoint.headOid);
    if(!binding || (initialResult.kind==='initial-pending-observed'&&!isDeepStrictEqual(initialResult.binding,binding))) return stopped('pending-read');
  } catch { return stopped('pending-read'); }
  if (plan.kind==='status-update-planned') {
    try { result=await runPendingProjectStatusStep({policy,collect,transport,expectedBinding:structuredClone(binding)}); } catch { return stopped('status'); }
    if (result?.kind!=='status-target-observed'||!isDeepStrictEqual(result.binding,binding)) return stopped('status');
  } else if (plan.kind!=='commit-handoff-planned') return stopped('pending-read');
  try { result=await runPendingCommitPublicationStep({policy,collect,verifyProtection,prepare,publish,observe,expectedBinding:structuredClone(binding)}); } catch { return stopped('commit'); }
  if (result?.kind!=='pending-commit-observed'||!isDeepStrictEqual(result.binding,binding)) return stopped('commit');
  return { kind:'first-handoff-observed', retryAllowed:false };
}
