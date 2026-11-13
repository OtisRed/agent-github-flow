import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assess,ensureBoard,parseProject,STATES} from '../scripts/project-board.mjs';

const clone=value=>structuredClone(value);
function project(layout='TABLE_LAYOUT',group=[]) {
 return {id:'project',closed:false,items:{totalCount:0},fields:{nodes:[{__typename:'ProjectV2SingleSelectField',id:'status',name:'Status',options:STATES.map(name=>({name}))}],pageInfo:{hasNextPage:false}},views:{nodes:[{id:'first',number:1,name:'View 1',filter:'is:open',layout,verticalGroupByFields:{nodes:group,pageInfo:{hasNextPage:false}}}]}};
}
function fake(initial, behavior={}) {
 let value=clone(initial),writes=0,reads=0;
 return {read(){reads++; if(behavior.read) return behavior.read(reads,value); return clone(value);},setStatus(id,options){writes++;assert.equal(id,'status');if(behavior.statusWrite!==false)value.fields.nodes[0].options=clone(options);return behavior.statusReply!==false;},setLayout(id){writes++; assert.equal(id,'first'); if(behavior.write!==false){value.views.nodes[0].layout='BOARD_LAYOUT';value.views.nodes[0].verticalGroupByFields.nodes=[{id:'status',name:'Status'}];}return behavior.reply!==false;},createView(id){writes++;assert.equal(id,'project');value.views.nodes=[project('BOARD_LAYOUT',[{id:'status'}]).views.nodes[0]];return true;},get writes(){return writes;},get value(){return value;}};
}
test('parse only exact, supported project identities',()=>{
 assert.deepEqual(parseProject('user:OtisRed/10'),{kind:'user',login:'OtisRed',number:10});
 for(const invalid of ['user:owner/0','https://github.com/x','user:a/1;bad','organization:a/999999999999999999999']) assert.equal(parseProject(invalid),null);
});
test('recognises an existing Status kanban without a write',()=>{
 const c=fake(project('BOARD_LAYOUT',[{id:'status'}]));assert.equal(ensureBoard(c,{apply:true}).state,'ok');assert.equal(c.writes,0);
});
test('plan is read-only; apply changes only the first layout and preserves filter',()=>{
 const c=fake(project());assert.equal(ensureBoard(c).state,'needs-layout');assert.equal(c.writes,0);
 assert.deepEqual(ensureBoard(c,{apply:true}),{state:'ok',changed:true,writeConfirmed:true,number:1});assert.equal(c.value.views.nodes[0].filter,'is:open');
});
test('missing, reordered, or extra statuses never change an existing field',()=>{
 for(const opts of [STATES.slice(1),[...STATES].reverse(),[...STATES,'other']]){const p=project();p.fields.nodes[0].options=opts.map(name=>({name}));const c=fake(p);assert.equal(ensureBoard(c,{apply:true}).state,'conflict');assert.equal(c.writes,0);}
});
test('partial reads and wrong board grouping do not claim success or overwrite view',()=>{
 const p=project();p.fields.pageInfo.hasNextPage=true;assert.equal(assess(p).state,'unverified');
 const c=fake(project('BOARD_LAYOUT',[{id:'other'}]));assert.equal(ensureBoard(c,{apply:true}).reason,'board-group');assert.equal(c.writes,0);
});
test('a changed view between reads stops the write',()=>{
 const p=project();const c=fake(p,{read(n,v){const out=clone(v);if(n===2)out.views.nodes[0].filter='changed';return out;}});assert.equal(ensureBoard(c,{apply:true}).reason,'changed-before-write');assert.equal(c.writes,0);
});
test('lost response is resolved only by reading back; never retries the mutation',()=>{
 const success=fake(project(),{reply:false});assert.deepEqual(ensureBoard(success,{apply:true}),{state:'ok',changed:true,writeConfirmed:false,number:1});assert.equal(success.writes,1);
 const unknown=fake(project(),{reply:false,write:false});assert.equal(ensureBoard(unknown,{apply:true}).reason,'write-outcome-unknown');assert.equal(unknown.writes,1);
});
test('creates the first view only after two reads confirm no view',()=>{
 const p=project();p.views.nodes=[];const c=fake(p);assert.equal(ensureBoard(c,{apply:true}).state,'ok');assert.equal(c.writes,1);
});
test('initialises an explicitly selected empty project while retaining default option IDs',()=>{
 const p=project();p.fields.nodes[0].options=['Todo','In Progress','Done'].map((name,index)=>({id:`old-${index}`,name}));
 const c=fake(p);assert.equal(ensureBoard(c,{apply:true}).state,'needs-status');assert.equal(c.writes,0);
 const result=ensureBoard(c,{apply:true,initializeEmpty:true});assert.equal(result.state,'ok');assert.equal(result.statusInitialized,true);assert.equal(c.writes,2);
 const opts=c.value.fields.nodes[0].options;assert.deepEqual(opts.map(o=>o.name),STATES);assert.equal(opts.find(o=>o.name==='needs-design').id,'old-0');assert.equal(opts.find(o=>o.name==='agent-ready').id,'old-1');assert.equal(opts.find(o=>o.name==='done').id,'old-2');
});
test('never initialises default statuses on projects with active or archived items or unknown item count',()=>{
 for(const total of [1,null,undefined]){const p=project();p.items={totalCount:total};p.fields.nodes[0].options=['Todo','In Progress','Done'].map((name,index)=>({id:`old-${index}`,name}));const c=fake(p);assert.equal(ensureBoard(c,{apply:true,initializeEmpty:true}).state,'conflict');assert.equal(c.writes,0);}
});
test('uncertain status write is not repeated or followed by layout write without readback',()=>{
 const p=project();p.fields.nodes[0].options=['Todo','In Progress','Done'].map((name,index)=>({id:`old-${index}`,name}));const c=fake(p,{statusWrite:false,statusReply:false});assert.equal(ensureBoard(c,{apply:true,initializeEmpty:true}).reason,'status-write-outcome-unknown');assert.equal(c.writes,1);
});
