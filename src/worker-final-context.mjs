// Detached comparison only. Callers must authenticate both snapshots and
// separately verify the signed plan, protected transport, ref/tree and ACK.
import {isDeepStrictEqual} from 'node:util';

const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)&&value!=='0'.repeat(40);

export function matchesFinalContext(input={}){
  try{
    const {encode,verifyContinuity}=input;
    const before=structuredClone(input.before),after=structuredClone(input.after),receipt=structuredClone(input.receipt);
    const oldOid=input.oldOid,newOid=input.newOid;
    const itemId=input.itemId,targetOptionId=input.targetOptionId;
    if(typeof encode!=='function'||typeof verifyContinuity!=='function'||!oid(oldOid)||!oid(newOid)||oldOid===newOid)
      return false;
    const checkpoint=before?.observation?.checkpoint,record=checkpoint?.selectedRecord,marker=record?.current,project=before?.observation?.project;
    const matchingOptions=Array.isArray(project?.statusOptions)?project.statusOptions.filter(option=>option?.name===marker?.targetStatus):[];
    if(checkpoint?.headOid!==oldOid||marker?.phase!=='pending'||!record.reservation||!marker.targetStatus
        ||typeof itemId!=='string'||!itemId||typeof targetOptionId!=='string'||!targetOptionId
        ||project?.issueState!=='OPEN'||project.issueNodeId!==record.issueId||project.itemId!==itemId
        ||project.currentStatus!==marker.targetStatus||project.statusOptionId!==targetOptionId
        ||matchingOptions.length!==1||matchingOptions[0].id!==targetOptionId)return false;
    const expected=structuredClone(before),expectedCheckpoint=expected.observation.checkpoint;
    expectedCheckpoint.headOid=newOid;expectedCheckpoint.selectedRecord.current.phase='committed';
    expectedCheckpoint.selectedRecord.reservation=null;
    const finalRecord=expectedCheckpoint.selectedRecord;
    if(encode(structuredClone(record))?.kind!=='encoded-record'||encode(structuredClone(finalRecord))?.kind!=='encoded-record'
        ||verifyContinuity(structuredClone(record),structuredClone(finalRecord))?.kind!=='continuity-verified'
        ||!isDeepStrictEqual(expected,after))return false;
    const expectedReceipt={repositoryId:record.repositoryId,issueId:record.issueId,number:record.number,
      phase:'committed',commentId:marker.commentId,commentMac:marker.commentMac,commentKeyId:marker.commentKeyId,
      configMac:marker.configMac,configKeyId:marker.configKeyId,checkpointOid:newOid};
    return isDeepStrictEqual(receipt,expectedReceipt);
  }catch{return false;}
}
