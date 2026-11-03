import { matchesV3ProtectedContext } from './flow-v3-protected-context.mjs';
import { createCheckpointGitReader } from './flow-checkpoint-git-reader.mjs';

const token=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\s\x00-\x1f\x7f]/.test(value);

// App-only GET transport, scoped to exactly one repository. Token creation,
// App identity and protected source of configuration are caller obligations.
// Neither returned data nor credentials may be logged.
export function createV3CheckpointGitReader({policy,projectRegistration,registrationCommitment,keyring,appToken,request=fetch}={}){
  try{policy=structuredClone(policy);projectRegistration=structuredClone(projectRegistration);registrationCommitment=structuredClone(registrationCommitment);}
  catch{throw Error('invalid-v3-git-reader');}
  if(!matchesV3ProtectedContext({policy,projectRegistration,registrationCommitment,keyring})||!token(appToken)||typeof request!=='function')
    throw Error('invalid-v3-git-reader');
  const parts=policy.repository.split('/');if(parts.length!==2)throw Error('invalid-v3-git-reader');
  const [owner,repo]=parts,repositoryUrl=`https://api.github.com/repos/${owner}/${repo}`;
  const get=async url=>{
    const response=await request(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers:{
      Accept:'application/vnd.github+json',Authorization:`Bearer ${appToken}`,'X-GitHub-Api-Version':'2026-03-10'}});
    if(!response||response.status!==200||typeof response.text!=='function'||typeof response.headers?.get!=='function')throw Error('read-failed');
    const raw=await response.text();if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>8_000_000)throw Error('read-failed');
    return {data:JSON.parse(raw),link:response.headers.get('link')};
  };
  return createCheckpointGitReader({owner,repo,request:async url=>{
    try{
      const scope=await get('https://api.github.com/installation/repositories'),items=scope.data?.repositories,item=items?.[0];
      if(scope.link||scope.data?.total_count!==1||!Array.isArray(items)||items.length!==1||item?.node_id!==policy.repositoryId
          ||item.full_name!==policy.repository||item.private!==projectRegistration.expectedPrivate||item.fork!==false)throw Error('scope');
      const result=await get(url),data=result.data;
      if(url===repositoryUrl&&(data?.node_id!==policy.repositoryId||data.full_name!==policy.repository
          ||data.private!==projectRegistration.expectedPrivate||data.fork!==false))throw Error('repository');
      return data;
    }catch{throw Error('v3-git-read-failed');}
  }});
}
