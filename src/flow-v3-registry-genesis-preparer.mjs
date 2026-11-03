import { createHash } from 'node:crypto';
import { planV3RegistryGenesis } from './flow-v3-registry-genesis-plan.mjs';

const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)&&value!=='0'.repeat(40);
const validToken=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\s\x00-\x1f\x7f]/.test(value);
const blocked=reason=>({kind:'blocked',reason});
const uncertain=()=>({kind:'registry-genesis-preparation-uncertain',retryAllowed:false});
const blobOid=contents=>{const bytes=Buffer.from(contents,'base64');return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');};

// Prepare unreachable Git objects for exactly one half of an authenticated
// registry genesis. Never create refs here. The caller must authenticate the
// App, enrollment, initial absence, protections and global serialization;
// prepared OIDs are not enrollment or permission to publish. No credential,
// registry content, API response or plan may be logged.
export function createV3RegistryGenesisPreparer({role,privateRepository,privateRepositoryId,anchorRepository,anchorRepositoryId,keyring,appToken,request=fetch}={}){
  const plan=planV3RegistryGenesis({privateRepository,privateRepositoryId,anchorRepository,anchorRepositoryId,keyring});
  if(!['private','anchor'].includes(role)||plan.kind!=='v3-registry-genesis-plan'||!validToken(appToken)||typeof request!=='function')
    throw Error('invalid-registry-genesis-preparer');
  const part=structuredClone(plan[role]),api=`https://api.github.com/repos/${part.repository}`;let started=false;
  const call=async(url,method='GET',body)=>{
    const response=await request(url,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{
      Accept:'application/vnd.github+json',Authorization:`Bearer ${appToken}`,'Content-Type':'application/json','X-GitHub-Api-Version':'2026-03-10'},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(response?.status!==(method==='POST'?201:200)||typeof response.text!=='function'||typeof response.headers?.get!=='function'
        ||response.headers.get('link'))throw Error('request-failed');
    const raw=await response.text();if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>2_000_000)throw Error('request-failed');return JSON.parse(raw);
  };
  const scope=async()=>{
    const result=await call('https://api.github.com/installation/repositories'),items=result?.repositories,item=items?.[0];
    if(result?.total_count!==1||!Array.isArray(items)||items.length!==1||item?.node_id!==part.repositoryId
        ||item.full_name!==part.repository||item.private!==part.expectedPrivate||item.fork!==false)return false;
    const repository=await call(api);
    return repository?.node_id===part.repositoryId&&repository.full_name===part.repository&&repository.private===part.expectedPrivate
      &&repository.fork===false&&typeof repository.default_branch==='string'&&repository.default_branch.length>0
      &&`refs/heads/${repository.default_branch}`!==part.ref;
  };
  return Object.freeze({prepare:async()=>{
    if(started)return blocked('registry-genesis-preparer-already-used');started=true;
    try{if(!await scope())return blocked('registry-genesis-scope-mismatch');}catch{return blocked('registry-genesis-scope-unavailable');}
    try{
      const tree=await call(`${api}/git/trees`,'POST',{tree:part.files.map(file=>({path:file.path,mode:'100644',type:'blob',
        content:Buffer.from(file.contents,'base64').toString('utf8')}))});
      if(!oid(tree?.sha))return uncertain();
      const observed=await call(`${api}/git/trees/${tree.sha}?recursive=1`);
      if(observed?.sha!==tree.sha||observed.truncated!==false||!Array.isArray(observed.tree)||observed.tree.length!==part.files.length)return uncertain();
      for(const file of part.files){const entries=observed.tree.filter(entry=>entry?.path===file.path);
        if(entries.length!==1||entries[0].mode!=='100644'||entries[0].type!=='blob'||entries[0].sha!==blobOid(file.contents))return uncertain();}
      if(!await scope())return uncertain();
      const commit=await call(`${api}/git/commits`,'POST',{message:'Initialize FLOW registry',tree:tree.sha,parents:[]});
      if(!oid(commit?.sha))return uncertain();
      const actual=await call(`${api}/git/commits/${commit.sha}`);
      if(actual?.sha!==commit.sha||actual.tree?.sha!==tree.sha||!Array.isArray(actual.parents)||actual.parents.length!==0||!await scope())return uncertain();
      return {kind:'v3-registry-genesis-objects-prepared',role,repositoryId:part.repositoryId,ref:part.ref,
        genesisOid:commit.sha,treeOid:tree.sha,retryAllowed:false};
    }catch{return uncertain();}
  }});
}
