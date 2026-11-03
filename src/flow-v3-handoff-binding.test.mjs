import test from 'node:test';
import assert from 'node:assert/strict';
import { v3HandoffBinding } from './flow-v3-handoff-binding.mjs';

const subject={repositoryId:'repo',repository:'owner/project',projectId:'private-project',statusFieldId:'private-field',issueId:'issue',issueNumber:1,
  appId:1,updateRulesetId:2,historyRulesetId:3,trustedAuthorIds:['user']};
const epoch={kind:'initial',anchor:'issue'};
const record={version:3,repositoryId:'repo',number:1,issueId:'issue',cutoverAt:'2026-01-01T10:00:00Z',epoch,reentry:null,
  current:{phase:'pending',commentId:'4',commentMac:'a'.repeat(64),commentKeyId:1,configMac:'b'.repeat(64),configKeyId:2,
    fromStatus:'needs-design',targetStatus:'agent-ready',createdAt:'2026-01-01T10:01:00Z',epoch},previous:null,reservation:null};
const head='c'.repeat(40);
test('binds exact handoff, config, epoch, reservation, subject and checkpoint head',()=>{
  const result=v3HandoffBinding(subject,record,head);assert.equal(result.commentMac,record.current.commentMac);assert.equal(result.configMac,record.current.configMac);
  for(const [field,value] of Object.entries({commentId:'5',commentMac:'d'.repeat(64),commentKeyId:3,configMac:'e'.repeat(64),configKeyId:4,
    fromStatus:'spike',targetStatus:'review',createdAt:'2026-01-01T10:02:00Z'})){
    const changed=structuredClone(record);changed.current[field]=value;const binding=v3HandoffBinding(subject,changed,head);
    assert.ok(binding);assert.notDeepEqual(binding,result);
  }
  const reserved=structuredClone(record);reserved.reservation={reservedAt:'2026-01-01T10:03:00Z'};
  assert.notDeepEqual(v3HandoffBinding(subject,reserved,head),result);
  assert.notDeepEqual(v3HandoffBinding(subject,record,'d'.repeat(40)),result);
});
test('rejects incomplete, committed, wrong-subject or malformed inputs',()=>{
  for(const changed of [{...record,current:{commentId:'4'}},{...record,current:{...record.current,phase:'committed'}},
    {...record,issueId:'other'},{...record,current:{...record.current,commentMac:'unkeyed'}}])
    assert.equal(v3HandoffBinding(subject,changed,head),null);
  assert.equal(v3HandoffBinding(subject,record,'0'.repeat(40)),null);
  assert.equal(v3HandoffBinding({...subject,issueId:''},record,head),null);
});
