import { createV3RegistryPairReader } from './flow-v3-registry-pair-reader.mjs';
import { createV3RegistryStagedStore } from './flow-v3-registry-staged-store.mjs';

// Composition of two independently scoped protected branch writers. The
// runtime must authenticate their repo/App identities and enforce one global
// writer. A partial update remains unavailable and is never retried here.
export function createV3RegistryStoreAdapter({privateWriter,anchorWriter,keyring,identities}={}){
  if(!privateWriter||!anchorWriter||privateWriter===anchorWriter
      ||![privateWriter.read,privateWriter.write,anchorWriter.read,anchorWriter.write].every(fn=>typeof fn==='function'))
    throw Error('invalid-v3-registry-store-adapter');
  const expected=structuredClone(identities);
  const valid=(identity,role)=>identity&&identity.role===role&&typeof identity.repository==='string'&&identity.repository.length>0
    &&typeof identity.repositoryId==='string'&&identity.repositoryId.length>0&&Number.isSafeInteger(identity.appId)&&identity.appId>0;
  const match=(actual,want)=>valid(actual,want.role)&&actual.repository===want.repository
    &&actual.repositoryId===want.repositoryId&&actual.appId===want.appId;
  if(!valid(expected?.private,'private')||!valid(expected?.anchor,'anchor')
      ||expected.private.repositoryId===expected.anchor.repositoryId||expected.private.repository===expected.anchor.repository
      ||expected.private.appId!==expected.anchor.appId||!match(privateWriter.identity,expected.private)||!match(anchorWriter.identity,expected.anchor))
    throw Error('registry-identity-mismatch');
  const checked=(writer,want)=>async()=>{const value=await writer.read();
    if(value?.repository!==want.repository||value.repositoryId!==want.repositoryId||value.role!==want.role)throw Error('registry-identity-mismatch');return value;};
  const read=createV3RegistryPairReader({readPrivate:checked(privateWriter,expected.private),readAnchor:checked(anchorWriter,expected.anchor)});
  let stagedContent=null;
  return createV3RegistryStagedStore({keyring,read,
    writePrivate:async({expectedHead,content,stagedAnchor})=>{
      const result=await privateWriter.write({expectedHead,content,anchor:stagedAnchor});
      if(result?.kind==='registry-private-advanced')stagedContent=content;return result;
    },
    writeAnchor:async({expectedHead,anchor})=>{
      if(typeof stagedContent!=='string')return {kind:'blocked',reason:'registry-stage-missing'};
      return anchorWriter.write({expectedHead,content:stagedContent,anchor});
    }});
}
