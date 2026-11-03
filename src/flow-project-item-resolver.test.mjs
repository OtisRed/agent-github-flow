import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveProjectIssueItem} from './flow-project-item-resolver.mjs';

const card=(nodeId,contentNodeId='issue',archived=false,contentType='Issue')=>({nodeId,contentNodeId,archived,contentType});
function fixture(){const calls=[];const pages={first:{items:[card('other','other')],nextCursor:'next'},
  next:{items:[card('item'),card('archived','issue',true)],nextCursor:null}};
  return {calls,pages,input:{owner:'owner',projectNumber:1,issueId:'issue',listItems:async x=>{calls.push(x);return structuredClone(pages[x.after??'first']);}}};}
test('finds one active issue card across all pages and rereads the same pages',async()=>{
  const f=fixture();assert.deepEqual(await resolveProjectIssueItem(f.input),{kind:'project-item-observed',issueId:'issue',itemId:'item'});
  assert.deepEqual(f.calls.map(x=>x.after),[null,'next',null,'next']);
});
test('blocks missing or multiple active matching cards and duplicate item IDs',async()=>{
  let f=fixture();f.pages.next.items[0].contentNodeId='different';assert.equal((await resolveProjectIssueItem(f.input)).reason,'ambiguous-card');
  f=fixture();f.pages.first.items.push(card('second'));assert.equal((await resolveProjectIssueItem(f.input)).reason,'ambiguous-card');
  f=fixture();f.pages.first.items.push(card('item','another'));assert.equal((await resolveProjectIssueItem(f.input)).reason,'duplicate-card');
});
test('blocks pagination loops, changes during confirmation and unavailable responses',async()=>{
  let f=fixture();f.pages.next.nextCursor='next';assert.equal((await resolveProjectIssueItem(f.input)).reason,'invalid-cursor');
  f=fixture();const original=f.input.listItems;f.input.listItems=async x=>{if(f.calls.length===2)f.pages.first.items[0].nodeId='changed';return original(x);};
  assert.equal((await resolveProjectIssueItem(f.input)).reason,'snapshot-changed');
  f=fixture();f.input.listItems=async()=>{throw Error('private information');};
  assert.deepEqual(await resolveProjectIssueItem(f.input),{kind:'blocked',reason:'project-items-unavailable'});
});
test('limits page entries and ignores unused response fields rather than retaining them',async()=>{
  let f=fixture();f.pages.first.items=Array.from({length:101},(_,i)=>card(`id${i}`,'other'));
  assert.equal((await resolveProjectIssueItem(f.input)).reason,'project-items-unavailable');
  f=fixture();f.pages.first.items[0].unused='x'.repeat(9000000);
  assert.equal((await resolveProjectIssueItem(f.input)).kind,'project-item-observed');
});
