import { isDeepStrictEqual } from 'node:util';
import { matchesV3ProtectedContext } from './flow-v3-protected-context.mjs';
import { matchesHandoffSubject } from './flow-handoff-binding.mjs';
import { v3HandoffBinding } from './flow-v3-handoff-binding.mjs';
import { inspectV3ReservedHandoff } from './flow-v3-reservation-plan.mjs';
import { waitForV3Retry } from './flow-v3-retry-wait.mjs';

const stopped=phase=>({kind:'v3-cycle-stopped',phase,retryAllowed:false});

// First handoff only; disconnected from Actions. All factories/readers must
// come from authenticated, scoped and protected runtime composition. Caller
// must enforce one global writer and resolve uncertain ref updates. Waiting
// does not prove a previously timed-out Project request has stopped.
export async function runFirstV3Cycle({policy,projectRegistration,registrationCommitment,keyring,collectContext,
  verifyBootstrap,makePublicationStep,makeStatusStep,wait,monotonic,timestamp}={}){
  try{policy=structuredClone(policy);projectRegistration=structuredClone(projectRegistration);registrationCommitment=structuredClone(registrationCommitment);}
  catch{return stopped('configuration');}
  if(!matchesV3ProtectedContext({policy,projectRegistration,registrationCommitment,keyring})
      ||![collectContext,verifyBootstrap,makePublicationStep,makeStatusStep,wait,monotonic,timestamp].every(fn=>typeof fn==='function'))
    return stopped('configuration');
  const registration=projectRegistration.checkpoint;
  const valid=context=>matchesHandoffSubject(context?.observation,policy)&&context.observation.expectedProjectId===policy.projectId
    &&context.observation.checkpoint?.schemaVersion===3&&context.observation.checkpoint.cutoverAt===registration.cutoverAt;
  const bind=context=>v3HandoffBinding(policy,context.observation.checkpoint.selectedRecord,context.observation.checkpoint.headOid);
  const inspect=context=>inspectV3ReservedHandoff({...context.observation,repository:context.repository,projectRegistration,registration,keyring});
  const collect=async()=>structuredClone(await collectContext());
  const publication=async args=>{const step=makePublicationStep();return typeof step==='function'?step(args):null;};
  try{
    const proof=await verifyBootstrap(structuredClone(registration));
    if(proof?.kind!=='v3-bootstrap-verified'||!isDeepStrictEqual(proof.registration,registration))return stopped('bootstrap');
    let context=await collect();if(!valid(context))return stopped('read');
    if(context.observation.checkpoint.selectedRecord===null){
      const initial=await publication({operation:'initial'});if(initial?.kind!=='v3-initial-observed')return stopped('initial');
      context=await collect();if(!valid(context)||!isDeepStrictEqual(bind(context),initial.binding))return stopped('read');
    }
    const record=context.observation.checkpoint.selectedRecord,marker=record?.current;
    let binding=bind(context);if(!binding||marker?.phase!=='pending')return stopped('pending');
    if(record.reservation===null&&marker.fromStatus===marker.targetStatus){
      const result=await publication({operation:'commit',expectedBinding:binding});
      return result?.kind==='v3-commit-observed'?{kind:'first-v3-handoff-observed',receipt:result.receipt,retryAllowed:false}:stopped('commit');
    }
    if(record.reservation!==null){
      const seen=inspect(context);
      if(seen.kind==='commit-handoff-planned'){
        const result=await publication({operation:'commit',expectedBinding:binding});
        return result?.kind==='v3-commit-observed'?{kind:'first-v3-handoff-observed',receipt:result.receipt,retryAllowed:false}:stopped('commit');
      }
      if(seen.kind!=='status-update-planned')return stopped('pending');
      const waited=await waitForV3Retry({policy,expectedBinding:binding,collect:async()=> (await collect()).observation,wait,monotonic});
      if(waited.kind!=='retry-wait-observed')return stopped('wait');
    }
    const reservedAt=timestamp(),reserved=await publication({operation:'reservation',expectedBinding:binding,reservedAt});
    if(reserved?.kind!=='v3-reservation-observed')return stopped('reservation');
    binding=reserved.binding;const statusStep=makeStatusStep();if(typeof statusStep!=='function')return stopped('status');
    const status=await statusStep({expectedBinding:binding});
    if(status?.kind!=='status-target-observed'||!isDeepStrictEqual(status.binding,binding))return stopped('status');
    const done=await publication({operation:'commit',expectedBinding:binding});
    return done?.kind==='v3-commit-observed'?{kind:'first-v3-handoff-observed',receipt:done.receipt,retryAllowed:false}:stopped('commit');
  }catch{return stopped('runtime');}
}
