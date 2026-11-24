import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {declare, compareVersion, profileAt, profileFile} from '../scripts/deployment-profile.mjs';
import {diagnose} from '../scripts/diagnose.mjs';

test('onboarding and offline diagnostics cover all supported pairs, conflicts and older repos', t => {
  const root = mkdtempSync(join(tmpdir(), 'agf-profile-'));
  t.after(()=>rmSync(root, {recursive:true, force:true}));
  execFileSync('git',['init','--quiet',root]);
  const input = join(root,'input.json');
  const destination = join(root,profileFile);
  const target = location => ({location, start:'Start a test application', verify:'Read the process revision'});
  assert.equal(diagnose(root).inventory.deploymentProfile.state,'missing');
  for (const [smoke, main] of [['server','server'],['local','server'],['local','local']]) {
    const declaration = {version:1, smoke:target(smoke), main:target(main)};
    writeFileSync(input, JSON.stringify(declaration));
    assert.equal(declare(root,input,false),'would-create');
    assert.equal(profileAt(root).state,'missing');
    assert.equal(declare(root,input,true),'created');
    assert.equal(declare(root,input,true),'unchanged');
    const p = diagnose(root,false,null,{smoke:'stopped'}).inventory.deploymentProfile;
    assert.equal(p.pair,smoke+'/'+main);
    assert.equal(p.runtime.main.state,'unverified');
    assert.equal(p.runtime.smoke.state,'stopped');
    declaration.main.start = 'Different';
    writeFileSync(input, JSON.stringify(declaration));
    assert.throws(()=>declare(root,input,true));
    rmSync(destination);
  }
  writeFileSync(input,JSON.stringify({version:1,smoke:target('server'),main:target('local')}));
  assert.throws(()=>declare(root,input,true));
  writeFileSync(destination,'{');
  assert.equal(profileAt(root).state,'unverified');
});

test('runtime comparison needs two full SHAs unless the target was observed stopped', () => {
  const sha = 'a'.repeat(40);
  assert.equal(compareVersion(sha,sha),'match');
  assert.equal(compareVersion(sha,'b'.repeat(40)),'mismatch');
  assert.equal(compareVersion(null,sha),'unverified');
  assert.equal(compareVersion(sha,'abcdef'),'unverified');
  assert.equal(compareVersion(sha,'stopped'),'stopped');
});
