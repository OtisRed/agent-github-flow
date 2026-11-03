import { createHmac, timingSafeEqual } from 'node:crypto';
import { encodeProjectRegistrationV3 } from './flow-project-registration-v3.mjs';
import { encodeV3Registry } from './flow-v3-registry.mjs';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value);
const invalid=()=>{throw Error('invalid-checkpoint-input');};

// Cryptographic primitive only: it does not provision, retain, rotate or
// authorize a key, registration, comment or write. The caller must keep the
// random key secret and supply historical keys when checking older records.
// Do not log key bytes, input objects or private configuration.
export function createCheckpointMac({key,keyId}={}){
  if(!Buffer.isBuffer(key)||key.length!==32||!Number.isSafeInteger(keyId)||keyId<1)throw Error('invalid-checkpoint-key');
  const secret=Buffer.from(key);
  const sign=(domain,payload)=>createHmac('sha256',secret).update(JSON.stringify([domain,keyId,payload]),'utf8').digest('hex');
  const config=value=>{
    const encoded=encodeProjectRegistrationV3(value);
    if(encoded.kind!=='encoded-registration')return invalid();
    return sign('agent-github-flow/config/v3',JSON.parse(encoded.content));
  };
  const comment=value=>{
    if(!exact(value,['repositoryId','issueId','commentId','body'])||!id(value.repositoryId)||!id(value.issueId)
        ||typeof value.commentId!=='string'||!/^[1-9][0-9]{0,19}$/.test(value.commentId)
        ||typeof value.body!=='string'||Buffer.byteLength(value.body,'utf8')>1024*1024)return invalid();
    return sign('agent-github-flow/comment/v3',{repositoryId:value.repositoryId,issueId:value.issueId,commentId:value.commentId,body:value.body});
  };
  const registry=value=>{
    const encoded=encodeV3Registry(value);if(encoded.kind!=='encoded-v3-registry')return invalid();
    return sign('agent-github-flow/registry/v1',JSON.parse(encoded.content));
  };
  const verify=(fn,value,expected)=>{
    if(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected))return false;
    try{return timingSafeEqual(Buffer.from(fn(value),'hex'),Buffer.from(expected,'hex'));}catch{return false;}
  };
  return Object.freeze({keyId,config,comment,registry,verifyConfig:(value,expected)=>verify(config,value,expected),
    verifyComment:(value,expected)=>verify(comment,value,expected),verifyRegistry:(value,expected)=>verify(registry,value,expected)});
}
