import test from 'node:test';
import assert from 'node:assert/strict';
import { planV3Genesis } from './flow-v3-genesis-plan.mjs';

test('plans only a versioned public marker and empty index for a fresh orphan root',()=>{
  const result=planV3Genesis({repositoryId:'repo',cutoverAt:'2026-01-01T10:00:00Z'});
  assert.equal(result.kind,'v3-genesis-plan');assert.deepEqual(result.parents,[]);
  assert.deepEqual(result.files.map(file=>file.path),['checkpoint-schema.json','index.json']);
  assert.deepEqual(JSON.parse(Buffer.from(result.files[0].contents,'base64').toString()),
    {version:3,repositoryId:'repo',cutoverAt:'2026-01-01T10:00:00Z'});
  assert.deepEqual(JSON.parse(Buffer.from(result.files[1].contents,'base64').toString()),{version:1,repositoryId:'repo',issues:[]});
});

test('does not plan malformed input or private configuration in the marker',()=>{
  for(const value of [{repositoryId:'',cutoverAt:'2026-01-01T10:00:00Z'},
    {repositoryId:'repo',cutoverAt:'today'}, {repositoryId:'repo',cutoverAt:'2026-01-01T10:00:00Z',projectId:'private'}])
    assert.equal(planV3Genesis(value).kind,'blocked');
});
