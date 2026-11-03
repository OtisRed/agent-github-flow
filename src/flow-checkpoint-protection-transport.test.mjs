import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckpointProtectionTransport,createV3RegistryProtectionTransport } from './flow-checkpoint-protection-transport.mjs';
import { readCheckpointProtectionAudit,readV3RegistryProtectionAudit } from './flow-checkpoint-protection-reader.mjs';
import { CHECKPOINT_BRANCH_REF as a, CHECKPOINT_ANCHOR_REF as b } from './flow-checkpoint-registration.mjs';
import { V3_REGISTRY_REF,V3_REGISTRY_ANCHOR_REF } from './flow-v3-registry-git-plan.mjs';

function fixture({wrongScope=false}={}) {
  const calls=[];
  const response=data => ({status:200,text:async()=>JSON.stringify(data),headers:{get:()=>null}});
  const request=async (url,options)=>{calls.push({url,options});
    if(url.endsWith('/installation/repositories')) return response({total_count:1,repositories:[{node_id:wrongScope?'wrong':'id',full_name:'owner/repo',private:true}]});
    return response({id:1});};
  const transport=createCheckpointProtectionTransport({owner:'owner',repo:'repo',repositoryId:'id',appToken:'secret-token',
    expectedSlug:'agent-flow',actualSlug:'agent-flow',updateRulesetId:1,historyRulesetId:2,request});
  return {calls,transport};
}
test('makes bounded read-only requests after verifying private App scope',async()=>{
  const f=fixture(); const result=await f.transport('https://api.github.com/repos/owner/repo/rulesets/1');
  assert.deepEqual(await result.json(),{id:1}); assert.equal(f.calls.length,2);
  for(const call of f.calls){assert.equal(call.options.method,'GET');assert.equal(call.options.redirect,'error');assert.equal(call.url.includes('secret-token'),false);}
  await f.transport('https://api.github.com/repos/owner/repo/rules/branches/agent-github-flow%2Fcheckpoints?per_page=100&page=1');
});
test('rejects unsafe endpoints, bad query and scope mismatch without target reads',async()=>{
  const f=fixture();
  for(const url of ['https://evil.invalid/repos/owner/repo','https://api.github.com/repos/owner/other',
    'https://api.github.com/repos/owner/repo/rulesets/3','https://api.github.com/repos/owner/repo?x=1',
    'https://api.github.com/repos/owner/repo/rules/branches/main?per_page=100&page=1',
    'https://api.github.com/repos/owner/repo/rules/branches/agent-github-flow%2Fcheckpoints?per_page=100&page=1&page=2',
    'https://api.github.com/repos/owner/repo/rules/branches/agent-github-flow%2Fcheckpoints?per_page=100&page=0']) {
    await assert.rejects(f.transport(url));
  }
  assert.equal(f.calls.length,0);
  const other=fixture({wrongScope:true}); await assert.rejects(other.transport('https://api.github.com/repos/owner/repo'));
  assert.equal(other.calls.length,1);
});
test('refuses paginated installation scope and malformed target response',async()=>{
  const make=mode=>createCheckpointProtectionTransport({owner:'owner',repo:'repo',repositoryId:'id',appToken:'secret-token',
    expectedSlug:'app',actualSlug:'app',updateRulesetId:1,historyRulesetId:2,request:async url=>{
      const install=url.endsWith('/installation/repositories');
      return {status:200,text:async()=>install?JSON.stringify({total_count:1,repositories:[{node_id:'id',full_name:'owner/repo',private:true}]}):'{',
        headers:{get:()=>install&&mode==='paginated'?'next':null}};}});
  await assert.rejects(make('paginated')('https://api.github.com/repos/owner/repo'));
  await assert.rejects(make('malformed')('https://api.github.com/repos/owner/repo'));
});
test('rejects untrusted App identity and missing or malformed tokens',()=>{
  for(const args of [{actualSlug:'wrong',appToken:'secret'},{actualSlug:'app',appToken:'bad\nsecret'},{actualSlug:'app',appToken:''}]) {
    assert.throws(()=>createCheckpointProtectionTransport({owner:'owner',repo:'repo',repositoryId:'id',expectedSlug:'app',
      updateRulesetId:1,historyRulesetId:2,...args}));
  }
});

