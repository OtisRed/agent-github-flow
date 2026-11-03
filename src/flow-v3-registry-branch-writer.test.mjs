import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCheckpointKeyring } from './flow-checkpoint-keyring.mjs';
import { reserveV3Project,pinV3ProjectGenesis } from './flow-v3-registry.mjs';
import { createV3RegistryAnchor,sealV3RegistryTransition } from './flow-v3-registry-anchor.mjs';
import { createV3RegistryBranchWriter } from './flow-v3-registry-branch-writer.mjs';
import { V3_REGISTRY_REF,V3_REGISTRY_ANCHOR_REF } from './flow-v3-registry-git-plan.mjs';
import { createV3GenesisPinStep } from './flow-v3-genesis-pin-step.mjs';
import { createV3RegistryStoreAdapter } from './flow-v3-registry-store-adapter.mjs';
import { createV3RegistryGitReader } from './flow-v3-registry-git-reader.mjs';
import { createV3RegistryWriteGuard } from './flow-v3-registry-write-guard.mjs';
import { createV3RegistryProtectionTransport } from './flow-checkpoint-protection-transport.mjs';
import { readV3RegistryProtectionAudit } from './flow-checkpoint-protection-reader.mjs';

const oid=c=>c.repeat(40),reply=(value,status=200)=>({status,text:async()=>JSON.stringify(value),headers:{get:()=>null}});
const blob=text=>{const bytes=Buffer.from(text);return {text,bytes,sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')};};
function fixture(role){
  const keyring=createCheckpointKeyring({currentKeyId:1,keys:[{id:1,key:Buffer.alloc(32,1)}]});
  const intent={source:'a'.repeat(32),repository:'owner/private-project',repositoryId:'private-project-id',expectedPrivate:true,
    cutoverAt:'2026-01-01T10:00:00Z',appId:12,updateRulesetId:1,historyRulesetId:2};
  const oldContent=reserveV3Project({version:1,revision:1,entries:[]},intent).content,oldAnchor=createV3RegistryAnchor(JSON.parse(oldContent),keyring).anchor;
  const newContent=pinV3ProjectGenesis(JSON.parse(oldContent),intent.source,{genesisOid:oid('e'),treeOid:oid('f')}).content;
  const next=sealV3RegistryTransition({content:oldContent,anchor:oldAnchor,afterContent:newContent,keyring}),newAnchor=next.anchor;
  const isPrivate=role==='private',repository=isPrivate?'owner/private-state':'owner/public-flow',ref=isPrivate?V3_REGISTRY_REF:V3_REGISTRY_ANCHOR_REF;
  const repositoryId=isPrivate?'private-repo-id':'public-repo-id';
  const initial=isPrivate?{'registry.json':oldContent,'anchor.json':JSON.stringify(oldAnchor)}:{'anchor.json':JSON.stringify(oldAnchor)};
  const state={head:oid('a'),visibility:isPrivate,fork:false,calls:[],guardCalls:0,guardFailAt:0,mutationUnknown:false,
    files:{[oid('b')]:Object.fromEntries(Object.entries(initial).map(([path,text])=>[path,blob(text)]))},trees:{[oid('a')]:oid('b')}};
  const request=async(url,options)=>{state.calls.push({url,method:options.method,body:options.body});assert.equal(options.headers.Authorization,'Bearer synthetic-app');
    const path=new URL(url).pathname;
    if(path==='/installation/repositories')return reply({total_count:1,repositories:[{node_id:repositoryId,full_name:repository,private:state.visibility,fork:state.fork}]});
    if(path===`/repos/${repository}`)return reply({node_id:repositoryId,full_name:repository,private:state.visibility,fork:state.fork,default_branch:'main'});
    const common={target:'branch',source_type:'Repository',source:repository,enforcement:'active',conditions:{ref_name:{include:[ref],exclude:[]}}};
    if(path.endsWith('/rulesets/1'))return reply({...common,id:1,rules:[{type:'update'}],bypass_actors:[{actor_type:'Integration',actor_id:12,bypass_mode:'always'}]});
    if(path.endsWith('/rulesets/2'))return reply({...common,id:2,rules:[{type:'deletion'},{type:'non_fast_forward'}],bypass_actors:[]});
    if(path.includes('/rules/branches/'))return reply(['update','deletion','non_fast_forward'].map((type,index)=>({type,ruleset_id:index?2:1,
      ruleset_source_type:'Repository',ruleset_source:repository})));
    if(path.includes('/git/ref/'))return reply({ref,object:{type:'commit',sha:state.head}});
    if(path.includes('/git/commits/')&&options.method==='GET'){const sha=path.split('/').at(-1);return reply({sha,tree:{sha:state.trees[sha]},parents:sha===oid('d')?[{sha:oid('a')}]:[]});}
    if(path.includes('/git/trees/')&&options.method==='GET'){const sha=path.split('/').at(-1),files=state.files[sha];
      return reply({sha,truncated:false,tree:Object.entries(files).map(([p,b])=>({path:p,mode:'100644',type:'blob',sha:b.sha,size:b.bytes.length}))});}
    if(path.includes('/git/blobs/')){const sha=path.split('/').at(-1),all=Object.values(state.files).flatMap(files=>Object.values(files)),found=all.find(b=>b.sha===sha);
      return reply({sha,size:found.bytes.length,encoding:'base64',content:found.bytes.toString('base64')});}
    if(path.endsWith('/git/trees')&&options.method==='POST'){const body=JSON.parse(options.body);
      state.files[oid('c')]=Object.fromEntries(body.tree.map(entry=>[entry.path,blob(entry.content)]));return reply({sha:oid('c')},201);}
    if(path.endsWith('/git/commits')&&options.method==='POST'){state.trees[oid('d')]=oid('c');return reply({sha:oid('d')},201);}
    if(path==='/graphql'){state.head=oid('d');if(state.mutationUnknown)throw Error('unknown');return reply({data:{updateRefs:{__typename:'UpdateRefsPayload'}}});}
    throw Error('unexpected');};
  const verifyProtection=async proof=>{state.guardCalls++;if(state.guardCalls===state.guardFailAt)return {kind:'blocked'};
    return {kind:'v3-registry-protection-observed',...proof};};
  const writer=createV3RegistryBranchWriter({role,repository,repositoryId,appId:12,appToken:'synthetic-app',keyring,verifyProtection,request});
  return {state,writer,newContent,newAnchor,ref,keyring,intent,repository,repositoryId,request};
}
test('writes one scoped branch by exact CAS and confirms its complete state',async()=>{
  for(const role of ['private','anchor']){const f=fixture(role),result=await f.writer.write({expectedHead:oid('a'),content:f.newContent,anchor:f.newAnchor});
    assert.equal(result.kind,role==='private'?'registry-private-advanced':'registry-anchor-advanced');assert.equal(result.head,oid('d'));
    const mutation=f.state.calls.find(call=>call.url==='https://api.github.com/graphql');
    assert.deepEqual(JSON.parse(mutation.body).variables.input.refUpdates,[{name:f.ref,beforeOid:oid('a'),afterOid:oid('d'),force:false}]);
    if(role==='anchor')assert.ok(f.state.calls.filter(call=>call.method==='POST').every(call=>!call.body.includes('private-project')));
    assert.equal((await f.writer.write({expectedHead:oid('a'),content:f.newContent,anchor:f.newAnchor})).kind,'blocked');}
});
test('blocks forged content, stale head and lost protection before the ref mutation',async()=>{
  let f=fixture('private');assert.equal((await f.writer.write({expectedHead:oid('9'),content:f.newContent,anchor:f.newAnchor})).kind,'blocked');
  f=fixture('private');assert.equal((await f.writer.write({expectedHead:oid('a'),content:f.newContent,anchor:{...f.newAnchor,mac:'0'.repeat(64)}})).kind,'blocked');
  f=fixture('private');f.state.guardFailAt=2;assert.equal((await f.writer.write({expectedHead:oid('a'),content:f.newContent,anchor:f.newAnchor})).kind,'v3-registry-branch-write-uncertain');
  assert.equal(f.state.calls.some(call=>call.url==='https://api.github.com/graphql'),false);
});
test('an uncertain ref mutation is never retried even when the server changed the ref',async()=>{
  const f=fixture('anchor');f.state.mutationUnknown=true;
  assert.equal((await f.writer.write({expectedHead:oid('a'),content:f.newContent,anchor:f.newAnchor})).kind,'v3-registry-branch-write-uncertain');
  assert.equal((await f.writer.write({expectedHead:oid('a'),content:f.newContent,anchor:f.newAnchor})).kind,'blocked');
  assert.equal(f.state.calls.filter(call=>call.url==='https://api.github.com/graphql').length,1);
});
test('composes the real scoped readers and branch writers as a staged pin on modeled GitHub',async()=>{
  const priv=fixture('private'),pub=fixture('anchor');
  const store=createV3RegistryStoreAdapter({privateWriter:priv.writer,anchorWriter:pub.writer,keyring:priv.keyring,
    identities:{private:priv.writer.identity,anchor:pub.writer.identity}});
  const pin=createV3GenesisPinStep({keyring:priv.keyring,load:store.load,commit:store.commit});
  const result=await pin(priv.intent,{genesisOid:oid('e'),treeOid:oid('f')});assert.equal(result.kind,'v3-genesis-pinned');
  assert.equal(priv.state.calls.filter(call=>call.url==='https://api.github.com/graphql').length,1);
  assert.equal(pub.state.calls.filter(call=>call.url==='https://api.github.com/graphql').length,1);
  for(const [branch,ref] of [[priv,V3_REGISTRY_REF],[pub,V3_REGISTRY_ANCHOR_REF]]){
    const mutation=branch.state.calls.find(call=>call.url==='https://api.github.com/graphql');
    assert.deepEqual(JSON.parse(mutation.body).variables.input.refUpdates,[{name:ref,beforeOid:oid('a'),afterOid:oid('d'),force:false}]);
  }
  assert.ok(pub.state.calls.filter(call=>call.method==='POST').every(call=>!call.body.includes('private-project')));
  assert.equal((await store.load()).anchor.revision,3);
});
test('refuses a differently configured public repository before either write',()=>{
  const priv=fixture('private'),pub=fixture('anchor');
  assert.throws(()=>createV3RegistryStoreAdapter({privateWriter:priv.writer,anchorWriter:pub.writer,keyring:priv.keyring,
    identities:{private:priv.writer.identity,anchor:{...pub.writer.identity,repository:'owner/other-flow',repositoryId:'other-id'}}}),/identity-mismatch/);
  assert.equal(priv.state.calls.length+pub.state.calls.length,0);
});
test('partial staged update remains unavailable and cannot be retried',async()=>{
  const priv=fixture('private'),pub=fixture('anchor');pub.state.guardFailAt=1;
  const store=createV3RegistryStoreAdapter({privateWriter:priv.writer,anchorWriter:pub.writer,keyring:priv.keyring,
    identities:{private:priv.writer.identity,anchor:pub.writer.identity}});
  const before=await store.load(),input={expectedVersion:before.version,content:priv.newContent,anchor:priv.newAnchor};
  assert.equal((await store.commit(input)).kind,'v3-registry-write-uncertain');
  await assert.rejects(store.load());
  assert.equal((await store.commit(input)).kind,'blocked');
  assert.equal(priv.state.calls.filter(call=>call.url==='https://api.github.com/graphql').length,1);
  assert.equal(pub.state.calls.filter(call=>call.url==='https://api.github.com/graphql').length,0);
});
test('refuses a reader that reports a different repository after construction',async()=>{
  const priv=fixture('private'),pub=fixture('anchor');
  const badReader={...pub.writer,read:async()=>({...await pub.writer.read(),repositoryId:'other-id'})};
  const store=createV3RegistryStoreAdapter({privateWriter:priv.writer,anchorWriter:badReader,keyring:priv.keyring,
    identities:{private:priv.writer.identity,anchor:pub.writer.identity}});
  await assert.rejects(store.load());assert.equal(priv.state.calls.filter(call=>call.url==='https://api.github.com/graphql').length,0);
  assert.equal(pub.state.calls.filter(call=>call.url==='https://api.github.com/graphql').length,0);
});
test('an uncertain public CAS is never retried even when it actually completed',async()=>{
  const priv=fixture('private'),pub=fixture('anchor');pub.state.mutationUnknown=true;
  const store=createV3RegistryStoreAdapter({privateWriter:priv.writer,anchorWriter:pub.writer,keyring:priv.keyring,
    identities:{private:priv.writer.identity,anchor:pub.writer.identity}});
  const before=await store.load(),input={expectedVersion:before.version,content:priv.newContent,anchor:priv.newAnchor};
  assert.equal((await store.commit(input)).kind,'v3-registry-write-uncertain');
  assert.equal((await store.load()).anchor.revision,3); // A later coherent observation is not an automatic retry.
  assert.equal((await store.commit(input)).kind,'blocked');
  for(const f of [priv,pub])assert.equal(f.state.calls.filter(call=>call.url==='https://api.github.com/graphql').length,1);
});
test('branch writer requires a fresh real reader and ruleset audit before and after CAS',async()=>{
  const f=fixture('private'),role='private',repositoryId=f.repositoryId,appId=12;
  const readBranch=createV3RegistryGitReader({role,repository:f.repository,repositoryId,appToken:'synthetic-app',keyring:f.keyring,request:f.request});
  const transport=createV3RegistryProtectionTransport({role,repository:f.repository,repositoryId,appToken:'synthetic-app',
    expectedSlug:'agent-flow',actualSlug:'agent-flow',updateRulesetId:1,historyRulesetId:2,request:f.request});
  const [owner,repo]=f.repository.split('/');
  const readProtection=()=>readV3RegistryProtectionAudit({role,owner,repo,repositoryId,appId,updateRulesetId:1,historyRulesetId:2,
    expectedPrivate:true,request:transport});
  const genesisOid=oid('e'),verifyLineage=async({expectedHeadOid})=>({kind:'v3-registry-lineage-observed',role,repositoryId,
    ref:V3_REGISTRY_REF,genesisOid,headOid:expectedHeadOid,rollbackProtected:false});
  const verifyProtection=createV3RegistryWriteGuard({role,repositoryId,appId,registryGenesisOid:genesisOid,updateRulesetId:1,historyRulesetId:2,readBranch,readProtection,verifyLineage});
  const writer=createV3RegistryBranchWriter({role,repository:f.repository,repositoryId,appId,appToken:'synthetic-app',
    keyring:f.keyring,verifyProtection,request:f.request});
  assert.equal((await writer.write({expectedHead:oid('a'),content:f.newContent,anchor:f.newAnchor})).kind,'registry-private-advanced');
  assert.equal(f.state.calls.filter(call=>call.url==='https://api.github.com/graphql').length,1);
  assert.ok(f.state.calls.filter(call=>call.url.includes('/rulesets/1')).length>=6);
});
