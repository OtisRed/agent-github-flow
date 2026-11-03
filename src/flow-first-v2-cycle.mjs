import { isDeepStrictEqual } from 'node:util';
import { isHandoffSubject, matchesHandoffSubject, handoffBinding } from './flow-handoff-binding.mjs';
import { isCheckpointRegistration } from './flow-checkpoint-registration.mjs';
import { inspectReservedHandoff } from './flow-checkpoint-reservation-plan.mjs';
import { runInitialV2PublicationStep, runStatusReservationPublicationStep, runReservedCommitPublicationStep,
  runUnchangedCommitPublicationStep } from './flow-initial-publication-step.mjs';
import { runReservedProjectStatusStep } from './flow-project-status-step.mjs';

const stopped = phase => ({ kind:'cycle-stopped', phase, retryAllowed:false });
const WAIT_MS = 120_000;

// Disconnected composition, not an Actions entrypoint. All dependencies,
// including monotonic time/wait and bootstrap verification, must be trusted
// and bound to the protected configuration. The caller must enforce one writer
// and resolve any uncertain Git ref publication. A delayed earlier Project
// request may still overwrite a later state: waiting only reduces that risk.
export async function runFirstV2Cycle({policy,registration,collect,verifyProtection,prepare,publish,observe,transport,
  verifyBootstrap,wait,monotonic,timestamp}={}) {
  if (!isHandoffSubject(policy) || !isCheckpointRegistration(registration) || registration.checkpointSchemaVersion!==2
      || registration.repositoryId!==policy.repositoryId || ![collect,verifyProtection,prepare,publish,observe,verifyBootstrap,wait,monotonic,timestamp]
        .every(fn=>typeof fn==='function') || typeof transport?.setStatus!=='function') return stopped('configuration');
  policy=structuredClone(policy);registration=structuredClone(registration);
  const deps={policy,registration,collect,verifyProtection,prepare,publish,observe};
  let proof,observation;
  try {
    proof=await verifyBootstrap(structuredClone(registration));
    if(proof?.kind!=='v2-bootstrap-verified'||!isDeepStrictEqual(proof.registration,registration)) return stopped('bootstrap');
    observation=structuredClone(await collect());
  } catch { return stopped('bootstrap'); }
  const valid=o=>matchesHandoffSubject(o,policy)&&o.checkpoint?.schemaVersion===2&&o.checkpoint.cutoverAt===registration.cutoverAt;
  if(!valid(observation))return stopped('read');
  if(observation.checkpoint.selectedRecord===null){
    const result=await runInitialV2PublicationStep(deps);
    if(result?.kind!=='initial-v2-pending-observed')return stopped('initial');
    try{observation=structuredClone(await collect());}catch{return stopped('read');}
    if(!valid(observation))return stopped('read');
    const marker=observation.checkpoint.selectedRecord?.current;
    const binding=marker&&handoffBinding(policy,marker.commentId,marker.digest,observation.checkpoint.headOid);
    if(!binding||!isDeepStrictEqual(binding,result.binding))return stopped('read');
  }
  const record=observation.checkpoint.selectedRecord,marker=record?.current;
  if(!marker||marker.phase!=='pending')return stopped('pending');
  let binding=handoffBinding(policy,marker.commentId,marker.digest,observation.checkpoint.headOid);
  if(!binding)return stopped('pending');
  if(record.reservation===null&&marker.fromStatus===marker.targetStatus){
    const result=await runUnchangedCommitPublicationStep({...deps,expectedBinding:binding});
    return result?.kind==='unchanged-commit-observed'?{kind:'first-v2-handoff-observed',retryAllowed:false}:stopped('commit');
  }
  if(record.reservation!==null){
    const plan=inspectReservedHandoff(observation);
    if(plan.kind==='commit-handoff-planned'){
      const result=await runReservedCommitPublicationStep({...deps,expectedBinding:binding});
      return result?.kind==='reserved-commit-observed'?{kind:'first-v2-handoff-observed',retryAllowed:false}:stopped('commit');
    }
    if(plan.kind!=='status-update-planned')return stopped('pending');
    try {
      const started=monotonic();if(!Number.isFinite(started))return stopped('wait');
      await wait(WAIT_MS);
      const ended=monotonic();if(!Number.isFinite(ended)||ended-started<WAIT_MS)return stopped('wait');
      const fresh=structuredClone(await collect());
      if(!valid(fresh)||!isDeepStrictEqual(observation,fresh))return stopped('wait-read');
      observation=fresh;
    } catch{return stopped('wait');}
  }
  let reservedAt;try{reservedAt=timestamp();}catch{return stopped('reservation');}
  const reserved=await runStatusReservationPublicationStep({...deps,expectedBinding:binding,reservedAt});
  if(reserved?.kind!=='status-reservation-observed')return stopped('reservation');
  binding=reserved.binding;
  const status=await runReservedProjectStatusStep({policy,collect,transport,verifyProtection,expectedBinding:binding});
  if(status?.kind!=='status-target-observed'||!isDeepStrictEqual(status.binding,binding))return stopped('status');
  const committed=await runReservedCommitPublicationStep({...deps,expectedBinding:binding});
  return committed?.kind==='reserved-commit-observed'?{kind:'first-v2-handoff-observed',retryAllowed:false}:stopped('commit');
}
