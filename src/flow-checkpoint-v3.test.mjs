import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCheckpointV3, decodeCheckpointV3, verifyCheckpointV3Continuity } from './flow-checkpoint-v3.mjs';

function pending(){const epoch={kind:'initial',anchor:'issue'};return {version:3,repositoryId:'repo',number:1,issueId:'issue',
  cutoverAt:'2026-01-01T10:00:00Z',epoch,reentry:null,current:{phase:'pending',commentId:'4',commentMac:'a'.repeat(64),commentKeyId:1,
    configMac:'c'.repeat(64),configKeyId:1,fromStatus:'needs-design',targetStatus:'agent-ready',createdAt:'2026-01-01T10:01:00Z',epoch},
  previous:null,reservation:null};}
const clone=value=>structuredClone(value),identity={repositoryId:'repo',number:1,issueId:'issue'};

test('round-trips canonical v3 without persisting private project identifiers or raw comment',()=>{
  const v=pending();v.reservation={reservedAt:'2026-01-01T10:02:00Z'};
  const encoded=encodeCheckpointV3(v);assert.equal(encoded.kind,'encoded-record');
  assert.deepEqual(decodeCheckpointV3(encoded.content,identity).record,v);
  for(const forbidden of ['projectId','itemId','statusFieldId','fromOptionId','targetOptionId','private-option','raw comment'])
    assert.equal(encoded.content.includes(forbidden),false);
  assert.equal(decodeCheckpointV3(encoded.content+'\n',identity).kind,'blocked');
});

test('rejects unkeyed, unsupported, malformed or misbound records',()=>{
  for(const change of [v=>{v.version=2;},v=>{v.current.commentKeyId=0;},v=>{v.current.configKeyId=0;},
    v=>{v.current.commentMac='bad';},v=>{v.current.configMac='bad';},v=>{v.reservation={reservedAt:'2026-01-01T10:00:00Z'};},
    v=>{v.reservation={reservedAt:'2026-01-01T10:02:00Z',fromOptionId:'private'};},v=>{v.current.projectId='private';},
    v=>{v.current.phase='committed';v.reservation={reservedAt:'2026-01-01T10:02:00Z'};}]){
    const v=pending();change(v);assert.equal(encodeCheckpointV3(v).kind,'blocked');}
});

test('preserves comment and config commitments across reservation, retry and commit',()=>{
  const first=pending(),reserved=clone(first);reserved.reservation={reservedAt:'2026-01-01T10:02:00Z'};
  const retry=clone(reserved);retry.reservation.reservedAt='2026-01-01T10:04:00Z';
  const committed=clone(retry);committed.current.phase='committed';committed.reservation=null;
  for(const [before,after] of [[null,first],[first,reserved],[reserved,retry],[retry,committed]])
    assert.equal(verifyCheckpointV3Continuity(before,after).kind,'continuity-verified');
  assert.equal(committed.current.configMac,first.current.configMac);assert.equal(committed.current.commentMac,first.current.commentMac);
});

test('blocks dropped or regressed reservations, changed commitments and unreserved real transitions',()=>{
  const first=pending(),reserved=clone(first);reserved.reservation={reservedAt:'2026-01-01T10:02:00Z'};
  for(const change of [v=>{v.reservation=null;},v=>{v.reservation.reservedAt='2026-01-01T10:01:30Z';},
    v=>{v.current.configMac='d'.repeat(64);},v=>{v.current.commentKeyId=2;}]){
    const next=clone(reserved);change(next);assert.equal(verifyCheckpointV3Continuity(reserved,next).kind,'blocked');}
  const committed=clone(first);committed.current.phase='committed';assert.equal(verifyCheckpointV3Continuity(first,committed).kind,'blocked');
  const unchanged=clone(first);unchanged.current.fromStatus=unchanged.current.targetStatus;
  const done=clone(unchanged);done.current.phase='committed';assert.equal(verifyCheckpointV3Continuity(unchanged,done).kind,'continuity-verified');
});

test('next handoff must preserve the complete previous keyed marker',()=>{
  const before=pending();before.current.phase='committed';
  const after=clone(before);after.previous=clone(before.current);after.current={...clone(before.current),phase:'pending',commentId:'5',
    commentMac:'b'.repeat(64),fromStatus:'agent-ready',targetStatus:'review',createdAt:'2026-01-01T10:03:00Z'};
  assert.equal(verifyCheckpointV3Continuity(before,after).kind,'continuity-verified');
  after.previous.commentKeyId=2;assert.equal(verifyCheckpointV3Continuity(before,after).kind,'blocked');
});

test('reentry cannot alter commitments for the same historical comment',()=>{
  const v=pending();v.current.phase='committed';v.epoch={kind:'reopened',anchor:'reopen-event'};
  v.reentry={phase:'pending',reopenedAt:'2026-01-01T10:03:00Z',fromStatus:'done',previous:clone(v.current)};
  assert.equal(encodeCheckpointV3(v).kind,'encoded-record');v.reentry.previous.configMac='d'.repeat(64);
  assert.equal(encodeCheckpointV3(v).kind,'blocked');
});

test('key rotation never silently changes the configuration commitment across handoffs or repairs',()=>{
  const before=pending();before.current.phase='committed';
  const next=clone(before);next.previous=clone(before.current);next.current={...clone(before.current),phase:'pending',commentId:'5',
    commentMac:'b'.repeat(64),commentKeyId:2,fromStatus:'agent-ready',targetStatus:'review',createdAt:'2026-01-01T10:03:00Z'};
  assert.equal(verifyCheckpointV3Continuity(before,next).kind,'continuity-verified');
  next.current.configKeyId=2;assert.equal(verifyCheckpointV3Continuity(before,next).kind,'blocked');
  for(const change of [v=>{v.current.commentKeyId=2;},v=>{v.current.configKeyId=2;}]){
    const repair=clone(before);repair.previous=clone(before.current);repair.current.phase='pending';repair.current.fromStatus='smoke';change(repair);
    assert.equal(encodeCheckpointV3(repair).kind,'blocked');}
});

test('the first handoff after reopen cannot silently change configuration',()=>{
  const before=pending();before.current.phase='committed';before.epoch={kind:'reopened',anchor:'reopen-event'};
  before.reentry={phase:'ready',reopenedAt:'2026-01-01T10:03:00Z',fromStatus:'done',previous:clone(before.current)};
  const after=clone(before);after.previous=clone(before.current);after.current={...clone(before.current),phase:'pending',commentId:'5',
    commentMac:'b'.repeat(64),epoch:clone(before.epoch),createdAt:'2026-01-01T10:04:00Z',fromStatus:'needs-design'};
  assert.equal(verifyCheckpointV3Continuity(before,after).kind,'continuity-verified');
  after.current.configMac='d'.repeat(64);assert.equal(verifyCheckpointV3Continuity(before,after).kind,'blocked');
});
