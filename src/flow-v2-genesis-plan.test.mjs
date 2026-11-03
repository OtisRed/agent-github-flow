import test from 'node:test';
import assert from 'node:assert/strict';
import { planV2Genesis } from './flow-v2-genesis-plan.mjs';

test('plans exactly an empty index and canonical v2 marker for an orphan commit',()=>{
  const result=planV2Genesis({repositoryId:'repo',cutoverAt:'2026-01-01T10:00:00Z'});
  assert.equal(result.kind,'v2-genesis-plan');assert.deepEqual(result.parents,[]);
  assert.deepEqual(result.files.map(file=>file.path),['checkpoint-schema.json','index.json']);
  assert.deepEqual(JSON.parse(Buffer.from(result.files[0].contents,'base64').toString()),
    {version:2,repositoryId:'repo',cutoverAt:'2026-01-01T10:00:00Z'});
  assert.deepEqual(JSON.parse(Buffer.from(result.files[1].contents,'base64').toString()),{version:1,repositoryId:'repo',issues:[]});
});

test('does not allow malformed identities, cutovers or additional input fields',()=>{
  for(const value of [{repositoryId:'',cutoverAt:'2026-01-01T10:00:00Z'},
    {repositoryId:'repo',cutoverAt:'today'}, {repositoryId:'repo',cutoverAt:'2026-01-01T10:00:00Z',extra:'x'}])
    assert.equal(planV2Genesis(value).kind,'blocked');
});
