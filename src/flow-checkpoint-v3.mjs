import { encodeCheckpointRecord } from './flow-checkpoint-record.mjs';
import { verifyCheckpointContinuity } from './flow-checkpoint-continuity.mjs';
import { parseFlowTimestamp } from './flow-epoch.mjs';

const blocked=reason=>({kind:'blocked',reason});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const positive=value=>Number.isSafeInteger(value)&&value>0;
const mac=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const rootKeys=['version','repositoryId','number','issueId','cutoverAt','epoch','reentry','current','previous','reservation'];
const markerKeys=['phase','commentId','commentMac','commentKeyId','configMac','configKeyId','fromStatus','targetStatus','createdAt','epoch'];
const markerValid=value=>exact(value,markerKeys)&&mac(value.commentMac)&&positive(value.commentKeyId)&&mac(value.configMac)&&positive(value.configKeyId);
const markerV1=value=>value===null?null:{phase:value.phase,commentId:value.commentId,digest:value.commentMac,
  fromStatus:value.fromStatus,targetStatus:value.targetStatus,createdAt:value.createdAt,epoch:value.epoch};
const markerCanonical=value=>value===null?null:{phase:value.phase,commentId:value.commentId,commentMac:value.commentMac,commentKeyId:value.commentKeyId,
  configMac:value.configMac,configKeyId:value.configKeyId,fromStatus:value.fromStatus,targetStatus:value.targetStatus,createdAt:value.createdAt,
  epoch:{kind:value.epoch.kind,anchor:value.epoch.anchor}};
const normalized=value=>value===null?null:{...markerCanonical(value),phase:'committed'};
const toV1=value=>({version:1,repositoryId:value.repositoryId,number:value.number,issueId:value.issueId,cutoverAt:value.cutoverAt,epoch:value.epoch,
  reentry:value.reentry===null?null:{phase:value.reentry.phase,reopenedAt:value.reentry.reopenedAt,fromStatus:value.reentry.fromStatus,previous:markerV1(value.reentry.previous)},
  current:markerV1(value.current),previous:markerV1(value.previous)});

// Structural schema only: keyed values, public-data provenance, registration,
// branch protection, fresh evidence and write authority must be verified by
// trusted callers. No private Project IDs, option IDs or comment text belong
// in the checkpoint. Never treat a bare unkeyed hash as a v3 commitment.
export function encodeCheckpointV3(value){
  if(!exact(value,rootKeys)||value.version!==3||!(value.current===null||markerValid(value.current))
      ||!(value.previous===null||markerValid(value.previous))
      ||!(value.reentry===null||(object(value.reentry)&&(value.reentry.previous===null||markerValid(value.reentry.previous)))))
    return blocked('invalid-v3-record');
  let projected;try{projected=toV1(value);}catch{return blocked('invalid-v3-record');}
  const base=encodeCheckpointRecord(projected);if(base.kind!=='encoded-record')return blocked('invalid-base-record');
  if(value.reservation!==null&&(!exact(value.reservation,['reservedAt'])||value.current?.phase!=='pending'
      ||parseFlowTimestamp(value.reservation.reservedAt)===null||value.reservation.reservedAt<value.current.createdAt))return blocked('invalid-reservation');
  const markers=[value.current,value.previous,value.reentry?.previous??null].filter(Boolean);
  for(let i=0;i<markers.length;i++)for(let j=i+1;j<markers.length;j++){
    const a=markers[i],b=markers[j];
    if(a.commentId===b.commentId&&(a.commentMac!==b.commentMac||a.commentKeyId!==b.commentKeyId
        ||a.configMac!==b.configMac||a.configKeyId!==b.configKeyId))return blocked('invalid-repair-commitment');
  }
  const canonical=JSON.parse(base.content);
  canonical.version=3;
  canonical.reentry=value.reentry===null?null:{phase:value.reentry.phase,reopenedAt:value.reentry.reopenedAt,
    fromStatus:value.reentry.fromStatus,previous:markerCanonical(value.reentry.previous)};
  canonical.current=markerCanonical(value.current);canonical.previous=markerCanonical(value.previous);
  canonical.reservation=value.reservation===null?null:{reservedAt:value.reservation.reservedAt};
  const content=JSON.stringify(canonical);
  return Buffer.byteLength(content,'utf8')<=16384?{kind:'encoded-record',content}:blocked('record-too-large');
}

