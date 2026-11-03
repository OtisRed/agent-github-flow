import { createHash } from 'node:crypto';
import { planV2Genesis } from './flow-v2-genesis-plan.mjs';
import { planV3Genesis } from './flow-v3-genesis-plan.mjs';

const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)&&value!=='0'.repeat(40);
const token=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\s\x00-\x1f\x7f]/.test(value);
const blocked=reason=>({kind:'blocked',reason});
const uncertain=()=>({kind:'genesis-preparation-uncertain',retryAllowed:false});
const blobOid=contents=>{const bytes=Buffer.from(contents,'base64');return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');};

// Creates unreachable Git objects only. It never updates refs, registers a
// project or authorizes bootstrap. The App token must be scoped to exactly the
// selected private repository, and inputs/results must not be logged.
export function createV2GenesisPreparer({owner,repo,repositoryId,cutoverAt,appToken,request=fetch}={}) {
  const plan=planV2Genesis({repositoryId,cutoverAt});
  return createPreparer({owner,repo,repositoryId,plan,appToken,request,version:2,expectedPrivate:true,requireNotFork:false});
}

// One explicit administrative setup intent; this creates no refs or registration
// and does not prove this repository is new to the flow. The caller must
// authenticate intent and prevent reinitialization after lost configuration.
export function createV3GenesisPreparer({setupIntent,appToken,request=fetch}={}){
  try{setupIntent=structuredClone(setupIntent);}catch{throw Error('invalid-v3-genesis-preparer');}
  if(!setupIntent||typeof setupIntent!=='object'||Array.isArray(setupIntent)||Object.keys(setupIntent).length!==4
      ||!['repository','repositoryId','expectedPrivate','cutoverAt'].every(key=>Object.hasOwn(setupIntent,key))
      ||typeof setupIntent.repository!=='string'||typeof setupIntent.expectedPrivate!=='boolean')throw Error('invalid-v3-genesis-preparer');
  const parts=setupIntent.repository.split('/');if(parts.length!==2)throw Error('invalid-v3-genesis-preparer');
  const plan=planV3Genesis({repositoryId:setupIntent.repositoryId,cutoverAt:setupIntent.cutoverAt});
  return createPreparer({owner:parts[0],repo:parts[1],repositoryId:setupIntent.repositoryId,plan,appToken,request,
    version:3,expectedPrivate:setupIntent.expectedPrivate,requireNotFork:true});
}

function createPreparer({owner,repo,repositoryId,plan,appToken,request,version,expectedPrivate,requireNotFork}) {
  if(!/^[A-Za-z0-9-]{1,39}$/.test(owner??'')||!/^[A-Za-z0-9_.-]{1,100}$/.test(repo??'')||['.','..'].includes(repo)
      ||plan.kind!==`v${version}-genesis-plan`||!token(appToken)||typeof request!=='function'||typeof expectedPrivate!=='boolean')throw Error('invalid-genesis-preparer');
  const api=`https://api.github.com/repos/${owner}/${repo}`;let started=false;
  const call=async(url,method='GET',body)=>{
    const response=await request(url,{method,redirect:'error',signal:AbortSignal.timeout(10_000),
      headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${appToken}`,'Content-Type':'application/json',
        'X-GitHub-Api-Version':'2026-03-10'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!response||response.status!==(method==='POST'?201:200)||typeof response.text!=='function')throw Error('api-failed');
    const raw=await response.text();if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>2_000_000)throw Error('invalid-response');
    return JSON.parse(raw);
  };
  const scope=async()=>{const response=await call('https://api.github.com/installation/repositories'),list=response?.repositories;
    return response?.total_count===1&&Array.isArray(list)&&list.length===1&&list[0]?.node_id===repositoryId
      &&list[0]?.full_name===`${owner}/${repo}`&&list[0]?.private===expectedPrivate&&(!requireNotFork||list[0]?.fork===false);};
  return Object.freeze({prepare:async()=>{
    if(started)return blocked('preparer-already-used');started=true;
    try{if(!await scope())return blocked('scope-mismatch');}catch{return blocked('scope-unavailable');}
    try{
      const tree=await call(`${api}/git/trees`,'POST',{tree:plan.files.map(file=>({path:file.path,mode:'100644',type:'blob',
        content:Buffer.from(file.contents,'base64').toString('utf8')}))});
      if(!oid(tree?.sha))return uncertain();
      const observed=await call(`${api}/git/trees/${tree.sha}?recursive=1`);
      if(observed?.sha!==tree.sha||observed.truncated!==false||!Array.isArray(observed.tree)||observed.tree.length!==plan.files.length)return uncertain();
      for(const file of plan.files){const matches=observed.tree.filter(entry=>entry?.path===file.path);
        if(matches.length!==1||matches[0].mode!=='100644'||matches[0].type!=='blob'||matches[0].sha!==blobOid(file.contents))return uncertain();}
      if(!await scope())return uncertain();
      const commit=await call(`${api}/git/commits`,'POST',{message:`Initialize FLOW checkpoint v${version}`,tree:tree.sha,parents:[]});
      if(!oid(commit?.sha))return uncertain();
      const actual=await call(`${api}/git/commits/${commit.sha}`);
      if(actual?.sha!==commit.sha||actual.tree?.sha!==tree.sha||!Array.isArray(actual.parents)||actual.parents.length!==0||!await scope())return uncertain();
      return {kind:`v${version}-genesis-objects-prepared`,genesisOid:commit.sha,treeOid:tree.sha,retryAllowed:false};
    }catch{return uncertain();}
  }});
}
