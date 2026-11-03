import { timingSafeEqual } from 'node:crypto';
import { createCheckpointMac } from './flow-checkpoint-mac.mjs';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const positive=value=>Number.isSafeInteger(value)&&value>0;

// In-memory access only. Provisioning, durable backup, environment storage,
// atomic rotation and determining when an old key can be retired are external.
// Never log the supplied buffers or serialize this object.
export function createCheckpointKeyring(input){
  if(!exact(input,['currentKeyId','keys'])||!positive(input.currentKeyId)||!Array.isArray(input.keys)
      ||input.keys.length<1||input.keys.length>64)throw Error('invalid-checkpoint-keyring');
  const ids=new Set(),materials=[],macs=new Map();
  for(const entry of input.keys){
    if(!exact(entry,['id','key'])||!positive(entry.id)||ids.has(entry.id)||!Buffer.isBuffer(entry.key)||entry.key.length!==32
        ||materials.some(previous=>timingSafeEqual(previous,entry.key)))throw Error('invalid-checkpoint-keyring');
    ids.add(entry.id);materials.push(Buffer.from(entry.key));macs.set(entry.id,createCheckpointMac({key:entry.key,keyId:entry.id}));
  }
  const currentKeyId=input.currentKeyId;
  if(!macs.has(currentKeyId))throw Error('invalid-checkpoint-keyring');
  const get=id=>{if(!positive(id)||!macs.has(id))throw Error('unknown-checkpoint-key');return macs.get(id);};
  return Object.freeze({current:()=>get(currentKeyId),forId:get});
}
