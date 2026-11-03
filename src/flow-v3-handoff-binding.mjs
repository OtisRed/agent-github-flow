import { handoffSubject } from './flow-handoff-binding.mjs';
import { encodeCheckpointV3 } from './flow-checkpoint-v3.mjs';

const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)&&value!=='0'.repeat(40);

// Internal identity only, not authorization and not a replacement for MAC
// verification. Never log the subject or private checkpoint context.
export function v3HandoffBinding(subject,record,checkpointOid){
  const bound=handoffSubject(subject);
  if(!bound||encodeCheckpointV3(record).kind!=='encoded-record'||record.repositoryId!==bound.repositoryId
      ||record.issueId!==bound.issueId||record.number!==bound.issueNumber||record.current?.phase!=='pending'
      ||record.epoch.kind!=='initial'||record.previous!==null||record.reentry!==null||!oid(checkpointOid))return null;
  const marker=record.current;
  return {...bound,commentId:marker.commentId,commentMac:marker.commentMac,commentKeyId:marker.commentKeyId,
    configMac:marker.configMac,configKeyId:marker.configKeyId,phase:marker.phase,fromStatus:marker.fromStatus,targetStatus:marker.targetStatus,
    createdAt:marker.createdAt,epoch:{...marker.epoch},reservation:record.reservation===null?null:{...record.reservation},checkpointOid};
}
