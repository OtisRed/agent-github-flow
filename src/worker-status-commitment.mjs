// A private, domain-separated equality commitment, not authorization or a
// proof that a GitHub snapshot is fresh. The supplied 32-byte material is the
// existing checkpoint key; the caller retains historical keys for recovery.
import {createHmac, timingSafeEqual} from 'node:crypto';
import {FLOW_STATUSES} from './flow.mjs';

const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const mac=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)&&value!=='0'.repeat(40);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const timestamp=value=>{
  if(typeof value!=='string'||value.startsWith('0000-')||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value))return null;
  const time=Date.parse(value);
  return Number.isFinite(time)&&new Date(time).toISOString()===value.replace('Z','.000Z')?time:null;
};
const bindingKeys=['repositoryId','repository','projectId','statusFieldId','issueId','issueNumber','appId',
  'updateRulesetId','historyRulesetId','trustedAuthorIds','commentId','commentMac','commentKeyId','configMac',
  'configKeyId','phase','fromStatus','targetStatus','createdAt','epoch','reservation','checkpointOid'];

function canonical(metadata,keyId){
  if(!exact(metadata,['deliveryId','binding','itemId','fromOptionId','targetOptionId'])||!uuid(metadata.deliveryId)
      ||![metadata.itemId,metadata.fromOptionId,metadata.targetOptionId].every(id)
      ||metadata.fromOptionId===metadata.targetOptionId||!positive(keyId)) return null;
  const b=metadata.binding;
  if(!exact(b,bindingKeys)||![b.repositoryId,b.repository,b.projectId,b.statusFieldId,b.issueId].every(id)
      ||![b.issueNumber,b.appId,b.updateRulesetId,b.historyRulesetId,b.commentKeyId,b.configKeyId].every(positive)
      ||b.updateRulesetId===b.historyRulesetId||!Array.isArray(b.trustedAuthorIds)||!b.trustedAuthorIds.length
      ||b.trustedAuthorIds.length>256||!b.trustedAuthorIds.every(id)||new Set(b.trustedAuthorIds).size!==b.trustedAuthorIds.length
      ||typeof b.commentId!=='string'||! /^[1-9][0-9]{0,19}$/.test(b.commentId)||!mac(b.commentMac)||!mac(b.configMac)
      ||b.phase!=='pending'||!FLOW_STATUSES.includes(b.fromStatus)||!FLOW_STATUSES.includes(b.targetStatus)
      ||b.fromStatus==='done'||b.targetStatus==='done'||b.fromStatus===b.targetStatus
      ||timestamp(b.createdAt)===null||!oid(b.checkpointOid)
      ||!exact(b.epoch,['kind','anchor'])||b.epoch.kind!=='initial'||b.epoch.anchor!==b.issueId
      ||!exact(b.reservation,['reservedAt'])||timestamp(b.reservation.reservedAt)===null
      ||timestamp(b.reservation.reservedAt)<timestamp(b.createdAt)) return null;
  return JSON.stringify(['agent-github-flow/worker-status-intent/v1',keyId,metadata.deliveryId,
    [b.repositoryId,b.repository,b.projectId,b.statusFieldId,b.issueId,b.issueNumber,b.appId,b.updateRulesetId,
      b.historyRulesetId,b.trustedAuthorIds],
    [b.commentId,b.commentMac,b.commentKeyId,b.configMac,b.configKeyId,b.phase,b.fromStatus,b.targetStatus,
      b.createdAt,b.epoch.kind,b.epoch.anchor,b.reservation.reservedAt,b.checkpointOid],
    [metadata.itemId,metadata.fromOptionId,metadata.targetOptionId]]);
}

export function createWorkerStatusSigner(input={}){
  if(!input)throw Error('invalid-worker-status-key');
  const key=input.key,keyId=input.keyId;
  if(!Buffer.isBuffer(key)||key.length!==32||!positive(keyId))throw Error('invalid-worker-status-key');
  const secret=Buffer.from(key);
  const sign=metadata=>{
    try{
      const payload=canonical(structuredClone(metadata),keyId);
      if(payload===null)return {kind:'blocked'};
      return {kind:'worker-status-commitment',keyId,mac:createHmac('sha256',secret).update(payload,'utf8').digest('hex')};
    }catch{return {kind:'blocked'};}
  };
  const verify=(metadata,expected)=>{
    try{
      expected=structuredClone(expected);
      if(!exact(expected,['kind','keyId','mac'])||expected.kind!=='worker-status-commitment'||!mac(expected.mac))return false;
      const actual=sign(metadata);
      return actual.kind==='worker-status-commitment'&&actual.keyId===expected.keyId
        &&timingSafeEqual(Buffer.from(actual.mac,'hex'),Buffer.from(expected.mac,'hex'));
    }catch{return false;}
  };
  const transition=input=>{
    try{
      input=structuredClone(input);
      if(!exact(input,['metadata','oldOid','newOid','treeOid','reservedAt'])
          ||![input.oldOid,input.newOid,input.treeOid].every(oid)||input.oldOid===input.newOid
          ||timestamp(input.reservedAt)===null)return {kind:'blocked'};
      const previous=structuredClone(input.metadata),old=sign(previous);
      if(old.kind!=='worker-status-commitment'||previous.binding.checkpointOid!==input.oldOid
          ||timestamp(input.reservedAt)<=timestamp(previous.binding.reservation.reservedAt))return {kind:'blocked'};
      const next=structuredClone(previous);
      next.binding.checkpointOid=input.newOid;next.binding.reservation.reservedAt=input.reservedAt;
      const expected=sign(next);
      if(expected.kind!=='worker-status-commitment')return {kind:'blocked'};
      const payload=JSON.stringify(['agent-github-flow/worker-ref-transition/v1','reservation',keyId,previous.deliveryId,
        old.mac,expected.mac,input.oldOid,input.newOid,input.treeOid,input.reservedAt]);
      return {kind:'worker-ref-transition',operation:'reservation',deliveryId:previous.deliveryId,keyId,oldMac:old.mac,nextMac:expected.mac,oldOid:input.oldOid,
        newOid:input.newOid,treeOid:input.treeOid,reservedAt:input.reservedAt,
        mac:createHmac('sha256',secret).update(payload,'utf8').digest('hex')};
    }catch{return {kind:'blocked'};}
  };
  const verifyTransition=(input,expected)=>{
    try{
      expected=structuredClone(expected);
      const keys=['kind','operation','deliveryId','keyId','oldMac','nextMac','oldOid','newOid','treeOid','reservedAt','mac'];
      if(!exact(expected,keys)||!mac(expected.mac))return false;
      const actual=transition(input);
      return actual.kind==='worker-ref-transition'&&keys.every(k=>k==='mac'||actual[k]===expected[k])
        &&timingSafeEqual(Buffer.from(actual.mac,'hex'),Buffer.from(expected.mac,'hex'));
    }catch{return false;}
  };
  return Object.freeze({keyId,sign,verify,transition,verifyTransition});
}
