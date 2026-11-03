import test from 'node:test';
import assert from 'node:assert/strict';
import { createV2GenesisRefTransport } from './flow-v2-genesis-ref-transport.mjs';
import { CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';

const oid=c=>c.repeat(40),reply=(data,status=200)=>({status,text:async()=>JSON.stringify(data)});
function fixture(){
  const calls=[],state={existing:false,uncertain:false,private:true,nullResponse:false,scopeReads:0,refReads:0,scopeChanges:false,lateRef:false,graphqlMode:'ok'};
  const request=async(url,options)=>{calls.push({url,method:options.method,body:options.body});assert.equal(options.redirect,'error');
    assert.equal(options.headers.Authorization,'Bearer synthetic-app-token');
    if(url.endsWith('/installation/repositories')){state.scopeReads++;return reply({total_count:1,repositories:[{node_id:'repo-id',full_name:'owner/project',private:state.private&&!(state.scopeChanges&&state.scopeReads>1)}]});}
    if(url.endsWith('/repos/owner/project'))return reply({node_id:'repo-id',full_name:'owner/project',private:state.private,default_branch:'main'});
    if(url.includes('/git/ref/heads/agent-github-flow/')){state.refReads++;return state.nullResponse?reply(null):state.existing||(state.lateRef&&state.refReads>2)?reply({ref:CHECKPOINT_BRANCH_REF}):reply({},404);}
    if(url.endsWith(`/git/commits/${oid('b')}`))return reply({sha:oid('b'),tree:{sha:oid('a')},parents:[]});
    if(url.endsWith('/graphql')){if(state.uncertain)throw Error('private transport failure');
      if(state.graphqlMode==='errors')return reply({errors:[{message:'private'}]});
      if(state.graphqlMode==='wrong')return reply({data:{updateRefs:{__typename:'other'}}});
      if(state.graphqlMode==='invalid')return {status:200,text:async()=>'{'};
      return reply({data:{updateRefs:{__typename:'UpdateRefsPayload'}}});}
    throw Error('unexpected url');};
  const build=()=>createV2GenesisRefTransport({owner:'owner',repo:'project',repositoryId:'repo-id',genesisOid:oid('b'),
    treeOid:oid('a'),appToken:'synthetic-app-token',request});return{calls,state,build};
}
test('attempts one atomic creation of exactly two absent checkpoint refs',async()=>{
  const f=fixture(),transport=f.build(),result=await transport.publish();assert.equal(result.kind,'ref-update-acknowledged');
  const writes=f.calls.filter(call=>call.method==='POST');assert.equal(writes.length,1);
  const input=JSON.parse(writes[0].body).variables.input;
  assert.deepEqual(input.refUpdates,[CHECKPOINT_BRANCH_REF,CHECKPOINT_ANCHOR_REF].map(name=>({name,beforeOid:'0'.repeat(40),afterOid:oid('b'),force:false})));
  assert.equal((await transport.publish()).reason,'ref-transport-already-used');
});

test('blocks a ref or scope change on the final preflight before mutation',async()=>{
  for(const change of ['lateRef','scopeChanges']){const f=fixture();f.state[change]=true;
    assert.equal((await f.build().publish()).kind,'blocked');assert.equal(f.calls.filter(c=>c.method==='POST').length,0);}
});

test('treats all malformed or rejected mutation responses as uncertain without retry',async()=>{
  for(const mode of ['errors','wrong','invalid']){const f=fixture();f.state.graphqlMode=mode;const transport=f.build();
    assert.equal((await transport.publish()).kind,'ref-update-uncertain');assert.equal((await transport.publish()).reason,'ref-transport-already-used');
    assert.equal(f.calls.filter(c=>c.method==='POST').length,1);}
});
test('blocks existing refs, wrong scope or uncertain mutation without retry',async()=>{
  let f=fixture();f.state.existing=true;assert.equal((await f.build().publish()).kind,'blocked');assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
  f=fixture();f.state.nullResponse=true;assert.equal((await f.build().publish()).kind,'blocked');assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
  f=fixture();f.state.private=false;assert.equal((await f.build().publish()).kind,'blocked');assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
  f=fixture();f.state.uncertain=true;const transport=f.build();assert.equal((await transport.publish()).kind,'ref-update-uncertain');
  assert.equal((await transport.publish()).reason,'ref-transport-already-used');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
