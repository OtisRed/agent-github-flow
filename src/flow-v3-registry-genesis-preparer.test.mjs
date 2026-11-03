import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCheckpointKeyring } from './flow-checkpoint-keyring.mjs';
import { createV3RegistryGenesisPreparer } from './flow-v3-registry-genesis-preparer.mjs';

const oid=c=>c.repeat(40),keyring=createCheckpointKeyring({currentKeyId:1,keys:[{id:1,key:Buffer.alloc(32,1)}]});
const gitBlob=text=>{const bytes=Buffer.from(text);return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');};
function fixture(role){
  const privateRepository='owner/private-state',anchorRepository='owner/public-flow',privateRepositoryId='private-id',anchorRepositoryId='public-id';
  const expectedPrivate=role==='private',repository=expectedPrivate?privateRepository:anchorRepository,repositoryId=expectedPrivate?privateRepositoryId:anchorRepositoryId;
  const state={calls:[],scopeWrong:false,treeWrong:false,commitUnknown:false,files:[]};
  const response=(data,status=200)=>({status,headers:{get:()=>null},text:async()=>JSON.stringify(data)});
  const request=async(url,options)=>{
    state.calls.push({url,method:options.method,body:options.body});assert.equal(options.headers.Authorization,'Bearer synthetic-token');
    const path=new URL(url).pathname,target={node_id:state.scopeWrong?'wrong':repositoryId,full_name:repository,private:expectedPrivate,fork:false,default_branch:'main'};
    if(path==='/installation/repositories')return response({total_count:1,repositories:[target]});
    if(path===`/repos/${repository}`)return response(target);
    if(path.endsWith('/git/trees')&&options.method==='POST'){state.files=JSON.parse(options.body).tree;return response({sha:oid('a')},201);}
    if(path.endsWith(`/git/trees/${oid('a')}`))return response({sha:oid('a'),truncated:false,tree:state.files.map((file,index)=>({path:file.path,mode:'100644',type:'blob',
      sha:state.treeWrong&&index===0?oid('c'):gitBlob(file.content)}))});
    if(path.endsWith('/git/commits')&&options.method==='POST'){if(state.commitUnknown)throw Error('unknown');
      assert.deepEqual(JSON.parse(options.body).parents,[]);return response({sha:oid('b')},201);}
    if(path.endsWith(`/git/commits/${oid('b')}`))return response({sha:oid('b'),tree:{sha:oid('a')},parents:[]});
    throw Error('unexpected-request');
  };
  const preparer=createV3RegistryGenesisPreparer({role,privateRepository,privateRepositoryId,anchorRepository,anchorRepositoryId,keyring,appToken:'synthetic-token',request});
  return {state,preparer};
}
test('prepares and independently reads root objects without touching refs or leaking private content to anchor',async()=>{
  for(const role of ['private','anchor']){
    const f=fixture(role),result=await f.preparer.prepare();assert.equal(result.kind,'v3-registry-genesis-objects-prepared');
    assert.equal(result.role,role);assert.equal(result.treeOid,oid('a'));assert.equal(result.genesisOid,oid('b'));
    assert.equal(f.state.calls.some(call=>call.url.includes('/git/ref')||call.url.endsWith('/graphql')),false);
    assert.deepEqual(f.state.files.map(file=>file.path),role==='private'?['registry.json','anchor.json']:['anchor.json']);
    if(role==='anchor')assert.ok(f.state.calls.filter(call=>call.body).every(call=>!call.body.includes('registry.json')&&!call.body.includes('private-state')));
    assert.equal((await f.preparer.prepare()).kind,'blocked');
  }
});
test('fails closed for changed scope, altered tree and ambiguous commit with no automatic retry',async()=>{
  let f=fixture('private');f.state.scopeWrong=true;assert.equal((await f.preparer.prepare()).kind,'blocked');
  assert.equal(f.state.calls.some(call=>call.method==='POST'),false);
  f=fixture('anchor');f.state.treeWrong=true;assert.equal((await f.preparer.prepare()).kind,'registry-genesis-preparation-uncertain');
  assert.equal(f.state.calls.some(call=>call.url.endsWith('/git/commits')),false);
  f=fixture('private');f.state.commitUnknown=true;assert.equal((await f.preparer.prepare()).kind,'registry-genesis-preparation-uncertain');
  assert.equal((await f.preparer.prepare()).kind,'blocked');assert.equal(f.state.calls.filter(call=>call.url.endsWith('/git/commits')).length,1);
});
