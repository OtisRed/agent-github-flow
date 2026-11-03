import test from 'node:test';
import assert from 'node:assert/strict';
import { planCheckpointCommit, planCheckpointV2Commit, planCheckpointV3Commit } from './flow-checkpoint-commit-plan.mjs';

function fixture(){const epoch={kind:'initial',anchor:'issue'};
  const record={version:3,repositoryId:'repo-id',number:1,issueId:'issue',cutoverAt:'2026-01-01T10:00:00Z',epoch,reentry:null,
    current:{phase:'pending',commentId:'4',commentMac:'a'.repeat(64),commentKeyId:1,configMac:'c'.repeat(64),configKeyId:1,
      fromStatus:'needs-design',targetStatus:'agent-ready',createdAt:'2026-01-01T10:01:00Z',epoch},previous:null,reservation:null};
  const snapshot={kind:'checkpoint-snapshot-observed',schemaVersion:3,headOid:'b'.repeat(40),repositoryId:'repo-id',repositoryFullName:'owner/project',
    cutoverAt:record.cutoverAt,selection:{number:1,issueId:'issue'},index:{version:1,repositoryId:'repo-id',issues:[{number:1,issueId:'issue'}]},selectedRecord:record};
  const registration={repositoryId:'repo-id',ref:'refs/heads/agent-github-flow/checkpoints',genesisOid:'a'.repeat(40),
    cutoverAt:record.cutoverAt,checkpointSchemaVersion:3};
  const after=structuredClone(record);after.reservation={reservedAt:'2026-01-01T10:02:00Z'};
  return {snapshot,registration,after};}

test('plans only a canonical v3 update for the registered issue and exact HEAD',()=>{
  const v=fixture(),plan=planCheckpointV3Commit(v);assert.equal(plan.kind,'checkpoint-commit-plan');assert.equal(plan.expectedHeadOid,v.snapshot.headOid);
  const record=JSON.parse(Buffer.from(plan.additions[1].contents,'base64').toString());assert.deepEqual(record,v.after);
  assert.equal(JSON.stringify(record).includes('OptionId'),false);
});
test('blocks legacy records, mismatched registration and use of old planners on a v3 snapshot',()=>{
  let v=fixture();v.snapshot.selectedRecord=null;v.snapshot.index.issues=[];v.after.reservation=null;
  assert.equal(planCheckpointCommit(v).kind,'blocked');assert.equal(planCheckpointV2Commit(v).kind,'blocked');
  v=fixture();v.registration.checkpointSchemaVersion=2;assert.equal(planCheckpointV3Commit(v).kind,'blocked');
  v=fixture();v.snapshot.schemaVersion=2;assert.equal(planCheckpointV3Commit(v).kind,'blocked');
  v=fixture();v.snapshot.selectedRecord.version=2;assert.equal(planCheckpointV3Commit(v).kind,'blocked');
  v=fixture();v.after.current.configMac='d'.repeat(64);assert.equal(planCheckpointV3Commit(v).kind,'blocked');
});
