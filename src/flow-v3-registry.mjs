import { encodeProjectRegistrationV3 } from './flow-project-registration-v3.mjs';
import { parseFlowTimestamp } from './flow-epoch.mjs';

const blocked=reason=>({kind:'blocked',reason});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value);
const validRepo=value=>typeof value==='string'&&/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(value)
  &&!['.','..'].includes(value.split('/')[1]);
const entryKeys=['source','repository','repositoryId','expectedPrivate','cutoverAt','appId','updateRulesetId','historyRulesetId','state','bootstrap','registration'];
const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)&&value!=='0'.repeat(40);
const intentMatches=(entry,registration)=>registration.source===entry.source&&registration.repository===entry.repository
  &&registration.repositoryId===entry.repositoryId&&registration.expectedPrivate===entry.expectedPrivate&&registration.checkpoint.cutoverAt===entry.cutoverAt
  &&registration.appId===entry.appId&&registration.updateRulesetId===entry.updateRulesetId&&registration.historyRulesetId===entry.historyRulesetId;

// Private registry payload, never a source of authority on its own. Callers
// must authenticate the complete canonical value against an independently
// protected anchor, manage rollback, and serialize setup changes. Never log
// or publish this payload; it contains private Project IDs and mappings.
export function encodeV3Registry(value){
  if(!exact(value,['version','revision','entries'])||value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<1
      ||!Array.isArray(value.entries)||value.entries.length>100)return blocked('invalid-registry');
  const entries=[],sources=new Set(),repositories=new Set(),repositoryIds=new Set();
  for(const entry of value.entries){
    if(!exact(entry,entryKeys)||typeof entry.source!=='string'||!/^[a-f0-9]{32}$/.test(entry.source)||!validRepo(entry.repository)
        ||!validId(entry.repositoryId)||typeof entry.expectedPrivate!=='boolean'||parseFlowTimestamp(entry.cutoverAt)===null
        ||[entry.appId,entry.updateRulesetId,entry.historyRulesetId].some(value=>!Number.isSafeInteger(value)||value<1)
        ||entry.updateRulesetId===entry.historyRulesetId
        ||!['reserved','initializing','active','retired'].includes(entry.state)||sources.has(entry.source)||repositories.has(entry.repository.toLowerCase())
        ||repositoryIds.has(entry.repositoryId))return blocked('invalid-entry');
    let registration=null,bootstrap=null;
    if(entry.state==='reserved'){if(entry.registration!==null||entry.bootstrap!==null)return blocked('invalid-entry');}
    else{
      if(!exact(entry.bootstrap,['genesisOid','treeOid'])||!oid(entry.bootstrap.genesisOid)||!oid(entry.bootstrap.treeOid))return blocked('invalid-entry');
      bootstrap={genesisOid:entry.bootstrap.genesisOid,treeOid:entry.bootstrap.treeOid};
      if(entry.state==='initializing'){if(entry.registration!==null)return blocked('invalid-entry');}
      else{
        const encoded=encodeProjectRegistrationV3(entry.registration);if(encoded.kind!=='encoded-registration')return blocked('invalid-entry');
        registration=JSON.parse(encoded.content);if(!intentMatches(entry,registration)||registration.checkpoint.genesisOid!==bootstrap.genesisOid)
          return blocked('registration-intent-mismatch');
      }
    }
    sources.add(entry.source);repositories.add(entry.repository.toLowerCase());repositoryIds.add(entry.repositoryId);
    entries.push({source:entry.source,repository:entry.repository,repositoryId:entry.repositoryId,expectedPrivate:entry.expectedPrivate,
      cutoverAt:entry.cutoverAt,appId:entry.appId,updateRulesetId:entry.updateRulesetId,historyRulesetId:entry.historyRulesetId,
      state:entry.state,bootstrap,registration});
  }
  entries.sort((a,b)=>a.source<b.source?-1:a.source>b.source?1:0);
  const content=JSON.stringify({version:1,revision:value.revision,entries});
  return Buffer.byteLength(content,'utf8')<=45*1024?{kind:'encoded-v3-registry',content}:blocked('registry-too-large');
}

export function decodeV3Registry(content){
  if(typeof content!=='string'||Buffer.byteLength(content,'utf8')>45*1024)return blocked('invalid-input');
  let value;try{value=JSON.parse(content);}catch{return blocked('invalid-json');}
  const encoded=encodeV3Registry(value);if(encoded.kind!=='encoded-v3-registry'||encoded.content!==content)return blocked('noncanonical-registry');
  return {kind:'decoded-v3-registry',registry:value};
}

// Pure transitions only. They do not authenticate enrollment, establish that
// a protected registry is current, verify a genesis, or persist any changes.
export function reserveV3Project(registry,intent){
  try{intent=structuredClone(intent);}catch{return blocked('invalid-input');}
  const encoded=encodeV3Registry(registry);
  if(encoded.kind!=='encoded-v3-registry'||!exact(intent,['source','repository','repositoryId','expectedPrivate','cutoverAt','appId','updateRulesetId','historyRulesetId'])
      ||registry.revision===Number.MAX_SAFE_INTEGER)return blocked('invalid-input');
  const after=JSON.parse(encoded.content);after.revision++;
  after.entries.push({...intent,state:'reserved',bootstrap:null,registration:null});
  const next=encodeV3Registry(after);return next.kind==='encoded-v3-registry'?{kind:'v3-registry-transition-planned',content:next.content}:next;
}

// Persist and independently anchor these exact prepared OIDs BEFORE attempting
// ref creation. Missing refs after this point cannot authorize new genesis.
export function pinV3ProjectGenesis(registry,source,bootstrap){
  try{bootstrap=structuredClone(bootstrap);}catch{return blocked('invalid-input');}
  const encoded=encodeV3Registry(registry);if(encoded.kind!=='encoded-v3-registry'||registry.revision===Number.MAX_SAFE_INTEGER)return blocked('invalid-input');
  const after=JSON.parse(encoded.content),entry=after.entries.find(item=>item.source===source);
  if(!entry||entry.state!=='reserved')return blocked('not-reserved');
  entry.state='initializing';entry.bootstrap=bootstrap;after.revision++;
  const next=encodeV3Registry(after);return next.kind==='encoded-v3-registry'?{kind:'v3-registry-transition-planned',content:next.content}:next;
}

export function activateV3Project(registry,source,registration){
  try{registration=structuredClone(registration);}catch{return blocked('invalid-input');}
  const encoded=encodeV3Registry(registry);if(encoded.kind!=='encoded-v3-registry'||registry.revision===Number.MAX_SAFE_INTEGER)return blocked('invalid-input');
  const after=JSON.parse(encoded.content),entry=after.entries.find(item=>item.source===source);
  if(!entry||entry.state!=='initializing')return blocked('not-initializing');
  entry.state='active';entry.registration=registration;after.revision++;
  const next=encodeV3Registry(after);return next.kind==='encoded-v3-registry'?{kind:'v3-registry-transition-planned',content:next.content}:next;
}

export function retireV3Project(registry,source){
  const encoded=encodeV3Registry(registry);if(encoded.kind!=='encoded-v3-registry'||registry.revision===Number.MAX_SAFE_INTEGER)return blocked('invalid-input');
  const after=JSON.parse(encoded.content),entry=after.entries.find(item=>item.source===source);
  if(!entry||entry.state!=='active')return blocked('not-active');
  entry.state='retired';after.revision++;const next=encodeV3Registry(after);
  return next.kind==='encoded-v3-registry'?{kind:'v3-registry-transition-planned',content:next.content}:next;
}
