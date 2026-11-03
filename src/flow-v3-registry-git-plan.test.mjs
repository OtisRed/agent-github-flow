import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckpointKeyring } from './flow-checkpoint-keyring.mjs';
import { reserveV3Project } from './flow-v3-registry.mjs';
import { createV3RegistryAnchor } from './flow-v3-registry-anchor.mjs';
import { planV3RegistryGitUpdate,V3_REGISTRY_REF,V3_REGISTRY_ANCHOR_REF } from './flow-v3-registry-git-plan.mjs';
import { verifyV3RegistryPreparedTree } from './flow-v3-registry-tree-verifier.mjs';
import { createHash } from 'node:crypto';

function fixture(){
  const keyring=createCheckpointKeyring({currentKeyId:1,keys:[{id:1,key:Buffer.alloc(32,1)}]});
  const intent={source:'a'.repeat(32),repository:'private-owner/private-project',repositoryId:'secret-repo-id',expectedPrivate:true,
    cutoverAt:'2026-01-01T10:00:00Z',appId:12,updateRulesetId:1,historyRulesetId:2};
  const content=reserveV3Project({version:1,revision:1,entries:[]},intent).content,registry=JSON.parse(content);
  const anchor=createV3RegistryAnchor(registry,keyring).anchor;
  return {keyring,content,anchor,repository:'owner/state-repo',repositoryId:'state-id',expectedPrivate:true,
    expectedHeadOid:'b'.repeat(40),baseTreeOid:'c'.repeat(40)};
}
test('keeps registry only in a private tree and emits an opaque anchor for the public tree',()=>{
  const f=fixture(),privatePlan=planV3RegistryGitUpdate({...f,role:'private'});
  assert.equal(privatePlan.kind,'v3-registry-git-plan');assert.equal(privatePlan.ref,V3_REGISTRY_REF);
  assert.deepEqual(privatePlan.additions.map(entry=>entry.path),['registry.json','anchor.json']);
  const publicPlan=planV3RegistryGitUpdate({...f,role:'anchor',repository:'owner/agent-github-flow',repositoryId:'flow-id',expectedPrivate:false});
  assert.equal(publicPlan.kind,'v3-registry-git-plan');assert.equal(publicPlan.ref,V3_REGISTRY_ANCHOR_REF);
  assert.deepEqual(publicPlan.additions.map(entry=>entry.path),['anchor.json']);
  const text=Buffer.from(publicPlan.additions[0].contents,'base64').toString('utf8');
  assert.deepEqual(Object.keys(JSON.parse(text)),['version','revision','keyId','mac']);
  assert.equal(JSON.stringify(publicPlan).includes('private-project'),false);assert.equal(text.includes('private-project'),false);
  assert.equal(text.includes('secret-repo-id'),false);
});
test('rejects private config in public storage and forged anchors or malformed OIDs',()=>{
  const f=fixture();assert.equal(planV3RegistryGitUpdate({...f,role:'private',expectedPrivate:false}).kind,'blocked');
  assert.equal(planV3RegistryGitUpdate({...f,role:'anchor',expectedPrivate:true}).kind,'blocked');
  assert.equal(planV3RegistryGitUpdate({...f,role:'anchor',anchor:{...f.anchor,mac:'0'.repeat(64)}}).kind,'blocked');
  assert.equal(planV3RegistryGitUpdate({...f,role:'anchor',expectedHeadOid:'0'.repeat(40)}).kind,'blocked');
  assert.equal(planV3RegistryGitUpdate({...f,role:'other'}).kind,'blocked');
});
test('verifies the exact prepared tree and rejects unrelated or changed blobs',()=>{
  for(const role of ['private','anchor']){const f=fixture(),plan=planV3RegistryGitUpdate({...f,role,expectedPrivate:role==='private'}),treeOid='d'.repeat(40);
    const tree={sha:treeOid,truncated:false,tree:plan.additions.map(entry=>{const bytes=Buffer.from(entry.contents,'base64');
      return {path:entry.path,mode:'100644',type:'blob',sha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')};})};
    const proof={content:f.content,anchor:f.anchor,keyring:f.keyring};
    assert.equal(verifyV3RegistryPreparedTree({plan,treeOid,tree,...proof}).kind,'v3-registry-tree-verified');
    const extra=structuredClone(tree);extra.tree.push({path:'extra',mode:'100644',type:'blob',sha:'e'.repeat(40)});
    assert.equal(verifyV3RegistryPreparedTree({plan,treeOid,tree:extra,...proof}).kind,'blocked');
    const changed=structuredClone(tree);changed.tree[0].sha='f'.repeat(40);
    assert.equal(verifyV3RegistryPreparedTree({plan,treeOid,tree:changed,...proof}).kind,'blocked');
    const forged=structuredClone(plan),forgedTree=structuredClone(tree),bytes=Buffer.from('private-project-secret');
    forged.additions[0].contents=bytes.toString('base64');forgedTree.tree[0].sha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.equal(verifyV3RegistryPreparedTree({plan:forged,treeOid,tree:forgedTree,...proof}).kind,'blocked');
  }
});
