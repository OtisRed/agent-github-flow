import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCheckpointKeyring } from './flow-checkpoint-keyring.mjs';
import { reserveV3Project } from './flow-v3-registry.mjs';
import { createV3RegistryAnchor } from './flow-v3-registry-anchor.mjs';
import { createV3RegistryGitReader } from './flow-v3-registry-git-reader.mjs';
import { V3_REGISTRY_REF,V3_REGISTRY_ANCHOR_REF } from './flow-v3-registry-git-plan.mjs';

const oid=c=>c.repeat(40),reply=data=>({status:200,text:async()=>JSON.stringify(data),headers:{get:()=>null}});
function fixture(role){
  const keyring=createCheckpointKeyring({currentKeyId:1,keys:[{id:1,key:Buffer.alloc(32,1)}]});
  const intent={source:'a'.repeat(32),repository:'owner/private-project',repositoryId:'private-id',expectedPrivate:true,
    cutoverAt:'2026-01-01T10:00:00Z',appId:12,updateRulesetId:1,historyRulesetId:2};
  const content=reserveV3Project({version:1,revision:1,entries:[]},intent).content,anchor=createV3RegistryAnchor(JSON.parse(content),keyring).anchor;
  const encode=(path,text)=>{const bytes=Buffer.from(text);return {path,text,bytes,sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')};};
  const files=role==='private'?[encode('registry.json',content),encode('anchor.json',JSON.stringify(anchor))]:[encode('anchor.json',JSON.stringify(anchor))];
  const privateRepo=role==='private',ref=privateRepo?V3_REGISTRY_REF:V3_REGISTRY_ANCHOR_REF;
  const state={head:oid('a'),private:privateRepo,fork:false,extra:false,calls:[],refReads:0,change:false};
  const request=async(url,options)=>{state.calls.push({url,method:options.method});assert.equal(options.headers.Authorization,'Bearer synthetic-app');
    const path=new URL(url).pathname;
    if(path==='/installation/repositories')return reply({total_count:1,repositories:[{node_id:'store-id',full_name:'owner/store',private:state.private,fork:state.fork}]});
    if(path==='/repos/owner/store')return reply({node_id:'store-id',full_name:'owner/store',private:state.private,fork:state.fork,default_branch:'main'});
    if(path.includes('/git/ref/')){state.refReads++;if(state.change&&state.refReads>1)state.head=oid('d');return reply({ref,object:{type:'commit',sha:state.head}});}
    if(path===`/repos/owner/store/git/commits/${oid('a')}`)return reply({sha:oid('a'),tree:{sha:oid('b')}});
    if(path===`/repos/owner/store/git/trees/${oid('b')}`)return reply({sha:oid('b'),truncated:false,tree:[...files.map(f=>({path:f.path,type:'blob',mode:'100644',sha:f.sha,size:f.bytes.length})),
      ...(state.extra?[{path:'extra',type:'blob',mode:'100644',sha:oid('e'),size:1}]:[])]});
    const file=files.find(f=>path===`/repos/owner/store/git/blobs/${f.sha}`);
    if(file)return reply({sha:file.sha,size:file.bytes.length,encoding:'base64',content:file.bytes.toString('base64')});
    throw Error('unexpected');};
  const read=createV3RegistryGitReader({role,repository:'owner/store',repositoryId:'store-id',appToken:'synthetic-app',keyring,request});
  return {read,state,content,anchor};
}
test('reads exact private registry and public anchor with scoped App GET requests',async()=>{
  for(const role of ['private','anchor']){const f=fixture(role),result=await f.read();assert.equal(result.kind,'v3-registry-branch-observed');
    assert.deepEqual(result.anchor,f.anchor);if(role==='private')assert.equal(result.content,f.content);else assert.equal(Object.hasOwn(result,'content'),false);
    assert.ok(f.state.calls.every(call=>call.method==='GET'));}
});
test('blocks changed visibility, fork, extra files and moving refs',async()=>{
  for(const mutate of [s=>{s.private=false;},s=>{s.fork=true;},s=>{s.extra=true;},s=>{s.change=true;}]){
    const f=fixture('private');mutate(f.state);assert.equal((await f.read()).kind,'blocked');}
});
