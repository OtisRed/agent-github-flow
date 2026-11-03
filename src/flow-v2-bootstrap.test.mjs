import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyV2Bootstrap, createV2BootstrapVerifier } from './flow-v2-bootstrap.mjs';

const blob = text => { const bytes=Buffer.from(text);const sha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  return {sha,size:bytes.length,encoding:'base64',content:bytes.toString('base64')}; };
function fixture(){
  const registration={repositoryId:'repo',ref:'refs/heads/agent-github-flow/checkpoints',genesisOid:'a'.repeat(40),
    cutoverAt:'2026-01-01T10:00:00Z',checkpointSchemaVersion:2};
  const marker=blob(JSON.stringify({version:2,repositoryId:'repo',cutoverAt:registration.cutoverAt}));
  const index=blob(JSON.stringify({version:1,repositoryId:'repo',issues:[]}));
  const root='b'.repeat(40),headRoot='d'.repeat(40),state={head:registration.genesisOid,marker,index,headMarker:null,extra:[],refReads:0,genesisParents:[]};
  const entry=(path,value)=>({path,type:'blob',mode:'100644',sha:value.sha,size:value.size});
  const args={registration,readRepository:async()=>({node_id:'repo',full_name:'owner/project',default_branch:'main'}),
    readRef:async ref=>{state.refReads++;return {ref,object:{type:'commit',sha:state.head}};},
    compare:async()=>({status:state.head===registration.genesisOid?'identical':'ahead',ahead_by:state.head===registration.genesisOid?0:1,behind_by:0,
      base_commit:{sha:registration.genesisOid},merge_base_commit:{sha:registration.genesisOid},commits:state.head===registration.genesisOid?[]:[{sha:state.head}]}),
    readCommit:async sha=>({sha,tree:{sha:sha===registration.genesisOid?root:headRoot},parents:sha===registration.genesisOid?state.genesisParents:[{sha:registration.genesisOid}]}),
    readTree:async sha=>({sha,truncated:false,tree:[entry('index.json',state.index),
      entry('checkpoint-schema.json',sha===headRoot&&state.headMarker?state.headMarker:state.marker),...state.extra]}),
    readBlob:async sha=>[state.marker,state.index].find(value=>value.sha===sha)};
  return {args,state,registration};
}

test('observes an empty v2 genesis and the same immutable marker at current head',async()=>{
  const f=fixture(),result=await verifyV2Bootstrap(f.args);
  assert.equal(result.kind,'v2-bootstrap-verified');assert.deepEqual(result.registration,f.registration);assert.notEqual(result.registration,f.registration);
  assert.ok(f.state.refReads>=8);
});
test('blocks legacy registration, malformed or changed marker, nonempty genesis and unstable refs',async()=>{
  let f=fixture();f.registration.checkpointSchemaVersion=1;assert.equal((await verifyV2Bootstrap(f.args)).kind,'blocked');
  f=fixture();f.state.marker=blob(JSON.stringify({version:1,repositoryId:'repo',cutoverAt:f.registration.cutoverAt}));assert.equal((await verifyV2Bootstrap(f.args)).kind,'blocked');
  f=fixture();f.state.marker=blob(JSON.stringify({version:2,repositoryId:'other',cutoverAt:f.registration.cutoverAt}));assert.equal((await verifyV2Bootstrap(f.args)).kind,'blocked');
  f=fixture();f.state.extra.push({path:'unrelated',type:'blob',mode:'100644',sha:'c'.repeat(40),size:0});assert.equal((await verifyV2Bootstrap(f.args)).kind,'blocked');
  f=fixture();f.state.index=blob(JSON.stringify({version:1,repositoryId:'repo',issues:[{number:1,issueId:'issue'}]}));
  assert.equal((await verifyV2Bootstrap(f.args)).kind,'blocked');
  f=fixture();f.state.head='c'.repeat(40);f.state.headMarker=blob('changed');
  assert.equal((await verifyV2Bootstrap(f.args)).reason,'marker-changed');
  f=fixture();f.state.genesisParents=[{sha:'8'.repeat(40)}];assert.equal((await verifyV2Bootstrap(f.args)).kind,'blocked');
  f=fixture();const original=f.args.readRef;f.args.readRef=async ref=>{const value=await original(ref);if(f.state.refReads>4)value.object.sha='9'.repeat(40);return value;};
  assert.equal((await verifyV2Bootstrap(f.args)).kind,'blocked');
});

test('accepts a descendant head when it retains the registered genesis marker',async()=>{
  const f=fixture();f.state.head='c'.repeat(40);
  assert.equal((await verifyV2Bootstrap(f.args)).kind,'v2-bootstrap-verified');
});

test('cannot swap a marker by mutating a previously returned tree during blob read',async()=>{
  const f=fixture(),valid=f.state.marker;f.state.marker=blob('different');
  const readTree=f.args.readTree,readBlob=f.args.readBlob;let lastTree;
  f.args.readTree=async(...args)=>{lastTree=await readTree(...args);return lastTree;};
  f.args.readBlob=async sha=>{if(sha===f.state.marker.sha){const entry=lastTree.tree.find(x=>x.path==='checkpoint-schema.json');
    entry.sha=valid.sha;entry.size=valid.size;f.state.marker=valid;return valid;}return readBlob(sha);};
  assert.equal((await verifyV2Bootstrap(f.args)).kind,'blocked');
});

test('cycle adapter verifies only the exact independently supplied registration',async()=>{
  const f=fixture(),verify=createV2BootstrapVerifier(f.args);
  assert.equal((await verify(f.registration)).kind,'v2-bootstrap-verified');
  const other={...f.registration,cutoverAt:'2025-01-01T00:00:00Z'},reads=f.state.refReads;
  assert.equal((await verify(other)).kind,'blocked');assert.equal(f.state.refReads,reads);
});
