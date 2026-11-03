import { V3_REGISTRY_REF,V3_REGISTRY_ANCHOR_REF } from './flow-v3-registry-git-plan.mjs';
import { decodeCheckpointGitBlob } from './flow-checkpoint-git-blob.mjs';
import { verifyV3Registry } from './flow-v3-registry-anchor.mjs';

const oid=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)&&value!=='0'.repeat(40);
const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value);
const token=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\s\x00-\x1f\x7f]/.test(value);
const repo=value=>typeof value==='string'&&/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(value)&&!['.','..'].includes(value.split('/')[1]);
const blocked=reason=>({kind:'blocked',reason});
const parseAnchor=text=>{
  let value;try{value=JSON.parse(text);}catch{return null;}
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==4
      ||!['version','revision','keyId','mac'].every(key=>Object.hasOwn(value,key))||value.version!==1
      ||!Number.isSafeInteger(value.revision)||value.revision<1||!Number.isSafeInteger(value.keyId)||value.keyId<1
      ||typeof value.mac!=='string'||!/^[a-f0-9]{64}$/.test(value.mac))return null;
  return JSON.stringify({version:value.version,revision:value.revision,keyId:value.keyId,mac:value.mac})===text?value:null;
};

// Read-only single-repository App transport. Trusted caller supplies the
// independently protected repo identity, App identity, branch provenance and
// protection audit. Private content and credential values must not be logged.
export function createV3RegistryGitReader({role,repository,repositoryId,appToken,keyring,request=fetch}={}){
  if(!['private','anchor'].includes(role)||!repo(repository)||!id(repositoryId)||!token(appToken)
      ||!keyring||typeof keyring.forId!=='function'||typeof request!=='function')throw Error('invalid-registry-reader');
  const expectedPrivate=role==='private',ref=expectedPrivate?V3_REGISTRY_REF:V3_REGISTRY_ANCHOR_REF;
  const paths=expectedPrivate?['registry.json','anchor.json']:['anchor.json'];
  const api=`https://api.github.com/repos/${repository}`;
  const get=async url=>{
    const response=await request(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers:{
      Accept:'application/vnd.github+json',Authorization:`Bearer ${appToken}`,'X-GitHub-Api-Version':'2026-03-10'}});
    if(!response||response.status!==200||typeof response.text!=='function'||typeof response.headers?.get!=='function')throw Error('read-failed');
    const raw=await response.text();if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>2_000_000)throw Error('read-failed');
    return {data:JSON.parse(raw),link:response.headers.get('link')};
  };
  const scope=async()=>{const result=await get('https://api.github.com/installation/repositories'),items=result.data?.repositories,item=items?.[0];
    return !result.link&&result.data?.total_count===1&&Array.isArray(items)&&items.length===1&&item?.node_id===repositoryId
      &&item.full_name===repository&&item.private===expectedPrivate&&item.fork===false;};
  const readRepo=async()=>{const data=(await get(api)).data;
    if(data?.node_id!==repositoryId||data.full_name!==repository||data.private!==expectedPrivate||data.fork!==false
        ||typeof data.default_branch!=='string'||!data.default_branch||`refs/heads/${data.default_branch}`===ref)throw Error('repository');
    return {node_id:data.node_id,full_name:data.full_name,private:data.private,fork:data.fork,default_branch:data.default_branch};};
  const readRef=async()=>{const data=(await get(`${api}/git/ref/${ref.slice('refs/'.length)}`)).data;
    if(data?.ref!==ref||data.object?.type!=='commit'||!oid(data.object.sha))throw Error('ref');return data.object.sha;};
  return async()=>{
    try{
      if(!await scope())return blocked('scope-mismatch');const before=await readRepo(),head=await readRef();
      const commit=(await get(`${api}/git/commits/${head}`)).data;if(commit?.sha!==head||!oid(commit.tree?.sha))return blocked('commit-mismatch');
      const tree=(await get(`${api}/git/trees/${commit.tree.sha}?recursive=1`)).data;
      if(tree?.sha!==commit.tree.sha||tree.truncated!==false||!Array.isArray(tree.tree)||tree.tree.length!==paths.length)return blocked('tree-mismatch');
      const decoded={};
      for(const path of paths){const entries=tree.tree.filter(entry=>entry?.path===path),entry=entries[0];
        if(entries.length!==1||entry.type!=='blob'||entry.mode!=='100644'||!oid(entry.sha)||!Number.isSafeInteger(entry.size)
            ||entry.size<0||entry.size>(path==='anchor.json'?1024:45*1024))return blocked('tree-mismatch');
        const blob=(await get(`${api}/git/blobs/${entry.sha}`)).data;
        if(blob?.size!==entry.size)return blocked('blob-mismatch');const result=decodeCheckpointGitBlob({expectedOid:entry.sha,blob});
        if(result.kind!=='decoded-blob')return blocked('blob-mismatch');decoded[path]=result.content;
      }
      const anchor=parseAnchor(decoded['anchor.json']);if(!anchor)return blocked('anchor-invalid');
      if(expectedPrivate&&verifyV3Registry(decoded['registry.json'],anchor,keyring).kind!=='v3-registry-verified')return blocked('registry-unverified');
      const last=await readRef(),after=await readRepo();
      if(last!==head||JSON.stringify(before)!==JSON.stringify(after)||!await scope())return blocked('observation-changed');
      return {kind:'v3-registry-branch-observed',role,head,treeOid:commit.tree.sha,anchor,
        ...(expectedPrivate?{content:decoded['registry.json']}:{})};
    }catch{return blocked('registry-read-unavailable');}
  };
}
