import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createV2GenesisPreparer } from './flow-v2-genesis-preparer.mjs';
import { planV2Genesis } from './flow-v2-genesis-plan.mjs';
import { createV3GenesisPreparer } from './flow-v3-genesis-preparer.mjs';
import { planV3Genesis } from './flow-v3-genesis-plan.mjs';

const oid=c=>c.repeat(40),reply=(data,status=200)=>({status,text:async()=>JSON.stringify(data)});
const hash=contents=>{const bytes=Buffer.from(contents,'base64');return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');};
function fixture(version=2,expectedPrivate=true){
  const plan=(version===3?planV3Genesis:planV2Genesis)({repositoryId:'repo-id',cutoverAt:'2026-01-01T10:00:00Z'}),calls=[];
  const state={private:expectedPrivate,fork:false,extra:false,parents:[],failCommit:false};
  const request=async(url,options)=>{calls.push({url,method:options.method,body:options.body});
    assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer synthetic-app-token');
    if(url.endsWith('/installation/repositories'))return reply({total_count:1,repositories:[{node_id:'repo-id',full_name:'owner/project',private:state.private,fork:state.fork}]});
    if(url.endsWith('/git/trees')&&options.method==='POST')return reply({sha:oid('a')},201);
    if(url.endsWith(`/git/trees/${oid('a')}?recursive=1`))return reply({sha:oid('a'),truncated:false,tree:[...plan.files.map(file=>({path:file.path,type:'blob',mode:'100644',sha:hash(file.contents)})),
      ...(state.extra?[{path:'extra',type:'blob',mode:'100644',sha:oid('e')}]:[])]});
    if(url.endsWith('/git/commits')&&options.method==='POST'){if(state.failCommit)throw Error('private error');return reply({sha:oid('b')},201);}
    if(url.endsWith(`/git/commits/${oid('b')}`))return reply({sha:oid('b'),tree:{sha:oid('a')},parents:state.parents});
    throw Error('unexpected url');};
  const build=()=>version===3?createV3GenesisPreparer({setupIntent:{repository:'owner/project',repositoryId:'repo-id',expectedPrivate,
    cutoverAt:'2026-01-01T10:00:00Z'},appToken:'synthetic-app-token',request})
    :createV2GenesisPreparer({owner:'owner',repo:'project',repositoryId:'repo-id',cutoverAt:'2026-01-01T10:00:00Z',appToken:'synthetic-app-token',request});
  return {plan,calls,state,build};
}
test('prepares and verifies only the root tree and commit without touching refs',async()=>{
  const f=fixture(),preparer=f.build(),result=await preparer.prepare();
  assert.equal(result.kind,'v2-genesis-objects-prepared');assert.equal(result.genesisOid,oid('b'));
  const writes=f.calls.filter(call=>call.method==='POST');assert.equal(writes.length,2);
  assert.deepEqual(JSON.parse(writes[1].body).parents,[]);
  assert.deepEqual(JSON.parse(writes[0].body).tree.map(entry=>entry.path),f.plan.files.map(entry=>entry.path));
  assert.equal(f.calls.some(call=>call.url.includes('/git/refs')),false);
  assert.deepEqual(await preparer.prepare(),{kind:'blocked',reason:'preparer-already-used'});
});
test('prepares the same safe v3 genesis for exact public and private scoped repos',async()=>{
  for(const expectedPrivate of [false,true]){const f=fixture(3,expectedPrivate),result=await f.build().prepare();
    assert.equal(result.kind,'v3-genesis-objects-prepared');const writes=f.calls.filter(call=>call.method==='POST');assert.equal(writes.length,2);
    const tree=JSON.parse(writes[0].body).tree;assert.deepEqual(tree.map(entry=>entry.path),['checkpoint-schema.json','index.json']);
    assert.equal(JSON.parse(tree[0].content).version,3);assert.deepEqual(JSON.parse(writes[1].body).parents,[]);
    assert.equal(f.calls.some(call=>call.url.includes('/git/refs')),false);
  }
});
test('v3 genesis refuses a changed scope, fork or malformed setup intent',async()=>{
  let f=fixture(3,false);f.state.private=true;assert.equal((await f.build().prepare()).kind,'blocked');assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
  f=fixture(3,false);f.state.fork=true;assert.equal((await f.build().prepare()).kind,'blocked');assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
  assert.throws(()=>createV3GenesisPreparer({setupIntent:{repository:'owner/project',repositoryId:'repo-id',expectedPrivate:false,
    cutoverAt:'2026-01-01T10:00:00Z',extra:'private'},appToken:'synthetic'}));
});
test('blocks public scope and unexpected trees before creating a commit',async()=>{
  let f=fixture();f.state.private=false;assert.equal((await f.build().prepare()).kind,'blocked');assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
  f=fixture();f.state.extra=true;assert.equal((await f.build().prepare()).kind,'genesis-preparation-uncertain');
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
test('does not retry an uncertain commit or accept a non-root result',async()=>{
  let f=fixture();f.state.failCommit=true;const p=f.build();assert.equal((await p.prepare()).kind,'genesis-preparation-uncertain');
  assert.equal((await p.prepare()).reason,'preparer-already-used');
  f=fixture();f.state.parents=[{sha:oid('c')}];assert.equal((await f.build().prepare()).kind,'genesis-preparation-uncertain');
});
