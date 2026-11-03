import test from 'node:test';
import assert from 'node:assert/strict';
import { collectProjectEvidence, completeNames } from './relay-onboarding-observe.mjs';

const repo = { node_id: 'node-1', full_name: 'owner/project', archived: false,
  default_branch: 'main', permissions: { admin: true } };
const page = (key, names, total = names.length) => [{ total_count: total, [key]: names.map(name => ({ name })) }];

test('only secret and variable names are returned as selected presence flags', () => {
  const calls = [];
  const get = args => {
    calls.push(args);
    if (args[0] === '/repos/owner/project') return repo;
    if (args[0].includes('/secrets?')) return page('secrets', ['FLOW_RELAY_TOKEN', 'PRIVATE_UNRELATED_NAME']);
    if (args[0].includes('/variables?')) return [{ total_count: 1, variables: [{ name: 'FLOW_RELAY_TARGET', value: 'sensitive-example' }] }];
    throw new Error('unexpected endpoint');
  };
  const result = collectProjectEvidence('owner', 'project', get);
  assert.deepEqual(result.projectSecrets, { complete: true, repositoryId: 'node-1', environmentName: 'flow-relay',
    relayTokenExists: true, sourceAliasExists: false, targetVariableExists: true });
  assert.doesNotMatch(JSON.stringify(result), /sensitive-example|PRIVATE_UNRELATED_NAME/);
  assert.equal(calls.length, 4);
  assert.ok(calls.slice(1, 3).every(args => args.includes('--paginate') && args.includes('--slurp')));
});

test('failed, incomplete or inconsistent results cannot establish absence', () => {
  for (const pages of [null, [], [{ total_count: 1, secrets: [] }],
    [{ total_count: 2, secrets: [{ name: 'A' }] }, { total_count: 2, secrets: [{ name: 'a' }] }],
    [{ total_count: 1, secrets: [{ name: 'A' }] }, { total_count: 2, secrets: [] }]]) {
    assert.equal(completeNames(pages, 'secrets'), null);
  }
  const result = collectProjectEvidence('owner', 'project', args => args[0] === '/repos/owner/project' ? repo : null);
  assert.deepEqual(result.projectSecrets, { complete: false });
  assert.equal(collectProjectEvidence('owner', 'project', () => ({ ...repo, full_name: 'other/project' })).repository.complete, false);
  assert.throws(() => collectProjectEvidence('..', 'project'));
  assert.deepEqual([...completeNames(page('secrets', []), 'secrets')], []);
});

test('a repository identity change invalidates the entire observation', () => {
  let metadataReads = 0;
  const result = collectProjectEvidence('owner', 'project', args => {
    if (args[0] === '/repos/owner/project') return ++metadataReads === 1 ? repo : { ...repo, node_id: 'other' };
    if (args[0].includes('/secrets?')) return page('secrets', []);
    return page('variables', []);
  });
  assert.deepEqual(result, { repository: { complete: false }, projectSecrets: { complete: false } });
});
