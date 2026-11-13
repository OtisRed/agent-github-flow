import {spawnSync} from 'node:child_process';
const SHA=/^[0-9a-f]{40}$/;

export function assessRepository(repo,expected) {
 if (!repo?.id || typeof repo.nameWithOwner!=='string' || repo.nameWithOwner.toLowerCase()!==`${expected.owner}/${expected.repo}`.toLowerCase() || typeof repo.isEmpty!=='boolean') return {state:'unverified',reason:'repository-read'};
 if (repo.isEmpty) return {state:'manual',reason:'infrastructure-commit-needed'};
 const base=repo.defaultBranchRef;
 if (!base?.name || !SHA.test(base.target?.oid??'')) return {state:'unverified',reason:'default-branch-read'};
 if (base.name==='smoke') return {state:'conflict',reason:'smoke-is-default'};
 if (repo.ref===null) return {state:'needs-create',repoId:repo.id,baseName:base.name,baseOid:base.target.oid};
 if (!SHA.test(repo.ref?.target?.oid??'')) return {state:'unverified',reason:'smoke-branch-read'};
 return {state:'ok',repoId:repo.id,baseName:base.name,smokeOid:repo.ref.target.oid};
}

export function ensureSmoke(client,identity,{apply=false}={}) {
 const first=assessRepository(client.read(),identity);
 if(first.state!=='needs-create' || !apply) return {...first,changed:false};
 const second=assessRepository(client.read(),identity);
 if(second.state!=='needs-create' || first.repoId!==second.repoId || first.baseName!==second.baseName || first.baseOid!==second.baseOid) return {state:'conflict',reason:'repository-changed-before-write',changed:false};
 const sent=client.create(first.repoId,first.baseOid);
 const raw=client.read(),after=assessRepository(raw,identity);
 if(after.state==='ok' && after.repoId===first.repoId && after.baseName===first.baseName && after.smokeOid===first.baseOid && raw.defaultBranchRef.target.oid===first.baseOid) return {state:'ok',changed:true,writeConfirmed:sent===true};
 return {state:'unverified',reason:sent?'branch-readback-mismatch':'branch-write-outcome-unknown',changed:null,writeAttempted:true};
}

function gh(args,input) {
 const result=spawnSync('gh',['api','graphql',...args],{input:input?JSON.stringify(input):undefined,encoding:'utf8',timeout:20000,maxBuffer:2*1024*1024,windowsHide:true,env:{...process.env,GH_PROMPT_DISABLED:'1',GH_NO_UPDATE_NOTIFIER:'1'}});
 if(result.error || result.status!==0)return null;
 try{const json=JSON.parse(result.stdout);return json.errors?.length?null:json.data;}catch{return null;}
}
export function githubRepositoryClient(identity) {
 const query='query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id nameWithOwner isEmpty defaultBranchRef{name target{oid}} ref(qualifiedName:"refs/heads/smoke"){target{oid}}}}';
 return {
  read(){return gh(['-f',`query=${query}`,'-f',`owner=${identity.owner}`,'-f',`name=${identity.repo}`])?.repository??null;},
  create(id,oid){return !!gh(['--input','-'],{query:'mutation($id:ID!,$oid:GitObjectID!){createRef(input:{repositoryId:$id,name:"refs/heads/smoke",oid:$oid}){ref{name}}}',variables:{id,oid}})?.createRef?.ref?.name;}
 };
}
