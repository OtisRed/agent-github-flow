import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { encodeCheckpointV3 } from './flow-checkpoint-v3.mjs';
import { verifyV3Commitments } from './flow-v3-commitment-verifier.mjs';
import { planPendingBranchHandoff } from './flow-checkpoint-pending-handoff.mjs';
import { planCheckpointV3Commit } from './flow-checkpoint-commit-plan.mjs';

const blocked=reason=>({kind:'blocked',reason});

// Pure inspection of the first pending handoff. Readers, configuration,
// keyring, bootstrap and protection must be independently trusted. Returned
// inspection is not permission to write or proof that a retry wait elapsed.
function inspect(input){
  try{
    const keyring=input.keyring;
    const observed=structuredClone({checkpoint:input.checkpoint,project:input.project,handoffEvidence:input.handoffEvidence,
      epochProof:input.epochProof,trustedAuthorIds:input.trustedAuthorIds,expectedProjectId:input.expectedProjectId,
      registration:input.registration,projectRegistration:input.projectRegistration,repository:input.repository});
    const {checkpoint,project,projectRegistration,registration,repository,handoffEvidence}=observed;
    const record=checkpoint?.selectedRecord,handoff=handoffEvidence?.handoff;
    if(checkpoint?.schemaVersion!==3||encodeCheckpointV3(record).kind!=='encoded-record'
        ||!isDeepStrictEqual(projectRegistration?.checkpoint,registration)
        ||checkpoint.repositoryFullName!==projectRegistration?.repository||checkpoint.repositoryId!==projectRegistration?.repositoryId
        ||!isDeepStrictEqual(projectRegistration?.trustedAuthorIds,observed.trustedAuthorIds)
        ||observed.expectedProjectId!==projectRegistration?.projectId||!handoff
        ||verifyV3Commitments({registration:projectRegistration,record,keyring,repository,project,
          comments:[{id:handoff.id,authorId:handoff.authorId,createdAt:handoff.createdAt,body:handoff.body}]}).kind!=='v3-commitments-verified')
      return blocked('v3-context-unverified');
    const projected=structuredClone(observed);projected.checkpoint.schemaVersion=1;
    const projectedRecord=projected.checkpoint.selectedRecord;projectedRecord.version=1;delete projectedRecord.reservation;
    const marker=projectedRecord.current;if(!marker)return blocked('missing-handoff');
    marker.digest=createHash('sha256').update(handoff.body,'utf8').digest('hex');
    delete marker.commentMac;delete marker.commentKeyId;delete marker.configMac;delete marker.configKeyId;
    const result=planPendingBranchHandoff(projected);
    return ['status-update-planned','commit-handoff-planned'].includes(result.kind)?{kind:result.kind,observed}:blocked('handoff-not-observed');
  }catch{return blocked('v3-inspection-unavailable');}
}

export function inspectV3ReservedHandoff(input){
  const result=inspect(input);
  return result.observed?.checkpoint.selectedRecord.reservation?{kind:result.kind}:blocked('missing-reservation');
}

// A reservation carries only the time: private option IDs are checked against
// the MAC-bound registration and stay out of both public records and results.
export function planV3StatusReservation(input){
  const result=inspect(input);if(result.kind!=='status-update-planned')return blocked('handoff-not-reservable');
  const {checkpoint,registration}=result.observed,after=structuredClone(checkpoint.selectedRecord);
  after.reservation={reservedAt:input.reservedAt};
  const commit=planCheckpointV3Commit({registration,snapshot:checkpoint,after});
  return commit.kind==='checkpoint-commit-plan'?{kind:'v3-status-reservation-planned',record:after,commit}:blocked('reservation-plan-invalid');
}

export function planV3HandoffCommit(input){
  const result=inspect(input);if(result.kind!=='commit-handoff-planned')return blocked('target-not-observed');
  const {checkpoint,registration}=result.observed,before=checkpoint.selectedRecord;
  if(!before.reservation&&before.current.fromStatus!==before.current.targetStatus)return blocked('missing-reservation');
  const after=structuredClone(before);after.current.phase='committed';after.reservation=null;
  const commit=planCheckpointV3Commit({registration,snapshot:checkpoint,after});
  return commit.kind==='checkpoint-commit-plan'?{kind:'v3-commit-handoff-planned',record:after,commit}:blocked('commit-plan-invalid');
}
