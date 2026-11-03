import test from 'node:test';
import assert from 'node:assert/strict';
import { auditCheckpointProtection } from './flow-checkpoint-protection-audit.mjs';
import { CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF } from './flow-checkpoint-registration.mjs';

function fixture() {
  const rule = (type, id) => ({ type, ruleset_id: id, ruleset_source_type: 'Repository', ruleset_source: 'owner/repo' });
  const common = { target: 'branch', source_type: 'Repository', source: 'owner/repo', enforcement: 'active',
    conditions: { ref_name: { include: [CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF], exclude: [] } } };
  return { repositoryId: 'repo-id', repository: 'owner/repo', appId: 12, expectedPrivate: true,
    repositoryData: { node_id: 'repo-id', full_name: 'owner/repo', fork: false, private: true, default_branch: 'main' },
    updateRuleset: { ...common, id: 1, rules: [{ type: 'update', parameters: { update_allows_fetch_and_merge: false } }],
      bypass_actors: [{ actor_type: 'Integration', actor_id: 12, bypass_mode: 'always' }] },
    historyRuleset: { ...common, id: 2, rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }], bypass_actors: [] },
    effective: [CHECKPOINT_BRANCH_REF, CHECKPOINT_ANCHOR_REF].map(ref => ({ ref,
      rules: [rule('update', 1), rule('deletion', 2), rule('non_fast_forward', 2)] })) };
}
test('observes only the configured App bypass and history protection on both refs', () => {
  assert.deepEqual(auditCheckpointProtection(fixture()), { kind: 'checkpoint-protection-observed', repositoryId: 'repo-id',
    updateRulesetId: 1, historyRulesetId: 2, appId: 12, updateFetchAndMerge: 'disabled-explicit' });
});
test('does not infer missing bypass details or permit other actors', () => {
  let v = fixture(); delete v.updateRuleset.bypass_actors; assert.equal(auditCheckpointProtection(v).reason, 'ruleset-details-unavailable');
  v = fixture(); delete v.historyRuleset.bypass_actors; assert.equal(auditCheckpointProtection(v).reason, 'ruleset-details-unavailable');
  v = fixture(); v.updateRuleset.bypass_actors.push({ actor_type: 'User', actor_id: 7, bypass_mode: 'always' });
  assert.equal(auditCheckpointProtection(v).reason, 'unexpected-bypass');
  v = fixture(); v.historyRuleset.bypass_actors.push(v.updateRuleset.bypass_actors[0]); assert.equal(auditCheckpointProtection(v).reason, 'unexpected-bypass');
  v = fixture(); v.updateRuleset.bypass_actors[0].actor_id = 13; assert.equal(auditCheckpointProtection(v).reason, 'unexpected-bypass');
});
test('requires both exact refs, all rules and active repository-owned rulesets', () => {
  let v = fixture(); v.effective[1].rules.pop(); assert.equal(auditCheckpointProtection(v).reason, 'required-rules-not-effective');
  v = fixture(); v.effective[1].ref = v.effective[0].ref; assert.equal(auditCheckpointProtection(v).reason, 'invalid-ref-evidence');
  v = fixture(); v.updateRuleset.enforcement = 'disabled'; assert.equal(auditCheckpointProtection(v).reason, 'ruleset-details-unavailable');
  v = fixture(); v.historyRuleset.source = 'owner/other'; assert.equal(auditCheckpointProtection(v).reason, 'ruleset-details-unavailable');
  v = fixture(); v.repositoryData.node_id = 'other'; assert.equal(auditCheckpointProtection(v).reason, 'invalid-input');
  v = fixture(); v.repositoryData.default_branch = 'agent-github-flow/checkpoints';
  assert.equal(auditCheckpointProtection(v).reason, 'invalid-input');
});
test('rejects bypass through fetch-and-merge and rules with wrong provenance', () => {
  let v = fixture(); v.updateRuleset.rules[0].parameters.update_allows_fetch_and_merge = true;
  assert.equal(auditCheckpointProtection(v).reason, 'unsafe-update-rule');
  v = fixture(); v.effective[0].rules[0].ruleset_source = 'owner/other';
  assert.equal(auditCheckpointProtection(v).reason, 'required-rules-not-effective');
});
test('rejects wide scopes, exclusions and extra rules in either ruleset', () => {
  let v = fixture(); v.updateRuleset.conditions.ref_name.include = ['~ALL'];
  assert.equal(auditCheckpointProtection(v).reason, 'unsafe-ruleset-scope');
  v = fixture(); v.historyRuleset.conditions = structuredClone(v.historyRuleset.conditions); v.historyRuleset.conditions.ref_name.exclude.push('refs/heads/main');
  assert.equal(auditCheckpointProtection(v).reason, 'unsafe-ruleset-scope');
  v = fixture(); v.updateRuleset.rules.push({ type: 'deletion' }); assert.equal(auditCheckpointProtection(v).reason, 'unexpected-rules');
  v = fixture(); v.historyRuleset.rules.push({ type: 'update' }); assert.equal(auditCheckpointProtection(v).reason, 'unexpected-rules');
  v = fixture(); v.historyRuleset.rules[1].type = 'deletion'; assert.equal(auditCheckpointProtection(v).reason, 'unexpected-rules');
});
test('accepts GitHub omitted parameters only for a freshly verified non-fork', () => {
  let v = fixture(); delete v.updateRuleset.rules[0].parameters;
  assert.equal(auditCheckpointProtection(v).updateFetchAndMerge, 'not-applicable-nonfork');
  for (const fork of [true, null, undefined, 'false']) {
    v = fixture(); v.repositoryData.fork = fork; delete v.updateRuleset.rules[0].parameters;
    assert.notEqual(auditCheckpointProtection(v).kind, 'checkpoint-protection-observed');
  }
  for (const parameters of [null, {}, [], { update_allows_fetch_and_merge: true },
    { update_allows_fetch_and_merge: 'false' }, { update_allows_fetch_and_merge: false, extra: true }]) {
    v = fixture(); v.updateRuleset.rules[0].parameters = parameters;
    assert.equal(auditCheckpointProtection(v).reason, 'unsafe-update-rule');
  }
  v = fixture(); v.repositoryData.private = false; assert.equal(auditCheckpointProtection(v).reason, 'invalid-input');
});
