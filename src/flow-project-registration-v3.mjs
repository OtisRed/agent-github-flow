import { FLOW_STATUSES } from './flow.mjs';
import { encodeProjectRegistration } from './flow-project-registration.mjs';

const blocked=reason=>({kind:'blocked',reason});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value);
const keys=['version','source','repository','repositoryId','expectedPrivate','dataPolicy','projectOwner','projectNumber','projectId',
  'statusFieldId','statusFieldName','statusOptions','appId','updateRulesetId','historyRulesetId','trustedAuthorIds','checkpoint'];
const checkpointKeys=['repositoryId','ref','genesisOid','cutoverAt','checkpointSchemaVersion'];

// Private configuration only. Provenance, protection, trusted storage and
// option visibility are checked by callers. Do not log this record or store it
// in a public checkpoint branch. It contains no credential values.
export function encodeProjectRegistrationV3(value){
  if(!exact(value,keys)||value.version!==3||typeof value.expectedPrivate!=='boolean'||value.dataPolicy!=='common-v3'
      ||!exact(value.checkpoint,checkpointKeys)||value.checkpoint.checkpointSchemaVersion!==3
      ||!Array.isArray(value.statusOptions)||value.statusOptions.length!==FLOW_STATUSES.length)return blocked('invalid-registration');
  const seen=new Set(),statusOptions=[];
  for(let i=0;i<FLOW_STATUSES.length;i++){
    const option=value.statusOptions[i];if(!exact(option,['name','id'])||option.name!==FLOW_STATUSES[i]||!id(option.id)||seen.has(option.id))
      return blocked('invalid-registration');
    seen.add(option.id);statusOptions.push({name:option.name,id:option.id});
  }
  // Reuse the older strict envelope validator only for data common to both
  // schemas. Its v1 projection is never returned or used for a write.
  const {expectedPrivate,dataPolicy,statusOptions:_options,...common}=value;
  const projected={...common,version:1,checkpoint:{...value.checkpoint,checkpointSchemaVersion:2}};
  const validated=encodeProjectRegistration(projected);
  if(validated.kind!=='encoded-registration')return blocked('invalid-registration');
  const base=JSON.parse(validated.content),checkpoint=base.checkpoint;
  const content=JSON.stringify({version:3,source:base.source,repository:base.repository,repositoryId:base.repositoryId,expectedPrivate,dataPolicy,
    projectOwner:base.projectOwner,projectNumber:base.projectNumber,projectId:base.projectId,statusFieldId:base.statusFieldId,
    statusFieldName:base.statusFieldName,statusOptions,appId:base.appId,updateRulesetId:base.updateRulesetId,historyRulesetId:base.historyRulesetId,
    trustedAuthorIds:base.trustedAuthorIds,checkpoint:{...checkpoint,checkpointSchemaVersion:3}});
  return Buffer.byteLength(content,'utf8')<=48*1024?{kind:'encoded-registration',content}:blocked('registration-too-large');
}

export function decodeProjectRegistrationV3(content,expected){
  if(typeof content!=='string'||Buffer.byteLength(content,'utf8')>48*1024||!object(expected)
      ||typeof expected.source!=='string'||!/^[0-9a-f]{32}$/.test(expected.source)||typeof expected.repository!=='string')return blocked('invalid-input');
  let value;try{value=JSON.parse(content);}catch{return blocked('invalid-json');}
  const encoded=encodeProjectRegistrationV3(value);if(encoded.kind!=='encoded-registration')return encoded;
  if(encoded.content!==content)return blocked('noncanonical-registration');
  if(value.source!==expected.source||value.repository!==expected.repository)return blocked('registration-route-mismatch');
  return {kind:'decoded-registration',registration:value};
}
