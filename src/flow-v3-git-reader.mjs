import { matchesV3ProtectedContext } from './flow-v3-protected-context.mjs';
import { createCheckpointGitReader } from './flow-checkpoint-git-reader.mjs';
import { planV3Genesis } from './flow-v3-genesis-plan.mjs';
import { CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';

const token=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\s\x00-\x1f\x7f]/.test(value);

// App-only GET transport, scoped to exactly one repository. Token creation,
// App identity and protected source of configuration are caller obligations.
// Neither returned data nor credentials may be logged.
export function createV3CheckpointGitReader({policy,projectRegistration,registrationCommitment,keyring,appToken,request=fetch}={}){
  try{policy=structuredClone(policy);projectRegistration=structuredClone(projectRegistration);registrationCommitment=structuredClone(registrationCommitment);}
  catch{throw Error('invalid-v3-git-reader');}
  if(!matchesV3ProtectedContext({policy,projectRegistration,registrationCommitment,keyring})||!token(appToken)||typeof request!=='function')
    throw Error('invalid-v3-git-reader');
  return createScopedReader({repository:policy.repository,repositoryId:policy.repositoryId,expectedPrivate:projectRegistration.expectedPrivate,
    appToken,request,allowMissingRefs:false});
}

// Administrative pre-registration reader. A 404 for either exact checkpoint
// ref means absence only; it never proves first enrollment or allows retry.
export function createV3SetupGitReader({setupIntent,appToken,request=fetch}={}){
  try{setupIntent=structuredClone(setupIntent);}catch{throw Error('invalid-v3-setup-reader');}
  if(!setupIntent||typeof setupIntent!=='object'||Array.isArray(setupIntent)||Object.keys(setupIntent).length!==4
      ||!['repository','repositoryId','expectedPrivate','cutoverAt'].every(key=>Object.hasOwn(setupIntent,key))
      ||typeof setupIntent.repository!=='string'||typeof setupIntent.expectedPrivate!=='boolean'
      ||planV3Genesis({repositoryId:setupIntent.repositoryId,cutoverAt:setupIntent.cutoverAt}).kind!=='v3-genesis-plan'
      ||!token(appToken)||typeof request!=='function')throw Error('invalid-v3-setup-reader');
  return createScopedReader({repository:setupIntent.repository,repositoryId:setupIntent.repositoryId,expectedPrivate:setupIntent.expectedPrivate,
    appToken,request,allowMissingRefs:true});
}

function createScopedReader({repository,repositoryId,expectedPrivate,appToken,request,allowMissingRefs}){
  const parts=repository.split('/');if(parts.length!==2)throw Error('invalid-v3-git-reader');
  const [owner,repo]=parts,repositoryUrl=`https://api.github.com/repos/${owner}/${repo}`;
  const get=async(url,allowAbsent=false)=>{
    const response=await request(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers:{
      Accept:'application/vnd.github+json',Authorization:`Bearer ${appToken}`,'X-GitHub-Api-Version':'2026-03-10'}});
    if(allowAbsent&&response?.status===404)return {data:null,link:null};
    if(!response||response.status!==200||typeof response.text!=='function'||typeof response.headers?.get!=='function')throw Error('read-failed');
    const raw=await response.text();if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>8_000_000)throw Error('read-failed');
    return {data:JSON.parse(raw),link:response.headers.get('link')};
  };
  const refs=[CHECKPOINT_BRANCH_REF,CHECKPOINT_ANCHOR_REF];
  const refUrls=refs.map(ref=>`${repositoryUrl}/git/ref/${ref.slice('refs/'.length)}`);
  const reader=createCheckpointGitReader({owner,repo,request:async url=>{
    try{
      const scope=await get('https://api.github.com/installation/repositories'),items=scope.data?.repositories,item=items?.[0];
      if(scope.link||scope.data?.total_count!==1||!Array.isArray(items)||items.length!==1||item?.node_id!==repositoryId
          ||item.full_name!==repository||item.private!==expectedPrivate||item.fork!==false)throw Error('scope');
      const result=await get(url,allowMissingRefs&&refUrls.includes(url)),data=result.data;
      if(url===repositoryUrl&&(data?.node_id!==repositoryId||data.full_name!==repository
          ||data.private!==expectedPrivate||data.fork!==false))throw Error('repository');
      return data;
    }catch{throw Error('v3-git-read-failed');}
  }});
  if(!allowMissingRefs)return reader;
  return Object.freeze({...reader,readRef:ref=>{
    if(!refs.includes(ref))throw Error('invalid-setup-ref');return reader.readRef(ref);
  }});
}
