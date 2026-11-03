import { isCheckpointRegistration } from './flow-checkpoint-registration.mjs';

const blocked=reason=>({kind:'blocked',reason});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value);
const source=value=>typeof value==='string'&&/^[0-9a-f]{32}$/.test(value);
const repo=value=>typeof value==='string'&&/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(value)
  &&!['.','..'].includes(value.split('/')[1]);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const keys=['version','source','repository','repositoryId','projectOwner','projectNumber','projectId','statusFieldId','statusFieldName',
  'appId','updateRulesetId','historyRulesetId','trustedAuthorIds','checkpoint'];
const checkpointKeys=['repositoryId','ref','genesisOid','cutoverAt','checkpointSchemaVersion'];

// This serializes private routing/configuration, not credentials. Its storage,
// provenance, rollback protection and onboarding authorization are external.
// Never include a token or write this content into a public log.
export function encodeProjectRegistration(value){
  if(!exact(value,keys)||value.version!==1||!source(value.source)||!repo(value.repository)||!id(value.repositoryId)
      ||typeof value.projectOwner!=='string'||!/^[A-Za-z0-9-]{1,39}$/.test(value.projectOwner)||!positive(value.projectNumber)
      ||!id(value.projectId)||!id(value.statusFieldId)||!id(value.statusFieldName)
      ||![value.appId,value.updateRulesetId,value.historyRulesetId].every(positive)||value.updateRulesetId===value.historyRulesetId
      ||!Array.isArray(value.trustedAuthorIds)||value.trustedAuthorIds.length<1||value.trustedAuthorIds.length>100
      ||value.trustedAuthorIds.some(author=>!id(author))||new Set(value.trustedAuthorIds).size!==value.trustedAuthorIds.length
      ||!exact(value.checkpoint,checkpointKeys)||!isCheckpointRegistration(value.checkpoint)
      ||value.checkpoint.repositoryId!==value.repositoryId||value.checkpoint.checkpointSchemaVersion!==2
      ||value.checkpoint.genesisOid==='0'.repeat(40))return blocked('invalid-registration');
  const checkpoint=value.checkpoint;
  const content=JSON.stringify({version:1,source:value.source,repository:value.repository,repositoryId:value.repositoryId,
    projectOwner:value.projectOwner,projectNumber:value.projectNumber,projectId:value.projectId,statusFieldId:value.statusFieldId,
    statusFieldName:value.statusFieldName,appId:value.appId,updateRulesetId:value.updateRulesetId,historyRulesetId:value.historyRulesetId,
    trustedAuthorIds:[...value.trustedAuthorIds],checkpoint:{repositoryId:checkpoint.repositoryId,ref:checkpoint.ref,
      genesisOid:checkpoint.genesisOid,cutoverAt:checkpoint.cutoverAt,checkpointSchemaVersion:2}});
  return Buffer.byteLength(content,'utf8')<=48*1024?{kind:'encoded-registration',content}:blocked('registration-too-large');
}

export function decodeProjectRegistration(content,expected){
  if(typeof content!=='string'||Buffer.byteLength(content,'utf8')>48*1024||!object(expected)||!source(expected.source)||!repo(expected.repository))
    return blocked('invalid-input');
  let value;try{value=JSON.parse(content);}catch{return blocked('invalid-json');}
  const encoded=encodeProjectRegistration(value);
  if(encoded.kind!=='encoded-registration')return encoded;
  if(content!==encoded.content)return blocked('noncanonical-registration');
  if(value.source!==expected.source||value.repository!==expected.repository)return blocked('registration-route-mismatch');
  return {kind:'decoded-registration',registration:value};
}
