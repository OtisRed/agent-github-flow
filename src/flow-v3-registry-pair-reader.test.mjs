import test from 'node:test';
import assert from 'node:assert/strict';
import { createV3RegistryPairReader } from './flow-v3-registry-pair-reader.mjs';

test('reads both scoped branches twice and preserves a stable partial update for diagnosis',async()=>{
  const priv={kind:'v3-registry-branch-observed',role:'private',head:'a'.repeat(40),content:'private-content',anchor:{revision:2}};
  const pub={kind:'v3-registry-branch-observed',role:'anchor',head:'b'.repeat(40),anchor:{revision:1}};
  let reads=0;const read=createV3RegistryPairReader({readPrivate:async()=>{reads++;return priv;},readAnchor:async()=>{reads++;return pub;}});
  const result=await read();assert.equal(reads,4);assert.equal(result.privateHead,priv.head);assert.equal(result.anchorHead,pub.head);
  assert.equal(result.stagedAnchor.revision,2);assert.equal(result.anchor.revision,1);
});
test('fails closed if either branch changes, is unavailable or has the wrong role',async()=>{
  let count=0;const read=createV3RegistryPairReader({readPrivate:async()=>({kind:'v3-registry-branch-observed',role:'private',
    head:(++count===1?'a':'c').repeat(40),content:'x',anchor:{}}),
    readAnchor:async()=>({kind:'v3-registry-branch-observed',role:'anchor',head:'b'.repeat(40),anchor:{}})});
  await assert.rejects(read());
  const wrong=createV3RegistryPairReader({readPrivate:async()=>({kind:'v3-registry-branch-observed',role:'anchor'}),
    readAnchor:async()=>({kind:'v3-registry-branch-observed',role:'anchor'})});await assert.rejects(wrong());
});
