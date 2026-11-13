import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepare} from '../scripts/onboard.mjs';

const success=['repository','remote-identity','github-live','explicit-project','github-project'];
const report=()=>({checks:success.map(id=>({id,state:'ok'})),inventory:{githubRepository:{owner:'owner',repo:'repo'}}});
test('orchestrates an explicitly identified repo and Project without claiming remaining work is done',()=>{
 let options;let t=100;
 const result=prepare({repo:'repo',project:'user:owner/10',apply:true,initializeEmpty:true},{diagnostic:report,makeClient:()=>({}),makeRepoClient:()=>({}),branch:()=>({state:'ok',changed:false}),board:(_c,o)=>(options=o,{state:'ok',changed:false,number:1}),now:()=>t+=10});
 assert.deepEqual(options,{apply:true,initializeEmpty:true});assert.equal(result.ready,false);assert.equal(result.state,'partial');assert.equal(result.firstView.state,'ok');assert.ok(result.remaining.includes('controller-enrollment-and-promotion'));assert.equal(result.durationMs,10);
});
test('will not touch the view if repository or Project identification is conflicting or unverified',()=>{
 for(const failed of success){let called=false;const result=prepare({repo:'repo',project:'user:owner/10',apply:true},{diagnostic:()=>({...report(),checks:report().checks.map(c=>c.id===failed?{...c,state:'unverified'}:c)}),board:()=>{called=true;},branch:()=>{called=true;}});assert.equal(result.firstView.state,'blocked');assert.ok(result.diagnostic.blockers.includes(failed));assert.equal(called,false);}
});
test('rejects malformed and missing project identities before diagnosis',()=>{
 let called=false;assert.throws(()=>prepare({repo:'repo',project:'https://example.com'},{diagnostic:()=>{called=true;}}));assert.equal(called,false);
});
test('an uncertain branch mutation stops before the Project view is touched',()=>{
 let called=false;const result=prepare({repo:'repo',project:'user:owner/10',apply:true},{diagnostic:report,makeRepoClient:()=>({}),branch:()=>({state:'unverified',reason:'branch-write-outcome-unknown'}),board:()=>{called=true;}});
 assert.equal(result.firstView.reason,'branch-outcome-unverified');assert.equal(called,false);
});
test('a project check does not create a missing smoke branch without its explicit setup flag',()=>{
 let branchOptions;prepare({repo:'repo',project:'user:owner/10',apply:true},{diagnostic:report,makeRepoClient:()=>({}),branch:(_c,_i,o)=>(branchOptions=o,{state:'needs-create'}),makeClient:()=>({}),board:()=>({state:'ok'})});assert.deepEqual(branchOptions,{apply:false});
});