test('a transport that can see bypasses can run the complete audit, blocking altered actors',async()=>{
  const common={target:'branch',source_type:'Repository',source:'owner/repo',enforcement:'active',
    conditions:{ref_name:{include:[a,b],exclude:[]}}};
  const repo={node_id:'id',full_name:'owner/repo',private:true,fork:false,default_branch:'main'};
  const update={...common,id:1,rules:[{type:'update'}],bypass_actors:[{actor_type:'Integration',actor_id:12,bypass_mode:'always'}]};
  const history={...structuredClone(common),id:2,rules:[{type:'deletion'},{type:'non_fast_forward'}],bypass_actors:[]};
  const rule=(type,id)=>({type,ruleset_id:id,ruleset_source_type:'Repository',ruleset_source:'owner/repo'});
  const rules=[rule('update',1),rule('deletion',2),rule('non_fast_forward',2)];
  const request=async url=>{const path=new URL(url).pathname;let data;
    if(path==='/installation/repositories')data={total_count:1,repositories:[repo]};else if(path==='/repos/owner/repo')data=repo;
    else if(path.endsWith('/rulesets/1'))data=update;else if(path.endsWith('/rulesets/2'))data=history;
    else if(path.includes('/rules/branches/'))data=rules;else throw Error('unexpected');
    return {status:200,text:async()=>JSON.stringify(data),headers:{get:()=>null}};};
  const transport=createCheckpointProtectionTransport({owner:'owner',repo:'repo',repositoryId:'id',appToken:'secret-token',
    expectedSlug:'agent-flow',actualSlug:'agent-flow',updateRulesetId:1,historyRulesetId:2,request});
  const input={owner:'owner',repo:'repo',repositoryId:'id',appId:12,updateRulesetId:1,historyRulesetId:2,expectedPrivate:true,request:transport};
  assert.equal((await readCheckpointProtectionAudit(input)).kind,'checkpoint-protection-observed');
  update.bypass_actors.push({actor_type:'User',actor_id:33,bypass_mode:'always'});
  assert.deepEqual(await readCheckpointProtectionAudit(input),{kind:'blocked',reason:'unexpected-bypass'});
});

test('bounds the combined audit data across pages and repeated observations',async()=>{
  let calls=0;const padding='x'.repeat(1024*1024);
  const request=async raw=>{calls++;const url=new URL(raw);let data,link=null;
    if(url.pathname.endsWith('/rulesets/1'))data={id:1};
    else if(url.pathname.endsWith('/rulesets/2'))data={id:2};
    else if(url.pathname.includes('/rules/branches/')){const page=Number(url.searchParams.get('page'));
      data=[{padding}];link=`<https://api.github.com${url.pathname}?per_page=100&page=${page+1}>; rel="next"`;}
    else data={node_id:'id',full_name:'owner/repo',private:true,fork:false,default_branch:'main'};
    return {status:200,json:async()=>data,headers:{get:()=>link}};};
  const result=await readCheckpointProtectionAudit({owner:'owner',repo:'repo',repositoryId:'id',appId:12,updateRulesetId:1,
    historyRulesetId:2,expectedPrivate:true,request});
  assert.deepEqual(result,{kind:'blocked',reason:'protection-read-unavailable'});assert.ok(calls<20);
});
test('v3 registry protection transport and reader audit only the role-specific ref',async()=>{
  for(const role of ['private','anchor']){const ref=role==='private'?V3_REGISTRY_REF:V3_REGISTRY_ANCHOR_REF,expectedPrivate=role==='private';
    const common={target:'branch',source_type:'Repository',source:'owner/repo',enforcement:'active',conditions:{ref_name:{include:[ref],exclude:[]}}};
    const repo={node_id:'id',full_name:'owner/repo',private:expectedPrivate,fork:false,default_branch:'main'};
    const update={...common,id:1,rules:[{type:'update'}],bypass_actors:[{actor_type:'Integration',actor_id:12,bypass_mode:'always'}]};
    const history={...structuredClone(common),id:2,rules:[{type:'deletion'},{type:'non_fast_forward'}],bypass_actors:[]};
    const rule=(type,id)=>({type,ruleset_id:id,ruleset_source_type:'Repository',ruleset_source:'owner/repo'}),calls=[];
    const request=async(url,options)=>{calls.push(url);assert.equal(options.method,'GET');const path=new URL(url).pathname;let data;
      if(path==='/installation/repositories')data={total_count:1,repositories:[repo]};else if(path==='/repos/owner/repo')data=repo;
      else if(path.endsWith('/rulesets/1'))data=update;else if(path.endsWith('/rulesets/2'))data=history;
      else if(path.includes('/rules/branches/'))data=[rule('update',1),rule('deletion',2),rule('non_fast_forward',2)];else throw Error('unexpected');
      return {status:200,text:async()=>JSON.stringify(data),headers:{get:()=>null}};};
    const transport=createV3RegistryProtectionTransport({role,repository:'owner/repo',repositoryId:'id',appToken:'synthetic-app',
      expectedSlug:'agent-flow',actualSlug:'agent-flow',updateRulesetId:1,historyRulesetId:2,request});
    const result=await readV3RegistryProtectionAudit({role,owner:'owner',repo:'repo',repositoryId:'id',appId:12,
      updateRulesetId:1,historyRulesetId:2,expectedPrivate,request:transport});
    assert.equal(result.kind,'v3-registry-protection-audit-observed');assert.equal(result.ref,ref);
    assert.ok(calls.filter(url=>url.includes('/rules/branches/')).every(url=>decodeURIComponent(new URL(url).pathname).endsWith(ref.slice(11))));
  }
});