export function decodeCheckpointV3(content,identity){
  if(typeof content!=='string'||Buffer.byteLength(content,'utf8')>16384||!object(identity)||!id(identity.repositoryId)
      ||!id(identity.issueId)||!positive(identity.number))return blocked('invalid-input');
  let value;try{value=JSON.parse(content);}catch{return blocked('invalid-json');}
  const encoded=encodeCheckpointV3(value);if(encoded.kind!=='encoded-record')return encoded;
  if(content!==encoded.content)return blocked('noncanonical-record');
  if(value.repositoryId!==identity.repositoryId||value.number!==identity.number||value.issueId!==identity.issueId)return blocked('record-identity-mismatch');
  return {kind:'decoded-record',record:value};
}

// Structural continuity is not HMAC verification or retry authorization.
export function verifyCheckpointV3Continuity(before,after){
  if(encodeCheckpointV3(after).kind!=='encoded-record')return blocked('invalid-next-record');
  if(before===null){
    if(after.reservation!==null)return blocked('initial-reservation');
    return verifyCheckpointContinuity(null,toV1(after));
  }
  if(encodeCheckpointV3(before).kind!=='encoded-record')return blocked('invalid-previous-record');
  const prior=toV1(before),next=toV1(after);
  if(verifyCheckpointContinuity(prior,next).kind!=='continuity-verified')return blocked('invalid-base-transition');
  const priorCanonical=JSON.parse(encodeCheckpointV3(before).content),nextCanonical=JSON.parse(encodeCheckpointV3(after).content);
  delete priorCanonical.reservation;delete nextCanonical.reservation;
  if(same(priorCanonical,nextCanonical)){
    if(same(before.reservation,after.reservation))return {kind:'continuity-verified'};
    if(after.reservation===null||after.current?.phase!=='pending')return blocked('reservation-removed');
    if(before.reservation!==null&&after.reservation.reservedAt<=before.reservation.reservedAt)return blocked('reservation-regressed');
    return {kind:'continuity-verified'};
  }
  if(after.reservation!==null)return blocked('reservation-with-handoff-change');
  if(before.current?.phase==='pending'&&after.current?.phase==='committed'){
    if(!same(normalized(before.current),markerCanonical(after.current)))return blocked('handoff-commitment-changed');
    if(before.reservation===null&&before.current.fromStatus!==before.current.targetStatus)return blocked('missing-transition-reservation');
  }else if(before.reservation!==null)return blocked('reservation-discarded');
  if(before.current?.phase==='committed'&&after.current?.phase==='pending'
      &&!same(markerCanonical(after.previous),markerCanonical(before.current)))return blocked('previous-commitment-changed');
  if(before.current&&after.current&&before.current.commentId!==after.current.commentId
      &&(before.current.configMac!==after.current.configMac||before.current.configKeyId!==after.current.configKeyId))
    return blocked('configuration-migration-required');
  if(same(markerV1(before.current),markerV1(after.current))&&!same(markerCanonical(before.current),markerCanonical(after.current)))
    return blocked('handoff-commitment-changed');
  if(before.epoch.kind!==after.epoch.kind||before.epoch.anchor!==after.epoch.anchor){
    if(!same(markerCanonical(after.current),markerCanonical(before.current))
        ||!same(markerCanonical(after.reentry.previous),markerCanonical(before.current)))return blocked('reentry-commitment-changed');
  }
  return {kind:'continuity-verified'};
}
