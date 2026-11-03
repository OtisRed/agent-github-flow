import { isDeepStrictEqual } from 'node:util';

// Composes independently scoped, authenticated v3 branch readers. A stable
// mismatching pair is returned for the staged transaction to diagnose; it is
// never itself an authenticated registry or an authorization to write.
export function createV3RegistryPairReader({readPrivate,readAnchor}={}){
  if(typeof readPrivate!=='function'||typeof readAnchor!=='function')throw Error('invalid-registry-pair-reader');
  return async()=>{
    const pair=async()=>[structuredClone(await readPrivate()),structuredClone(await readAnchor())];
    const first=await pair(),second=await pair();
    if(!isDeepStrictEqual(first,second)||first[0]?.kind!=='v3-registry-branch-observed'||first[0].role!=='private'
        ||first[1]?.kind!=='v3-registry-branch-observed'||first[1].role!=='anchor'||typeof first[0].content!=='string')
      throw Error('registry-pair-unavailable');
    return {privateHead:first[0].head,anchorHead:first[1].head,content:first[0].content,
      stagedAnchor:first[0].anchor,anchor:first[1].anchor};
  };
}
