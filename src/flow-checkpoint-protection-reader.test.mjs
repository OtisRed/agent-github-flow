import test from 'node:test';
import assert from 'node:assert/strict';
import { readCheckpointProtectionAudit, readCheckpointVisibleProtection } from './flow-checkpoint-protection-reader.mjs';
import { createOwnerProtectionReceipt } from './flow-checkpoint-protection-receipt.mjs';

const refA = 'refs/heads/agent-github-flow/checkpoints', refB = 'refs/heads/agent-github-flow/checkpoint-anchor';
const response = (data, link = null) => ({ status: 200, json: async () => data, headers: { get: name => name === 'link' ? link : null } });
function fixture() {
  const common = { target: 'branch', source_type: 'Repository', source: 'owner/repo', enforcement: 'active',
    conditions: { ref_name: { include: [refA, refB], exclude: [] } } };
  const state = { repo: { node_id: 'repo-id', full_name: 'owner/repo', fork: false, private: true, default_branch: 'main' },
    update: { ...common, id: 1, rules: [{ type: 'update' }], bypass_actors: [{ actor_type: 'Integration', actor_id: 12, bypass_mode: 'always' }] },
    history: { ...common, id: 2, rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }], bypass_actors: [] },
    rules: [{ type: 'update', ruleset_id: 1, ruleset_source_type: 'Repository', ruleset_source: 'owner/repo' },
      { type: 'deletion', ruleset_id: 2, ruleset_source_type: 'Repository', ruleset_source: 'owner/repo' },
      { type: 'non_fast_forward', ruleset_id: 2, ruleset_source_type: 'Repository', ruleset_source: 'owner/repo' }], calls: [] };
  const request = async raw => { state.calls.push(raw); const url = new URL(raw);
    assert.equal(url.origin, 'https://api.github.com');
    if (url.pathname === '/repos/owner/repo') return response(state.repo);
    if (url.pathname.endsWith('/rulesets/1')) return response(state.update);
    if (url.pathname.endsWith('/rulesets/2')) return response(state.history);
    if (url.pathname.includes('/rules/branches/')) return response(state.rules);
    throw Error('unexpected-url'); };
  return { state, input: { owner: 'owner', repo: 'repo', repositoryId: 'repo-id', appId: 12,
    updateRulesetId: 1, historyRulesetId: 2, expectedPrivate: true, request } };
}
test('reads both refs and owner-visible rulesets twice without treating result as write authority', async () => {
  const f = fixture(); const result = await readCheckpointProtectionAudit(f.input);
  assert.equal(result.kind, 'checkpoint-protection-observed'); assert.equal(result.updateFetchAndMerge, 'not-applicable-nonfork');
  assert.equal(f.state.calls.length, 10);
});
test('paginates effective rules, reconstructs fixed URLs and repeats every page', async () => {
  const f = fixture(); const basic = f.input.request;
  const extras = Array.from({ length: 100 }, (_, i) => ({ type: 'creation', ruleset_id: 100 + i,
    ruleset_source_type: 'Organization', ruleset_source: 'org' }));
  f.input.request = async raw => { const url = new URL(raw);
    if (!url.pathname.includes('/rules/branches/')) return basic(raw);
    f.state.calls.push(raw);
    if (url.searchParams.get('page') === '1') { url.searchParams.set('page', '2'); return response(extras, `<${url}>; rel="next"`); }
    return response(f.state.rules);
  };
  assert.equal((await readCheckpointProtectionAudit(f.input)).kind, 'checkpoint-protection-observed');
  assert.equal(f.state.calls.filter(call => call.includes('/rules/branches/')).length, 8);
});
test('rejects redirects in pagination, hidden bypasses, duplicate rules and changing observations', async () => {
  let f = fixture(); const base = f.input.request;
  f.input.request = async raw => raw.includes('/rules/branches/') ? response(f.state.rules,
    '<https://attacker.invalid/rules?page=2&per_page=100>; rel="next"') : base(raw);
  assert.deepEqual(await readCheckpointProtectionAudit(f.input), { kind: 'blocked', reason: 'protection-read-unavailable' });
  f = fixture(); delete f.state.update.bypass_actors;
  assert.deepEqual(await readCheckpointProtectionAudit(f.input), { kind: 'blocked', reason: 'ruleset-details-unavailable' });
  f = fixture(); f.state.rules.push({ ...f.state.rules[0] });
  assert.deepEqual(await readCheckpointProtectionAudit(f.input), { kind: 'blocked', reason: 'invalid-effective-rules' });
  f = fixture(); const original = f.input.request; let count = 0;
  f.input.request = async raw => { if (raw.endsWith('/rulesets/1') && ++count === 2) f.state.update.enforcement = 'disabled'; return original(raw); };
  assert.deepEqual(await readCheckpointProtectionAudit(f.input), { kind: 'blocked', reason: 'protection-observation-changed' });
});
test('rejects missing page metadata and sanitizes transport failures', async () => {
  let f = fixture(); f.input.request = async () => ({ status: 200, json: async () => ({}) });
  assert.deepEqual(await readCheckpointProtectionAudit(f.input), { kind: 'blocked', reason: 'protection-read-unavailable' });
  f = fixture(); f.input.request = async () => { throw Error('private data'); };
  assert.deepEqual(await readCheckpointProtectionAudit(f.input), { kind: 'blocked', reason: 'protection-read-unavailable' });
});

test('ignores unrelated volatile repository metadata but rejects a changed default branch', async () => {
  let f = fixture(); let count = 0; const original = f.input.request;
  f.input.request = async raw => { if (raw.endsWith('/repos/owner/repo')) f.state.repo.volatile = ++count; return original(raw); };
  assert.equal((await readCheckpointProtectionAudit(f.input)).kind, 'checkpoint-protection-observed');
  f = fixture(); count = 0; const next = f.input.request;
  f.input.request = async raw => { if (raw.endsWith('/repos/owner/repo') && ++count === 2) f.state.repo.default_branch = 'other'; return next(raw); };
  assert.deepEqual(await readCheckpointProtectionAudit(f.input), { kind: 'blocked', reason: 'protection-observation-changed' });
});

test('compares App-visible reads with a full owner audit and fails on drift', async () => {
  const f = fixture();
  f.state.update.updated_at = f.state.history.updated_at = '2026-11-03T10:00:00Z';
  const auditInput = { repositoryId: 'repo-id', repository: 'owner/repo', appId: 12, expectedPrivate: true,
    repositoryData: f.state.repo, updateRuleset: f.state.update, historyRuleset: f.state.history,
    effective: [refA, refB].map(ref => ({ ref, rules: f.state.rules })) };
  const receipt = createOwnerProtectionReceipt({ auditInput, observedAt: '2026-11-03T10:01:00Z', expiresAt: '2026-11-04T10:01:00Z' });
  delete f.state.update.bypass_actors; delete f.state.history.bypass_actors;
  const input = { ...f.input, receipt, now: '2026-11-03T11:00:00Z', maxAgeMs: 86400000 };
  assert.deepEqual(await readCheckpointVisibleProtection(input), { kind: 'visible-profile-matches-owner-audit' });
  assert.deepEqual(await readCheckpointVisibleProtection({ ...input, expectedPrivate: false }), { kind: 'blocked', reason: 'registration-mismatch' });
  f.state.update.updated_at = '2026-11-03T10:30:00Z';
  assert.deepEqual(await readCheckpointVisibleProtection(input), { kind: 'blocked', reason: 'visible-protection-drift' });
  assert.equal((await readCheckpointVisibleProtection({ ...input, maxAgeMs: undefined })).kind, 'blocked');
});
