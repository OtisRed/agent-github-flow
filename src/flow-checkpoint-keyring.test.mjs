import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckpointKeyring } from './flow-checkpoint-keyring.mjs';

const input=()=>({currentKeyId:2,keys:[{id:1,key:Buffer.alloc(32,1)},{id:2,key:Buffer.alloc(32,2)}]});
const comment={repositoryId:'repo',issueId:'issue',commentId:'4',body:'[FLOW]\nexample'};
test('uses the current key for new MACs and retains explicitly selected old keys for verification',()=>{
  const ring=createCheckpointKeyring(input()),old=ring.forId(1),current=ring.current();
  assert.equal(current.keyId,2);const oldMac=old.comment(comment),newMac=current.comment(comment);
  assert.equal(ring.forId(1).verifyComment(comment,oldMac),true);assert.equal(current.verifyComment(comment,oldMac),false);
  assert.equal(current.verifyComment(comment,newMac),true);assert.notEqual(oldMac,newMac);
});
test('never substitutes the current key for an unknown historical key',()=>{
  const value=input(),ring=createCheckpointKeyring(value);value.currentKeyId=1;assert.equal(ring.current().keyId,2);
  assert.throws(()=>ring.forId(3),/unknown-checkpoint-key/);
  assert.throws(()=>ring.forId(0),/unknown-checkpoint-key/);
});
test('caller mutations cannot change either historical or current key',()=>{
  const value=input(),ring=createCheckpointKeyring(value),old=ring.forId(1).comment(comment),current=ring.current().comment(comment);
  value.keys[0].key.fill(0);value.keys[1].key.fill(0);
  assert.equal(ring.forId(1).comment(comment),old);assert.equal(ring.current().comment(comment),current);
});
test('rejects malformed rings, duplicate IDs and duplicate key material',()=>{
  for(const change of [v=>{v.currentKeyId=3;},v=>{v.keys[1].id=1;},v=>{v.keys[1].key=Buffer.alloc(32,1);},
    v=>{v.keys[0].key=Buffer.alloc(31);},v=>{v.keys[0].extra=true;},v=>{v.keys=[];}]){
    const value=input();change(value);assert.throws(()=>createCheckpointKeyring(value),/invalid-checkpoint-keyring/);}
});
