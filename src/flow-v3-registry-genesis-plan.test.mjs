import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckpointKeyring } from './flow-checkpoint-keyring.mjs';
import { verifyV3Registry } from './flow-v3-registry-anchor.mjs';
import { planV3RegistryGenesis } from './flow-v3-registry-genesis-plan.mjs';
const keyring=createCheckpointKeyring({currentKeyId:1,keys:[{id:1,key:Buffer.alloc(32,1)}]});
const input={privateRepository:'owner/state',privateRepositoryId:'private-id',anchorRepository:'owner/flow',anchorRepositoryId:'public-id',keyring};
const decode=file=>Buffer.from(file.contents,'base64').toString('utf8');
test('plans empty authenticated registry in private and matching opaque public anchor',()=>{
  const plan=planV3RegistryGenesis(input);assert.equal(plan.kind,'v3-registry-genesis-plan');
  assert.deepEqual(plan.private.parents,[]);assert.deepEqual(plan.anchor.parents,[]);assert.equal(plan.private.expectedPrivate,true);assert.equal(plan.anchor.expectedPrivate,false);
  assert.deepEqual(plan.private.files.map(x=>x.path),['registry.json','anchor.json']);assert.deepEqual(plan.anchor.files.map(x=>x.path),['anchor.json']);
  const content=decode(plan.private.files[0]),anchor=JSON.parse(decode(plan.anchor.files[0]));
  assert.equal(decode(plan.private.files[1]),decode(plan.anchor.files[0]));
  assert.equal(verifyV3Registry(content,anchor,keyring).kind,'v3-registry-verified');assert.deepEqual(JSON.parse(content),{version:1,revision:1,entries:[]});
});
test('rejects shared or invalid repository identity and missing key',()=>{
  for(const change of [{privateRepository:'owner/FLOW'},{privateRepositoryId:'public-id'},{keyring:null},{anchorRepository:'../no'}])
    assert.equal(planV3RegistryGenesis({...input,...change}).kind,'blocked');
});
