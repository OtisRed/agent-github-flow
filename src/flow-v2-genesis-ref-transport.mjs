import { planCheckpointRefPairCreate } from './flow-checkpoint-ref-pair.mjs';
import { CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';
import { CHECKPOINT_UPDATE_REFS } from './flow-checkpoint-ref-transport.mjs';

const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)&&value!=='0'.repeat(40);
const token=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\s\x00-\x1f\x7f]/.test(value);
const blocked=reason=>({kind:'blocked',reason});
const uncertain=()=>({kind:'ref-update-uncertain',retryAllowed:false});

// One low-level mutation attempt. Caller must independently establish that the
// repo has never been registered, verify exact genesis contents, protection,
// and serialize bootstrap; afterward it must read back both refs. Not wired to
// Actions. It never retries, changes product branches or logs private inputs.
export function createV2GenesisRefTransport({owner,repo,repositoryId,genesisOid,treeOid,appToken,request=fetch}={}) {
  if(!/^[A-Za-z0-9-]{1,39}$/.test(owner??'')||!/^[A-Za-z0-9_.-]{1,100}$/.test(repo??'')||['.','..'].includes(repo)
      ||typeof repositoryId!=='string'||!repositoryId||repositoryId.length>256||repositoryId.trim()!==repositoryId
      ||!oid(genesisOid)||!oid(treeOid)||!token(appToken)||typeof request!=='function')throw Error('invalid-genesis-ref-transport');
  const api=`https://api.github.com/repos/${owner}/${repo}`;let started=false;
  const call=async(url,method='GET',body,missing=false)=>{
    const response=await request(url,{method,redirect:'error',signal:AbortSignal.timeout(10_000),
      headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${appToken}`,'Content-Type':'application/json',
        'X-GitHub-Api-Version':'2026-03-10'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(missing&&response?.status===404)return {kind:'ref-absent'};
    if(!response||response.status!==200||typeof response.text!=='function')throw Error('api-failed');
    const raw=await response.text();if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>2_000_000)throw Error('invalid-response');
    const value=JSON.parse(raw);return missing?{kind:'ref-present',value}:value;
  };
  const scope=async()=>{const response=await call('https://api.github.com/installation/repositories'),list=response?.repositories;
    return response?.total_count===1&&Array.isArray(list)&&list.length===1&&list[0]?.node_id===repositoryId
      &&list[0]?.full_name===`${owner}/${repo}`&&list[0]?.private===true;};
  const ref=async refName=>{const result=await call(`${api}/git/ref/${refName.slice('refs/'.length)}`,'GET',undefined,true);
    return result?.kind==='ref-absent'?null:result;};
  return Object.freeze({publish:async()=>{
    if(started)return blocked('ref-transport-already-used');started=true;let plan;
    try{
      if(!await scope())return blocked('scope-mismatch');
      const repository=await call(api);
      if(repository?.node_id!==repositoryId||repository.full_name!==`${owner}/${repo}`||repository.private!==true
          ||typeof repository.default_branch!=='string'||!repository.default_branch
          ||[CHECKPOINT_BRANCH_REF,CHECKPOINT_ANCHOR_REF].includes(`refs/heads/${repository.default_branch}`))return blocked('repository-mismatch');
      const checkpointRef=await ref(CHECKPOINT_BRANCH_REF),anchorRef=await ref(CHECKPOINT_ANCHOR_REF);
      const commit=await call(`${api}/git/commits/${genesisOid}`);
      if(commit?.sha!==genesisOid)return blocked('genesis-mismatch');
      plan=planCheckpointRefPairCreate({repositoryId,expectedTreeOid:treeOid,checkpointRef,anchorRef,commit});
      if(plan.kind!=='atomic-ref-pair-plan')return blocked('invalid-ref-plan');
      if(!await scope()||await ref(CHECKPOINT_BRANCH_REF)!==null||await ref(CHECKPOINT_ANCHOR_REF)!==null)return blocked('ref-preflight-changed');
    }catch{return blocked('ref-preflight-unavailable');}
    try{
      const response=await call('https://api.github.com/graphql','POST',
        {query:CHECKPOINT_UPDATE_REFS,variables:{input:{repositoryId,refUpdates:plan.refUpdates}}});
      if(!response||(Object.hasOwn(response,'errors')&&(!Array.isArray(response.errors)||response.errors.length!==0))
          ||response.data?.updateRefs?.__typename!=='UpdateRefsPayload')return uncertain();
      return {kind:'ref-update-acknowledged',retryAllowed:false};
    }catch{return uncertain();}
  }});
}
