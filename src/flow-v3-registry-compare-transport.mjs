const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)&&value!=='0'.repeat(40);
const repo=value=>typeof value==='string'&&/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(value)&&!['.','..'].includes(value.split('/')[1]);

// GET only, one selected installation repository, no redirects and no
// server-supplied URLs. Token/App identity and pinned genesis are trusted
// externally. Partial/paginated comparisons fail closed in the observer.
export function createV3RegistryCompareTransport({role,repository,repositoryId,appToken,request=fetch}={}){
  if(!['private','anchor'].includes(role)||!repo(repository)||typeof repositoryId!=='string'||!repositoryId||repositoryId.length>256
      ||typeof appToken!=='string'||!appToken||appToken.length>512||/[\s\x00-\x1f\x7f]/.test(appToken)||typeof request!=='function')
    throw Error('invalid-registry-compare');
  const expectedPrivate=role==='private',api=`https://api.github.com/repos/${repository}`;
  const get=async url=>{const response=await request(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers:{
    Accept:'application/vnd.github+json',Authorization:`Bearer ${appToken}`,'X-GitHub-Api-Version':'2026-03-10'}});
    if(response?.status!==200||typeof response.text!=='function'||typeof response.headers?.get!=='function'||response.headers.get('link'))throw Error('compare-unavailable');
    const raw=await response.text();if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>2_000_000)throw Error('compare-unavailable');return JSON.parse(raw);};
  const scope=async()=>{const installation=await get('https://api.github.com/installation/repositories'),items=installation?.repositories,item=items?.[0];
    if(installation?.total_count!==1||!Array.isArray(items)||items.length!==1||item?.node_id!==repositoryId||item.full_name!==repository
      ||item.private!==expectedPrivate||item.fork!==false)return false;
    const actual=await get(api);return actual?.node_id===repositoryId&&actual.full_name===repository&&actual.private===expectedPrivate&&actual.fork===false;};
  return async({genesisOid,headOid}={})=>{
    if(!oid(genesisOid)||!oid(headOid))throw Error('invalid-compare-oid');
    if(!await scope())throw Error('compare-scope');
    const comparison=await get(`${api}/compare/${genesisOid}...${headOid}`);
    if(!await scope())throw Error('compare-scope');return comparison;
  };
}
