import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckpointProtectionTransport } from './flow-checkpoint-protection-transport.mjs';
import { readCheckpointProtectionAudit, readCheckpointVisibleProtection } from './flow-checkpoint-protection-reader.mjs';
import { createOwnerProtectionReceipt } from './flow-checkpoint-protection-receipt.mjs';
import { CHECKPOINT_BRANCH_REF as a, CHECKPOINT_ANCHOR_REF as b } from './flow-checkpoint-registration.mjs';

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

test('collector and scoped transport agree on exact URLs and fail on visible drift',async()=>{
  const common={target:'branch',source_type:'Repository',source:'owner/repo',enforcement:'active',updated_at:'2026-11-03T10:00:00Z',
    conditions:{ref_name:{include:[a,b],exclude:[]}}};
  const repo={node_id:'id',full_name:'owner/repo',private:true,fork:false,default_branch:'main'};
  const update={...common,id:1,rules:[{type:'update'}],bypass_actors:[{actor_type:'Integration',actor_id:12,bypass_mode:'always'}]};
  const history={...structuredClone(common),id:2,rules:[{type:'deletion'},{type:'non_fast_forward'}],bypass_actors:[]};
  const rule=(type,id)=>({type,ruleset_id:id,ruleset_source_type:'Repository',ruleset_source:'owner/repo'});
  const rules=[rule('update',1),rule('deletion',2),rule('non_fast_forward',2)];
  const receipt=createOwnerProtectionReceipt({auditInput:{repositoryId:'id',repository:'owner/repo',appId:12,expectedPrivate:true,
    repositoryData:repo,updateRuleset:update,historyRuleset:history,effective:[a,b].map(ref=>({ref,rules}))},
    observedAt:'2026-11-03T10:01:00Z',expiresAt:'2026-11-04T10:01:00Z'});
  delete update.bypass_actors; delete history.bypass_actors;
  const calls=[]; const request=async(url,options)=>{calls.push({url,options});const path=new URL(url).pathname;
    let data;if(path==='/installation/repositories')data={total_count:1,repositories:[repo]};
    else if(path==='/repos/owner/repo')data=repo;else if(path.endsWith('/rulesets/1'))data=update;
    else if(path.endsWith('/rulesets/2'))data=history;else if(path.includes('/rules/branches/'))data=rules;else throw Error('unexpected');
    return {status:200,text:async()=>JSON.stringify(data),headers:{get:()=>null}};};
  const transport=createCheckpointProtectionTransport({owner:'owner',repo:'repo',repositoryId:'id',appToken:'secret-token',
    expectedSlug:'agent-flow',actualSlug:'agent-flow',updateRulesetId:1,historyRulesetId:2,request});
  const input={owner:'owner',repo:'repo',repositoryId:'id',appId:12,updateRulesetId:1,historyRulesetId:2,expectedPrivate:true,
    request:transport,receipt,now:'2026-11-03T11:00:00Z',maxAgeMs:86400000};
  assert.equal((await readCheckpointVisibleProtection(input)).kind,'visible-profile-matches-owner-audit');
  assert.equal(calls.length,20);update.updated_at='2026-11-03T10:30:00Z';
  assert.deepEqual(await readCheckpointVisibleProtection(input),{kind:'blocked',reason:'visible-protection-drift'});
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
