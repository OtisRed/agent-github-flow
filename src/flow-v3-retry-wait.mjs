import { isDeepStrictEqual } from 'node:util';
import { isHandoffSubject, matchesHandoffSubject } from './flow-handoff-binding.mjs';
import { v3HandoffBinding } from './flow-v3-handoff-binding.mjs';
import { matchesHandoffEpoch } from './flow-epoch-proof.mjs';

const WAIT_MS=120_000;
const stopped=reason=>({kind:'retry-wait-stopped',reason});

// Observation only: the caller must bind collect to authenticated v3 reads
// and later recheck Project, MAC, protection and HEAD before a write. Waiting
// reduces but cannot eliminate the risk of a delayed earlier Project request.
export async function waitForV3Retry({policy,expectedBinding,collect,wait,monotonic}={}){
  if(!isHandoffSubject(policy)||![collect,wait,monotonic].every(fn=>typeof fn==='function'))return stopped('invalid-input');
  try{
    policy=structuredClone(policy);expectedBinding=structuredClone(expectedBinding);
    const valid=observation=>{
      const record=observation?.checkpoint?.selectedRecord,marker=record?.current;
      const handoff=observation?.handoffEvidence?.handoff;
      const binding=v3HandoffBinding(policy,record,observation?.checkpoint?.headOid);
      return !!binding&&matchesHandoffSubject(observation,policy)&&observation.checkpoint.kind==='checkpoint-snapshot-observed'
        &&observation.checkpoint.schemaVersion===3&&observation.project.kind==='branch-project-observed'&&observation.expectedProjectId===policy.projectId
        &&record?.reservation!==null&&record?.reservation!==undefined
        &&marker?.phase==='pending'&&marker.fromStatus!==marker.targetStatus
        &&observation.project.issueState==='OPEN'&&observation.project.currentStatus===marker.fromStatus
        &&observation.handoffEvidence?.kind==='evidence'&&handoff?.kind==='handoff'&&handoff.id===marker.commentId
        &&handoff.createdAt===marker.createdAt&&policy.trustedAuthorIds.includes(handoff.authorId)
        &&matchesHandoffEpoch({issueNodeId:policy.issueId,epoch:record.epoch},handoff,observation.epochProof)
        &&isDeepStrictEqual(binding,expectedBinding);
    };
    const first=structuredClone(await collect());if(!valid(first))return stopped('initial-observation');
    const start=monotonic();if(!Number.isFinite(start))return stopped('clock');
    await wait(WAIT_MS);
    const end=monotonic();if(!Number.isFinite(end)||end-start<WAIT_MS)return stopped('clock');
    const second=structuredClone(await collect());
    if(!valid(second)||!isDeepStrictEqual(first,second))return stopped('observation-changed');
    return {kind:'retry-wait-observed',binding:expectedBinding};
  }catch{return stopped('observation-unavailable');}
}
